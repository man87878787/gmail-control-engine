import test from "node:test";
import assert from "node:assert/strict";
import { buildJsonPrompt, localJson, parseModelJson } from "../src/local-model.mjs";

test("local model parser accepts strict JSON and embedded JSON",()=>{
 assert.deepEqual(parseModelJson('{"ok":true}'),{ok:true});
 assert.deepEqual(parseModelJson('result: {"x":1} end'),{x:1});
});

test("prompt demands JSON-only output",()=>{
 assert.match(buildJsonPrompt({task:"classify",input:{x:1},schema:{category:"string"}}),/ONLY valid JSON/);
});

test("local model blocks remote endpoints by default",async()=>{
 let called=false;
 await assert.rejects(
  ()=>localJson({
   task:"x",
   input:{a:1},
   baseUrl:"https://example.com",
   fetchImpl:async()=>{called=true;},
  }),
  /localhost|ALLOW_REMOTE_AI_ENDPOINTS/,
 );
 assert.equal(called,false);
});

test("local model allows loopback endpoints and reaches fetch",async()=>{
 let calledUrl="";
 const result=await localJson({
  task:"x",
  input:{a:1},
  baseUrl:"http://127.0.0.1:11434",
  fetchImpl:async(url)=>{
   calledUrl=url;
   return {ok:true,json:async()=>({response:'{"ok":true}'})};
  },
 });
 assert.equal(calledUrl,"http://127.0.0.1:11434/api/generate");
 assert.deepEqual(result,{ok:true});
});
