import {
  countRecipientUnits,
  hashObject,
  id,
  isEmail,
  makeMessageId,
  normalizeEmail,
  nowIso,
  parseAddressList,
  parseRecipientLines,
} from "./utils.mjs";

const MAX_SUBJECT_CHARS = 500;
const MAX_BODY_CHARS = 20_000;
const MAX_NAME_CHARS = 300;
const MAX_JOB_KEY_CHARS = 160;

function normalizeRow(item) {
  const email = normalizeEmail(typeof item === "string" ? item : item?.email);
  const name = typeof item === "object" ? String(item?.name || "").trim() : "";
  const cc = typeof item === "object" ? String(item?.cc || "").trim() : "";
  const bcc = typeof item === "object" ? String(item?.bcc || "").trim() : "";
  const ccList = parseAddressList(cc);
  const bccList = parseAddressList(bcc);

  let invalidReason = "";
  if (!isEmail(email)) invalidReason = "Invalid primary email address";
  else if (ccList.some((address) => !isEmail(address))) invalidReason = "Invalid Cc address";
  else if (bccList.some((address) => !isEmail(address))) invalidReason = "Invalid Bcc address";

  const row = {
    email,
    name: name.slice(0, MAX_NAME_CHARS),
    vars: typeof item === "object" && item?.vars && typeof item.vars === "object"
      ? structuredClone(item.vars)
      : {},
    subject: typeof item === "object" && item?.subject != null ? String(item.subject) : null,
    body: typeof item === "object" && item?.body != null ? String(item.body) : null,
    htmlBody: typeof item === "object" && item?.htmlBody != null ? String(item.htmlBody) : null,
    cc,
    bcc,
    valid: !invalidReason,
    invalidReason,
  };
  row.units = countRecipientUnits(row);
  return row;
}

export function normalizeRecipients(input) {
  if (typeof input === "string") {
    const parsed = parseRecipientLines(input);
    return {
      rows: parsed.recipients.map((item) => normalizeRow(item)),
      duplicates: parsed.duplicates,
      totalInput: parsed.recipients.length + parsed.duplicates,
    };
  }

  const seen = new Set();
  const rows = [];
  let duplicates = 0;
  let totalInput = 0;

  for (const item of Array.isArray(input) ? input : []) {
    totalInput += 1;
    const row = normalizeRow(item);
    if (!row.email) continue;
    if (seen.has(row.email)) {
      duplicates += 1;
      continue;
    }
    seen.add(row.email);
    rows.push(row);
  }

  return { rows, duplicates, totalInput };
}

function applyRepeatTest(parsed, body) {
  const repeatCount = Number.parseInt(body?.testRepeatCount, 10);
  if (!Number.isFinite(repeatCount) || repeatCount <= 1) return parsed;

  if (parsed.rows.length !== 1) {
    return { ...parsed, repeatError: "testRepeatCount requires exactly one unique recipient" };
  }
  if (repeatCount > 500) {
    return { ...parsed, repeatError: "testRepeatCount cannot exceed 500" };
  }

  const original = parsed.rows[0];
  return {
    ...parsed,
    rows: Array.from({ length: repeatCount }, (_, index) => ({
      ...structuredClone(original),
      vars: {
        ...(original.vars || {}),
        sequence: index + 1,
        total: repeatCount,
      },
    })),
    totalInput: repeatCount,
    duplicates: 0,
  };
}

