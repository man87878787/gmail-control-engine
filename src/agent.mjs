import fs from "node:fs/promises";
import { getOrCreateAgentKey } from "./security.mjs";

const base = process.env.GMAIL_CONTROL_URL || "http://127.0.0.1:4317";
const key = getOrCreateAgentKey();
const pretty = process.argv.includes("--pretty") || process.env.GMAIL_AGENT_PRETTY === "1";

async function request(route, options = {}, auth = true) {
  const headers = {
    "content-type": "application/json",
    ...(options.headers || {}),
  };
  if (auth) headers["x-gmail-control-key"] = key;

  const response = await fetch(base + route, { ...options, headers });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!response.ok) {
    const error = new Error(data?.error || "HTTP " + response.status);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function out(value) {
  process.stdout.write(JSON.stringify(value, null, pretty ? 2 : 0) + "\n");
}

async function jsonFile(file) {
  return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

async function textFile(file) {
  return fs.readFile(file, "utf8");
}

function help() {
  out({
    commands: {
      status: "agent status",
      live: "agent live",
      ready: "agent ready",
      accounts: "agent accounts",
      accountAdd: "agent account-add <alias> [expected-email] [label]",
      accountOauthUrl: "agent account-oauth-url <alias>",
      accountAction: "agent account-action <alias> <pause|resume> [reason]",
      accountConfig: "agent account-config <alias> <settings.json>",
      oauthConfig: "agent oauth-config <google-client.json>",
      validate: "agent validate <job.json>",
      create: "agent create <job.json>",
      job: "agent job <job-id-or-key>",
      bind: "agent bind <job-id-or-key> <account>",
      jobConfig: "agent job-config <job-id-or-key> <rate-per-minute>",
      action: "agent action <job-id-or-key> <start|pause|resume|cancel|retry-failed>",
      system: "agent system <pause|resume> [reason]",
      config: "agent config <settings.json>",
      backup: "agent backup [destination.sqlite3]",
      inbox: "agent inbox <account> <gmail-query> [max]",
      read: "agent read <account> <message-id>",
      replyDraft: "agent reply-draft <account> <message-id> <body-file>",
      replySend: "agent reply-send <account> <message-id> <body-file>",
      suppress: "agent suppress <email|domain> <value> [reason]",
      suppressAccount: "agent suppress-account <account> <email|domain> <value> [reason]",
      logs: "agent logs [limit]",
    },
  });
}

const argv = process.argv.slice(2).filter((arg) => arg !== "--pretty");
const [command, ...args] = argv;

try {
  if (!command || command === "help") {
    help();
  } else if (command === "live") {
    out(await request("/health/live", {}, false));
  } else if (command === "ready") {
    out(await request("/health/ready", {}, false));
  } else if (command === "status") {
    out(await request("/api/agent/status"));
  } else if (command === "accounts") {
    out(await request("/api/accounts"));
  } else if (command === "account-add") {
    if (!args[0]) throw new Error("Usage: account-add <alias> [expected-email] [label]");
    out(await request("/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        alias: args[0],
        expectedEmail: args[1] || "",
        label: args.slice(2).join(" "),
      }),
    }));
  } else if (command === "account-oauth-url") {
    if (!args[0]) throw new Error("Usage: account-oauth-url <alias>");
    out(await request("/api/accounts/" + encodeURIComponent(args[0]) + "/oauth-url", {
      method: "POST",
      body: "{}",
    }));
  } else if (command === "account-action") {
    if (!args[0] || !["pause", "resume"].includes(args[1])) {
      throw new Error("Usage: account-action <alias> <pause|resume> [reason]");
    }
    out(await request("/api/accounts/" + encodeURIComponent(args[0]) + "/action", {
      method: "POST",
      body: JSON.stringify({
        action: args[1],
        reason: args.slice(2).join(" "),
      }),
    }));
  } else if (command === "account-config") {
    if (!args[0] || !args[1]) throw new Error("Usage: account-config <alias> <settings.json>");
    out(await request("/api/accounts/" + encodeURIComponent(args[0]) + "/config", {
      method: "PUT",
      body: JSON.stringify(await jsonFile(args[1])),
    }));
  } else if (command === "oauth-config") {
    if (!args[0]) throw new Error("Missing Google OAuth client JSON file.");
    out(await request("/api/oauth/client", {
      method: "POST",
      body: JSON.stringify({ client: await jsonFile(args[0]) }),
    }));
  } else if (command === "validate") {
    if (!args[0]) throw new Error("Missing job JSON file.");
    out(await request("/api/agent/validate", {
      method: "POST",
      body: JSON.stringify(await jsonFile(args[0])),
    }));
  } else if (command === "create") {
    if (!args[0]) throw new Error("Missing job JSON file.");
    out(await request("/api/agent/jobs", {
      method: "POST",
      body: JSON.stringify(await jsonFile(args[0])),
    }));
  } else if (command === "job") {
    if (!args[0]) throw new Error("Missing job id/key.");
    out(await request("/api/agent/jobs/" + encodeURIComponent(args[0])));
  } else if (command === "bind") {
    if (!args[0] || !args[1]) throw new Error("Usage: bind <job> <account>");
    out(await request("/api/agent/jobs/" + encodeURIComponent(args[0]) + "/account", {
      method: "POST",
      body: JSON.stringify({ account: args[1] }),
    }));
  } else if (command === "job-config") {
    if (!args[0] || !args[1]) throw new Error("Usage: job-config <job> <rate-per-minute>");
    out(await request("/api/agent/jobs/" + encodeURIComponent(args[0]) + "/config", {
      method: "PUT",
      body: JSON.stringify({ ratePerMinute: Number(args[1]) }),
    }));
  } else if (command === "action") {
    if (!args[0] || !args[1]) throw new Error("Usage: action <job> <action>");
    out(await request("/api/agent/jobs/" + encodeURIComponent(args[0]) + "/action", {
      method: "POST",
      body: JSON.stringify({ action: args[1] }),
    }));
  } else if (command === "system") {
    if (!["pause", "resume"].includes(args[0])) throw new Error("Usage: system <pause|resume> [reason]");
    out(await request("/api/agent/system", {
      method: "POST",
      body: JSON.stringify({
        action: args[0],
        reason: args.slice(1).join(" "),
      }),
    }));
  } else if (command === "config") {
    if (!args[0]) throw new Error("Missing settings JSON file.");
    out(await request("/api/agent/config", {
      method: "PUT",
      body: JSON.stringify(await jsonFile(args[0])),
    }));
  } else if (command === "backup") {
    out(await request("/api/agent/backup", {
      method: "POST",
      body: JSON.stringify({ destination: args[0] || "" }),
    }));
  } else if (command === "inbox") {
    if (!args[0]) throw new Error("Usage: inbox <account> <query> [max]");
    out(await request(
      "/api/accounts/" + encodeURIComponent(args[0])
        + "/inbox/search?q=" + encodeURIComponent(args[1] || "")
        + "&max=" + encodeURIComponent(args[2] || "25"),
    ));
  } else if (command === "read") {
    if (!args[0] || !args[1]) throw new Error("Usage: read <account> <message-id>");
    out(await request(
      "/api/accounts/" + encodeURIComponent(args[0])
        + "/messages/" + encodeURIComponent(args[1]),
    ));
  } else if (command === "reply-draft" || command === "reply-send") {
    if (!args[0] || !args[1] || !args[2]) {
      throw new Error("Usage: reply-draft|reply-send <account> <message-id> <body-file>");
    }
    out(await request(
      "/api/accounts/" + encodeURIComponent(args[0])
        + "/messages/" + encodeURIComponent(args[1]) + "/reply",
      {
        method: "POST",
        body: JSON.stringify({
          text: await textFile(args[2]),
          mode: command === "reply-send" ? "send" : "draft",
        }),
      },
    ));
  } else if (command === "suppress" || command === "suppress-account") {
    const scoped = command === "suppress-account";
    const offset = scoped ? 1 : 0;
    if (scoped && !args[0]) throw new Error("Missing account.");
    if (!["email", "domain"].includes(args[offset]) || !args[offset + 1]) {
      throw new Error("Invalid suppression arguments.");
    }
    out(await request("/api/suppression", {
      method: "POST",
      body: JSON.stringify({
        account: scoped ? args[0] : "",
        type: args[offset],
        value: args[offset + 1],
        reason: args.slice(offset + 2).join(" "),
      }),
    }));
  } else if (command === "logs") {
    out(await request("/api/logs?limit=" + encodeURIComponent(args[0] || "100")));
  } else {
    throw new Error("Unknown command: " + command);
  }
} catch (error) {
  out({
    ok: false,
    error: error.message,
    status: error.status || null,
    detail: error.data || null,
  });
  process.exitCode = 1;
}
