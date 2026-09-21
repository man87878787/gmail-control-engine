import test from "node:test";
import assert from "node:assert/strict";
import { analyzeMessage, analyzeThread } from "../src/intelligence.mjs";

test("message intelligence finds requests, urgency, dates and money", () => {
  const a=analyzeMessage({from:"billing@example.com",subject:"Urgent invoice",text:"Please confirm payment by tomorrow. Balance due is $42.50."});
  assert.equal(a.category,"payment"); assert.equal(a.urgency,"high"); assert.equal(a.replyLikely,true);
  assert.ok(a.entities.dates.includes("tomorrow")); assert.ok(a.entities.money.includes("$42.50"));
});
test("automated mail is not marked reply-likely",()=> {
  const a=analyzeMessage({from:"no-reply@example.com",subject:"Notification",text:"Your order shipped."});
  assert.equal(a.automatedLikely,true); assert.equal(a.replyLikely,false);
});
test("thread intelligence rolls up messages",()=> {
  const a=analyzeThread([{text:"Your order shipped."},{text:"Could you confirm delivery?"}]);
  assert.equal(a.messageCount,2); assert.equal(a.replyLikely,true); assert.ok(a.openRequests.length);
});

test("intelligence extracts contact details and sensitive-data warnings", () => {
 const a=analyzeMessage({from:"person@example.com",subject:"Account check",text:"Call 614-555-1212 or email help@example.org. Never send your password. Please confirm."});
 assert.ok(a.entities.phones.includes("614-555-1212"));
 assert.ok(a.entities.emails.includes("help@example.org"));
 assert.equal(a.safety.sensitiveDataMentioned,true);
 assert.ok(a.priorityScore>0);
});
test("suspicious language is surfaced without asserting fraud", () => {
 const a=analyzeMessage({from:"alerts@example.com",subject:"Action required",text:"Verify your account. Click here immediately."});
 assert.equal(a.safety.suspiciousLanguage,true);
 assert.equal(a.urgency,"high");
});