export function validateJobPayload(body, settings) {
  const parsed = applyRepeatTest(normalizeRecipients(body?.recipients), body);
  const errors = [];
  const jobKey = String(body?.jobKey || "").trim();
  const name = String(body?.name || "").trim();
  const account = String(body?.account || "").trim();
  const subject = String(body?.subject || "");
  const textBody = String(body?.body || "");
  const htmlBody = String(body?.htmlBody || "");
  const maxRecipients = Math.min(500, Number(settings?.maxRecipientsPerJob || 500));

  if (parsed.repeatError) errors.push(parsed.repeatError);
  if (!jobKey) errors.push("jobKey is required");
  if (jobKey.length > MAX_JOB_KEY_CHARS) errors.push("jobKey is too long");
  if (!name) errors.push("name is required");
  if (name.length > 300) errors.push("name is too long");
  if (!account) errors.push("account is required");
  if (!parsed.rows.length) errors.push("at least one recipient is required");
  if (parsed.rows.length > maxRecipients) {
    errors.push("job exceeds the " + maxRecipients + "-recipient limit");
  }
  if (subject.length > MAX_SUBJECT_CHARS) errors.push("global subject is too long");
  if (textBody.length > MAX_BODY_CHARS || htmlBody.length > MAX_BODY_CHARS) {
    errors.push("global body is too long");
  }

  for (const row of parsed.rows) {
    if (row.subject != null && row.subject.length > MAX_SUBJECT_CHARS) {
      errors.push("subject too long for " + row.email);
      break;
    }
    if ((row.body != null && row.body.length > MAX_BODY_CHARS)
        || (row.htmlBody != null && row.htmlBody.length > MAX_BODY_CHARS)) {
      errors.push("body too long for " + row.email);
      break;
    }
  }

  if (!subject.trim() && parsed.rows.some((row) =>
    row.valid && !String(row.subject || "").trim())) {
    errors.push("subject is required globally or for every valid recipient");
  }

  if (!textBody.trim() && !htmlBody.trim()
      && parsed.rows.some((row) =>
        row.valid
        && !String(row.body || "").trim()
        && !String(row.htmlBody || "").trim())) {
    errors.push("body/htmlBody is required globally or for every valid recipient");
  }

  const validRows = parsed.rows.filter((row) => row.valid);
  if (!validRows.length && parsed.rows.length) errors.push("job has no valid recipients");

  return {
    parsed,
    errors,
    stats: {
      totalInput: parsed.totalInput,
      unique: parsed.rows.length,
      duplicatesRemoved: parsed.duplicates,
      valid: validRows.length,
      invalid: parsed.rows.length - validRows.length,
      estimatedRecipientUnits: validRows.reduce((sum, row) => sum + row.units, 0),
      maxRecipients,
    },
  };
}

export function jobFingerprint(body, parsedRows) {
  return hashObject({
    jobKey: String(body?.jobKey || "").trim(),
    name: String(body?.name || "").trim(),
    account: String(body?.account || "").trim().toLowerCase(),
    mode: body?.mode === "send" ? "send" : "draft",
    subject: String(body?.subject || ""),
    body: String(body?.body || ""),
    htmlBody: String(body?.htmlBody || ""),
    ratePerMinute: Number(body?.ratePerMinute || 0),
    startAt: body?.startAt || null,
    testRepeatCount: Number.parseInt(body?.testRepeatCount, 10) || 0,
    recipients: parsedRows.map((row) => ({
      email: row.email,
      name: row.name,
      vars: row.vars,
      subject: row.subject,
      body: row.body,
      htmlBody: row.htmlBody,
      cc: row.cc,
      bcc: row.bcc,
    })),
  });
}

export function buildCampaign(body, validation, settings, accountId) {
  const campaignId = id("cmp");
  const createdAt = nowIso();
  const requestedRate = Number.parseInt(body?.ratePerMinute, 10);
  const ratePerMinute = Number.isFinite(requestedRate)
    ? Math.max(1, Math.min(requestedRate, 50))
    : Math.min(50, Number(settings.defaultPerMinute || 50));

  const recipients = validation.parsed.rows.map((row) => {
    const recipientId = id("rcp");
    return {
      id: recipientId,
      email: row.email,
      name: row.name,
      vars: row.vars,
      subject: row.subject,
      body: row.body,
      htmlBody: row.htmlBody,
      cc: row.cc,
      bcc: row.bcc,
      units: row.units,
      messageIdHeader: makeMessageId(campaignId, recipientId),
      state: row.valid ? "queued" : "invalid",
      attempts: 0,
      lastError: row.valid ? "" : row.invalidReason,
      createdAt,
      updatedAt: createdAt,
      nextAttemptAt: null,
      needsReconcile: false,
      reconciled: false,
    };
  });

  return {
    id: campaignId,
    jobKey: String(body.jobKey).trim(),
    jobFingerprint: jobFingerprint(body, validation.parsed.rows),
    accountId,
    name: String(body.name).trim(),
    mode: body.mode === "send" ? "send" : "draft",
    status: body.start === true ? "running" : "ready",
    subject: String(body?.subject || ""),
    body: String(body?.body || ""),
    htmlBody: String(body?.htmlBody || ""),
    ratePerMinute,
    startAt: body.startAt ? new Date(body.startAt).toISOString() : null,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    recipients,
  };
}
