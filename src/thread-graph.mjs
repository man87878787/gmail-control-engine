import { analyzeMessage } from "./intelligence.mjs";
function norm(v){return String(v||"").trim()}
function refs(v){return norm(v).match(/<[^>]+>/g)||[]}
export function buildThreadGraph(messages=[],{ownAddresses=[]}={}){
 const own=new Set(ownAddresses.map(x=>x.toLowerCase()));
 const nodes=messages.map((m,i)=>({id:m.id||String(i),rfcId:norm(m.messageIdHeader)||null,inReplyTo:norm(m.inReplyTo)||null,references:refs(m.references),from:norm(m.from),date:m.date||"",analysis:analyzeMessage(m),message:m}));
 const byRfc=new Map(nodes.filter(n=>n.rfcId).map(n=>[n.rfcId,n]));
 const edges=[];const childIds=new Set();
 for(const n of nodes){
  const candidate=n.inReplyTo||n.references.at(-1)||"";
  const p=byRfc.get(candidate);
  if(p&&p.id!==n.id){edges.push({from:p.id,to:n.id,type:"reply"});childIds.add(n.id)}
 }
 const roots=nodes.filter(n=>!childIds.has(n.id)).map(n=>n.id);
 const children=new Map();for(const e of edges){if(!children.has(e.from))children.set(e.from,[]);children.get(e.from).push(e.to)}
 const leaves=nodes.filter(n=>!(children.get(n.id)||[]).length);
 const latest=[...nodes].sort((a,b)=>new Date(a.date||0)-new Date(b.date||0)).at(-1);
 const sender=(latest?.from.match(/<([^>]+)>/)?.[1]||latest?.from||"").toLowerCase();
 const fromSelf=own.has(sender);
 let bottleneck="none";
 if(latest?.analysis.replyLikely)bottleneck=fromSelf?"other-party":"you";
 const unresolved=leaves.filter(n=>n.analysis.replyLikely).map(n=>({messageId:n.id,requests:n.analysis.requests,from:n.from}));
 return {nodes:nodes.map(({message,...rest})=>rest),edges,roots,leaves:leaves.map(n=>n.id),unresolved,bottleneck};
}
