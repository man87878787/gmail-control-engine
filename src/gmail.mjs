import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import {
  decodeBase64Url,
  encodeBase64Url,
  normalizeEmail,
  publicError,
  sanitizeHeader,
} from "./utils.mjs";
import { withRetry } from "./retry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = process.env.GMAIL_CONTROL_DATA_DIR
  ? path.resolve(process.env.GMAIL_CONTROL_DATA_DIR)
  : path.join(root, "data");
const clientPath = path.join(dataDir, "google-oauth-client.json");
const statesPath = path.join(dataDir, "oauth-states.json");
const defaultRedirect = process.env.GOOGLE_REDIRECT_URI || "http://127.0.0.1:4317/oauth/callback";
const scopes = ["https://www.googleapis.com/auth/gmail.modify"];
const authCache = new Map();
const gmailCache = new Map();

fs.mkdirSync(dataDir, { recursive: true });

function safeAccountId(accountId) {
  const value = String(accountId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!value) throw new Error("Valid account id is required.");
  return value;
}

function tokenPath(accountId) {
  return path.join(dataDir, "oauth-token-" + safeAccountId(accountId) + ".json");
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function privateWriteJson(file, value) {
  const temp = file + "." + process.pid + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function normalizeClientJson(input) {
  const source = input?.installed || input?.web || input;
  if (!source?.client_id || !source?.client_secret) {
    throw new Error("OAuth JSON must contain client_id and client_secret.");
  }
  return {
    client_id: String(source.client_id),
    client_secret: String(source.client_secret),
    redirect_uri: defaultRedirect,
    project_id: source.project_id || input?.project_id || "",
  };
}

export function saveClientJson(input) {
  const normalized = normalizeClientJson(input);
  privateWriteJson(clientPath, normalized);
  authCache.clear();
  gmailCache.clear();
  return {
    configured: true,
    projectId: normalized.project_id,
    redirectUri: normalized.redirect_uri,
  };
}

function clientConfig() {
  const file = readJson(clientPath);
  if (file?.client_id && file?.client_secret) return file;

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return {
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: defaultRedirect,
      project_id: "",
    };
  }
  return null;
}

function readToken(accountId) {
  return readJson(tokenPath(accountId));
}

function makeOauth(accountId, useStoredToken = true) {
  const safeId = safeAccountId(accountId);
  if (useStoredToken && authCache.has(safeId)) return authCache.get(safeId);

  const config = clientConfig();
  if (!config) throw new Error("Google OAuth client is not configured.");

  const auth = new google.auth.OAuth2(
    config.client_id,
    config.client_secret,
    config.redirect_uri || defaultRedirect,
  );

  if (useStoredToken) {
    const saved = readToken(safeId);
    if (saved) auth.setCredentials(saved);
  }

  auth.on("tokens", (fresh) => {
    const current = readToken(safeId) || {};
    privateWriteJson(tokenPath(safeId), {
      ...current,
      ...fresh,
      refresh_token: fresh.refresh_token || current.refresh_token,
    });
  });

  if (useStoredToken) authCache.set(safeId, auth);
  return auth;
}

function oauthStates() {
  const current = readJson(statesPath, {});
  const cutoff = Date.now() - 10 * 60 * 1000;
  const clean = {};
  for (const [key, entry] of Object.entries(current || {})) {
    if (Number(entry?.createdAt || 0) >= cutoff) clean[key] = entry;
  }
  return clean;
}

function saveOauthStates(states) {
  privateWriteJson(statesPath, states);
}

export function clientStatus() {
  const config = clientConfig();
  return {
    configured: Boolean(config),
    redirectUri: config?.redirect_uri || defaultRedirect,
    projectId: config?.project_id || "",
  };
}

export function oauthStatus(accountId) {
  const client = clientStatus();
  const saved = accountId ? readToken(accountId) : null;
  return {
    ...client,
    accountId: accountId || null,
    authorized: Boolean(saved?.access_token || saved?.refresh_token),
  };
}

export function authorizationUrl({ accountId, expectedEmail = "" }) {
  const safeId = safeAccountId(accountId);
  const auth = makeOauth(safeId, false);
  const state = crypto.randomBytes(24).toString("hex");
  const states = oauthStates();
  states[state] = {
    accountId: safeId,
    expectedEmail: normalizeEmail(expectedEmail),
    createdAt: Date.now(),
  };
  saveOauthStates(states);

  return auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account",
    scope: scopes,
    include_granted_scopes: true,
    state,
    ...(expectedEmail ? { login_hint: expectedEmail } : {}),
  });
}

