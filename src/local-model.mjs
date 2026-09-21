import { scrubObject } from "./privacy.mjs";
function isLoopback(value){try{const h=new URL(value).hostname.toLowerCase();return h==="127.0.0.1"||h==="localhost"||h==="::1"||h==="[::1]"}catch{return false}}
function extractJson(text){
 const s=String(text||"").trim();
 try{return JSON.parse(s)}catch{}
 const a=s.indexOf("{"),b=s.lastIndexOf("}");if(a>=0&&b>a)return JSON.parse(s.slice(a,b+1));
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
export async function localJson({task,input,schema,model=process.env.OLLAMA_MODEL||"qwen3:4b",baseUrl=process.env.OLLAMA_URL||"http://127.0.0.1:11434",timeoutMs=30000,fetchImpl=fetch}){
 const remote=!isLoopback(baseUrl);if(remote&&process.env.ALLOW_REMOTE_MODEL!=="1")throw new Error("Remote model endpoints are blocked by default. Set ALLOW_REMOTE_MODEL=1 to opt in.");
 const safeInput=(remote||process.env.LOCAL_MODEL_SCRUB==="1")?scrubObject(input):input;
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const r=await fetchImpl(baseUrl.replace(/\/$/,"")+"/api/generate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model,prompt:buildJsonPrompt({task,input:safeInput,schema}),stream:false,format:"json",options:{temperature:0}}),signal:controller.signal});
  if(!r.ok)throw new Error("Local model HTTP "+r.status);
  const data=await r.json();return extractJson(data.response);
 }finally{clearTimeout(timer)}
}
export { extractJson as parseModelJson };
