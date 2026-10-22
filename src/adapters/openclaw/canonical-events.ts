import { canonicalPayload, isCanonicalPayload, type CanonicalUpdate, type JSONObject, type AttachmentDescriptor } from "@syengup/fridaynext-channel-kit";
import type { DurableRuntimeEvent } from "../../runtime-v3/durable-run-store.js";
import { logicalSessionKey } from "./session-metadata.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const json = (value: Record<string, unknown>): JSONObject => JSON.parse(JSON.stringify(value)) as JSONObject;
const visible = (value: unknown): string | undefined => {
  const text = string(value);
  return text && !["NO_REPLY", "HEARTBEAT_OK"].includes(text.trim()) ? text : undefined;
};
const details = (data: Record<string, unknown>): JSONObject => {
  const keys = ["name","toolName","toolCallId","itemId","kind","args","arguments","input","result","output","command","status","summary","title","progressText","meta","durationMs","startedAt","endedAt","tokensBefore","tokensAfter","completed","willRetry","error","isError","exitCode","language","usage","modelName","totalTokens","contextTokensUsed","contextWindowMax","hideFromChannelProgress","fileName","mediaUrl","mediaUrls","mediaKind","questionId","approvalId","expiresAtMs","questions","answers","choices","options","commandPreview","description","allowPermanent","allowSession","actions","metadata","commandText","cwd","host","severity","decision","resolvedBy","statusLine","answeredLabels","caption","audioAsVoice","requestId","reason","outcome","depth","label","parentRunId","runId","childSessionKey","sessionKey"];
  return json(Object.fromEntries(keys.filter(key => data[key] !== undefined).map(key => [key,data[key]])));
};

function normalizedAttachments(data:Record<string,unknown>):AttachmentDescriptor[] {
  const meta=object(object(data.channelData).fridayNext),voice=data.audioAsVoice === true || ["tts","tts_likely"].includes(String(meta.mediaKind ?? data.mediaKind));
  const urls=[...(Array.isArray(data.mediaUrls) ? data.mediaUrls:[]),...(typeof data.mediaUrl === "string" ? [data.mediaUrl]:[])].filter((url):url is string=>typeof url === "string");
  return [...new Set(urls)].map(url=>{
    const filename=decodeURIComponent(url.split("?")[0].split("/").at(-1) ?? "attachment"),extension=filename.split(".").at(-1)?.toLowerCase();
    const kind=voice ? "voice":["jpg","jpeg","png","webp","gif","heic"].includes(extension ?? "") ? "image":["mp3","m4a","wav","aac","ogg","opus"].includes(extension ?? "") ? "audio":"file";
    return {id:url,url,filename,mimeType:kind === "image" ? `image/${extension === "jpg" ? "jpeg":extension}`:kind === "voice" || kind === "audio" ? "audio/mpeg":"application/octet-stream",kind};
  });
}
function presentationDetails(payload:Record<string,unknown>):JSONObject {
  const metadata=object(object(payload.channelData).fridayNext);
  return {...details(payload),...details(metadata)};
}

