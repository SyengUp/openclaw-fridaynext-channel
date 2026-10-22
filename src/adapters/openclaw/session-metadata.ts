import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { SessionDescriptor } from "@syengup/fridaynext-channel-kit";
import { normalizeAgentId } from "../../agent-id.js";
import { resolvePluginDataRoot, sharedAdapterService } from "./environment.js";

type Binding = { logical: string; native: string; agentId: string };
function bindings() {
  const root=resolvePluginDataRoot();
  return sharedAdapterService("session-bindings",root,()=>{
    const file=path.join(root,"session-bindings.json");
    let entries:Binding[]=[];
    try { const data=JSON.parse(fs.readFileSync(file,"utf8")) as {sessions?:Binding[]}; entries=(data.sessions??[]).filter(b=>typeof b.logical === "string" && typeof b.native === "string" && typeof b.agentId === "string"); } catch { /* 首次启动没有旧绑定文件 */ }
    const byLogical=new Map(entries.map(b=>[b.logical,b]));
    const byNative=new Map(entries.map(b=>[b.native,b]));
    return {
      native:(key:string)=>byLogical.get(key)?.native,
      logical:(key:string)=>byNative.get(key)?.logical,
      ensure:(logical:string,rawAgent:string)=>{
        const agentId=normalizeAgentId(rawAgent);
        const existing=byLogical.get(logical);
        if(existing) { if(existing.agentId!==agentId) throw new Error("SESSION_AGENT_CONFLICT"); return existing; }
        const binding:Binding={logical,native:`agent:${agentId}:fridaynext:${crypto.randomUUID()}`,agentId};
        byLogical.set(logical,binding);byNative.set(binding.native,binding);
        fs.mkdirSync(root,{recursive:true});
        const temporary=`${file}.${process.pid}.tmp`,fd=fs.openSync(temporary,"w",0o600);
        try { fs.writeFileSync(fd,JSON.stringify({version:1,sessions:[...byLogical.values()]}));fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temporary,file);
        return binding;
      },
    };
  });
}

export function mappedNativeSessionKey(key:string):string|undefined { return bindings().native(key); }
export function logicalSessionKey(key:string):string { return bindings().logical(key) ?? key; }
export function ensureLogicalSession(key:string,agentId:string):string {
  if(/^agent:/i.test(key)) return key;
  return bindings().ensure(key,agentId).native;
}

export function describeSession(native:string,conversationId?:string):SessionDescriptor {
  const match=/^agent:([^:]+):(.+)$/i.exec(native),rest=match?.[2] ?? "";
  const kind:SessionDescriptor["kind"]=rest === "main" ? "system" : rest.startsWith("subagent:") ? "subagent" : rest.startsWith("cron:") ? "scheduled":"conversation";
  return {sessionKey:logicalSessionKey(native),agentId:match?.[1] ?? "main",kind,...(conversationId?{conversationId}:{})};
}
