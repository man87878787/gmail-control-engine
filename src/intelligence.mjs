const CATEGORIES = [
  ["payment", /\b(invoice|payment|paid|refund|charge|receipt|billing|balance due|subscription|renewal)\b/i],
  ["meeting", /\b(meeting|appointment|schedule|calendar|zoom|teams|call|reschedule)\b/i],
  ["account", /\b(account|login|password|security|verification|verify|sign[ -]?in|2fa|two-factor)\b/i],
  ["order", /\b(order|shipment|shipping|delivered|delivery|tracking|return|package)\b/i],
  ["support", /\b(help|support|issue|problem|broken|error|not working|troubleshoot)\b/i],
  ["school", /\b(class|assignment|teacher|school|homework|grade|course)\b/i],
  ["legal", /\b(legal|contract|agreement|terms|notice|attorney|court)\b/i],
];
const URGENT=/\b(urgent|asap|immediately|today|deadline|time[- ]sensitive|overdue|final notice|action required)\b/i;
const REQUEST=/\?|\b(can you|could you|would you|will you|please|need you to|let me know|reply|respond|confirm|send me|provide|complete|review|approve)\b/i;
const AUTO=/\b(no[- ]?reply|noreply|do not reply|automated (?:message|email)|notification@|mailer-daemon)\b/i;
const RISK=/\b(password|passcode|verification code|one[- ]time code|otp|ssn|social security|credit card|debit card|bank account|routing number|seed phrase|private key)\b/i;
const PHISH=/\b(verify your account|account (?:will be )?(?:closed|suspended)|click (?:here|below)|unusual activity|confirm your identity|gift card|crypto(?:currency)? payment)\b/i;

export function cleanText(value=""){
 return String(value).replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<script[\s\S]*?<\/script>/gi," ")
 .replace(/<br\s*\/?>/gi,"\n").replace(/<\/p>/gi,"\n").replace(/<[^>]+>/g," ")
 .replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&lt;/gi,"<").replace(/&gt;/gi,">")
 .replace(/[ \t]+/g," ").replace(/\n{3,}/g,"\n\n").trim();
}
function sentences(t){return cleanText(t).split(/(?<=[.!?])\s+|\n+/).map(x=>x.trim()).filter(Boolean)}
function uniq(xs,n=10){return [...new Set(xs.filter(Boolean))].slice(0,n)}
function dates(t){const ps=[/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\b/gi,/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/g,/\b(?:today|tomorrow|tonight|this (?:morning|afternoon|evening)|next\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/gi];return uniq(ps.flatMap(p=>t.match(p)||[]))}
function money(t){return uniq(t.match(/(?:\$|USD\s*)\d[\d,]*(?:\.\d{1,2})?/gi)||[])}
function links(t){return uniq(String(t).match(/https?:\/\/[^\s<>"')]+/gi)||[],20)}
function phones(t){return uniq(t.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g)||[])}
function emails(t){return uniq((t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[]).map(x=>x.toLowerCase()))}
function scorePriority({urgent,reply,unread=false,risk=false,automated=false}){
 let score=0;if(urgent)score+=45;if(reply)score+=25;if(unread)score+=10;if(risk)score+=10;if(automated)score-=20;
 return Math.max(0,Math.min(100,score));
}
export function analyzeMessage(message={}){
 const body=cleanText(message.text||message.html||message.snippet||"");
 const combined=[message.subject,message.from,body].filter(Boolean).join("\n");
 const categories=CATEGORIES.filter(([,p])=>p.test(combined)).map(([n])=>n);
 const requests=sentences(body).filter(s=>REQUEST.test(s)).slice(0,8);
 const automatedLikely=AUTO.test((message.from||"")+" "+body);
 const replyLikely=!automatedLikely&&(requests.length>0||REQUEST.test(message.subject||""));
 const urgent=URGENT.test(combined), risk=RISK.test(combined), suspicious=PHISH.test(combined);
 const unread=Array.isArray(message.labelIds)&&message.labelIds.includes("UNREAD");
 const priorityScore=scorePriority({urgent,reply:replyLikely,unread,risk,automated:automatedLikely});
 const summary=sentences(body).filter(s=>s.length>15).slice(0,4).join(" ").slice(0,1200)||cleanText(message.snippet||message.subject||"");
 return {
  summary, category:categories[0]||"general", categories:categories.length?categories:["general"],
  urgency:urgent?"high":replyLikely?"normal":"low", priorityScore, replyLikely, automatedLikely,
  requests, entities:{dates:dates(combined),money:money(combined),links:links((message.html||"")+"\n"+body),emails:emails(combined),phones:phones(combined)},
  safety:{sensitiveDataMentioned:risk,suspiciousLanguage:suspicious,advice:suspicious?"Treat links/requests cautiously and verify the sender independently.":null},
  signals:{hasQuestion:body.includes("?"),hasDeadline:urgent,unread},
  confidence:{category:categories.length?0.82:0.45,replyLikely:requests.length?0.86:0.62,urgency:urgent?0.9:0.7}
 };
}
export function analyzeThread(messages=[]){
 const a=messages.map(analyzeMessage), last=a.at(-1);
 return {messageCount:messages.length,summary:a.map(x=>x.summary).filter(Boolean).slice(-5).join(" ").slice(0,1800),
  urgency:a.some(x=>x.urgency==="high")?"high":last?.urgency||"low",priorityScore:Math.max(0,...a.map(x=>x.priorityScore)),
  replyLikely:Boolean(last?.replyLikely),openRequests:last?.requests||[],categories:uniq(a.flatMap(x=>x.categories),20),
  entities:{dates:uniq(a.flatMap(x=>x.entities.dates)),money:uniq(a.flatMap(x=>x.entities.money)),links:uniq(a.flatMap(x=>x.entities.links),20),emails:uniq(a.flatMap(x=>x.entities.emails)),phones:uniq(a.flatMap(x=>x.entities.phones))},
  safety:{sensitiveDataMentioned:a.some(x=>x.safety.sensitiveDataMentioned),suspiciousLanguage:a.some(x=>x.safety.suspiciousLanguage)}};
}
