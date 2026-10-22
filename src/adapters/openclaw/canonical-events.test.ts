import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalizeRuntimeEvent } from "./canonical-events.js";
import type { DurableRuntimeEvent } from "../../runtime-v3/durable-run-store.js";

function event(type: string, data: Record<string, unknown>): DurableRuntimeEvent {
  return { protocolVersion:3,serverInstanceId:"server",eventId:7,sessionKey:"agent:main:existing",agentId:"main",runId:"run",runSeq:3,eventType:"agent.assistant.delta",occurredAt:1,payload:{_sourceEventType:type,_sourceEventData:data} };
}

describe("OpenClaw 规范事件适配", () => {
  it("转换正文增量并保留外层身份，不把旧事件带给客户端", () => {
    const normalized=canonicalizeRuntimeEvent(event("agent",{stream:"assistant",data:{delta:"你好🙂"}}));
    expect(normalized).toMatchObject({eventId:7,runSeq:3,payload:{format:"canonical-v1",updates:[{kind:"text",channel:"answer",operation:"append",delta:"你好🙂"}]}});
    expect(JSON.stringify(normalized)).not.toContain("_sourceEvent");
    expect(normalized.sessionKey).toBe("agent:main:existing");
  });
  it("最终正文与运行完成是不同更新", () => {
    expect(canonicalizeRuntimeEvent(event("deliver",{kind:"final",payload:{text:"完成"}})).payload).toMatchObject({updates:[{kind:"text",operation:"replace",text:"完成"}]});
    expect(canonicalizeRuntimeEvent(event("agent",{stream:"lifecycle",data:{phase:"end"}})).payload).toMatchObject({updates:[{kind:"run",phase:"completed"}]});
  });
  it("控制哨兵只在助手内容适配时静音", () => {
    expect(canonicalizeRuntimeEvent(event("deliver",{kind:"final",payload:{text:"NO_REPLY"}})).payload).toMatchObject({updates:[]});
  });
  it("真实流式样本中的隐藏候选不进入公共展示面",()=>{
    const captured=JSON.parse(fs.readFileSync(new URL("../../sse/fixtures/runtime-streaming-updates.json",import.meta.url),"utf8")) as Array<{payload:Record<string,unknown>}>;
    const normalized=captured.map(row=>canonicalizeRuntimeEvent({...event("agent",{}),payload:row.payload}));
    expect(normalized.filter(row=>(row.payload.updates as unknown[]).length === 0)).toHaveLength(12);
    expect(JSON.stringify(normalized)).not.toContain("answer_candidate");
  });
  it("原生命令、推理和压缩转成明确的通用展示种类",()=>{
    expect(canonicalizeRuntimeEvent(event("agent",{stream:"item",data:{kind:"command",phase:"start",itemId:"cmd",title:"pwd"}})).payload).toMatchObject({updates:[{kind:"activity",id:"cmd",data:{presentation:"terminal"}}]});
    expect(canonicalizeRuntimeEvent(event("agent",{stream:"item",data:{kind:"analysis",itemId:"thought",progressText:"想法"}})).payload).toMatchObject({updates:[{kind:"text",channel:"reasoning",text:"想法"}]});
    expect(canonicalizeRuntimeEvent(event("agent",{stream:"compaction",data:{phase:"start",itemId:"ctx"}})).payload).toMatchObject({updates:[{kind:"activity",data:{presentation:"context-compaction"}}]});
  });
  it("未声明事件与宿主上下文不绕过适配边界",()=>{
    const normalized=canonicalizeRuntimeEvent(event("agent",{stream:"assistant",data:{delta:"正文",ctx:{privateRuntime:"secret"},channelData:{unknown:{privateRuntime:"secret"}}}}));
    expect(JSON.stringify(normalized)).not.toContain("secret");
    expect(canonicalizeRuntimeEvent(event("unknown-native-event",{privateRuntime:"secret"})).payload).toMatchObject({updates:[]});
  });

});
