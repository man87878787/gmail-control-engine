import test from "node:test";import assert from "node:assert/strict";import { actionRisk } from "../src/action-store.mjs";
test("high-impact actions are classified high risk",()=>{assert.equal(actionRisk("send-reply"),"high");assert.equal(actionRisk("trash"),"high");assert.equal(actionRisk("archive"),"medium");assert.equal(actionRisk("labels"),"low")});
