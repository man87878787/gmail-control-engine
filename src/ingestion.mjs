import { emitEvent } from "./plugin-bus.mjs";
import { indexSemanticMessage } from "./semantic-store.mjs";
export function parsePubSubEnvelope(body){
 const encoded=body?.message?.data;if(!encoded)throw new Error("Pub/Sub message.data is required.");
 let data;try{data=JSON.parse(Buffer.from(encoded,"base64").toString("utf8"))}catch{throw new Error("Invalid Pub/Sub Gmail notification payload.")}
 if(!data.emailAddress||!data.historyId)throw new Error("Gmail notification requires emailAddress and historyId.");
 return {emailAddress:String(data.emailAddress).toLowerCase(),historyId:String(data.historyId),messageId:String(body?.message?.messageId||"")};
}
export async function processNotification(body,{resolveAccount,historySince,readMessage,embeddingOptions={}}){
 const note=parsePubSubEnvelope(body);const account=await resolveAccount(note.emailAddress);if(!account)throw new Error("No configured account for "+note.emailAddress);
 const changes=await historySince(account.id,note.historyId);const indexed=[];
 for(const change of changes.messagesAdded||[]){const id=change.message?.id||change.id;if(!id)continue;const message=await readMessage(account.id,id);await indexSemanticMessage(account.id,message,embeddingOptions);indexed.push(id);await emitEvent("message.received",{account,message});}
 await emitEvent("gmail.history",{account,notification:note,indexed});
 return {accountId:account.id,historyId:changes.historyId||note.historyId,indexed};
}