async function profileWithAuth(auth) {
  const gmail = google.gmail({ version: "v1", auth });
  const { data } = await gmail.users.getProfile({ userId: "me" });
  return {
    emailAddress: data.emailAddress || "",
    messagesTotal: data.messagesTotal || 0,
    threadsTotal: data.threadsTotal || 0,
    historyId: data.historyId || "",
  };
}

export async function exchangeCode(code, returnedState) {
  const states = oauthStates();
  const pending = states[String(returnedState || "")];
  if (!pending) throw new Error("OAuth state check failed or expired.");

  delete states[String(returnedState)];
  saveOauthStates(states);

  const accountId = safeAccountId(pending.accountId);
  const auth = makeOauth(accountId, false);
  const { tokens } = await auth.getToken(code);
  auth.setCredentials(tokens);

  const profile = await profileWithAuth(auth);
  const actual = normalizeEmail(profile.emailAddress);
  const expected = normalizeEmail(pending.expectedEmail);

  if (expected && actual !== expected) {
    throw new Error(
      "Wrong Google account authorized. Expected " + expected + " but Google returned " + actual + ".",
    );
  }

  privateWriteJson(tokenPath(accountId), tokens);
  authCache.set(accountId, auth);
  gmailCache.delete(accountId);
  return { accountId, profile };
}

export function disconnectOauth(accountId) {
  const safeId = safeAccountId(accountId);
  authCache.delete(safeId);
  gmailCache.delete(safeId);
  try { fs.rmSync(tokenPath(safeId), { force: true }); } catch {}
}

async function api(accountId) {
  const safeId = safeAccountId(accountId);
  if (gmailCache.has(safeId)) return gmailCache.get(safeId);

  const status = oauthStatus(safeId);
  if (!status.authorized) throw new Error("Google account is not authorized: " + safeId);

  const auth = makeOauth(safeId, true);
  const gmail = google.gmail({ version: "v1", auth });
  gmailCache.set(safeId, gmail);
  return gmail;
}

export async function accountProfile(accountId) {
  const gmail = await api(accountId);
  const { data } = await gmail.users.getProfile({ userId: "me" });
  return {
    emailAddress: data.emailAddress || "",
    messagesTotal: data.messagesTotal || 0,
    threadsTotal: data.threadsTotal || 0,
    historyId: data.historyId || "",
  };
}

function encodedSubject(subject) {
  return "=?UTF-8?B?" + Buffer.from(sanitizeHeader(subject), "utf8").toString("base64") + "?=";
}

function buildRawMessage({
  to,
  cc = "",
  bcc = "",
  subject,
  text = "",
  html = "",
  inReplyTo = "",
  references = "",
  messageIdHeader = "",
}) {
  const headers = [
    "To: " + sanitizeHeader(to),
    ...(cc ? ["Cc: " + sanitizeHeader(cc)] : []),
    ...(bcc ? ["Bcc: " + sanitizeHeader(bcc)] : []),
    "Subject: " + encodedSubject(subject),
    ...(messageIdHeader ? ["Message-ID: " + sanitizeHeader(messageIdHeader)] : []),
    "X-Gmail-Control: 1",
    "MIME-Version: 1.0",
  ];

  if (inReplyTo) headers.push("In-Reply-To: " + sanitizeHeader(inReplyTo));
  if (references) headers.push("References: " + sanitizeHeader(references));

  if (!html) {
    return encodeBase64Url([
      ...headers,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      text || "",
      "",
    ].join("\r\n"));
  }

  const boundary = "gmail-control-" + crypto.randomBytes(12).toString("hex");
  return encodeBase64Url([
    ...headers,
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    "",
    "--" + boundary,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    text || "",
    "--" + boundary,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    "--" + boundary + "--",
    "",
  ].join("\r\n"));
}

export async function sendMessage(accountId, message) {
  const gmail = await api(accountId);
  const { data } = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: buildRawMessage(message),
      ...(message.threadId ? { threadId: message.threadId } : {}),
    },
  });
  return {
    id: data.id || "",
    threadId: data.threadId || "",
    labelIds: data.labelIds || [],
  };
}

