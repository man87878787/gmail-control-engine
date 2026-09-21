import { EventEmitter } from "node:events";
const emitter=new EventEmitter();emitter.setMaxListeners(50);
const plugins=new Map();
function timeout(p,ms,name){return Promise.race([p,new Promise((_,rej)=>setTimeout(()=>rej(new Error("Plugin timeout: "+name)),ms))])}
export function registerPlugin(plugin){
 if(!plugin?.name||typeof plugin.handle!=="function")throw new Error("Plugin requires name and handle(event,payload).");
 if(plugins.has(plugin.name))throw new Error("Plugin already registered: "+plugin.name);
 const entry={events:new Set(plugin.events||["*"]),handle:plugin.handle,timeoutMs:Math.max(100,Math.min(30000,Number(plugin.timeoutMs)||5000))};
 plugins.set(plugin.name,entry);return ()=>plugins.delete(plugin.name);
}
export async function emitEvent(event,payload,{onError=()=>{}}={}){
 const results=[];
 for(const [name,p] of plugins){
  if(!p.events.has("*")&&!p.events.has(event))continue;
  try{results.push({name,ok:true,result:await timeout(Promise.resolve(p.handle(event,payload)),p.timeoutMs,name)})}
  catch(error){onError({name,event,error});results.push({name,ok:false,error:error.message})}
 }
 emitter.emit(event,payload);return results;
}
export function onEvent(event,handler){emitter.on(event,handler);return()=>emitter.off(event,handler)}
export function listPlugins(){return [...plugins.entries()].map(([name,p])=>({name,events:[...p.events],timeoutMs:p.timeoutMs}))}
