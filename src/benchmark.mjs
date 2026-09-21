import fs from "node:fs";import path from "node:path";import { fileURLToPath } from "node:url";import { analyzeMessage } from "./intelligence.mjs";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");const cases=JSON.parse(fs.readFileSync(path.join(root,"benchmarks","adversarial.json"),"utf8"));
let checks=0,passed=0;const failures=[];
for(const item of cases){const a=analyzeMessage(item.message);for(const [k,v] of Object.entries(item.expected)){checks++;const actual=k==="suspiciousLanguage"?a.safety.suspiciousLanguage:k==="sensitiveDataMentioned"?a.safety.sensitiveDataMentioned:a[k];if(actual===v)passed++;else failures.push({case:item.name,field:k,expected:v,actual})}}
const score=checks?passed/checks:1;const report={cases:cases.length,checks,passed,score:Number(score.toFixed(4)),failures};process.stdout.write(JSON.stringify(report,null,2)+"\n");if(score<0.9)process.exitCode=1;
