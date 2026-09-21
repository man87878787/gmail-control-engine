import { analyzeMessage } from "./intelligence.mjs";
import { readMessage, searchMessages } from "./gmail.mjs";
export async function unifiedInbox(accounts,{query="in:inbox",maxPerAccount=20,includeBodies=true}={}){
 const all=[];
 await Promise.all(accounts.map(async account=>{
  const ref=typeof account==="string"?account:account.id||account.alias;
  const label=typeof account==="string"?account:account.label||account.alias||ref;
  const found=await searchMessages(ref,query,Math.max(1,Math.min(50,maxPerAccount)));
  for(const item of found.messages||[]){
   if(item.error){all.push({...item,account:ref,accountLabel:label});continue}
   const message=includeBodies?await readMessage(ref,item.id):item;const intelligence=analyzeMessage(message);
   all.push({...message,account:ref,accountLabel:label,intelligence});
  }
 }));
 all.sort((a,b)=>(b.intelligence?.priorityScore??-1)-(a.intelligence?.priorityScore??-1)||new Date(b.date||0)-new Date(a.date||0));
 return {query,count:all.length,messages:all};
}
