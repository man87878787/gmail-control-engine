import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("SQLite store persists settings and can back up", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-control-store-"));
  process.env.GMAIL_CONTROL_DATA_DIR = dir;

  const store = await import("../src/store.mjs?storetest=" + Date.now());
  await store.setSettings({ defaultDailyCap: 321 });
  assert.equal(store.getSettings().defaultDailyCap, 321);
  assert.equal(store.getSettings().maxRecipientsPerJob, 500);
  assert.equal(store.getSettings().maxAccounts, 4);
  assert.equal(store.storeHealth().ok, true);

  for (let i = 1; i <= 4; i += 1) {
    const result = store.createAccount({
      id: "acct_" + i,
      alias: "acct" + i,
      expectedEmail: "acct" + i + "@example.com",
    });
    assert.equal(result.created, true);
  }
  assert.equal(store.listAccounts().length, 4);
  assert.throws(() => store.createAccount({
    id: "acct_5",
    alias: "acct5",
    expectedEmail: "acct5@example.com",
  }), /Maximum of 4 Gmail profiles/);

  const backupPath = await store.backupStore();
  assert.equal(fs.existsSync(backupPath), true);
  store.closeStore();
});
