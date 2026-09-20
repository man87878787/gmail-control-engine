import test from "node:test";
import assert from "node:assert/strict";
import { jobFingerprint, validateJobPayload } from "../src/job.mjs";

const settings = {
  maxRecipientsPerJob: 500,
  perMinute: 8,
};

function recipients(count) {
  return Array.from({ length: count }, (_, i) => ({
    email: `person${i + 1}@example.com`,
    name: `Person ${i + 1}`,
    subject: `Subject ${i + 1}`,
    body: `Body ${i + 1}`,
  }));
}

test("500 unique recipients is accepted", () => {
  const result = validateJobPayload({
    jobKey: "five-hundred",
    name: "500 test",
    account: "test",
    mode: "draft",
    recipients: recipients(500),
  }, settings);

  assert.deepEqual(result.errors, []);
  assert.equal(result.stats.unique, 500);
  assert.equal(result.stats.valid, 500);
});

test("explicit repeat test can create 120 messages to one recipient", () => {
  const result = validateJobPayload({
    jobKey: "repeat-120",
    name: "Repeat test",
    account: "test",
    mode: "send",
    testRepeatCount: 120,
    subject: "Test {{sequence}} of {{total}}",
    body: "Body {{sequence}} of {{total}}",
    recipients: [{ email: "target@example.com" }],
  }, settings);

  assert.deepEqual(result.errors, []);
  assert.equal(result.stats.unique, 120);
  assert.equal(result.stats.valid, 120);
  assert.equal(result.parsed.rows[0].vars.sequence, 1);
  assert.equal(result.parsed.rows[119].vars.sequence, 120);
});

test("501 unique recipients is rejected", () => {
  const result = validateJobPayload({
    jobKey: "five-oh-one",
    name: "501 test",
    account: "test",
    mode: "draft",
    recipients: recipients(501),
  }, settings);

  assert.ok(result.errors.some((error) => error.includes("500-recipient")));
});

test("fingerprint is stable for equivalent nested object key order", () => {
  const body = {
    jobKey: "fingerprint",
    name: "Fingerprint",
    account: "test",
    recipients: [{
      email: "a@example.com",
      subject: "Hi",
      body: "Body",
      vars: { b: 2, a: 1 },
    }],
  };
  const validation = validateJobPayload(body, settings);
  const first = jobFingerprint(body, validation.parsed.rows);

  const body2 = {
    ...body,
    recipients: [{
      email: "a@example.com",
      subject: "Hi",
      body: "Body",
      vars: { a: 1, b: 2 },
    }],
  };
  const validation2 = validateJobPayload(body2, settings);
  const second = jobFingerprint(body2, validation2.parsed.rows);
  assert.equal(first, second);
});
