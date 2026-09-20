import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function makeJob(count, key = "boundary-500") {
  return {
    jobKey: key,
    name: "Boundary test",
    account: "test",
    mode: "draft",
    start: false,
    recipients: Array.from({ length: count }, (_, i) => ({
      email: `person${i + 1}@example.com`,
      subject: `Subject ${i + 1}`,
      body: `Body ${i + 1}`,
    })),
  };
}

async function waitFor(url, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become ready");
}

test("server enforces 500 boundary and idempotency", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-control-server-"));
  const key = "a".repeat(64);
  fs.writeFileSync(path.join(dir, "agent-key.txt"), key + "\n", "utf8");

  const port = 47000 + (process.pid % 1000);
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      GMAIL_CONTROL_DATA_DIR: dir,
      PORT: String(port),
      HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(() => {
    try { child.kill("SIGTERM"); } catch {}
  });

  const base = `http://127.0.0.1:${port}`;
  await waitFor(base + "/health/live");

  async function api(route, body) {
    return fetch(base + route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gmail-control-key": key,
      },
      body: JSON.stringify(body),
    });
  }

  const accountCreate = await api("/api/accounts", {
    alias: "test",
    expectedEmail: "test@example.com",
    label: "Test Account",
  });
  assert.equal(accountCreate.status, 201);

  const validate500 = await api("/api/agent/validate", makeJob(500));
  assert.equal(validate500.status, 200);
  const validate500Body = await validate500.json();
  assert.equal(validate500Body.unique, 500);

  const create500 = await api("/api/agent/jobs", makeJob(500));
  assert.equal(create500.status, 201);
  const created = await create500.json();
  assert.equal(created.campaign.total, 500);

  const replay = await api("/api/agent/jobs", makeJob(500));
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).duplicatePrevented, true);

  const changed = makeJob(500);
  changed.recipients[0].body = "Changed body";
  const conflict = await api("/api/agent/jobs", changed);
  assert.equal(conflict.status, 409);

  const validate501 = await api("/api/agent/validate", makeJob(501, "boundary-501"));
  assert.equal(validate501.status, 400);
  const over = await validate501.json();
  assert.ok(over.errors.some((error) => error.includes("500-recipient")));
});