function normalizeSource(type: string, raw: unknown, wire: DurableRuntimeEvent): CanonicalUpdate[] {
  const source=object(raw), data=object(source.data);
  if (type === "agent") {
    const stream=string(source.stream) ?? "";
    if (stream === "lifecycle") {
      const phase=({start:"running",end:"completed",error:"failed"} as Record<string,string>)[String(data.phase)];
      return phase ? [{kind:"run",phase:["run.cancelled"].includes(wire.eventType) ? "cancelled":phase,data:details(data)}] : [];
    }
    if(stream === "item") {
      const kind=string(data.kind) ?? "";
      if(data.hideFromChannelProgress === true || kind === "answer_candidate" || (data.suppressChannelProgress === true && kind === "tool")) return [];
      const id=string(data.toolCallId) ?? string(data.itemId);
      if(["analysis","preamble"].includes(kind)) {
        const text=string(data.progressText) ?? string(data.summary);
        return text ? [{kind:"text",id,channel:"reasoning",operation:"replace",text}]:[];
      }
      if(["command","process"].includes(kind)) return [{kind:"activity",id:string(data.itemId),phase:string(data.phase),text:string(data.output) ?? string(data.summary),operation:"replace",data:json({...details(data),presentation:"terminal",name:string(data.name) ?? kind})}];
      if(["tool","patch","search"].includes(kind)) return [{kind:"tool",id,phase:string(data.phase),data:json({...details(data),name:string(data.name) ?? kind,result:data.summary ?? data.result ?? null})}];
      return [];
    }
    if(stream === "compaction") return [{kind:"activity",id:string(data.itemId) ?? `context:${wire.runId}`,phase:string(data.phase),data:json({...details(data),presentation:"context-compaction"})}];
    if (["assistant","thinking","reasoning"].includes(stream)) {
      const delta=visible(data.delta), text=visible(data.text);
      if (!delta && !text) return [];
      return [{kind:"text",id:string(data.itemId),channel:stream === "assistant" ? "answer" : "reasoning",operation:delta !== undefined ? "append":"replace",...(delta !== undefined ? {delta}:{text}),data:json({...details(data),...((data.textPrefixChars ?? data.text_prefix_chars ?? data.reasoningPrefixChars ?? data.reasoning_prefix_chars) !== undefined ? {prefixUTF16:data.textPrefixChars ?? data.text_prefix_chars ?? data.reasoningPrefixChars ?? data.reasoning_prefix_chars}:{})})}];
    }
    if (stream === "tool" && (data.name === "progress_card" || data.toolName === "progress_card")) {
      return data.phase === "start" ? [{kind:"extension",id:"progress-card",operation:"replace",data:json(object(data.args ?? data.arguments))}]:[];
    }
    if (stream === "tool") return [{kind:"tool",id:string(data.toolCallId) ?? string(data.itemId),phase:string(data.phase) ?? "update",data:details(data)}];
    if (["command_output","process_output"].includes(stream)) return [{kind:"activity",id:string(data.itemId),phase:string(data.phase) ?? "update",text:string(data.output) ?? string(data.text),operation:"replace",data:json({...details(data),presentation:"terminal"})}];
    return [];
  }
  if (type === "deliver") {
    const payload=object(source.payload), text=visible(payload.text), result: CanonicalUpdate[]=[];
    const askUser=object(object(payload.channelData).askUser);
    if (Object.keys(askUser).length) result.push({kind:"control",id:string(askUser.id) ?? string(askUser.questionId),phase:"request",data:json({kind:"question",generation:`${wire.runId}:${string(askUser.id) ?? string(askUser.questionId) ?? ""}`})});
    if (text) result.push({kind:"text",channel:"answer",operation:"replace",text,phase:string(source.kind),data:presentationDetails(payload)});
    const attachments=normalizedAttachments(payload);
    if(attachments.length) result.push({kind:"extension",id:"message.attachments",attachments});
    return result;
  }
  if (type === "outbound") {
    const op=string(source.op);
    if (op === "text") {
      const text=visible(source.text);
      return text ? [{kind:"text",channel:"answer",operation:"replace",text,data:details(source)}]:[];
    }
    if(op === "media") return [{kind:"extension",id:"message.attachments",attachments:normalizedAttachments({...object(source.ctx),...source}),data:presentationDetails(source)}];
    if(op === "final_meta") return [{kind:"session",data:presentationDetails(source)}];
    if (op === "dispatch_error") return [{kind:"run",phase:"failed",data:details(source)}];
    return [{kind:"extension",id:op ?? "outbound",phase:op,data:details(source)}];
  }
  if (type === "tool-hook") return [{kind:"tool",id:string(source.toolCallId),phase:source.when === "before" ? "start":"result",data:details(source)}];
  if (type === "subagent") return [{kind:"subagent",id:string(source.toolCallId) ?? string(source.childSessionKey) ?? string(source.runId),phase:string(source.phase),data:details(source)}];
  if (type === "approval" || type === "question") return [{kind:"control",id:string(source.approvalId) ?? string(source.questionId) ?? string(source.id),phase:string(source.op) ?? "request",data:json({...details(source),kind:type,generation:string(source.generation) ?? string(source.executionGeneration) ?? `${wire.runId}:${string(source.approvalId) ?? string(source.questionId) ?? string(source.id) ?? String(wire.runSeq)}`})}];
  if (type === "session-title") return [{kind:"session",phase:"updated",data:json({title:source.title})}];
  if (["fridaynext-health-query","fridaynext-health-log","fridaynext-calendar-query","fridaynext-calendar-log","fridaynext-location-query"].includes(type)) {
    const keys=["requestId","metrics","start","end","bucket","samples","kinds","limit","items","sessionKey","runId"];
    return [{kind:"device",id:string(source.requestId),phase:"request",data:json({...Object.fromEntries(keys.filter(key=>source[key] !== undefined).map(key=>[key,source[key]])),kind:type.slice("fridaynext-".length)})}];
  }
  if(type === "inbox-changed") return [{kind:"extension",id:"inbox-changed",data:{}}];
  return [];
}

// 仅此适配器理解旧宿主事件；规范载荷不含原始 SSE 信封或私有事件字段。
export function canonicalizeRuntimeEvent(wire: DurableRuntimeEvent): DurableRuntimeEvent {
  if (isCanonicalPayload(wire.payload)) return {...wire,sessionKey:logicalSessionKey(wire.sessionKey)};
  const payload=object(wire.payload);
  const sources=Array.isArray(payload._sourceEventBatch) ? payload._sourceEventBatch.map(object) : [{type:payload._sourceEventType,data:payload._sourceEventData}];
  let updates=sources.flatMap(source => typeof source.type === "string" ? normalizeSource(source.type,source.data,wire):[]);
  if (!updates.length && !payload._sourceEventType && !payload._sourceEventBatch) {
    const phase=({"run.accepted":"accepted","run.queued":"queued","dispatch.started":"running","run.started":"running","run.completed":"completed","run.failed":"failed","run.cancelled":"cancelled","run.reconciling":"reconciling","run.recovered":"running"} as Record<string,string>)[wire.eventType];
    if (phase) updates=[{kind:"run",phase,data:details(payload)}];
  }
  return {...wire,sessionKey:logicalSessionKey(wire.sessionKey),payload:canonicalPayload(updates)};
}
