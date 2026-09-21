import crypto from "node:crypto";
import fs from "node:fs";import path from "node:path";import { DatabaseSync } from "node:sqlite";import { fileURLToPath } from "node:url";
import { scrubObject } from "./privacy.mjs";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");const dataDir=process.env.GMAIL_CONTROL_DATA_DIR?path.resolve(process.env.GMAIL_CONTROL_DATA_DIR):path.join(root,"data");fs.mkdirSync(dataDir,{recursive:true});
const dbPath=path.join(dataDir,"actions.sqlite3");let database;
function db(){if(database)return database;database=new DatabaseSync(dbPath);database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");database.exec(`CREATE TABLE IF NOT EXISTS staged_actions(
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL,type TEXT NOT NULL,risk TEXT NOT NULL,status TEXT NOT NULL,payload_json TEXT NOT NULL,
 created_at TEXT NOT NULL,decided_at TEXT,executed_at TEXT,result_json TEXT,error TEXT NOT NULL DEFAULT ''
);CREATE INDEX IF NOT EXISTS idx_actions_status ON staged_actions(status,created_at);`);try{fs.chmodSync(dbPath,0o600)}catch{}return database}
const HIGH=new Set(["send","send-reply","trash","delete","permanent-delete","forward"]);
const MEDIUM=new Set(["draft","draft-reply","archive","mark-spam"]);
export function actionRisk(type){const t=String(type||"").toLowerCase();return HIGH.has(t)?"high":MEDIUM.has(t)?"medium":"low"}
function map(r){if(!r)return null;return {id:r.id,accountId:r.account_id,type:r.type,risk:r.risk,status:r.status,payload:JSON.parse(r.payload_json),createdAt:r.created_at,decidedAt:r.decided_at,executedAt:r.executed_at,result:r.result_json?JSON.parse(r.result_json):null,error:r.error||""}}
export function stageAction({accountId,type,payload={}}){if(!accountId||!type)throw new Error("accountId and type are required.");const id="act_"+crypto.randomBytes(12).toString("hex"),at=new Date().toISOString(),risk=actionRisk(type);db().prepare("INSERT INTO staged_actions(id,account_id,type,risk,status,payload_json,created_at) VALUES(?,?,?,?,?,?,?)").run(id,String(accountId),String(type),risk,"staged",JSON.stringify(scrubObject(payload)),at);return getAction(id)}
export function getAction(id){return map(db().prepare("SELECT * FROM staged_actions WHERE id=?").get(String(id)))}
export function listActions({status="",limit=100}={}){const n=Math.max(1,Math.min(500,Number(limit)||100));const rows=status?db().prepare("SELECT * FROM staged_actions WHERE status=? ORDER BY created_at DESC LIMIT ?").all(status,n):db().prepare("SELECT * FROM staged_actions ORDER BY created_at DESC LIMIT ?").all(n);return rows.map(map)}
export function approveAction(id){const a=getAction(id);if(!a)throw new Error("Unknown action.");if(!["staged","rejected"].includes(a.status))throw new Error("Action cannot be approved from status "+a.status);db().prepare("UPDATE staged_actions SET status='approved',decided_at=?,error='' WHERE id=?").run(new Date().toISOString(),id);return getAction(id)}
export function rejectAction(id){const a=getAction(id);if(!a)throw new Error("Unknown action.");if(["executed","executing"].includes(a.status))throw new Error("Executed action cannot be rejected.");db().prepare("UPDATE staged_actions SET status='rejected',decided_at=? WHERE id=?").run(new Date().toISOString(),id);return getAction(id)}
export function beginExecution(id){const a=getAction(id);if(!a)throw new Error("Unknown action.");if(a.risk==="high"&&a.status!=="approved")throw new Error("High-risk action requires explicit approval.");if(!["staged","approved"].includes(a.status))throw new Error("Action cannot execute from status "+a.status);db().prepare("UPDATE staged_actions SET status='executing' WHERE id=?").run(id);return getAction(id)}
export function finishExecution(id,result){db().prepare("UPDATE staged_actions SET status='executed',executed_at=?,result_json=?,error='' WHERE id=?").run(new Date().toISOString(),JSON.stringify(scrubObject(result??null)),id);return getAction(id)}
export function failExecution(id,error){db().prepare("UPDATE staged_actions SET status='failed',error=? WHERE id=?").run(String(error?.message||error||"execution failed").slice(0,2000),id);return getAction(id)}
