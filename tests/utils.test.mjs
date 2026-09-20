import test from "node:test";
import assert from "node:assert/strict";
import {
  countRecipientUnits,
  isEmail,
  makeMessageId,
  parseRecipientLines,
  renderTemplate,
} from "../src/utils.mjs";

test("recipient parser normalizes and removes duplicates", () => {
  const parsed = parseRecipientLines("A@Example.com, Alpha\na@example.com, Duplicate\nb@example.org, Beta\ninvalid");
  assert.equal(parsed.duplicates, 1);
  assert.equal(parsed.recipients.length, 3);
  assert.equal(parsed.recipients[0].email, "a@example.com");
  assert.equal(parsed.recipients[0].name, "Alpha");
  assert.equal(parsed.recipients[2].valid, false);
});

test("template rendering replaces values and blanks unknown values", () => {
  assert.equal(
    renderTemplate("Hi {{ name }} — {{email}} {{missing}}", {
      name: "Alpha",
      email: "a@example.com",
    }),
    "Hi Alpha — a@example.com ",
  );
});

test("email validation and recipient-unit counting are conservative", () => {
  assert.equal(isEmail("person@example.com"), true);
  assert.equal(isEmail("not-an-email"), false);
  assert.equal(countRecipientUnits({
    email: "a@example.com",
    cc: "b@example.com, c@example.com",
    bcc: "b@example.com",
  }), 3);
});

test("message ids are deterministic for a recipient", () => {
  assert.equal(
    makeMessageId("cmp_abc", "rcp_xyz"),
    "<cmp_abc.rcp_xyz@gmail-control.local>",
  );
});
