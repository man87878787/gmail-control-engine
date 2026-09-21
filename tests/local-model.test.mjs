import test from "node:test";import assert from "node:assert/strict";import { buildJsonPrompt, parseModelJson } from "../src/local-model.mjs";
test("local model parser accepts strict JSON and embedded JSON",()=>{assert.deepEqual(parseModelJson('{"ok":true}'),{ok:true});assert.deepEqual(parseModelJson('result: {"x":1} end'),{x:1})});
test("prompt demands JSON-only output",()=>{assert.match(buildJsonPrompt({task:"classify",input:{x:1},schema:{category:"string"}}),/ONLY valid JSON/)});

test("local model blocks remote endpoints by default",async()=>{let called=false;await assert.rejects(()=>import("../src/local-model.mjs").then(({localJson})=>localJson({task:"x",input:{a:1},baseUrl:"https://example.com",fetchImpl:async()=>{called=true}})),/localhost/);assert.equal(called,false)});
