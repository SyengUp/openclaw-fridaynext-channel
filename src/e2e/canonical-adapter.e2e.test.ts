import path from "node:path";
import {randomUUID} from "node:crypto";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {createAppSimulator} from "../test-support/app-simulator.js";
import {mockDispatchScript,resetMockDispatch} from "../test-support/mock-dispatch.js";
import {createTempHistoryDir,removeTempHistoryDir,setMockRuntime} from "../test-support/mock-runtime.js";
import {getRuntimeV3Store} from "../runtime-v3/runtime-store.js";
import {mappedNativeSessionKey} from "../adapters/openclaw/session-metadata.js";

describe("规范客户端和原生执行器共用公共准入",()=>{
  let root="";
  beforeEach(()=>{root=createTempHistoryDir();setMockRuntime({historyDir:path.join(root,"history"),authToken:"test-token"});});
  afterEach(()=>{resetMockDispatch();removeTempHistoryDir(root);});
  it("逻辑 UUID 不推导原生 key，公共收据去重且新旧客户端序列化均可恢复",async()=>{
    const dispatch=mockDispatchScript().lifecycle("start").partial("规范回复🙂").deliverFinal({text:"规范回复🙂"}).lifecycle("end").install();
    const app=createAppSimulator({token:"test-token",deviceId:"PHONE"}),store=getRuntimeV3Store();
    const logical=randomUUID(),body={sessionKey:logical,agentId:"main",deviceId:"PHONE",clientRequestId:"unchanged-request",text:"任务",expectedServerInstanceId:store.serverInstanceId};
    const request=()=>app.rawRequest({method:"POST",path:"/friday-next/v3/messages",headers:{"content-type":"application/json","x-fridaynext-event-format":"canonical-v1"},body:JSON.stringify(body)});
    const accepted=await request();expect(accepted.status).toBe(202);
    const result=JSON.parse(accepted.body) as {runId:string};
    await vi.waitFor(()=>expect(store.run(result.runId)?.phase).toBe("completed"));
    const repeated=JSON.parse((await request()).body) as {runId:string;replayed:boolean};
    expect(repeated).toMatchObject({runId:result.runId,replayed:true});expect(dispatch.calls).toHaveLength(1);
    expect(mappedNativeSessionKey(logical)).toBe(store.run(result.runId)?.sessionKey);
    expect(store.run(result.runId)?.sessionKey).not.toBe(logical);
    const modern=await app.rawRequest({method:"GET",path:"/friday-next/v3/sync?deviceId=PHONE",headers:{"x-fridaynext-event-format":"canonical-v1"}});
    expect(modern.body).not.toContain("_sourceEvent");expect(modern.body).toContain(logical);
    const legacy=await app.rawRequest({method:"GET",path:"/friday-next/v3/sync?deviceId=PHONE"});
    expect(legacy.body).toContain("_sourceEventData");expect(legacy.body).toContain("规范回复🙂");
  });
  it("旧服务身份在原生执行前被拒绝",async()=>{
    const dispatch=mockDispatchScript().lifecycle("start").lifecycle("end").install();
    const app=createAppSimulator({token:"test-token"});
    const response=await app.rawRequest({method:"POST",path:"/friday-next/v3/messages",headers:{"content-type":"application/json","x-fridaynext-event-format":"canonical-v1"},body:JSON.stringify({deviceId:"PHONE",sessionKey:randomUUID(),agentId:"main",clientRequestId:"old",text:"任务",expectedServerInstanceId:"old-service"})});
    expect(response.status).toBe(409);expect(dispatch.calls).toHaveLength(0);expect(getRuntimeV3Store().runs()).toHaveLength(0);
  });
});