export async function createDraft(accountId, message) {
  const gmail = await api(accountId);
  const { data } = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: {
        raw: buildRawMessage(message),
        ...(message.threadId ? { threadId: message.threadId } : {}),
      },
    },
  });
  return {
    draftId: data.id || "",
    messageId: data.message?.id || "",
    threadId: data.message?.threadId || "",
  };
}

export async function findMessageByRfcMessageId(accountId, messageIdHeader, mode = "send") {
  if (!messageIdHeader) return null;
  const gmail = await api(accountId);
  const clean = String(messageIdHeader).replace(/[<>]/g, "");
  const scope = mode === "draft" ? "in:drafts" : "in:sent";
  const { data } = await gmail.users.messages.list({
    userId: "me",
    q: scope + " rfc822msgid:" + clean,
    maxResults: 2,
  });
  const found = data.messages?.[0];
  if (!found?.id) return null;

  const { data: message } = await gmail.users.messages.get({
    userId: "me",
    id: found.id,
    format: "metadata",
    metadataHeaders: ["Message-ID"],
  });
  return {
    id: message.id || found.id,
    threadId: message.threadId || found.threadId || "",
    labelIds: message.labelIds || [],
  };
}

function headerMap(headers = []) {
  const map = {};
  for (const header of headers) {
    map[String(header.name || "").toLowerCase()] = header.value || "";
  }
  return map;
}

function bodyFromPayload(payload) {
  if (!payload) return { text: "", html: "" };
  let text = "";
  let html = "";

  function walk(part) {
    if (!part) return;
    const mime = String(part.mimeType || "").toLowerCase();
    const value = part.body?.data ? decodeBase64Url(part.body.data) : "";
    if (mime === "text/plain" && value && !text) text = value;
    if (mime === "text/html" && value && !html) html = value;
    for (const child of part.parts || []) walk(child);
  }

  walk(payload);
  return { text, html };
}

export async function searchMessages(accountId, query = "", maxResults = 25) {
  const gmail = await api(accountId);
  const { data } = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: Math.min(100, Math.max(1, Number(maxResults) || 25)),
  });

  const ids = (data.messages || []).map((item) => item.id).filter(Boolean);
  const rows = await Promise.all(ids.map(async (id) => {
    try {
      const result = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Cc", "Subject", "Date", "Message-ID", "References"],
      });
      const h = headerMap(result.data.payload?.headers);
      return {
        id,
        threadId: result.data.threadId || "",
        from: h.from || "",
        to: h.to || "",
        subject: h.subject || "(no subject)",
        date: h.date || "",
        snippet: result.data.snippet || "",
        labelIds: result.data.labelIds || [],
      };
    } catch (error) {
      return { id, error: publicError(error) };
    }
  }));

  return { messages: rows, nextPageToken: data.nextPageToken || "" };
}

export async function readMessage(accountId, messageId) {
  const gmail = await api(accountId);
  const { data } = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });
  const h = headerMap(data.payload?.headers);
  const body = bodyFromPayload(data.payload);

  return {
    id: data.id,
    threadId: data.threadId || "",
    from: h.from || "",
    to: h.to || "",
    cc: h.cc || "",
    subject: h.subject || "(no subject)",
    date: h.date || "",
    messageIdHeader: h["message-id"] || "",
    references: h.references || "",
    inReplyTo: h["in-reply-to"] || "",
    snippet: data.snippet || "",
    labelIds: data.labelIds || [],
    text: body.text,
    html: body.html,
  };
}

export async function replyToMessage(accountId, messageId, { text = "", html = "", mode = "draft" }) {
  const original = await readMessage(accountId, messageId);
  const subject = /^re:/i.test(original.subject) ? original.subject : "Re: " + original.subject;
  const references = [original.references, original.messageIdHeader].filter(Boolean).join(" ").trim();
  const message = {
    to: original.from,
    subject,
    text,
    html,
    threadId: original.threadId,
    inReplyTo: original.messageIdHeader,
    references,
  };
  return mode === "send"
    ? sendMessage(accountId, message)
    : createDraft(accountId, message);
}

export async function listLabels(accountId) {
  const gmail = await api(accountId);
  const { data } = await gmail.users.labels.list({ userId: "me" });
  return (data.labels || []).map((label) => ({
    id: label.id,
    name: label.name,
    type: label.type,
  }));
}

