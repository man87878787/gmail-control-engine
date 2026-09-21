import crypto from "node:crypto";
import { approveAction, getAction, listActions, rejectAction, stageAction } from "./action-store.mjs";
import { executeAction } from "./action-executor.mjs";
import { analyzeMessage } from "./intelligence.mjs";
import { processNotification, setHistoryCursor } from "./ingestion.mjs";
import { localJson } from "./local-model.mjs";
import { listPlugins } from "./plugin-bus.mjs";
import { indexSemanticMessage, semanticSearch, semanticStats } from "./semantic-store.mjs";
import { buildThreadGraph } from "./thread-graph.mjs";
import { unifiedInbox } from "./unified-inbox.mjs";
import {
  archiveMessage, historySince, modifyMessageLabels, oauthStatus, readMessage, readThread,
  replyToMessage, searchMessages, stopInboxWatch, trashMessage, watchInbox,
} from "./gmail.mjs";
import {
  getAccount, getSentUnitsToday, getSettings, listAccounts, recordSendEvent, setAccountPause,
} from "./store.mjs";

function resolveAccount(ref){const a=getAccount(ref);if(!a){const e=new Error("Unknown Gmail profile: "+String(ref||""));e.status=404;throw e}return a}
function accountByEmail(email){return listAccounts().find(a=>String(a.email||a.expectedEmail||"").toLowerCase()===String(email||"").toLowerCase())||null}
function safeEqual(a,b){const x=Buffer.from(String(a||"")),y=Buffer.from(String(b||""));return x.length===y.length&&x.length>0&&crypto.timingSafeEqual(x,y)}
function messageId(payload){const id=String(payload?.messageId||"");if(!id)throw new Error("messageId is required.");return id}
function assertOutboundAllowed(account){
 const settings=getSettings();if(settings.masterPaused||account.paused)throw new Error("Outbound actions are paused.");
 if(!oauthStatus(account.id).authorized)throw new Error("Gmail profile is not authorized.");
 if(getSentUnitsToday(account.id)+1>account.dailyCap){setAccountPause(account.id,true,"daily_cap");throw new Error("Account daily send cap reached.");}
}
function actionHandlers(){
 return {
  "draft-reply":async a=>replyToMessage(a.accountId,messageId(a.payload),{text:String(a.payload.text||""),html:String(a.payload.html||""),mode:"draft"}),
  "send-reply":async a=>{const account=resolveAccount(a.accountId);assertOutboundAllowed(account);const r=await replyToMessage(a.accountId,messageId(a.payload),{text:String(a.payload.text||""),html:String(a.payload.html||""),mode:"send"});recordSendEvent({accountId:a.accountId,kind:"send",email:"reply",units:1});return r},
  archive:async a=>archiveMessage(a.accountId,messageId(a.payload)),
  trash:async a=>trashMessage(a.accountId,messageId(a.payload)),
  labels:async a=>modifyMessageLabels(a.accountId,messageId(a.payload),Array.isArray(a.payload.add)?a.payload.add:[],Array.isArray(a.payload.remove)?a.payload.remove:[]),
 };
}

export function installEventRoutes(app){
 app.post("/events/gmail",async(req,res)=>{
  try{
   const configured=process.env.GMAIL_PUSH_TOKEN||"";const supplied=req.get("x-gmail-push-token")||req.query.token||"";
   if(!configured)return res.status(503).json({error:"Gmail push endpoint is disabled until GMAIL_PUSH_TOKEN is configured."});
   if(!safeEqual(configured,supplied))return res.status(401).json({error:"invalid push token"});
   const result=await processNotification(req.body,{resolveAccount:accountByEmail,historySince,readMessage});
   res.json({ok:true,...result});
  }catch(error){res.status(error.status||400).json({error:error.message})}
 });
}

