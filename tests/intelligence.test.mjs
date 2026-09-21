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
