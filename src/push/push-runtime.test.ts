import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach,describe,expect,it,vi} from "vitest";
import {DurableRunStore} from "../runtime-v3/durable-run-store.js";
import {PushRuntime,pushCandidates,pushIdentity} from "./push-runtime.js";
const roots:string[]=[];
afterEach(()=>{vi.useRealTimers(); for(const root of roots.splice(0)) fs.rmSync(root,{recursive:true,force:true});});
function setup() {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-12T00:00:00Z"));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"friday-push-"));roots.push(root);
  const store=new DurableRunStore(root); const send=vi.fn(async()=>202); const cancel=vi.fn(async()=>200);
  const file=path.join(root,"push-state.json");
  const push=new PushRuntime(file,store,send,Date.now,cancel);
  push.register({deviceId:"PHONE",profileId:"p",registrationId:"reg",pushGrant:"grant"});
  const run=store.acceptCommand({deviceId:"PHONE",clientRequestId:"req",sessionKey:"agent:main:s",agentId:"main",text:"private",attachments:[]}).run!;
  return {root,store,send,cancel,file,push,run};
}
describe("持久推送队列",()=>{
  it("无 SSE 监听者时等待一秒，然后发送且重启不重复",async()=>{
    const {store,send,cancel,file,push,run}=setup();
    store.appendRunEvent(run.runId,"run.completed",{});
    expect(store.deviceListenerCount("PHONE")).toBe(0);
    await push.tick(); expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); await push.tick();expect(send).toHaveBeenCalledTimes(1);
    const restarted=new PushRuntime(file,store,send,Date.now,cancel);await restarted.tick(); expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls)).not.toContain("private");
  });
  it("SSE ACK 与重启压缩不能吃掉推送未处理的事件",async()=>{
    const {root,store,send,cancel,file,run}=setup();
    const event=store.appendRunEvent(run.runId,"run.completed",{});
    store.acknowledge("PHONE",event.eventId);
    const restored=new DurableRunStore(root);
    const push=new PushRuntime(file,restored,send,Date.now,cancel);
    vi.advanceTimersByTime(1000);await push.tick();expect(send).toHaveBeenCalledTimes(1);
  });
  it("前台确认可以早于推送扫描，且请求撤销会同步中继",async()=>{
    const {store,send,cancel,push,run}=setup();
    const wire=store.appendRunEvent(run.runId,"run.completed",{});
    const id=pushIdentity("p",pushCandidates(wire)[0].event);
    push.handled("PHONE",id);vi.advanceTimersByTime(1000);await push.tick();
    expect(send).not.toHaveBeenCalled();expect(cancel).toHaveBeenCalledWith("grant",id);
  });
  it("失败后重启重试；用户取消抢先抑制 completion",async()=>{
    const {store,send,cancel,file,push,run}=setup();
    send.mockResolvedValueOnce(503);store.appendRunEvent(run.runId,"run.completed",{});
    vi.advanceTimersByTime(1000);await push.tick();
    const restart=new PushRuntime(file,store,send,Date.now,cancel);await restart.tick();expect(send).toHaveBeenCalledTimes(1);
    restart.cancel(run.runId);vi.advanceTimersByTime(5000);await restart.tick();expect(send).toHaveBeenCalledTimes(1);
  });
  it("询问终态先到不会补发旧询问；审批按真实到期时间截断",async()=>{
    const {store,send,push,run}=setup();
    store.appendRunEvent(run.runId,"question.resolved",{questionId:"q"});
    store.appendRunEvent(run.runId,"deliver.tool",{_sourceEventType:"deliver",_sourceEventData:{payload:{channelData:{askUser:{questionId:"q"}}}}});
    const wire=store.appendRunEvent(run.runId,"approval.request",{approvalId:"a",expiresAtMs:Date.now()+100});
    expect(pushCandidates(wire)[0].event.expiresAt).toBe(Date.now()+100);
    vi.advanceTimersByTime(1000);await push.tick();expect(send).not.toHaveBeenCalled();
  });
  it("子会话和定时任务不产生执行结束通知，失败共用完成身份",()=>{
    const {store,run}=setup();const wire=store.appendRunEvent(run.runId,"run.completed",{});
    expect(pushCandidates({...wire,parentRunId:"parent"})).toEqual([]);
    expect(pushCandidates({...wire,sessionKey:"agent:main:cron:c"})).toEqual([]);
    const event=pushCandidates(wire)[0].event;
    expect(pushIdentity("p",event)).toBe(pushIdentity("p",{...event,kind:"failed"}));
    expect(pushIdentity("q",event)).not.toBe(pushIdentity("p",event));
  });
});
