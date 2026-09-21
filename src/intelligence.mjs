const ACTION_PATTERNS = [
  ["payment", /\b(invoice|payment|paid|refund|charge|receipt|billing|balance due)\b/i],
  ["meeting", /\b(meeting|appointment|schedule|calendar|zoom|teams|call)\b/i],
  ["account", /\b(account|login|password|security|verification|verify|sign[ -]?in)\b/i],
  ["order", /\b(order|shipment|shipping|delivered|tracking|return)\b/i],
  ["support", /\b(help|support|issue|problem|broken|error|not working)\b/i],
];

const URGENCY = /\b(urgent|asap|immediately|today|deadline|time[- ]sensitive|overdue)\b/i;
const QUESTION = /\?|\b(can you|could you|would you|please|need you to|let me know|reply|respond|confirm)\b/i;
const AUTO = /\b(no[- ]?reply|noreply|automated|do not reply|notification)\b/i;

function cleanText(value="") {
  return String(value).replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<[^>]+>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&")
    .replace(/\s+/g," ").trim();
}

function sentences(text) {
  return cleanText(text).split(/(?<=[.!?])\s+/).filter(Boolean);
}

function extractDates(text) {
  const out = new Set();
  const patterns = [
    /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\b/gi,
    /\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/g,
    /\b(?:today|tomorrow|tonight|next\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/gi,
  ];
  for (const p of patterns) for (const m of text.match(p)||[]) out.add(m);
  return [...out].slice(0,10);
}

function extractMoney(text) {
  return [...new Set((text.match(/(?:\$|USD\s*)\d[\d,]*(?:\.\d{2})?/gi)||[]))].slice(0,10);
}

function extractLinks(text) {
  return [...new Set((String(text).match(/https?:\/\/[^\s<>"')]+/gi)||[]))].slice(0,20);
}

export function analyzeMessage(message) {
  const body = cleanText(message.text || message.html || message.snippet || "");
  const combined = [message.subject, message.from, body].filter(Boolean).join("\n");
  const cats = ACTION_PATTERNS.filter(([,p])=>p.test(combined)).map(([n])=>n);
  const asks = sentences(body).filter(s=>QUESTION.test(s)).slice(0,5);
  const replyLikely = !AUTO.test(message.from+" "+body) && (QUESTION.test(body) || QUESTION.test(message.subject||""));
  const urgency = URGENCY.test(combined) ? "high" : replyLikely ? "normal" : "low";
  const summaryParts = sentences(body).filter(s=>s.length>20).slice(0,3);
  return {
    summary: summaryParts.join(" ").slice(0,900) || cleanText(message.snippet || message.subject || ""),
    category: cats[0] || "general",
    categories: cats.length ? cats : ["general"],
    urgency,
    replyLikely,
    automatedLikely: AUTO.test(message.from+" "+body),
    requests: asks,
    entities: { dates: extractDates(combined), money: extractMoney(combined), links: extractLinks(message.html+"\n"+body) },
    signals: { hasQuestion: QUESTION.test(body), hasDeadline: URGENCY.test(combined) },
  };
}

export function analyzeThread(messages=[]) {
  const analyses = messages.map(analyzeMessage);
  const openRequests = analyses.flatMap(a=>a.requests).slice(-10);
  return {
    messageCount: messages.length,
    summary: analyses.map(a=>a.summary).filter(Boolean).slice(-4).join(" ").slice(0,1400),
    urgency: analyses.some(a=>a.urgency==="high") ? "high" : analyses.some(a=>a.urgency==="normal") ? "normal" : "low",
    replyLikely: analyses.length ? analyses.at(-1).replyLikely : false,
    openRequests,
    categories: [...new Set(analyses.flatMap(a=>a.categories))],
    entities: {
      dates:[...new Set(analyses.flatMap(a=>a.entities.dates))].slice(0,10),
      money:[...new Set(analyses.flatMap(a=>a.entities.money))].slice(0,10),
      links:[...new Set(analyses.flatMap(a=>a.entities.links))].slice(0,20),
    },
  };
}
