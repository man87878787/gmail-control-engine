import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, backup } from "node:sqlite";
import { nowIso } from "./utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = process.env.GMAIL_CONTROL_DATA_DIR
  ? path.resolve(process.env.GMAIL_CONTROL_DATA_DIR)
  : path.join(root, "data");
const dbPath = path.join(dataDir, "state.sqlite3");

fs.mkdirSync(dataDir, { recursive: true });

export const DEFAULT_SETTINGS = Object.freeze({
  masterPaused: true,
  pauseReason: "startup",
  maxRecipientsPerJob: 500,
  maxAccounts: 4,
  globalConcurrency: 8,
  perAccountConcurrency: 3,
  defaultPerMinute: 50,
  defaultDailyCap: 500,
  maxAttempts: 6,
  retryBaseSeconds: 2,
  maxBackoffSeconds: 90,
});

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA synchronous=FULL");
db.exec("PRAGMA busy_timeout=5000");
db.exec("PRAGMA foreign_keys=ON");
db.exec("PRAGMA temp_store=MEMORY");

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    alias TEXT NOT NULL UNIQUE COLLATE NOCASE,
    label TEXT NOT NULL DEFAULT '',
    expected_email TEXT NOT NULL DEFAULT '',
    email TEXT UNIQUE COLLATE NOCASE,
    enabled INTEGER NOT NULL DEFAULT 1,
    paused INTEGER NOT NULL DEFAULT 1,
    pause_reason TEXT NOT NULL DEFAULT 'not_authorized',
    per_minute INTEGER NOT NULL DEFAULT 50,
    daily_cap INTEGER NOT NULL DEFAULT 500,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    job_key TEXT NOT NULL UNIQUE,
    job_fingerprint TEXT NOT NULL,
    account_id TEXT,
    name TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    html_body TEXT NOT NULL DEFAULT '',
    rate_per_minute INTEGER NOT NULL,
    start_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS recipients (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    vars_json TEXT NOT NULL DEFAULT '{}',
    subject TEXT,
    body TEXT,
    html_body TEXT,
    cc TEXT NOT NULL DEFAULT '',
    bcc TEXT NOT NULL DEFAULT '',
    units INTEGER NOT NULL DEFAULT 1,
    message_id_header TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    next_attempt_at TEXT,
    needs_reconcile INTEGER NOT NULL DEFAULT 0,
    reconciled INTEGER NOT NULL DEFAULT 0,
    sent_at TEXT,
    drafted_at TEXT,
    draft_id TEXT NOT NULL DEFAULT '',
    gmail_message_id TEXT NOT NULL DEFAULT '',
    gmail_thread_id TEXT NOT NULL DEFAULT '',
    last_action_at TEXT,
    FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS suppression (
    id TEXT PRIMARY KEY,
    account_id TEXT,
    type TEXT NOT NULL,
    value TEXT NOT NULL COLLATE NOCASE,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    account_id TEXT,
    campaign_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS send_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    account_id TEXT,
    campaign_id TEXT,
    recipient_id TEXT,
    email TEXT NOT NULL DEFAULT '',
    units INTEGER NOT NULL DEFAULT 1,
    reconciled INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_campaign_status_account
    ON campaigns(status, account_id, start_at);
  CREATE INDEX IF NOT EXISTS idx_recipient_queue
    ON recipients(campaign_id, state, next_attempt_at);
  CREATE INDEX IF NOT EXISTS idx_recipient_state
    ON recipients(state);
  CREATE INDEX IF NOT EXISTS idx_send_account_at
    ON send_events(account_id, at);
  CREATE INDEX IF NOT EXISTS idx_audit_at
    ON audit(at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_suppression_unique
    ON suppression(COALESCE(account_id, ''), type, value);
`);

const stmt = {
  getMeta: db.prepare("SELECT value FROM meta WHERE key=?"),
  putMeta: db.prepare(`
    INSERT INTO meta(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `),
  getSetting: db.prepare("SELECT value_json FROM settings WHERE key=?"),
  putSetting: db.prepare(`
    INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
  `),
  accountByRef: db.prepare(`
    SELECT * FROM accounts
    WHERE id=? OR alias=? COLLATE NOCASE OR email=? COLLATE NOCASE OR expected_email=? COLLATE NOCASE
    LIMIT 1
  `),
  accountByAlias: db.prepare("SELECT * FROM accounts WHERE alias=? COLLATE NOCASE LIMIT 1"),
  insertAccount: db.prepare(`
    INSERT INTO accounts(
      id,alias,label,expected_email,email,enabled,paused,pause_reason,
      per_minute,daily_cap,created_at,updated_at
    ) VALUES(?,?,?,?,NULL,1,1,'not_authorized',?,?,?,?)
  `),
  updateAccountProfile: db.prepare(`
    UPDATE accounts SET email=?, paused=1, pause_reason='startup', updated_at=? WHERE id=?
  `),
  setAccountPause: db.prepare(`
    UPDATE accounts SET paused=?, pause_reason=?, updated_at=? WHERE id=?
  `),
  accountCount: db.prepare("SELECT COUNT(*) AS count FROM accounts"),
  listAccounts: db.prepare("SELECT * FROM accounts ORDER BY created_at ASC"),
  insertCampaign: db.prepare(`
    INSERT INTO campaigns(
      id,job_key,job_fingerprint,account_id,name,mode,status,subject,body,html_body,
      rate_per_minute,start_at,created_at,updated_at,completed_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `),
  insertRecipient: db.prepare(`
    INSERT INTO recipients(
      id,campaign_id,email,name,vars_json,subject,body,html_body,cc,bcc,units,
      message_id_header,state,attempts,last_error,created_at,updated_at,next_attempt_at,
      needs_reconcile,reconciled,sent_at,drafted_at,draft_id,gmail_message_id,
      gmail_thread_id,last_action_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `),
  campaignByRef: db.prepare(`
    SELECT c.*, a.alias AS account_alias, a.email AS account_email
    FROM campaigns c
    LEFT JOIN accounts a ON a.id=c.account_id
    WHERE c.id=? OR c.job_key=?
    LIMIT 1
  `),
  campaignByJobKey: db.prepare(`
    SELECT c.*, a.alias AS account_alias, a.email AS account_email
    FROM campaigns c
    LEFT JOIN accounts a ON a.id=c.account_id
    WHERE c.job_key=? LIMIT 1
  `),
  campaignRecipients: db.prepare("SELECT * FROM recipients WHERE campaign_id=? ORDER BY created_at,id"),
  campaignCounts: db.prepare(`
    SELECT state, COUNT(*) AS count
    FROM recipients WHERE campaign_id=?
    GROUP BY state
  `),
  runningCampaigns: db.prepare(`
    SELECT c.*, a.alias AS account_alias, a.email AS account_email
    FROM campaigns c
    LEFT JOIN accounts a ON a.id=c.account_id
    WHERE c.status='running'
    ORDER BY c.created_at ASC
  `),
  allCampaigns: db.prepare(`
    SELECT c.*, a.alias AS account_alias, a.email AS account_email
    FROM campaigns c
    LEFT JOIN accounts a ON a.id=c.account_id
    ORDER BY c.created_at DESC
  `),
  bindCampaignAccount: db.prepare("UPDATE campaigns SET account_id=?,updated_at=? WHERE id=?"),
  setCampaignStatus: db.prepare("UPDATE campaigns SET status=?,updated_at=? WHERE id=?"),
  completeCampaign: db.prepare(`
    UPDATE campaigns SET status='completed',completed_at=?,updated_at=? WHERE id=?
  `),
  cancelRecipients: db.prepare(`
    UPDATE recipients SET state='cancelled',next_attempt_at=NULL,updated_at=?
    WHERE campaign_id=? AND state IN ('queued','retry')
  `),
  retryFailed: db.prepare(`
    UPDATE recipients SET state='retry',attempts=0,last_error='',next_attempt_at=NULL,
      needs_reconcile=1,updated_at=?
    WHERE campaign_id=? AND state='failed'
  `),
  nextRecipient: db.prepare(`
    SELECT * FROM recipients
    WHERE campaign_id=?
      AND (
        state='queued'
        OR (state='retry' AND (next_attempt_at IS NULL OR next_attempt_at<=?))
      )
    ORDER BY created_at,id
    LIMIT 1
  `),
  claimRecipient: db.prepare(`
    UPDATE recipients SET state='sending',attempts=attempts+1,last_action_at=?,updated_at=?
    WHERE id=? AND state IN ('queued','retry')
  `),
  recipientById: db.prepare("SELECT * FROM recipients WHERE id=? LIMIT 1"),
  pendingCount: db.prepare(`
    SELECT COUNT(*) AS count FROM recipients
    WHERE campaign_id=? AND state IN ('queued','retry','sending')
  `),
  markSuppressed: db.prepare(`
    UPDATE recipients SET state='suppressed',last_error=?,next_attempt_at=NULL,updated_at=?
    WHERE id=?
  `),
  suppressionMatch: db.prepare(`
    SELECT * FROM suppression
    WHERE (account_id IS NULL OR account_id=?)
      AND (
        (type='email' AND value=? COLLATE NOCASE)
        OR (type='domain' AND value=? COLLATE NOCASE)
      )
    ORDER BY account_id IS NOT NULL DESC
    LIMIT 1
  `),
  insertSuppression: db.prepare(`
    INSERT INTO suppression(id,account_id,type,value,reason,created_at)
    VALUES(?,?,?,?,?,?)
  `),
  listSuppression: db.prepare("SELECT * FROM suppression ORDER BY created_at DESC"),
  deleteSuppression: db.prepare("DELETE FROM suppression WHERE id=?"),
  insertAudit: db.prepare(`
    INSERT INTO audit(at,type,account_id,campaign_id,detail_json) VALUES(?,?,?,?,?)
  `),
  insertSendEvent: db.prepare(`
    INSERT INTO send_events(at,kind,account_id,campaign_id,recipient_id,email,units,reconciled)
    VALUES(?,?,?,?,?,?,?,?)
  `),
  sentUnitsSince: db.prepare(`
    SELECT COALESCE(SUM(units),0) AS units FROM send_events
    WHERE account_id=? AND kind='send' AND at>=?
  `),
  sendActionsSince: db.prepare(`
    SELECT COUNT(*) AS count FROM send_events
    WHERE account_id=? AND at>=?
  `),
  markSuccess: db.prepare(`
    UPDATE recipients SET
      state=?,
      updated_at=?,
      last_action_at=?,
      last_error='',
      next_attempt_at=NULL,
      needs_reconcile=0,
      reconciled=?,
      sent_at=COALESCE(sent_at,?),
      drafted_at=COALESCE(drafted_at,?),
      draft_id=CASE WHEN ?<>'' THEN ? ELSE draft_id END,
      gmail_message_id=CASE WHEN ?<>'' THEN ? ELSE gmail_message_id END,
      gmail_thread_id=CASE WHEN ?<>'' THEN ? ELSE gmail_thread_id END
    WHERE id=?
  `),
  markFailure: db.prepare(`
    UPDATE recipients SET state=?,last_error=?,updated_at=?,next_attempt_at=?,needs_reconcile=? WHERE id=?
  `),
  recoverSending: db.prepare(`
    UPDATE recipients SET state='retry',next_attempt_at=?,last_error=?,
      updated_at=?,needs_reconcile=1
    WHERE state='sending'
  `),
  exceptions: db.prepare(`
    SELECT id,email,state,attempts,last_error FROM recipients
    WHERE campaign_id=? AND state IN ('failed','invalid','suppressed')
    ORDER BY updated_at DESC
  `),
};

function json(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function setMeta(key, value) {
  stmt.putMeta.run(key, String(value));
}

function getMeta(key) {
  return stmt.getMeta.get(key)?.value ?? null;
}

function readSettingsRaw() {
  const rows = db.prepare("SELECT key,value_json FROM settings").all();
  const result = {};
  for (const row of rows) result[row.key] = json(row.value_json, row.value_json);
  return result;
}

export function getSettings() {
  return {
    ...DEFAULT_SETTINGS,
    ...readSettingsRaw(),
    maxRecipientsPerJob: 500,
    maxAccounts: 4,
  };
}

export async function setSettings(patch) {
  const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
  const merged = { ...getSettings(), ...patch, maxRecipientsPerJob: 500, maxAccounts: 4 };
  const at = nowIso();

  tx(() => {
    for (const [key, value] of Object.entries(merged)) {
      if (!allowed.has(key)) continue;
      stmt.putSetting.run(key, JSON.stringify(value), at);
    }
  });
  return merged;
}

function insertLegacyCampaign(campaign) {
  stmt.insertCampaign.run(
    campaign.id,
    campaign.jobKey || campaign.id,
    campaign.jobFingerprint || "",
    campaign.accountId || null,
    campaign.name || "Migrated job",
    campaign.mode === "send" ? "send" : "draft",
    campaign.status || "ready",
    campaign.subject || "",
    campaign.body || "",
    campaign.htmlBody || "",
    Number(campaign.ratePerMinute || DEFAULT_SETTINGS.defaultPerMinute),
    campaign.startAt || null,
    campaign.createdAt || nowIso(),
    campaign.updatedAt || nowIso(),
    campaign.completedAt || null,
  );

  for (const recipient of campaign.recipients || []) {
    stmt.insertRecipient.run(
      recipient.id,
      campaign.id,
      recipient.email || "",
      recipient.name || "",
      JSON.stringify(recipient.vars || {}),
      recipient.subject ?? null,
      recipient.body ?? null,
      recipient.htmlBody ?? null,
      recipient.cc || "",
      recipient.bcc || "",
      Number(recipient.units || 1),
      recipient.messageIdHeader || "",
      recipient.state || "queued",
      Number(recipient.attempts || 0),
      recipient.lastError || "",
      recipient.createdAt || campaign.createdAt || nowIso(),
      recipient.updatedAt || nowIso(),
      recipient.nextAttemptAt || null,
      recipient.needsReconcile ? 1 : 0,
      recipient.reconciled ? 1 : 0,
      recipient.sentAt || null,
      recipient.draftedAt || null,
      recipient.draftId || "",
      recipient.gmailMessageId || "",
      recipient.gmailThreadId || "",
      recipient.lastActionAt || null,
    );
  }
}

function migrateLegacyBlobIfNeeded() {
  const version = Number(getMeta("schema_version") || 0);
  if (version >= 3) return;

  const hasLegacy = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='state_store'
  `).get();

  if (hasLegacy) {
    const row = db.prepare("SELECT value FROM state_store WHERE key='state'").get();
    if (row?.value) {
      const legacy = json(row.value, null);
      if (legacy) {
        tx(() => {
          const settings = {
            ...DEFAULT_SETTINGS,
            masterPaused: true,
            pauseReason: "startup",
          };
          for (const [key, value] of Object.entries(settings)) {
            stmt.putSetting.run(key, JSON.stringify(value), nowIso());
          }

          for (const campaign of legacy.campaigns || []) {
            const exists = stmt.campaignByJobKey.get(campaign.jobKey || campaign.id);
            if (!exists) insertLegacyCampaign(campaign);
          }

          for (const item of legacy.suppression || []) {
            try {
              stmt.insertSuppression.run(
                item.id || "sup_migrated_" + Math.random().toString(16).slice(2),
                null,
                item.type || "email",
                item.value || "",
                item.reason || "",
                item.createdAt || nowIso(),
              );
            } catch {}
          }

          for (const item of legacy.audit || []) {
            stmt.insertAudit.run(
              item.at || nowIso(),
              item.type || "legacy",
              null,
              item.detail?.campaignId || null,
              JSON.stringify(item.detail || {}),
            );
          }

          for (const item of legacy.sendEvents || []) {
            const event = typeof item === "string" ? { at: item, kind: "send" } : item;
            stmt.insertSendEvent.run(
              event.at || nowIso(),
              event.kind || "send",
              null,
              event.campaignId || null,
              event.recipientId || null,
              event.email || "",
              Number(event.units || 1),
              event.reconciled ? 1 : 0,
            );
          }
        });
      }
    }
  }

  const at = nowIso();
  tx(() => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      stmt.putSetting.run(key, JSON.stringify(value), at);
    }
    setMeta("schema_version", "3");
  });
}

migrateLegacyBlobIfNeeded();

export function storeHealth() {
  try {
    const result = db.prepare("PRAGMA quick_check").get();
    const value = result ? Object.values(result)[0] : "unknown";
    return {
      ok: value === "ok",
      sqlite: String(value),
      path: dbPath,
      schemaVersion: Number(getMeta("schema_version") || 0),
    };
  } catch (error) {
    return { ok: false, sqlite: error.message, path: dbPath, schemaVersion: 0 };
  }
}

export async function backupStore(destination = "") {
  const target = destination
    ? path.resolve(destination)
    : path.join(dataDir, "backups", "state-" + new Date().toISOString().replace(/[:.]/g, "-") + ".sqlite3");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await backup(db, target);
  return target;
}

export async function audit(type, detail = {}, accountId = null, campaignId = null) {
  stmt.insertAudit.run(
    nowIso(),
    type,
    accountId,
    campaignId || detail?.campaignId || null,
    JSON.stringify(detail || {}),
  );

  const count = Number(db.prepare("SELECT COUNT(*) AS count FROM audit").get()?.count || 0);
  if (count > 5500) {
    db.exec(`
      DELETE FROM audit
      WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 5000)
    `);
  }
}

export function listAudit(limit = 200) {
  const safe = Math.max(1, Math.min(1000, Number(limit || 200)));
  return db.prepare(`
    SELECT id,at,type,account_id,campaign_id,detail_json
    FROM audit ORDER BY id DESC LIMIT ?
  `).all(safe).map((row) => ({
    id: row.id,
    at: row.at,
    type: row.type,
    accountId: row.account_id,
    campaignId: row.campaign_id,
    detail: json(row.detail_json, {}),
  }));
}

export function listAccounts() {
  return stmt.listAccounts.all().map(mapAccount);
}

function mapAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    alias: row.alias,
    label: row.label,
    expectedEmail: row.expected_email,
    email: row.email || "",
    enabled: Boolean(row.enabled),
    paused: Boolean(row.paused),
    pauseReason: row.pause_reason || "",
    perMinute: Number(row.per_minute),
    dailyCap: Number(row.daily_cap),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAccount(ref) {
  const value = String(ref || "").trim();
  if (!value) return null;
  return mapAccount(stmt.accountByRef.get(value, value, value, value));
}

export function createAccount({ id, alias, label = "", expectedEmail = "" }) {
  const settings = getSettings();
  const existing = stmt.accountByAlias.get(alias);
  if (existing) return { created: false, account: mapAccount(existing) };

  const count = Number(stmt.accountCount.get()?.count || 0);
  if (count >= settings.maxAccounts) {
    const error = new Error("Maximum of " + settings.maxAccounts + " Gmail profiles reached.");
    error.code = "MAX_ACCOUNTS";
    throw error;
  }

  const at = nowIso();
  stmt.insertAccount.run(
    id,
    alias,
    label,
    expectedEmail,
    settings.defaultPerMinute,
    settings.defaultDailyCap,
    at,
    at,
  );
  return { created: true, account: getAccount(id) };
}

export function updateAccountProfile(accountId, email) {
  stmt.updateAccountProfile.run(email, nowIso(), accountId);
  return getAccount(accountId);
}

export function setAccountPause(accountId, paused, reason = "") {
  stmt.setAccountPause.run(paused ? 1 : 0, reason, nowIso(), accountId);
  return getAccount(accountId);
}

export function configureAccount(accountId, { perMinute, dailyCap, enabled } = {}) {
  const account = getAccount(accountId);
  if (!account) return null;

  const settings = getSettings();
  const nextPerMinute = Math.max(1, Math.min(50, Number(perMinute ?? account.perMinute)));
  const nextDailyCap = Math.max(1, Math.min(500, Number(dailyCap ?? account.dailyCap)));
  const nextEnabled = enabled == null ? account.enabled : Boolean(enabled);

  db.prepare(`
    UPDATE accounts SET per_minute=?,daily_cap=?,enabled=?,updated_at=? WHERE id=?
  `).run(nextPerMinute, nextDailyCap, nextEnabled ? 1 : 0, nowIso(), account.id);
  return getAccount(account.id);
}

function rowToCampaign(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobKey: row.job_key,
    jobFingerprint: row.job_fingerprint,
    accountId: row.account_id,
    accountAlias: row.account_alias || "",
    accountEmail: row.account_email || "",
    name: row.name,
    mode: row.mode,
    status: row.status,
    subject: row.subject,
    body: row.body,
    htmlBody: row.html_body,
    ratePerMinute: Number(row.rate_per_minute),
    startAt: row.start_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function rowToRecipient(row) {
  if (!row) return null;
  return {
    id: row.id,
    campaignId: row.campaign_id,
    email: row.email,
    name: row.name,
    vars: json(row.vars_json, {}),
    subject: row.subject,
    body: row.body,
    htmlBody: row.html_body,
    cc: row.cc,
    bcc: row.bcc,
    units: Number(row.units),
    messageIdHeader: row.message_id_header,
    state: row.state,
    attempts: Number(row.attempts),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextAttemptAt: row.next_attempt_at,
    needsReconcile: Boolean(row.needs_reconcile),
    reconciled: Boolean(row.reconciled),
    sentAt: row.sent_at,
    draftedAt: row.drafted_at,
    draftId: row.draft_id,
    gmailMessageId: row.gmail_message_id,
    gmailThreadId: row.gmail_thread_id,
    lastActionAt: row.last_action_at,
  };
}

export function campaignSummary(campaignOrRef) {
  const campaign = typeof campaignOrRef === "string"
    ? getCampaign(campaignOrRef, false)
    : campaignOrRef;
  if (!campaign) return null;

  const counts = {};
  for (const row of stmt.campaignCounts.all(campaign.id)) {
    counts[row.state] = Number(row.count);
  }

  const units = Number(db.prepare(`
    SELECT COALESCE(SUM(units),0) AS units FROM recipients WHERE campaign_id=?
  `).get(campaign.id)?.units || 0);

  const total = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM recipients WHERE campaign_id=?
  `).get(campaign.id)?.count || 0);

  return {
    id: campaign.id,
    jobKey: campaign.jobKey,
    accountId: campaign.accountId,
    accountAlias: campaign.accountAlias,
    accountEmail: campaign.accountEmail,
    name: campaign.name,
    mode: campaign.mode,
    status: campaign.status,
    total,
    recipientUnits: units,
    counts,
    ratePerMinute: campaign.ratePerMinute,
    startAt: campaign.startAt,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    completedAt: campaign.completedAt,
  };
}

export function getCampaign(ref, includeRecipients = true) {
  const value = String(ref || "");
  const base = rowToCampaign(stmt.campaignByRef.get(value, value));
  if (!base) return null;
  if (includeRecipients) {
    base.recipients = stmt.campaignRecipients.all(base.id).map(rowToRecipient);
  }
  return base;
}

export function findCampaignByJobKey(jobKey) {
  return rowToCampaign(stmt.campaignByJobKey.get(String(jobKey || "")));
}

export function listRunningCampaigns() {
  return stmt.runningCampaigns.all().map(rowToCampaign);
}

export function listCampaigns() {
  return stmt.allCampaigns.all().map(rowToCampaign);
}

export function getCampaignCount() {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM campaigns").get()?.count || 0);
}

export function getQueueStats() {
  const rows = db.prepare(`
    SELECT state, COUNT(*) AS count FROM recipients GROUP BY state
  `).all();
  const counts = {};
  for (const row of rows) counts[row.state] = Number(row.count);
  return {
    counts,
    pending: (counts.queued || 0) + (counts.retry || 0) + (counts.sending || 0),
    failed: counts.failed || 0,
  };
}

export function insertCampaign(campaign) {
  tx(() => {
    stmt.insertCampaign.run(
      campaign.id,
      campaign.jobKey,
      campaign.jobFingerprint,
      campaign.accountId || null,
      campaign.name,
      campaign.mode,
      campaign.status,
      campaign.subject || "",
      campaign.body || "",
      campaign.htmlBody || "",
      campaign.ratePerMinute,
      campaign.startAt || null,
      campaign.createdAt,
      campaign.updatedAt,
      campaign.completedAt || null,
    );

    for (const recipient of campaign.recipients || []) {
      stmt.insertRecipient.run(
        recipient.id,
        campaign.id,
        recipient.email,
        recipient.name || "",
        JSON.stringify(recipient.vars || {}),
        recipient.subject ?? null,
        recipient.body ?? null,
        recipient.htmlBody ?? null,
        recipient.cc || "",
        recipient.bcc || "",
        Number(recipient.units || 1),
        recipient.messageIdHeader || "",
        recipient.state,
        Number(recipient.attempts || 0),
        recipient.lastError || "",
        recipient.createdAt,
        recipient.updatedAt,
        recipient.nextAttemptAt || null,
        recipient.needsReconcile ? 1 : 0,
        recipient.reconciled ? 1 : 0,
        recipient.sentAt || null,
        recipient.draftedAt || null,
        recipient.draftId || "",
        recipient.gmailMessageId || "",
        recipient.gmailThreadId || "",
        recipient.lastActionAt || null,
      );
    }
  });
  return getCampaign(campaign.id, false);
}

export function bindCampaignAccount(campaignRef, accountRef) {
  const campaign = getCampaign(campaignRef, false);
  const account = getAccount(accountRef);
  if (!campaign || !account) return null;
  stmt.bindCampaignAccount.run(account.id, nowIso(), campaign.id);
  return getCampaign(campaign.id, false);
}

export function configureCampaign(campaignRef, { ratePerMinute } = {}) {
  const campaign = getCampaign(campaignRef, false);
  if (!campaign) return null;
  const account = campaign.accountId ? getAccount(campaign.accountId) : null;
  const ceiling = Math.max(1, Math.min(50, Number(account?.perMinute || 50)));
  const requested = Number.parseInt(ratePerMinute, 10);
  const nextRate = Number.isFinite(requested)
    ? Math.max(1, Math.min(ceiling, requested))
    : Math.min(ceiling, campaign.ratePerMinute || ceiling);

  db.prepare("UPDATE campaigns SET rate_per_minute=?,updated_at=? WHERE id=?")
    .run(nextRate, nowIso(), campaign.id);
  return getCampaign(campaign.id, false);
}

export function applyCampaignAction(campaignRef, action) {
  const campaign = getCampaign(campaignRef, false);
  if (!campaign) return null;
  const at = nowIso();

  if (action === "start" || action === "resume") {
    stmt.setCampaignStatus.run("running", at, campaign.id);
  } else if (action === "pause") {
    stmt.setCampaignStatus.run("paused", at, campaign.id);
  } else if (action === "cancel") {
    tx(() => {
      stmt.setCampaignStatus.run("cancelled", at, campaign.id);
      stmt.cancelRecipients.run(at, campaign.id);
    });
  } else if (action === "retry-failed") {
    tx(() => {
      stmt.retryFailed.run(at, campaign.id);
      stmt.setCampaignStatus.run("paused", at, campaign.id);
    });
  }
  return getCampaign(campaign.id, false);
}

export function claimRecipient(campaignId) {
  const now = nowIso();
  return tx(() => {
    while (true) {
      const row = stmt.nextRecipient.get(campaignId, now);
      if (!row) return null;

      const campaign = getCampaign(campaignId, false);
      if (!campaign?.accountId) return null;

      const email = String(row.email || "").toLowerCase();
      const domain = email.split("@")[1] || "";
      const suppression = stmt.suppressionMatch.get(campaign.accountId, email, domain);
      if (suppression) {
        stmt.markSuppressed.run(
          "Suppressed: " + (suppression.reason || suppression.value),
          now,
          row.id,
        );
        continue;
      }

      const result = stmt.claimRecipient.run(now, now, row.id);
      if (Number(result.changes || 0) !== 1) continue;

      return {
        campaign: getCampaign(campaignId, false),
        recipient: rowToRecipient(stmt.recipientById.get(row.id)),
      };
    }
  });
}

export function getSentUnitsToday(accountId) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return Number(stmt.sentUnitsSince.get(accountId, start.toISOString())?.units || 0);
}

export function getRecentSendActions(accountId, sinceIso) {
  return Number(stmt.sendActionsSince.get(accountId, sinceIso)?.count || 0);
}

export function recordSendEvent({
  accountId,
  kind = "send",
  campaignId = null,
  recipientId = null,
  email = "",
  units = 1,
  reconciled = false,
}) {
  stmt.insertSendEvent.run(
    nowIso(),
    kind,
    accountId || null,
    campaignId,
    recipientId,
    email,
    Math.max(1, Number(units || 1)),
    reconciled ? 1 : 0,
  );
}

export function markRecipientSuccess({
  campaignId,
  recipientId,
  accountId,
  mode,
  result,
  reconciled = false,
}) {
  const at = nowIso();
  const sentAt = mode === "send" ? at : null;
  const draftedAt = mode === "draft" ? at : null;
  const draftId = result?.draftId || "";
  const messageId = result?.messageId || result?.id || "";
  const threadId = result?.threadId || "";

  tx(() => {
    stmt.markSuccess.run(
      mode === "send" ? "sent" : "drafted",
      at,
      at,
      reconciled ? 1 : 0,
      sentAt,
      draftedAt,
      draftId,
      draftId,
      messageId,
      messageId,
      threadId,
      threadId,
      recipientId,
    );
    stmt.insertSendEvent.run(
      at,
      mode,
      accountId,
      campaignId,
      recipientId,
      stmt.recipientById.get(recipientId)?.email || "",
      Number(stmt.recipientById.get(recipientId)?.units || 1),
      reconciled ? 1 : 0,
    );
  });

  finalizeCampaign(campaignId);
}

export function markRecipientFailure(recipientId, {
  state,
  error,
  nextAttemptAt = null,
  needsReconcile = true,
}) {
  stmt.markFailure.run(
    state,
    String(error || ""),
    nowIso(),
    nextAttemptAt,
    needsReconcile ? 1 : 0,
    recipientId,
  );
}

export function finalizeCampaign(campaignId) {
  const pending = Number(stmt.pendingCount.get(campaignId)?.count || 0);
  if (pending === 0) {
    const campaign = getCampaign(campaignId, false);
    if (campaign?.status === "running") {
      stmt.completeCampaign.run(nowIso(), nowIso(), campaignId);
    }
  }
}

export function getCampaignExceptions(campaignId) {
  return stmt.exceptions.all(campaignId).map((row) => ({
    id: row.id,
    email: row.email,
    state: row.state,
    attempts: Number(row.attempts),
    error: row.last_error,
  }));
}

export function recoverInterruptedRecipients() {
  const at = nowIso();
  const result = stmt.recoverSending.run(
    at,
    "Recovered after service restart; reconciling before retry.",
    at,
  );
  return Number(result.changes || 0);
}

export function addSuppression({ id, accountId = null, type, value, reason = "", createdAt = nowIso() }) {
  try {
    stmt.insertSuppression.run(id, accountId, type, value, reason, createdAt);
    return { created: true };
  } catch (error) {
    if (String(error.message).toLowerCase().includes("unique")) return { created: false };
    throw error;
  }
}

export function listSuppression() {
  return stmt.listSuppression.all().map((row) => ({
    id: row.id,
    accountId: row.account_id,
    type: row.type,
    value: row.value,
    reason: row.reason,
    createdAt: row.created_at,
  }));
}

export function removeSuppression(id) {
  stmt.deleteSuppression.run(id);
}

export function exportState() {
  return {
    version: 3,
    exportedAt: nowIso(),
    settings: getSettings(),
    accounts: listAccounts(),
    campaigns: listCampaigns().map((campaign) => ({
      ...campaign,
      recipients: stmt.campaignRecipients.all(campaign.id).map(rowToRecipient),
    })),
    suppression: listSuppression(),
    audit: listAudit(1000),
    sendEvents: db.prepare("SELECT * FROM send_events ORDER BY id DESC LIMIT 5000").all(),
  };
}

export function closeStore() {
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
  try { db.close(); } catch {}
}
