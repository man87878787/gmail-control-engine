import { beginExecution, failExecution, finishExecution } from "./action-store.mjs";
export async function executeAction(id,{handlers}={}){
 const action=beginExecution(id);const fn=handlers?.[action.type];if(typeof fn!=="function"){const e=new Error("No executor registered for action type: "+action.type);failExecution(id,e);throw e}
 try{return finishExecution(id,await fn(action))}catch(error){failExecution(id,error);throw error}
}
