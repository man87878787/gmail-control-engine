import "dotenv/config";
import express from "express";
import {
  accountProfile,
  authorizationUrl,
  clientStatus,
  disconnectOauth,
  exchangeCode,
  gmailErrorInfo,
  listLabels,
  modifyMessageLabels,
  oauthStatus,
  readMessage,
  replyToMessage,
  saveClientJson,
  searchMessages,
} from "./gmail.mjs";
import {
  buildCampaign,
  jobFingerprint,
  validateJobPayload,
} from "./job.mjs";
import { requireAgentKey } from "./security.mjs";
import {
  addSuppression,
  applyCampaignAction,
  audit,
  backupStore,
  bindCampaignAccount,
  campaignSummary,
  closeStore,
  configureAccount,
  configureCampaign,
  createAccount,
  DEFAULT_SETTINGS,
  exportState,
  findCampaignByJobKey,
  getAccount,
  getCampaign,
  getCampaignCount,
  getCampaignExceptions,
  getQueueStats,
  getSentUnitsToday,
  getSettings,
  insertCampaign,
  listAccounts,
  listAudit,
  listRunningCampaigns,
  listSuppression,
  recordSendEvent,
  recoverInterruptedRecipients,
  removeSuppression,
  setAccountPause,
  setSettings,
  storeHealth,
  updateAccountProfile,
} from "./store.mjs";
import { startWorker, stopWorker, workerStatus } from "./worker.mjs";
import {
  clampInt,
  id,
  isEmail,
  normalizeEmail,
  nowIso,
  publicError,
} from "./utils.mjs";

const VERSION = "2.0.0";
const app = express();
const host = process.env.HOST || "127.0.0.1";
const port = clampInt(process.env.PORT, 1024, 65535, 4317);

app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

function accountView(account) {
  if (!account) return null;
  const auth = oauthStatus(account.id);
  return {
    ...account,
    oauthConfigured: auth.configured,
    authorized: auth.authorized,
    sentUnitsToday: getSentUnitsToday(account.id),
    canRun: account.enabled && !account.paused && auth.authorized,
  };
}

function resolveAccount(ref) {
  const account = getAccount(ref);
  if (!account) {
    const error = new Error("Unknown Gmail profile: " + String(ref || ""));
    error.status = 404;
    throw error;
  }
  return account;
}

function validateAlias(value) {
  const alias = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(alias)) {
    throw new Error("Alias must be 2-32 characters: lowercase letters, numbers, _ or -.");
  }
  return alias;
}

app.get("/health/live", (_req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
    at: nowIso(),
  });
});

app.get("/health/ready", (_req, res) => {
  const store = storeHealth();
  res.status(store.ok ? 200 : 503).json({
    ok: store.ok,
    version: VERSION,
    store,
    googleClient: clientStatus(),
    worker: workerStatus(),
  });
});

app.get("/oauth/callback", async (req, res) => {
  try {
    if (!req.query.code || !req.query.state) {
      throw new Error("Google did not return the required OAuth values.");
    }
    const result = await exchangeCode(String(req.query.code), String(req.query.state));
    const account = getAccount(result.accountId);
    if (!account) {
      disconnectOauth(result.accountId);
      throw new Error("OAuth returned for an unknown local Gmail profile.");
    }

    updateAccountProfile(result.accountId, normalizeEmail(result.profile.emailAddress));
    setAccountPause(result.accountId, true, "authorized_waiting_for_resume");
    await audit("oauth_connected", {
      email: result.profile.emailAddress,
      alias: account.alias,
    }, result.accountId);

    res.type("text/plain").send(
      "Connected " + account.alias + " as " + result.profile.emailAddress + ". You can close this tab.",
    );
  } catch (error) {
    res.status(400).type("text/plain").send("OAuth failed: " + publicError(error));
  }
});

app.use("/api", requireAgentKey);

