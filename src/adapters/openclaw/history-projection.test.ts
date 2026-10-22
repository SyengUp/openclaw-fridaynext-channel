import {describe,it,expect} from "vitest";
import {canonicalHistory} from "./history-projection.js";
import {normalizeHistoryMessage} from "../../history/normalize-message.js";
import fs from "node:fs";
import { transcriptRecordsToRawMessages } from "../../history/read-transcript.js";

describe("OpenClaw 历史身份适配",()=>{
  it("真实 2026.10.5 回合保留宿主 runId，并把前置用户和助手归回同一请求",()=>{
    const fixture=JSON.parse(fs.readFileSync(new URL("../../history/fixtures/canonical-device-turn-2026-10-20.json",import.meta.url),"utf8")) as {runId:string;clientRequestId:string;records:unknown[]};
    const raw=transcriptRecordsToRawMessages(fixture.records,100);
    const rows=raw.map((row,index)=>normalizeHistoryMessage(row,index)!);
    expect(rows[1].runId).toBe(fixture.runId);
    const projected=canonicalHistory(rows,new Set([fixture.clientRequestId]),new Map([[fixture.runId,fixture.clientRequestId]]));
    expect(projected.map(row=>row.clientRequestId)).toEqual([fixture.clientRequestId,fixture.clientRequestId]);
    expect(projected.map(row=>row.runId)).toEqual([fixture.runId,fixture.runId]);
    expect(projected.map(row=>row.id)).toEqual(["3cfbc0bb-68e3-4fb9-bf70-cfdcc846304b","646f0cfe-fad0-46f9-8aa2-e683a18f24d9"]);
  });

  it("原生 transport 的消息身份优先于宿主自行生成的幂等键",()=>{
    const row=normalizeHistoryMessage({role:"user",content:"相同正文",idempotencyKey:"native-run:user",__openclaw:{id:"entry",seq:1,transport:{channel:"friday-next",messageId:"Request/AbC"}}},0)!;
    expect(canonicalHistory([row],new Set(["Request/AbC"]))[0].clientRequestId).toBe("Request/AbC");
  });

  it("分叉前缀的外部 runId 不能把消息绑定到当前会话",()=>{
    const rows=canonicalHistory([{id:"copied-user",seq:1,role:"user",text:"相同正文"},{id:"copied-answer",seq:2,role:"assistant",text:"相同回复",runId:"foreign-run"}],new Set(["current-request"]),new Map([["current-run","current-request"]]));
    expect(rows.every(row=>row.clientRequestId === undefined && row.runId === undefined)).toBe(true);
  });

  it("同一用户边界中出现多个请求时不能按文本或时间回填",()=>{
    const rows=canonicalHistory([{id:"user",seq:1,role:"user",text:"相同正文"},{id:"a",seq:2,role:"assistant",text:"相同回复",runId:"Run/AbC"},{id:"b",seq:3,role:"assistant",text:"相同回复",runId:"Run/aBc"}],new Set(["Request/AbC","Request/aBc"]),new Map([["Run/AbC","Request/AbC"],["Run/aBc","Request/aBc"]]));
    expect(rows[0].clientRequestId).toBeUndefined();
    expect(rows.slice(1).map(row=>row.clientRequestId)).toEqual(["Request/AbC","Request/aBc"]);
  });

  it("保留官方请求身份，连续相同正文的两个请求不能被当作重放副本",()=>{
    const rows=["Request/AbC","Request/aBc"].map((id,index)=>normalizeHistoryMessage({role:"user",content:"相同正文",idempotencyKey:id,__openclaw:{id:`entry-${index}`,seq:index+1}},index)!);
    const normalized=canonicalHistory([...rows,{id:"answer",seq:3,role:"assistant",text:"结果"}],new Set(["Request/AbC","Request/aBc"]));
    expect(normalized.map(row=>row.clientRequestId)).toEqual(["Request/AbC","Request/aBc","Request/aBc"]);
    expect(normalized[1].kind).not.toBe("hidden");
  });
  it("机器唤醒边界不能把上一个请求身份分配给新的后台回复",()=>{
    const rows=canonicalHistory([{id:"u",seq:1,role:"user",text:"输入",clientRequestId:"request"},{id:"a",seq:2,role:"assistant",text:"结果"},{id:"wake",seq:3,role:"user",text:"[OpenClaw cron wake]"},{id:"background",seq:4,role:"assistant",text:"后台通知"}],new Set(["request"]));
    expect(rows[2].kind).toBe("turnBoundary");expect(rows[3].clientRequestId).toBeUndefined();
  });  it("分叉前缀的原请求不能关联到另一会话的本地命令",()=>{
    const rows=canonicalHistory([{id:"copied-entry",seq:1,role:"user",text:"前缀",clientRequestId:"source-request"},{id:"copied-answer",seq:2,role:"assistant",text:"历史回答",clientRequestId:"source-request"}],new Set(["new-request"]));
    expect(rows.map(row=>row.id)).toEqual(["copied-entry","copied-answer"]);
    expect(rows.every(row=>row.clientRequestId === undefined)).toBe(true);
  });

});
