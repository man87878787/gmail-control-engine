import test from "node:test";import assert from "node:assert/strict";import { isTransientError, withRetry } from "../src/retry.mjs";
test("retry recognizes transient status",()=>{assert.equal(isTransientError({status:429}),true);assert.equal(isTransientError({status:400}),false)});
test("withRetry eventually succeeds",async()=>{let n=0;const v=await withRetry(async()=>{n++;if(n<3){const e=new Error("temp");e.status=500;throw e}return "ok"},{attempts:3,baseMs:1,maxMs:2,jitter:0});assert.equal(v,"ok");assert.equal(n,3)});