app.get("/api/agent/status", (_req, res) => {
  const settings = getSettings();
  const accounts = listAccounts().map(accountView);
  const running = listRunningCampaigns().map(campaignSummary);
  const queue = getQueueStats();

  res.json({
    ok: true,
    version: VERSION,
    paused: settings.masterPaused,
    pauseReason: settings.pauseReason || "",
    googleClient: clientStatus(),
    store: storeHealth(),
    worker: workerStatus(),
    settings,
    accounts,
    running,
    campaignCount: getCampaignCount(),
    queue,
  });
});

app.get("/api/accounts", (_req, res) => {
  res.json(listAccounts().map(accountView));
});

app.post("/api/accounts", async (req, res) => {
  try {
    const alias = validateAlias(req.body?.alias);
    const expectedEmail = normalizeEmail(req.body?.expectedEmail || "");
    if (expectedEmail && !isEmail(expectedEmail)) {
      return res.status(400).json({ error: "Invalid expected email address." });
    }

    const result = createAccount({
      id: id("acct"),
      alias,
      label: String(req.body?.label || "").trim(),
      expectedEmail,
    });

    await audit(result.created ? "account_created" : "account_exists", {
      alias,
      expectedEmail,
    }, result.account.id);

    res.status(result.created ? 201 : 200).json({
      created: result.created,
      account: accountView(result.account),
    });
  } catch (error) {
    res.status(error.code === "MAX_ACCOUNTS" ? 409 : 400).json({ error: publicError(error) });
  }
});

app.put("/api/accounts/:ref/config", async (req, res) => {
  try {
    const account = resolveAccount(req.params.ref);
    const updated = configureAccount(account.id, {
      perMinute: req.body?.perMinute,
      dailyCap: req.body?.dailyCap,
      enabled: req.body?.enabled,
    });
    await audit("account_config_updated", {
      perMinute: updated.perMinute,
      dailyCap: updated.dailyCap,
      enabled: updated.enabled,
    }, updated.id);
    res.json(accountView(updated));
  } catch (error) {
    res.status(error.status || 400).json({ error: publicError(error) });
  }
});

app.post("/api/accounts/:ref/action", async (req, res) => {
  try {
    const account = resolveAccount(req.params.ref);
    const action = String(req.body?.action || "").trim();

    if (action === "pause") {
      const updated = setAccountPause(
        account.id,
        true,
        String(req.body?.reason || "manual"),
      );
      await audit("account_paused", { reason: updated.pauseReason }, account.id);
      return res.json(accountView(updated));
    }

    if (action === "resume") {
      if (!oauthStatus(account.id).authorized) {
        return res.status(409).json({ error: "This Gmail profile is not authorized." });
      }
      const updated = setAccountPause(account.id, false, "");
      await audit("account_resumed", {}, account.id);
      return res.json(accountView(updated));
    }

    return res.status(400).json({ error: "action must be pause or resume" });
  } catch (error) {
    res.status(error.status || 400).json({ error: publicError(error) });
  }
});

app.post("/api/accounts/:ref/oauth-url", (req, res) => {
  try {
    const account = resolveAccount(req.params.ref);
    const url = authorizationUrl({
      accountId: account.id,
      expectedEmail: account.expectedEmail,
    });
    res.json({
      alias: account.alias,
      expectedEmail: account.expectedEmail,
      url,
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: publicError(error) });
  }
});

app.post("/api/accounts/:ref/oauth-disconnect", async (req, res) => {
  try {
    const account = resolveAccount(req.params.ref);
    disconnectOauth(account.id);
    const updated = setAccountPause(account.id, true, "oauth_disconnected");
    await audit("oauth_disconnected", {}, account.id);
    res.json(accountView(updated));
  } catch (error) {
    res.status(error.status || 400).json({ error: publicError(error) });
  }
});

app.post("/api/oauth/client", async (req, res) => {
  try {
    const result = saveClientJson(req.body?.client || req.body);
    await audit("oauth_client_configured", { projectId: result.projectId || "" });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: publicError(error) });
  }
});

app.post("/api/agent/validate", (req, res) => {
  const settings = getSettings();
  const validation = validateJobPayload(req.body || {}, settings);
  const account = getAccount(req.body?.account);

  if (!account) validation.errors.push("Unknown Gmail profile: " + String(req.body?.account || ""));

  res.status(validation.errors.length ? 400 : 200).json({
    ok: validation.errors.length === 0,
    errors: validation.errors,
    ...validation.stats,
    account: account ? accountView(account) : null,
    dailyCap: account?.dailyCap || settings.defaultDailyCap,
  });
});

