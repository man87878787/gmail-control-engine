import {
  createDraft,
  findMessageByRfcMessageId,
  gmailErrorInfo,
  oauthStatus,
  sendMessage,
} from "./gmail.mjs";
import {
  audit,
  claimRecipient,
  finalizeCampaign,
  getAccount,
  getSentUnitsToday,
  getSettings,
  listRunningCampaigns,
  markRecipientFailure,
  markRecipientSuccess,
  setAccountPause,
} from "./store.mjs";
import {
  jitteredBackoffSeconds,
  nowIso,
  publicError,
  recipientVars,
  renderTemplate,
} from "./utils.mjs";

let timer = null;
let lastTickAt = null;
let draining = false;
const activePromises = new Set();
const activeByAccount = new Map();
const pendingUnitsByAccount = new Map();
const accountClaims = new Map();
const campaignClaims = new Map();
const lastAccountClaimAt = new Map();
const lastCampaignClaimAt = new Map();

function rateRows(map, key) {
  const now = Date.now();
  const cutoff = now - 60_000;
  const rows = map.get(key) || [];
  while (rows.length && rows[0] < cutoff) rows.shift();
  if (rows.length) map.set(key, rows);
  else map.delete(key);
  return rows;
}

function rateAvailable(accountId, campaignId, accountLimit, campaignLimit) {
  const now = Date.now();
  const accountInterval = Math.ceil(60_000 / Math.max(1, accountLimit));
  const campaignInterval = Math.ceil(60_000 / Math.max(1, campaignLimit));
  const accountLast = Number(lastAccountClaimAt.get(accountId) || 0);
  const campaignLast = Number(lastCampaignClaimAt.get(campaignId) || 0);

  return rateRows(accountClaims, accountId).length < accountLimit
    && rateRows(campaignClaims, campaignId).length < campaignLimit
    && now - accountLast >= accountInterval
    && now - campaignLast >= campaignInterval;
}

function reserveRate(accountId, campaignId) {
  const now = Date.now();
  const accountRows = rateRows(accountClaims, accountId);
  accountRows.push(now);
  accountClaims.set(accountId, accountRows);
  lastAccountClaimAt.set(accountId, now);

  const campaignRows = rateRows(campaignClaims, campaignId);
  campaignRows.push(now);
  campaignClaims.set(campaignId, campaignRows);
  lastCampaignClaimAt.set(campaignId, now);
}

function accountActive(accountId) {
  return Number(activeByAccount.get(accountId) || 0);
}

function addActive(accountId, units) {
  activeByAccount.set(accountId, accountActive(accountId) + 1);
  pendingUnitsByAccount.set(
    accountId,
    Number(pendingUnitsByAccount.get(accountId) || 0) + Math.max(1, Number(units || 1)),
  );
}

function removeActive(accountId, units) {
  const nextActive = Math.max(0, accountActive(accountId) - 1);
  if (nextActive) activeByAccount.set(accountId, nextActive);
  else activeByAccount.delete(accountId);

  const nextUnits = Math.max(
    0,
    Number(pendingUnitsByAccount.get(accountId) || 0) - Math.max(1, Number(units || 1)),
  );
  if (nextUnits) pendingUnitsByAccount.set(accountId, nextUnits);
  else pendingUnitsByAccount.delete(accountId);
}

async function processClaim({ campaign, recipient, account }) {
  const vars = recipientVars(recipient);
  const subject = renderTemplate(recipient.subject ?? campaign.subject, vars);
  const text = renderTemplate(recipient.body ?? campaign.body, vars);
  const htmlSource = recipient.htmlBody ?? campaign.htmlBody;
  const html = htmlSource ? renderTemplate(htmlSource, vars) : "";

  try {
    if ((recipient.needsReconcile || recipient.attempts > 1) && recipient.messageIdHeader) {
      const found = await findMessageByRfcMessageId(
        account.id,
        recipient.messageIdHeader,
        campaign.mode,
      );
      if (found) {
        markRecipientSuccess({
          campaignId: campaign.id,
          recipientId: recipient.id,
          accountId: account.id,
          mode: campaign.mode,
          result: found,
          reconciled: true,
        });
        await audit("recipient_reconciled", {
          recipientId: recipient.id,
          email: recipient.email,
        }, account.id, campaign.id);
        return;
      }
    }

    const message = {
      to: recipient.email,
      cc: recipient.cc || "",
      bcc: recipient.bcc || "",
      subject,
      text,
      html,
      messageIdHeader: recipient.messageIdHeader || "",
    };

    const result = campaign.mode === "send"
      ? await sendMessage(account.id, message)
      : await createDraft(account.id, message);

    markRecipientSuccess({
      campaignId: campaign.id,
      recipientId: recipient.id,
      accountId: account.id,
      mode: campaign.mode,
      result,
      reconciled: false,
    });

    await audit(
      "recipient_" + (campaign.mode === "send" ? "sent" : "drafted"),
      {
        recipientId: recipient.id,
        email: recipient.email,
      },
      account.id,
      campaign.id,
    );
  } catch (error) {
    const info = gmailErrorInfo(error);
    const settings = getSettings();
    const attempts = Number(recipient.attempts || 0);

    if (info.sendLimit) {
      markRecipientFailure(recipient.id, {
        state: "retry",
        error: info.message,
        nextAttemptAt: null,
        needsReconcile: true,
      });
      setAccountPause(account.id, true, "gmail_send_limit");
    } else if (info.auth) {
      markRecipientFailure(recipient.id, {
        state: "retry",
        error: info.message,
        nextAttemptAt: null,
        needsReconcile: true,
      });
      setAccountPause(account.id, true, "oauth_error");
    } else if (info.permanent) {
      markRecipientFailure(recipient.id, {
        state: "failed",
        error: info.message,
        nextAttemptAt: null,
        needsReconcile: false,
      });
    } else if (attempts < Number(settings.maxAttempts || 6)) {
      const delay = jitteredBackoffSeconds(
        attempts,
        Number(settings.retryBaseSeconds || 2),
        Number(settings.maxBackoffSeconds || 90),
      );
      markRecipientFailure(recipient.id, {
        state: "retry",
        error: info.message,
        nextAttemptAt: new Date(Date.now() + delay * 1000).toISOString(),
        needsReconcile: true,
      });
    } else {
      markRecipientFailure(recipient.id, {
        state: "failed",
        error: info.message,
        nextAttemptAt: null,
        needsReconcile: true,
      });
    }

    await audit("recipient_error", {
      recipientId: recipient.id,
      email: recipient.email,
      error: publicError(error),
      status: info.status,
      category: info.sendLimit
        ? "gmail_send_limit"
        : info.auth
          ? "oauth"
          : info.permanent
            ? "permanent"
            : info.transient
              ? "transient"
              : "unknown",
    }, account.id, campaign.id);
  } finally {
    finalizeCampaign(campaign.id);
  }
}