export function installAssistantRoutes(app){
 app.get("/api/assistant/unified",async(req,res)=>{try{res.json(await unifiedInbox(listAccounts(),{query:String(req.query.q||"in:inbox"),maxPerAccount:Number(req.query.max)||20,includeBodies:req.query.bodies!=="0"}))}catch(e){res.status(e.status||400).json({error:e.message})}});
 app.get("/api/assistant/plugins",(_req,res)=>res.json(listPlugins()));
 app.get("/api/assistant/semantic/status",(_req,res)=>res.json(semanticStats()));
 app.get("/api/assistant/semantic/search",async(req,res)=>{try{const q=String(req.query.q||"").trim();if(!q)return res.status(400).json({error:"q is required"});res.json({query:q,results:await semanticSearch(q,{accountId:String(req.query.account||""),limit:Number(req.query.limit)||10})})}catch(e){res.status(400).json({error:e.message})}});
 app.post("/api/assistant/semantic/index",async(req,res)=>{try{const account=resolveAccount(req.body?.account);const found=await searchMessages(account.id,String(req.body?.query||"newer_than:90d"),Math.max(1,Math.min(100,Number(req.body?.max)||50)));const indexed=[];for(const row of found.messages||[]){if(row.error)continue;const m=await readMessage(account.id,row.id);await indexSemanticMessage(account.id,m);indexed.push(row.id)}res.json({accountId:account.id,indexed:indexed.length,messageIds:indexed})}catch(e){res.status(e.status||400).json({error:e.message})}});
 app.get("/api/assistant/accounts/:ref/threads/:threadId/graph",async(req,res)=>{try{const account=resolveAccount(req.params.ref);const messages=await readThread(account.id,req.params.threadId);res.json({threadId:req.params.threadId,graph:buildThreadGraph(messages,{ownAddresses:[account.email,account.expectedEmail].filter(Boolean)}),messages})}catch(e){res.status(e.status||400).json({error:e.message})}});
 app.post("/api/assistant/accounts/:ref/messages/:messageId/deep-analyze",async(req,res)=>{try{const account=resolveAccount(req.params.ref);const message=await readMessage(account.id,req.params.messageId);const deterministic=analyzeMessage(message);const model=await localJson({task:"Analyze this email. Preserve the deterministic evidence and produce a concise summary, intent, requested actions, urgency, and uncertainty.",input:{message,deterministic},schema:{summary:"string",intent:"string",requestedActions:["string"],urgency:"low|normal|high",uncertainty:["string"]}});res.json({messageId:message.id,deterministic,model})}catch(e){res.status(e.status||400).json({error:e.message})}});
 app.post("/api/assistant/accounts/:ref/watch",async(req,res)=>{try{const account=resolveAccount(req.params.ref);const result=await watchInbox(account.id,String(req.body?.topicName||""));setHistoryCursor(account.id,result.historyId);res.json({accountId:account.id,...result})}catch(e){res.status(e.status||400).json({error:e.message})}});
 app.delete("/api/assistant/accounts/:ref/watch",async(req,res)=>{try{const account=resolveAccount(req.params.ref);res.json(await stopInboxWatch(account.id))}catch(e){res.status(e.status||400).json({error:e.message})}});
 app.get("/api/assistant/actions",(req,res)=>res.json(listActions({status:String(req.query.status||""),limit:Number(req.query.limit)||100})));
 app.post("/api/assistant/actions",(req,res)=>{try{const account=resolveAccount(req.body?.account);const allowed=new Set(["draft-reply","send-reply","archive","trash","labels"]);const type=String(req.body?.type||"");if(!allowed.has(type))return res.status(400).json({error:"unsupported action type"});res.status(201).json(stageAction({accountId:account.id,type,payload:req.body?.payload||{}}))}catch(e){res.status(e.status||400).json({error:e.message})}});
 app.post("/api/assistant/actions/:id/approve",(req,res)=>{try{res.json(approveAction(req.params.id))}catch(e){res.status(400).json({error:e.message})}});
 app.post("/api/assistant/actions/:id/reject",(req,res)=>{try{res.json(rejectAction(req.params.id))}catch(e){res.status(400).json({error:e.message})}});
 app.post("/api/assistant/actions/:id/execute",async(req,res)=>{try{const action=getAction(req.params.id);if(!action)return res.status(404).json({error:"action not found"});res.json(await executeAction(action.id,{handlers:actionHandlers()}))}catch(e){res.status(409).json({error:e.message})}});
}