app.post("/api/agent/jobs", async (req, res) => {
  try {
    const settings = getSettings();
    const validation = validateJobPayload(req.body || {}, settings);
    if (validation.errors.length) {
      return res.status(400).json({
        error: "job validation failed",
        errors: validation.errors,
        stats: validation.stats,
      });
    }

    const account = resolveAccount(req.body.account);
    const requestedFingerprint = jobFingerprint(req.body, validation.parsed.rows);
    const existing = findCampaignByJobKey(String(req.body.jobKey).trim());

    if (existing) {
      if (existing.jobFingerprint && existing.jobFingerprint !== requestedFingerprint) {
        return res.status(409).json({
          error: "idempotency conflict",
          detail: "jobKey already exists with different content",
          campaign: campaignSummary(existing),
        });
      }
      return res.json({
        created: false,
        duplicatePrevented: true,
        campaign: campaignSummary(existing),
      });
    }

    if (req.body.start === true && !oauthStatus(account.id).authorized) {
      return res.status(409).json({ error: "Selected Gmail profile is not authorized." });
    }

    const campaign = buildCampaign(req.body, validation, settings, account.id);
    const inserted = insertCampaign(campaign);

    await audit("agent_job_created", {
      jobKey: campaign.jobKey,
      mode: campaign.mode,
      recipients: campaign.recipients.length,
      recipientUnits: campaign.recipients.reduce(
        (sum, row) => sum + Math.max(1, Number(row.units || 1)),
        0,
      ),
      duplicatesRemoved: validation.parsed.duplicates,
    }, account.id, campaign.id);

    res.status(201).json({
      created: true,
      duplicatePrevented: false,
      duplicatesRemoved: validation.parsed.duplicates,
      campaign: campaignSummary(inserted),
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: publicError(error) });
  }
});

app.get("/api/agent/jobs/:id", (req, res) => {
  const campaign = getCampaign(req.params.id, false);
  if (!campaign) return res.status(404).json({ error: "job not found" });
  res.json({
    campaign: campaignSummary(campaign),
    exceptions: getCampaignExceptions(campaign.id),
  });
});

app.post("/api/agent/jobs/:id/account", async (req, res) => {
  try {
    const account = resolveAccount(req.body?.account);
    const campaign = bindCampaignAccount(req.params.id, account.id);
    if (!campaign) return res.status(404).json({ error: "job not found" });
    await audit("job_account_bound", {
      alias: account.alias,
    }, account.id, campaign.id);
    res.json(campaignSummary(campaign));
  } catch (error) {
    res.status(error.status || 400).json({ error: publicError(error) });
  }
});

app.put("/api/agent/jobs/:id/config", async (req, res) => {
  const campaign = configureCampaign(req.params.id, {
    ratePerMinute: req.body?.ratePerMinute,
  });
  if (!campaign) return res.status(404).json({ error: "job not found" });
  await audit("job_config_updated", {
    ratePerMinute: campaign.ratePerMinute,
  }, campaign.accountId, campaign.id);
  res.json(campaignSummary(campaign));
});

app.post("/api/agent/jobs/:id/action", async (req, res) => {
  const action = String(req.body?.action || "").trim();
  if (!["start", "pause", "resume", "cancel", "retry-failed"].includes(action)) {
    return res.status(400).json({ error: "invalid action" });
  }

  const campaign = getCampaign(req.params.id, false);
  if (!campaign) return res.status(404).json({ error: "job not found" });

  if (["start", "resume"].includes(action)) {
    if (!campaign.accountId) return res.status(409).json({ error: "Job has no Gmail profile assigned." });
    if (!oauthStatus(campaign.accountId).authorized) {
      return res.status(409).json({ error: "Job Gmail profile is not authorized." });
    }
  }

  const updated = applyCampaignAction(campaign.id, action);
  await audit("agent_job_action", { action }, campaign.accountId, campaign.id);
  res.json(campaignSummary(updated));
});

