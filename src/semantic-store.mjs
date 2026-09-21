function assertLocalUrl(value){const u=new URL(value);const local=["127.0.0.1","localhost","::1"].includes(u.hostname);if(!local&&process.env.ALLOW_REMOTE_AI_ENDPOINTS!=="1")throw new Error("Embedding endpoint must use localhost unless ALLOW_REMOTE_AI_ENDPOINTS=1.");return u.toString().replace(/\/$/,"")}
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const dataDir=process.env.GMAIL_CONTROL_DATA_DIR?path.resolve(process.env.GMAIL_CONTROL_DATA_DIR):path.join(root,"data");
fs.mkdirSync(dataDir,{recursive:true});
const dbPath=path.join(dataDir,"semantic.sqlite3");
let database;
function db(){
 if(database)return database;
 database=new DatabaseSync(dbPath);database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
 database.exec(`CREATE TABLE IF NOT EXISTS semantic_messages(
  account_id TEXT NOT NULL,message_id TEXT NOT NULL,thread_id TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',from_addr TEXT NOT NULL DEFAULT '',date TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',vector_json TEXT NOT NULL,dimensions INTEGER NOT NULL,updated_at TEXT NOT NULL,
  PRIMARY KEY(account_id,message_id)
 );CREATE INDEX IF NOT EXISTS idx_sem_thread ON semantic_messages(account_id,thread_id);`);
 try{fs.chmodSync(dbPath,0o600)}catch{}
 return database;
}
function tokens(text){return String(text||"").toLowerCase().match(/[a-z0-9]{2,}/g)||[]}
export function hashEmbedding(text,dimensions=128){
 const v=new Float32Array(dimensions);
 for(const token of tokens(text)){let h=2166136261;for(let i=0;i<token.length;i++){h^=token.charCodeAt(i);h=Math.imul(h,16777619)}const idx=(h>>>0)%dimensions;v[idx]+=1}
 let n=Math.sqrt(v.reduce((s,x)=>s+x*x,0))||1;return Array.from(v,x=>x/n);
}
export function cosine(a,b){let dot=0,aa=0,bb=0;const n=Math.min(a.length,b.length);for(let i=0;i<n;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i]}return aa&&bb?dot/Math.sqrt(aa*bb):0}
export async function embedText(text,{provider=process.env.LOCAL_EMBEDDING_PROVIDER||"hash",fetchImpl=fetch}={}){
 if(provider==="hash")return hashEmbedding(text);
 if(provider==="ollama"){
  const base=assertLocalUrl(process.env.OLLAMA_URL||"http://127.0.0.1:11434");
  const model=process.env.OLLAMA_EMBED_MODEL||"nomic-embed-text";
  const r=await fetchImpl(base+"/api/embed",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model,input:String(text||"")})});
  if(!r.ok)throw new Error("Ollama embedding HTTP "+r.status);const j=await r.json();const v=j.embeddings?.[0]||j.embedding;if(!Array.isArray(v))throw new Error("Embedding response missing vector.");return v;
 }
 if(provider==="http"){
  const raw=process.env.LOCAL_EMBEDDING_URL;if(!raw)throw new Error("LOCAL_EMBEDDING_URL is required.");const url=assertLocalUrl(raw);
  const r=await fetchImpl(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({input:String(text||"")})});
  if(!r.ok)throw new Error("Embedding HTTP "+r.status);const j=await r.json();const v=j.embedding||j.embeddings?.[0];if(!Array.isArray(v))throw new Error("Embedding response missing vector.");return v;
 }
 throw new Error("Unknown embedding provider: "+provider);
}
function documentText(m){return [m.subject,m.from,m.text||m.html||m.snippet].filter(Boolean).join("\n")}
export async function indexSemanticMessage(accountId,message,options={}){
 const vector=await embedText(documentText(message),options);const excerpt=String(message.text||message.snippet||"").replace(/\s+/g," ").slice(0,1200);
 db().prepare(`INSERT INTO semantic_messages(account_id,message_id,thread_id,subject,from_addr,date,excerpt,vector_json,dimensions,updated_at)
 VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,message_id) DO UPDATE SET thread_id=excluded.thread_id,subject=excluded.subject,from_addr=excluded.from_addr,date=excluded.date,excerpt=excluded.excerpt,vector_json=excluded.vector_json,dimensions=excluded.dimensions,updated_at=excluded.updated_at`)
 .run(String(accountId),String(message.id),String(message.threadId||""),String(message.subject||""),String(message.from||""),String(message.date||""),excerpt,JSON.stringify(vector),vector.length,new Date().toISOString());
 return {accountId:String(accountId),messageId:String(message.id),dimensions:vector.length};
}
export async function semanticSearch(query,{accountId="",limit=10,minScore=0.12,...options}={}){
 const q=await embedText(query,options);const rows=accountId?db().prepare("SELECT * FROM semantic_messages WHERE account_id=?").all(String(accountId)):db().prepare("SELECT * FROM semantic_messages").all();
 return rows.map(r=>({accountId:r.account_id,messageId:r.message_id,threadId:r.thread_id,subject:r.subject,from:r.from_addr,date:r.date,excerpt:r.excerpt,score:cosine(q,JSON.parse(r.vector_json))}))
  .filter(x=>x.score>=minScore).sort((a,b)=>b.score-a.score).slice(0,Math.max(1,Math.min(100,Number(limit)||10)));
}
export function semanticStats(){const r=db().prepare("SELECT COUNT(*) count,COUNT(DISTINCT account_id) accounts FROM semantic_messages").get();return {messages:Number(r.count||0),accounts:Number(r.accounts||0),provider:process.env.LOCAL_EMBEDDING_PROVIDER||"hash"}}
export function closeSemanticStore(){try{database?.close()}catch{}database=null}
