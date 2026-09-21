export function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
export function retryAfterMs(error){
 const h=error?.response?.headers||error?.headers;
 const raw=h?.get?.("retry-after")??h?.["retry-after"];
 if(!raw)return 0;
 const n=Number(raw); if(Number.isFinite(n))return Math.max(0,n*1000);
 const at=Date.parse(raw);return Number.isFinite(at)?Math.max(0,at-Date.now()):0;
}
export function isTransientError(error){
 const status=Number(error?.response?.status||error?.status||error?.code||0);
 return status===408||status===425||status===429||status>=500||["ECONNRESET","ETIMEDOUT","ENETUNREACH","EAI_AGAIN"].includes(String(error?.code||""));
}
export async function withRetry(fn,{attempts=5,baseMs=250,maxMs=8000,jitter=0.2,shouldRetry=isTransientError,onRetry=()=>{}}={}){
 let last;
 for(let attempt=1;attempt<=attempts;attempt++){
  try{return await fn(attempt)}catch(error){
   last=error;if(attempt>=attempts||!shouldRetry(error))throw error;
   const server=retryAfterMs(error);
   const exp=Math.min(maxMs,baseMs*(2**(attempt-1)));
   const spread=exp*jitter;
   const delay=Math.max(server,Math.round(exp-spread+Math.random()*spread*2));
   await onRetry({attempt,error,delay});
   await sleep(delay);
  }
 }
 throw last;
}