app.post("/api/agent/system", async (req, res) => {
  const action = String(req.body?.action || "").trim();
  if (action === "pause") {
    const settings = await setSettings({
      masterPaused: true,
      pauseReason: String(req.body?.reason || "manual"),
    });
    await audit("agent_system_paused", { reason: settings.pauseReason });
    return res.json({ paused: true, pauseReason: settings.pauseReason });
  }

  if (action === "resume") {
    const settings = await setSettings({
      masterPaused: false,
      pauseReason: "",
    });
    await audit("agent_system_resumed");
    return res.json({ paused: false, pauseReason: settings.pauseReason });
  }

  res.status(400).json({ error: "action must be pause or resume" });
});

app.put("/api/agent/config", async (req, res) => {
  const current = getSettings();
  const patch = {
    globalConcurrency: clampInt(req.body?.globalConcurrency, 1, 16, current.globalConcurrency),
    perAccountConcurrency: clampInt(req.body?.perAccountConcurrency, 1, 5, current.perAccountConcurrency),
    defaultPerMinute: clampInt(req.body?.defaultPerMinute, 1, 50, current.defaultPerMinute),
    defaultDailyCap: clampInt(req.body?.defaultDailyCap, 1, 500, current.defaultDailyCap),
    maxAttempts: clampInt(req.body?.maxAttempts, 1, 10, current.maxAttempts),
    retryBaseSeconds: clampInt(req.body?.retryBaseSeconds, 1, 60, current.retryBaseSeconds),
    maxBackoffSeconds: clampInt(req.body?.maxBackoffSeconds, 15, 300, current.maxBackoffSeconds),
  };
  const settings = await setSettings(patch);
  await audit("agent_config_updated", patch);
  res.json(settings);
});

app.post("/api/agent/backup", async (req, res) => {
  try {
    const target = await backupStore(String(req.body?.destination || ""));
    await audit("backup_created", { path: target });
    res.json({ ok: true, path: target });
  } catch (error) {
    res.status(500).json({ error: publicError(error) });
  }
});

app.get("/api/suppression", (_req, res) => {
  res.json(listSuppression());
});

app.post("/api/suppression", async (req, res) => {
  try {
    const type = req.body?.type === "domain" ? "domain" : "email";
    let value = String(req.body?.value || "").trim().toLowerCase();
    if (type === "domain") value = value.replace(/^@/, "");

    if (!value) return res.status(400).json({ error: "suppression value is required" });
    if (type === "email" && !isEmail(value)) return res.status(400).json({ error: "invalid email" });
    if (type === "domain" && (!value.includes(".") || value.includes("@"))) {
      return res.status(400).json({ error: "invalid domain" });
    }

    let accountId = null;
    if (req.body?.account) accountId = resolveAccount(req.body.account).id;

    const entry = {
      id: id("sup"),
      accountId,
      type,
      value,
      reason: String(req.body?.reason || "").trim(),
      createdAt: nowIso(),
    };
    const result = addSuppression(entry);
    await audit(result.created ? "suppression_added" : "suppression_exists", entry, accountId);
    res.status(result.created ? 201 : 200).json({ created: result.created, entry });
  } catch (error) {
    res.status(error.status || 400).json({ error: publicError(error) });
  }
});

app.delete("/api/suppression/:id", async (req, res) => {
  removeSuppression(req.params.id);
  await audit("suppression_removed", { id: req.params.id });
  res.json({ ok: true });
});

app.get("/api/logs", (req, res) => {
  res.json(listAudit(clampInt(req.query.limit, 1, 1000, 200)));
});

app.get("/api/export", (_req, res) => {
  res.setHeader("Content-Disposition", 'attachment; filename="gmail-control-backup.json"');
  res.json(exportState());
});

app.get("/api/accounts/:ref/inbox/search", async (req, res) => {
  try {
    const account = resolveAccount(req.params.ref);
    res.json(await searchMessages(
      account.id,
      String(req.query.q || ""),
      clampInt(req.query.max, 1, 100, 25),
    ));
  } catch (error) {
    res.status(error.status || 400).json({ error: publicError(error) });
  }
});

