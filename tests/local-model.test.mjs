import test from "node:test";import assert from "node:assert/strict";import { buildJsonPrompt, parseModelJson } from "../src/local-model.mjs";
test("local model parser accepts strict JSON and embedded JSON",()=>{assert.deepEqual(parseModelJson('{"ok":true}'),{ok:true});assert.deepEqual(parseModelJson('result: {"x":1} end'),{x:1})});
test("prompt demands JSON-only output",()=>{assert.match(buildJsonPrompt({task:"classify",input:{x:1},schema:{category:"string"}}),/ONLY valid JSON/)});
