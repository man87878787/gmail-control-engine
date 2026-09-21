import { scrubObject } from "./privacy.mjs";

function normalizeModelBaseUrl(value){
 const u=new URL(value);
 const host=u.hostname.toLowerCase();
 const local=["127.0.0.1","localhost","::1","[::1]"].includes(host);
 if(!local&&process.env.ALLOW_REMOTE_AI_ENDPOINTS!=="1"){
  throw new Error("Local model endpoint must use localhost unless ALLOW_REMOTE_AI_ENDPOINTS=1.");
 }
 return {base:u.toString().replace(/\/$/,""),remote:!local};
}

function extractJson(text){
 const s=String(text||"").trim();
 try{return JSON.parse(s)}catch{}
 const a=s.indexOf("{"),b=s.lastIndexOf("}");
 if(a>=0&&b>a)return JSON.parse(s.slice(a,b+1));
 throw new Error("Local model did not return valid JSON.");
}

export function buildJsonPrompt({task,input,schema}){
 return [
  "You are a local email-analysis component.",
  "Return ONLY valid JSON. No markdown and no commentary.",
  "Do not invent facts. Use null or [] when evidence is missing.",
  schema?"Required JSON shape: "+JSON.stringify(schema):"",
  "Task: "+String(task||""),
  "Input: "+JSON.stringify(input),
 ].filter(Boolean).join("\n");
}

export async function localJson({
 task,
 input,
 schema,
 model=process.env.OLLAMA_MODEL||"qwen3:4b",
 baseUrl=process.env.OLLAMA_URL||"http://127.0.0.1:11434",
 timeoutMs=30000,
 fetchImpl=fetch,
}){
 const {base:safeBase,remote}=normalizeModelBaseUrl(baseUrl);
 const safeInput=(remote||process.env.LOCAL_MODEL_SCRUB==="1")?scrubObject(input):input;
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const r=await fetchImpl(safeBase+"/api/generate",{
   method:"POST",
   headers:{"content-type":"application/json"},
   body:JSON.stringify({
    model,
    prompt:buildJsonPrompt({task,input:safeInput,schema}),
    stream:false,
    format:"json",
    options:{temperature:0},
   }),
   signal:controller.signal,
  });
  if(!r.ok)throw new Error("Local model HTTP "+r.status);
  const data=await r.json();
  return extractJson(data.response);
 }finally{
  clearTimeout(timer);
 }
}

export { extractJson as parseModelJson };
