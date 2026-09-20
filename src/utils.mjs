import crypto from "node:crypto";

export function id(prefix = "id") {
  return prefix + "_" + crypto.randomBytes(10).toString("hex");
}

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeEmail(value = "") {
  return String(value).trim().toLowerCase();
}

export function isEmail(value = "") {
  const email = normalizeEmail(value);
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email) && email.length <= 254;
}

export function sanitizeHeader(value = "") {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

export function parseAddressList(value = "") {
  const seen = new Set();
  const rows = [];
  for (const raw of String(value).split(/[;,]/)) {
    const email = normalizeEmail(raw);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    rows.push(email);
  }
  return rows;
}

export function countRecipientUnits(recipient = {}) {
  const all = [
    normalizeEmail(recipient.email),
    ...parseAddressList(recipient.cc),
    ...parseAddressList(recipient.bcc),
  ].filter(Boolean);
  return new Set(all).size;
}

export function renderTemplate(template = "", vars = {}) {
  return String(template).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => {
    const parts = key.split(".");
    let value = vars;
    for (const part of parts) value = value?.[part];
    return value == null ? "" : String(value);
  });
}

export function recipientVars(recipient) {
  return {
    email: recipient.email,
    name: recipient.name || "",
    ...(recipient.vars || {}),
  };
}

export function parseRecipientLines(text = "") {
  const seen = new Set();
  const recipients = [];
  let duplicates = 0;

  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const comma = line.indexOf(",");
    const email = normalizeEmail(comma >= 0 ? line.slice(0, comma) : line);
    const name = comma >= 0 ? line.slice(comma + 1).trim() : "";

    if (seen.has(email)) {
      duplicates += 1;
      continue;
    }
    seen.add(email);
    recipients.push({ email, name, valid: isEmail(email) });
  }
  return { recipients, duplicates };
}

export function publicError(error) {
  const message = error?.response?.data?.error?.message
    || error?.response?.data?.error
    || error?.message
    || String(error);
  return String(message).slice(0, 1000);
}

export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function encodeBase64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function decodeBase64Url(value = "") {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

export function makeMessageId(campaignId, recipientId) {
  const safe = (value) => String(value).replace(/[^a-zA-Z0-9._-]/g, "");
  return "<" + safe(campaignId) + "." + safe(recipientId) + "@gmail-control.local>";
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

export function hashObject(value) {
  const canonical = JSON.stringify(canonicalize(value));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function jitteredBackoffSeconds(attempt, baseSeconds = 5, maxSeconds = 64) {
  const exponent = Math.max(0, Number(attempt || 1) - 1);
  const core = Math.min(maxSeconds, baseSeconds * (2 ** exponent));
  return core + Math.random();
}

export function sameSecret(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
