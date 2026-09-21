import { analyzeMessage, analyzeThread } from "./intelligence.mjs";
import { readMessage, searchMessages } from "./gmail.mjs";

function out(v){ process.stdout.write(JSON.stringify(v,null,2)+"\n"); }
const [cmd, account, target, maxArg] = process.argv.slice(2);

async function readThread(accountId, threadId) {
  const found = await searchMessages(accountId, "thread:"+threadId, 100);
  const rows=[];
  for (const item of found.messages||[]) {
    if (!item.error) rows.push(await readMessage(accountId,item.id));
  }
  rows.sort((a,b)=>new Date(a.date||0)-new Date(b.date||0));
  return rows;
}

try {
  if (cmd==="understand") {
    if(!account||!target) throw new Error("Usage: smart understand <account> <message-id>");
    const message=await readMessage(account,target);
    out({message, intelligence:analyzeMessage(message)});
  } else if (cmd==="thread") {
    if(!account||!target) throw new Error("Usage: smart thread <account> <thread-id>");
    const messages=await readThread(account,target);
    out({threadId:target, messages, intelligence:analyzeThread(messages)});
  } else if (cmd==="triage") {
    if(!account) throw new Error("Usage: smart triage <account> [gmail-query] [max]");
    const query=target||"in:inbox";
    const found=await searchMessages(account,query,Math.min(50,Number(maxArg)||20));
    const rows=[];
    for(const item of found.messages||[]) {
      if(item.error){ rows.push(item); continue; }
      const message=await readMessage(account,item.id);
      rows.push({...item,intelligence:analyzeMessage(message)});
    }
    const rank={high:0,normal:1,low:2};
    rows.sort((a,b)=>(rank[a.intelligence?.urgency]??9)-(rank[b.intelligence?.urgency]??9));
    out({query,count:rows.length,messages:rows});
  } else {
    out({commands:{
      understand:"smart understand <account> <message-id>",
      thread:"smart thread <account> <thread-id>",
      triage:"smart triage <account> [gmail-query] [max]"
    }});
  }
} catch(error){ out({ok:false,error:error.message}); process.exitCode=1; }