app.get("/api/accounts/:ref/messages/:messageId", async (req, res) => {
  try {
    const account = resolveAccount(req.params.ref);
    res.json(await readMessage(account.id, req.params.messageId));
  } catch (error) {
    res.status(error.status || 400).json({ error: publicError(error) });
  }
});

app.post("/api/accounts/:ref/messages/:messageId/reply", async (req, res) => {
  try {
    const account = resolveAccount(req.params.ref);
    const mode = req.body?.mode === "send" ? "send" : "draft";
    const settings = getSettings();

    if (settings.masterPaused || account.paused) {
      return res.status(409).json({ error: "Outbound actions are paused." });
    }
    if (!oauthStatus(account.id).authorized) {
      return res.status(409).json({ error: "Gmail profile is not authorized." });
    }
    if (mode === "send" && getSentUnitsToday(account.id) + 1 > account.dailyCap) {
      setAccountPause(account.id, true, "daily_cap");
      return res.status(429).json({ error: "Account daily send cap reached." });
    }

    const result = await replyToMessage(
      account.id,
      req.params.messageId,
      {
        text: String(req.body?.text || ""),
        html: String(req.body?.html || ""),
        mode,
      },
    );

    if (mode === "send") {
      recordSendEvent({
        accountId: account.id,
        kind: "send",
        email: "reply",
        units: 1,
      });
    }
    await audit("message_reply_" + mode, {
      messageId: req.params.messageId,
    }, account.id);
    res.json(result);
  } catch (error) {
    const account = getAccount(req.params.ref);
    const info = gmailErrorInfo(error);
    if (account && (info.sendLimit || info.auth)) {
      setAccountPause(
        account.id,
        true,
        info.sendLimit ? "gmail_send_limit" : "oauth_error",
      );
    }
    res.status(info.status || error.status || 400).json({ error: info.message || publicError(error) });
  }
});

app.get("/api/accounts/:ref/labels", async (req, res) => {
  try {
    const account = resolveAccount(req.params.ref);
    res.json(await listLabels(account.id));
  } catch (error) {
    res.status(error.status || 400).json({ error: publicError(error) });
  }
});

app.post("/api/accounts/:ref/messages/:messageId/labels", async (req, res) => {
  try {
    const account = resolveAccount(req.params.ref);
    const result = await modifyMessageLabels(
      account.id,
      req.params.messageId,
      Array.isArray(req.body?.add) ? req.body.add : [],
      Array.isArray(req.body?.remove) ? req.body.remove : [],
    );
    await audit("message_labels_modified", {
      messageId: req.params.messageId,
    }, account.id);
    res.json(result);
  } catch (error) {
    res.status(error.status || 400).json({ error: publicError(error) });
  }
});

app.use((error, _req, res, _next) => {
  res.status(500).json({ error: publicError(error) });
});

await setSettings({
  masterPaused: true,
  pauseReason: "startup",
  maxRecipientsPerJob: 500,
  maxAccounts: 4,
});

const recovered = recoverInterruptedRecipients();
if (recovered) await audit("startup_recovered_recipients", { recovered });
await audit("service_started", { version: VERSION, pid: process.pid });

startWorker();

const server = app.listen(port, host, () => {
  process.stdout.write(JSON.stringify({
    level: "info",
    event: "listening",
    version: VERSION,
    url: "http://" + host + ":" + port,
    paused: true,
  }) + "\n");
});

let shuttingDown = false;
async function shutdown(signal = "shutdown", exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  try { await audit("service_stopping", { signal }); } catch {}
  try { await stopWorker({ drainMs: 15_000 }); } catch {}

  await new Promise((resolve) => {
    server.close(resolve);
    const handle = setTimeout(resolve, 5_000);
    handle.unref?.();
  });

  closeStore();
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown("SIGINT", 0));
process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("uncaughtException", async (error) => {
  try { await audit("uncaught_exception", { error: publicError(error) }); } catch {}
  await shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", async (error) => {
  try { await audit("unhandled_rejection", { error: publicError(error) }); } catch {}
});
