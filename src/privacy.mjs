const SECRET_KEYS=/^(?:authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|agent[_-]?key|password|passcode|secret)$/i;
const TOKEN_PATTERNS=[
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bya29\.[0-9A-Za-z_-]+\b/g,
];
export function scrubText(value=""){
 let s=String(value);
 for(const p of TOKEN_PATTERNS)s=s.replace(p,"[REDACTED_TOKEN]");
 s=s.replace(/([A-Z0-9._%+-])[A-Z0-9._%+-]*(@[A-Z0-9.-]+\.[A-Z]{2,})/gi,"$1***$2");
 s=s.replace(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g,"[REDACTED_PHONE]");
 s=s.replace(/\b(?:\d[ -]*?){13,19}\b/g,m=>/[ -]/.test(m)||m.length>=13?"[REDACTED_NUMBER]":m);
 s=s.replace(/\b\d{1,6}\s+[A-Za-z0-9.' -]{2,50}\s(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Court|Ct|Drive|Dr|Lane|Ln|Way)\b/gi,"[REDACTED_ADDRESS]");
 return s;
}
export function scrubObject(value,seen=new WeakSet()){
 if(value==null||typeof value==="number"||typeof value==="boolean")return value;
 if(typeof value==="string")return scrubText(value);
 if(typeof value!=="object")return String(value);
 if(seen.has(value))return "[CIRCULAR]";
 seen.add(value);
 if(Array.isArray(value))return value.map(v=>scrubObject(v,seen));
 const out={};
 for(const [k,v] of Object.entries(value))out[k]=SECRET_KEYS.test(k)?"[REDACTED_SECRET]":scrubObject(v,seen);
 return out;
}
export function safeLogDetail(value){return scrubObject(value)}
export function safeJson(value){return JSON.stringify(scrubObject(value))}