async function tick() {
  lastTickAt = nowIso();
  if (draining) return;

  const settings = getSettings();
  if (settings.masterPaused) return;

  let globalSlots = Math.max(
    0,
    Number(settings.globalConcurrency || 8) - activePromises.size,
  );
  if (!globalSlots) return;

  const campaigns = listRunningCampaigns();

  for (const campaign of campaigns) {
    if (!globalSlots) break;
    if (!campaign.accountId) continue;
    if (campaign.startAt && new Date(campaign.startAt).getTime() > Date.now()) continue;

    const account = getAccount(campaign.accountId);
    if (!account?.enabled || account.paused) continue;
    if (!oauthStatus(account.id).authorized) continue;

    const perAccountConcurrency = Number(settings.perAccountConcurrency || 3);
    if (accountActive(account.id) >= perAccountConcurrency) continue;

    const accountRate = Math.max(1, Math.min(50, Number(account.perMinute || 50)));
    const campaignRate = Math.max(
      1,
      Math.min(accountRate, Number(campaign.ratePerMinute || accountRate)),
    );
    if (!rateAvailable(account.id, campaign.id, accountRate, campaignRate)) continue;

    const claim = claimRecipient(campaign.id);
    if (!claim) {
      finalizeCampaign(campaign.id);
      continue;
    }

    const units = Math.max(1, Number(claim.recipient.units || 1));

    if (campaign.mode === "send") {
      const sent = getSentUnitsToday(account.id);
      const pending = Number(pendingUnitsByAccount.get(account.id) || 0);
      if (sent + pending + units > Number(account.dailyCap || 500)) {
        markRecipientFailure(claim.recipient.id, {
          state: "retry",
          error: "Account daily cap reached.",
          nextAttemptAt: null,
          needsReconcile: false,
        });
        setAccountPause(account.id, true, "daily_cap");
        await audit("account_daily_cap_reached", {
          sentUnits: sent,
          pendingUnits: pending,
          attemptedUnits: units,
          dailyCap: account.dailyCap,
        }, account.id, campaign.id);
        continue;
      }
    }

    reserveRate(account.id, campaign.id);
    addActive(account.id, units);
    globalSlots -= 1;

    const promise = processClaim({
      campaign: claim.campaign,
      recipient: claim.recipient,
      account,
    })
      .catch(async (error) => {
        await audit("worker_unhandled_error", {
          error: publicError(error),
        }, account.id, campaign.id);
      })
      .finally(() => {
        activePromises.delete(promise);
        removeActive(account.id, units);
      });

    activePromises.add(promise);
  }
}

export function startWorker() {
  if (timer) return;
  draining = false;
  timer = setInterval(() => {
    tick().catch(async (error) => {
      await audit("worker_tick_error", { error: publicError(error) });
    });
  }, 200);
}

export async function stopWorker({ drainMs = 15_000 } = {}) {
  draining = true;
  if (timer) clearInterval(timer);
  timer = null;

  if (!activePromises.size) return { drained: true, active: 0 };

  const settled = Promise.allSettled([...activePromises]);
  const timeout = new Promise((resolve) => {
    const handle = setTimeout(() => resolve("timeout"), drainMs);
    handle.unref?.();
  });

  const result = await Promise.race([settled, timeout]);
  return {
    drained: result !== "timeout",
    active: activePromises.size,
  };
}

export function workerStatus() {
  const accountActivity = {};
  for (const [accountId, count] of activeByAccount.entries()) {
    accountActivity[accountId] = {
      active: count,
      pendingUnits: Number(pendingUnitsByAccount.get(accountId) || 0),
      claimsLastMinute: rateRows(accountClaims, accountId).length,
    };
  }

  return {
    running: Boolean(timer),
    draining,
    active: activePromises.size,
    lastTickAt,
    accountActivity,
  };
}