export async function modifyMessageLabels(accountId, messageId, addLabelIds = [], removeLabelIds = []) {
  const gmail = await api(accountId);
  const { data } = await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { addLabelIds, removeLabelIds },
  });
  return { id: data.id, labelIds: data.labelIds || [] };
}


export async function readThread(accountId, threadId) {
  const gmail = await api(accountId);
  const { data } = await withRetry(() => gmail.users.threads.get({ userId: "me", id: threadId, format: "full" }));
  return (data.messages || []).map((message) => {
    const h = headerMap(message.payload?.headers);
    const body = bodyFromPayload(message.payload);
    return {
      id: message.id || "",
      threadId: message.threadId || threadId,
      from: h.from || "",
      to: h.to || "",
      cc: h.cc || "",
      subject: h.subject || "(no subject)",
      date: h.date || "",
      messageIdHeader: h["message-id"] || "",
      inReplyTo: h["in-reply-to"] || "",
      references: h.references || "",
      snippet: message.snippet || "",
      labelIds: message.labelIds || [],
      text: body.text,
      html: body.html,
    };
  });
}

export async function watchInbox(accountId, topicName) {
  if (!String(topicName || "").startsWith("projects/")) throw new Error("A Google Pub/Sub topic name is required.");
  const gmail = await api(accountId);
  const { data } = await withRetry(() => gmail.users.watch({
    userId: "me",
    requestBody: { topicName: String(topicName), labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" },
  }));
  return { historyId: data.historyId || "", expiration: data.expiration || "" };
}

export async function stopInboxWatch(accountId) {
  const gmail = await api(accountId);
  await withRetry(() => gmail.users.stop({ userId: "me" }));
  return { ok: true };
}

export async function historySince(accountId, startHistoryId) {
  if (!startHistoryId) throw new Error("startHistoryId is required.");
  const gmail = await api(accountId);
  const out = { historyId: String(startHistoryId), messagesAdded: [], messagesDeleted: [], labelsAdded: [], labelsRemoved: [] };
  let pageToken = "";
  do {
    const { data } = await withRetry(() => gmail.users.history.list({
      userId: "me",
      startHistoryId: String(startHistoryId),
      historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
      maxResults: 500,
      ...(pageToken ? { pageToken } : {}),
    }));
    for (const row of data.history || []) {
      out.messagesAdded.push(...(row.messagesAdded || []));
      out.messagesDeleted.push(...(row.messagesDeleted || []));
      out.labelsAdded.push(...(row.labelsAdded || []));
      out.labelsRemoved.push(...(row.labelsRemoved || []));
    }
    if (data.historyId) out.historyId = String(data.historyId);
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return out;
}

export async function trashMessage(accountId, messageId) {
  const gmail = await api(accountId);
  const { data } = await withRetry(() => gmail.users.messages.trash({ userId: "me", id: messageId }));
  return { id: data.id || messageId, threadId: data.threadId || "", labelIds: data.labelIds || [] };
}

export async function archiveMessage(accountId, messageId) {
  return modifyMessageLabels(accountId, messageId, [], ["INBOX"]);
}

export function gmailErrorInfo(error) {
  const status = Number(error?.response?.status || error?.code || 0);
  const payload = error?.response?.data?.error;
  const message = publicError(error);
  const reasons = Array.isArray(payload?.errors)
    ? payload.errors.map((item) => String(item?.reason || "")).filter(Boolean)
    : [];
  const lower = (message + " " + reasons.join(" ")).toLowerCase();

  const sendLimit = lower.includes("mail sending")
    || lower.includes("daily limit")
    || lower.includes("dailylimitexceeded")
    || lower.includes("too many messages");

  const auth = status === 401
    || lower.includes("invalid credentials")
    || lower.includes("invalid_grant");

  const transient = !sendLimit && !auth && (
    status === 408
    || status === 429
    || status >= 500
    || lower.includes("ratelimitexceeded")
    || lower.includes("userratelimitexceeded")
    || lower.includes("backenderror")
  );

  const permanent = !transient && !sendLimit && !auth && status >= 400 && status < 500;

  return {
    status,
    message,
    reasons,
    sendLimit,
    auth,
    transient,
    permanent,
  };
}
