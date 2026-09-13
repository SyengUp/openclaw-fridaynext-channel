import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {IncomingMessage,ServerResponse} from "node:http";
const mocks=vi.hoisted(()=>({auth:vi.fn(),read:vi.fn(),register:vi.fn(),remove:vi.fn(),handled:vi.fn()}));
vi.mock("../middleware/auth.js",()=>({extractBearerToken:mocks.auth}));
vi.mock("../middleware/body.js",()=>({readJsonBody:mocks.read}));
vi.mock("../../push/push-runtime.js",()=>({PUSH_ORIGIN:"https://gw.syengup.host",getPushRuntime:()=>mocks}));
import {handlePush} from "./push.js";
async function request(method="POST",route="registration") {
  const res={statusCode:0,setHeader:vi.fn(),end:vi.fn()};
  await handlePush({method,url:"/friday-next/push/"+route} as IncomingMessage,res as unknown as ServerResponse);
  return res.statusCode;
}
beforeEach(()=>{vi.clearAllMocks();mocks.auth.mockReturnValue("token");mocks.read.mockResolvedValue({deviceId:"phone",profileId:"p",registrationId:"r",pushGrant:"secret"});});
afterEach(()=>vi.unstubAllGlobals());
describe("推送注册认证",()=>{
  it("无 bearer 不访问控制面",async()=>{mocks.auth.mockReturnValue(null);expect(await request()).toBe(401);expect(mocks.read).not.toHaveBeenCalled();});
  it("伪造绑定被拒绝，不写入本地队列",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({deviceId:"OTHER",profileId:"p",registrationId:"r"}))));
    expect(await request()).toBe(403);expect(mocks.register).not.toHaveBeenCalled();
  });
  it("已验真的绑定只向固定中继请求，规范化设备身份",async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({deviceId:"PHONE",profileId:"p",registrationId:"r"})));
    vi.stubGlobal("fetch",fetcher);expect(await request()).toBe(200);
    expect(fetcher.mock.calls[0][0]).toBe("https://gw.syengup.host/v1/push/binding");
    expect(mocks.register).toHaveBeenCalledWith({deviceId:"PHONE",profileId:"p",registrationId:"r",pushGrant:"secret"});
  });
  it("控制面不可用不假装注册成功",async()=>{vi.stubGlobal("fetch",vi.fn(async()=>new Response("",{status:503})));expect(await request()).toBe(503);expect(mocks.register).not.toHaveBeenCalled();});
  it("前台确认必须带固定身份，撤销只影响指定设备",async()=>{
    expect(await request("POST","handled")).toBe(400);
    mocks.read.mockResolvedValue({deviceId:"phone",notificationId:"session."+"a".repeat(64)});
    expect(await request("POST","handled")).toBe(200);expect(mocks.handled).toHaveBeenCalledWith("PHONE","session."+"a".repeat(64));
    expect(await request("DELETE")).toBe(200);expect(mocks.remove).toHaveBeenCalledWith("PHONE");
  });
});
