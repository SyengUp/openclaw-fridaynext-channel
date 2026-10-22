import type {FridayHistoryMessage} from "../../history/normalize-message.js";
import {HISTORY_TEXT_MAX_CHARS} from "../../history/normalize-message.js";
const wake=new Set(["[openclaw heartbeat poll]","[openclaw exec completion]","[openclaw cron wake]","[openclaw session event]"]);
type HistoryDisplayOptions = { userTextByRequest?: ReadonlyMap<string, string>; fullText?: boolean };
// 宿主控制文本和自动副本在适配边界归一化，客户端只读取声明的展示事实。
export function canonicalHistory(messages:FridayHistoryMessage[], ownedRequests:ReadonlySet<string>, requestByRun:ReadonlyMap<string,string> = new Map(), options:HistoryDisplayOptions = {}):FridayHistoryMessage[] {
  const runsByRequest = new Map<string, string[]>();
  for (const [runId, requestId] of requestByRun) {
    if (ownedRequests.has(requestId)) runsByRequest.set(requestId, [...(runsByRequest.get(requestId) ?? []), runId]);
  }
  const scoped = messages.map(message => {
    const row = {...message};
    if (row.clientRequestId && !ownedRequests.has(row.clientRequestId)) delete row.clientRequestId;
    if (row.kind !== "compaction") {
      if (row.runId && !requestByRun.has(row.runId)) delete row.runId;
      const request = row.runId ? requestByRun.get(row.runId) : undefined;
      if (!row.clientRequestId && request && ownedRequests.has(request)) row.clientRequestId = request;
    }
    return row;
  });
  // 老宿主的用户记录没有频道请求身份，但助手记录保留真实 runId。
  // 只在同一原生用户回合内、账本关联唯一时回填，禁止按正文或时间猜测。
  for (const [index, row] of scoped.entries()) {
    if (row.role !== "user" || row.kind === "hidden" || /^\[cron:\S+\s+[^\]]+\]/.test((row.text ?? "").trim()) || wake.has((row.text ?? "").trim().toLowerCase())) continue;
    const requests = new Set(row.clientRequestId ? [row.clientRequestId] : []);
    for (let next = index + 1; next < scoped.length; next++) {
      const candidate = scoped[next];
      if (candidate.role === "user" || candidate.kind === "turnBoundary") break;
      if (candidate.role === "assistant" && candidate.clientRequestId) requests.add(candidate.clientRequestId);
    }
    if (requests.size === 1) row.clientRequestId = [...requests][0];
  }
  let lastUser:string|undefined,lastRequest:string|undefined,visibleAssistant=false;
  return scoped.map(message=>{
    const row={...message,format:"canonical-v1" as const};
    // 分叉前缀可保留原请求的宿主元数据，只有当前会话的命令才允许关联本地乐观消息。
    if(row.clientRequestId && !ownedRequests.has(row.clientRequestId)) delete row.clientRequestId;
    if (row.role === "user" && row.clientRequestId) {
      const original = options.userTextByRequest?.get(row.clientRequestId);
      if (original !== undefined) {
        if (!options.fullText && original.length > HISTORY_TEXT_MAX_CHARS) {
          row.text = original.slice(0, HISTORY_TEXT_MAX_CHARS);
          row.truncated = true;
        } else {
          row.text = original;
          delete row.truncated;
        }
      }
    }
    const text=(row.text ?? "").trim();
    if(row.role === "user") {
      if(/^\[cron:\S+\s+[^\]]+\]/.test(text) || wake.has(text.toLowerCase())) {lastRequest=undefined;return {...row,role:"system",kind:"turnBoundary",text:""};}
      if(text && lastUser === text && !visibleAssistant && (!row.clientRequestId || row.clientRequestId === lastRequest)) return {...row,role:"system",kind:"hidden",text:""};
      lastUser=text;lastRequest=row.clientRequestId;visibleAssistant=false;
    }
    if(row.role === "assistant" && !row.clientRequestId && lastRequest) row.clientRequestId=lastRequest;
    if (!row.runId && row.clientRequestId) {
      const runs = runsByRequest.get(row.clientRequestId) ?? [];
      if (runs.length === 1) row.runId = runs[0];
    }
    if(row.role === "assistant" && ["NO_REPLY","HEARTBEAT_OK"].includes(text.toUpperCase())) row.text="";
    if(text.startsWith("[Inter-session message]") || text.includes("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>")) return {...row,kind:"hidden"};
    if(row.role === "assistant" && (row.text || row.thinking || row.images?.length || row.toolCalls?.length)) visibleAssistant=true;
    return row;
  });
}
