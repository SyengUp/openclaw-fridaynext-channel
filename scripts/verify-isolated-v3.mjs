#!/usr/bin/env node
// 使用现有官方 SDK 启动全新 loopback 状态，验证生产插件；不连接生产网关、不调用模型。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const sdk=process.env.OPENCLAW_PACKAGE_ROOT;
if(!sdk || !fs.existsSync(path.join(sdk,'openclaw.mjs'))) throw new Error('请显式提供 OPENCLAW_PACKAGE_ROOT，指向现有官方安装；本脚本不安装或改写 SDK');
let plugin=process.env.FRIDAY_TEST_PLUGIN_ROOT ? path.resolve(process.env.FRIDAY_TEST_PLUGIN_ROOT) : fileURLToPath(new URL('../',import.meta.url));
const producerPlugin=plugin;
const npmSpec=process.env.FRIDAY_TEST_NPM_SPEC;
const archivePath=process.env.FRIDAY_TEST_ARCHIVE_PATH;
assert.ok(!(npmSpec && archivePath),'archive 与 registry 安装不能同时选择');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'friday-v3-native-'));
const state=path.join(root,'state'),configFile=path.join(root,'config.json'),token=randomUUID();
const available=http.createServer();available.listen(0,'127.0.0.1');await once(available,'listening');
const port=available.address().port;await new Promise(resolve=>available.close(resolve));
const config={gateway:{mode:'local',bind:'loopback',port,auth:{mode:'token',token},controlUi:{enabled:false}},
  discovery:{mdns:{mode:'off'}},cron:{enabled:false},agents:{defaults:{workspace:path.join(root,'workspace')}},
  plugins:{allow:['friday-next'],load:{paths:[plugin]},entries:{'friday-next':{enabled:true,hooks:{allowConversationAccess:true}}}},
  channels:{'friday-next':{enabled:true,authToken:token,historyDir:path.join(root,'channel','history'),publicAccess:{enabled:false}}}};
fs.mkdirSync(state,{recursive:true});fs.writeFileSync(configFile,JSON.stringify(npmSpec || archivePath ? {...config,plugins:{},channels:{}} : config),{mode:0o600});
const env={PATH:path.dirname(process.execPath)+path.delimiter+(process.env.PATH ?? ''),HOME:process.env.HOME,LANG:process.env.LANG ?? 'en_US.UTF-8',
  OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:configFile,FRIDAY_NEXT_PUBLIC_ACCESS_DATA_DIR:path.join(root,'public-access')};
const log=fs.openSync(path.join(root,'gateway.log'),'a',0o600);
let child,npmInstallation,archiveInstallation;
const request=async(route,{method='GET',body,canonical=true,eventFormat='canonical-v1'}={})=>{
  const response=await fetch(`http://127.0.0.1:${port}${route}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...(canonical?{'X-FridayNext-Event-Format':eventFormat}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
  const raw=await response.text();let value;try{value=JSON.parse(raw);}catch{throw new Error(`接口未返回 JSON：${route} ${response.status}`);}
  return {status:response.status,body:value};
};
try {
  if(npmSpec || archivePath) {
    if(npmSpec) assert.match(npmSpec,/^@syengup\/friday-channel-next@[0-9A-Za-z.+-]+$/);
    else assert.ok(path.isAbsolute(archivePath) && fs.existsSync(archivePath),'archive 必须是现有完整包的绝对路径');
    const anonymous=path.join(root,'anonymous.npmrc');
    fs.writeFileSync(anonymous,'registry=https://registry.npmjs.org/\n',{mode:0o600});
    Object.assign(env,{NPM_CONFIG_USERCONFIG:anonymous,NPM_CONFIG_GLOBALCONFIG:'/dev/null',NPM_CONFIG_CACHE:path.join(root,'npm-cache')});
    const installLog=fs.openSync(path.join(root,'install.log'),'a',0o600);
    let installed;
    try {
      installed=spawnSync(process.execPath,[path.join(sdk,'openclaw.mjs'),'plugins','install',npmSpec ?? archivePath,'--force',...(npmSpec?['--pin']:[]),'--accept-capabilities'],{cwd:root,env,stdio:['ignore',installLog,installLog],timeout:240000});
    } finally {fs.closeSync(installLog);}
    assert.equal(installed.status,0,`SDK 正式安装未成功，请查看 ${root}/install.log`);
    const database=new DatabaseSync(path.join(state,'state/openclaw.sqlite'),{readOnly:true});
    let row;
    try {row=database.prepare("SELECT value_json FROM config_machine_state WHERE state_key='plugins.installedIndex'").get();}
    finally {database.close();}
    const record=JSON.parse(row.value_json).index.installRecords['friday-next'];
    assert.equal(record.source,npmSpec?'npm':'archive');if(npmSpec) assert.equal(record.spec,npmSpec);
    plugin=record.installPath;
    const expectedVersion=npmSpec?npmSpec.slice(npmSpec.lastIndexOf('@')+1):JSON.parse(fs.readFileSync(path.join(producerPlugin,'package.json'),'utf8')).version;
    assert.equal(JSON.parse(fs.readFileSync(path.join(plugin,'package.json'),'utf8')).version,expectedVersion);
    const installedConfig=JSON.parse(fs.readFileSync(configFile,'utf8'));
    const fixtureChannels=config.channels;
    Object.assign(config,installedConfig);
    config.channels={...installedConfig.channels,...fixtureChannels};
    const stored=installedConfig.plugins ?? {};
    config.plugins={...stored,allow:[...new Set([...(stored.allow ?? []),'friday-next'])],entries:{...stored.entries,'friday-next':{...stored.entries?.['friday-next'],enabled:true,hooks:{allowConversationAccess:true}}}};
    assert.ok(!config.plugins.load?.paths?.length,'SDK 正式安装不得叠加路径安装');
    fs.writeFileSync(configFile,JSON.stringify(config),{mode:0o600});
    if(npmSpec) npmInstallation={source:record.source,spec:record.spec,pluginRoot:plugin};
    else archiveInstallation={source:record.source,archivePath,pluginRoot:plugin,version:expectedVersion};
  }
  // 所有 SDK 写入使用测试数据根；原安装只有读取。
  process.env.OPENCLAW_STATE_DIR=state;process.env.OPENCLAW_CONFIG_PATH=configFile;
  const sessions=await import(pathToFileURL(path.join(sdk,'dist/plugin-sdk/session-store-runtime.js')).href);
  const transcript=await import(pathToFileURL(path.join(sdk,'dist/plugin-sdk/session-transcript-runtime.js')).href);
  const sessionKey='agent:main:fridaynext:fixture-'+randomUUID(),sessionId=randomUUID();
  await sessions.upsertSessionEntry({agentId:'main',sessionKey,env,entry:{sessionId,updatedAt:Date.now(),displayName:'隔离测试会话',channel:'friday-next',lastChannel:'friday-next',lastTo:'CONTRACT',deliveryContext:{channel:'friday-next',to:'CONTRACT',accountId:'default'}}});
  const extractedFile='\n\n<file name="fixture.txt" mime="text/plain">\n附件提取正文只提供给模型\n</file>';
  for(const [index,role] of ['user','assistant','user','assistant'].entries()) {
    const result=await transcript.appendSessionTranscriptMessageByIdentityStrict({agentId:'main',sessionKey,sessionId,env,config,eventId:randomUUID(),message:{role,content:[{type:'text',text:index === 1 ? 'NO_REPLY' : `测试消息${index+1}${index === 0 ? extractedFile : ''}`}],...(role === 'user' ? {idempotencyKey:`fixture-request-${index}`} : {}),...(index === 0 ? {__openclaw:{media:[{fileName:'fixture.txt',contentType:'text/plain',kind:'document'}]}} : {}),timestamp:Date.now()+index}});
    assert.equal(result.kind,'result');
  }
  // 模拟进程在持久准入后、领取前退出；子进程必须由生产恢复链路执行一次。
  // 复用真实客户端同样的持久映射形状；逻辑 ID 与原生会话格式完全不同。
  // 切点使用独立会话，避免合成审批仅登记、不执行模型而留下的未知运行阻挡操作。
  const actionSessionKey=randomUUID(),actionNativeKey='agent:main:fridaynext:action-'+randomUUID(),actionNativeId=randomUUID();
  await sessions.upsertSessionEntry({agentId:'main',sessionKey:actionNativeKey,env,entry:{sessionId:actionNativeId,updatedAt:Date.now(),channel:'friday-next',lastChannel:'friday-next',lastTo:'CONTRACT',deliveryContext:{channel:'friday-next',to:'CONTRACT',accountId:'default'}}});
  for(const [index,role] of ['user','assistant','user','assistant'].entries()) {
    const written=await transcript.appendSessionTranscriptMessageByIdentityStrict({agentId:'main',sessionKey:actionNativeKey,sessionId:actionNativeId,env,config,eventId:randomUUID(),message:{role,content:[{type:'text',text:`切点消息${index+1}`}],timestamp:Date.now()+index}});
    assert.equal(written.kind,'result');
  }
  fs.mkdirSync(path.join(root,'channel'),{recursive:true});
  fs.writeFileSync(path.join(root,'channel/session-bindings.json'),JSON.stringify({version:1,sessions:[{logical:actionSessionKey,native:actionNativeKey,agentId:'main'}]}),{mode:0o600});
  const nativeRuntime=await import(pathToFileURL(path.join(producerPlugin,'dist/src/runtime.js')).href);
  nativeRuntime.setFridayNextRuntime({config:{loadConfig:()=>config}});
  const {OpenClawBackendAdapter}=await import(pathToFileURL(path.join(producerPlugin,'dist/src/adapters/openclaw/backend-adapter.js')).href);
  const {getRuntimeV3Store}=await import(pathToFileURL(path.join(producerPlugin,'dist/src/runtime-v3/runtime-store.js')).href);
  // 普通 npm 安装会提升依赖；按包解析规则兼容提升布局和完整部署包内嵌布局。
  const kitEntry=createRequire(path.join(plugin,'package.json')).resolve('@syengup/fridaynext-channel-kit');
  const producerKit=createRequire(path.join(producerPlugin,'package.json')).resolve('@syengup/fridaynext-channel-kit');
  const {ChannelRunner}=await import(pathToFileURL(producerKit).href);
  const managedInstallation=npmInstallation ?? archiveInstallation;
  if(managedInstallation) {
    managedInstallation.kitVersion=JSON.parse(fs.readFileSync(path.join(path.dirname(kitEntry),'../package.json'),'utf8')).version;
    const expectedKitVersion=JSON.parse(fs.readFileSync(path.join(producerPlugin,'package.json'),'utf8')).dependencies['@syengup/fridaynext-channel-kit'];
    assert.match(expectedKitVersion,/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,'生产 Kit 必须声明精确 registry 版本');
    assert.equal(managedInstallation.kitVersion,expectedKitVersion);
    managedInstallation.kitEntry=kitEntry;
  }
  // 真实 SDK 必须能绑定标准停止入口；不能让函数改名后静默降级为 plain abort。
  const stopBridge=await import(pathToFileURL(path.join(plugin,'dist/src/agent/session-abort-bridge.js')).href);
  const stopTarget=await stopBridge.locateAbortSessionRunTargetInDist(path.join(sdk,'dist'));
  assert.equal(typeof stopTarget,'function','当前 SDK 缺少可用的标准停止适配');
  const idleStop=stopTarget({agentId:'main',key:'agent:main:friday-stop-compat-'+randomUUID()});
  assert.equal(idleStop.active,false);assert.equal(idleStop.aborted,false);
  await idleStop.retirement;
  const recoveryCommand={deviceId:'RECOVERY',sessionKey:randomUUID(),agentId:'main',clientRequestId:randomUUID(),text:'/help',attachments:[]};
  const recovery=await new ChannelRunner(getRuntimeV3Store(),new OpenClawBackendAdapter()).admit(recoveryCommand);
  assert.equal(recovery.run.phase,'queued');
  child=spawn(process.execPath,[path.join(sdk,'openclaw.mjs'),'gateway','run','--allow-unconfigured','--bind','loopback','--port',String(port)],{cwd:root,env,stdio:['ignore',log,log]});
  const deadline=Date.now()+60000;let health;
  while(Date.now()<deadline) {
    if(child.exitCode !== null) throw new Error(`隔离网关提前退出：${child.exitCode}`);
    try {health=await request('/friday-next/health');if(health.body.backend?.id === 'openclaw')break;} catch {}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.equal(health?.body.backend?.id,'openclaw','插件未完成真实宿主注册');
  // 看门狗不持有用户凭证；真实兼容门面的 GET 必须到达鉴权，HEAD 仍明确拒绝。
  const probeHealthUrl=`http://127.0.0.1:${port}/friday-next/health`;
  const probeGet=await fetch(probeHealthUrl,{signal:AbortSignal.timeout(10000)});
  assert.equal(probeGet.status,401);await probeGet.arrayBuffer();
  const probeHead=await fetch(probeHealthUrl,{method:'HEAD',signal:AbortSignal.timeout(10000)});
  assert.equal(probeHead.status,405);await probeHead.arrayBuffer();
  fs.writeFileSync(path.join(root,'public-health-probe-contract.json'),JSON.stringify({unauthenticatedGet:probeGet.status,unsupportedHead:probeHead.status},null,2));
  // 审批仅由真实宿主登记，不执行命令；公共查询必须通过其读取身份校验。
  const gatewayRuntime=await import(pathToFileURL(path.join(sdk,'dist/plugin-sdk/gateway-runtime.js')).href);
  const callApproval=(method,params)=>gatewayRuntime.callGatewayFromCli(method,{port:String(port),timeout:'10000',json:true},params,{progress:false,scopes:['operator.admin'],sharedStateMode:'read-only'});
  assert.equal((await request('/friday-next/sessions/bind',{method:'POST',body:{deviceId:'CONTRACT',sessionKey}})).status,200);
  for(const decision of ['allow-once','deny']) {
    const approvalId=randomUUID(),approvalRun=randomUUID();
    await callApproval('exec.approval.request',{id:approvalId,command:'/usr/bin/true',cwd:root,host:'local',ask:'always',agentId:'main',sessionKey,runId:approvalRun,twoPhase:true,requireDeliveryRoute:false,timeoutMs:60000});
    const nativeApproval=await callApproval('approval.get',{id:approvalId});
    assert.equal(nativeApproval.approval.status,'pending');
    const approval=(await request('/friday-next/v3/controls/'+encodeURIComponent(approvalId))).body.control;
    assert.equal(approval?.status,'pending','宿主已存在的审批不能在公共查询中静默丢失');
    assert.equal(approval.id,approvalId);assert.equal(approval.runId,approvalRun);
    assert.equal(approval.generation,`${approvalRun}:${approvalId}`);
    assert.equal(approval.data.commandText,'/usr/bin/true');
    const approvalPage=(await request('/friday-next/v3/sync?deviceId=CONTRACT')).body;
    assert.ok(approvalPage.events.some(event=>event.runId===approvalRun && event.payload.updates.some(update=>update.kind==='control' && update.id===approvalId)));
    await request('/friday-next/v3/events/ack',{method:'POST',body:{deviceId:'CONTRACT',serverInstanceId:approvalPage.serverInstanceId,throughEventId:approvalPage.events.at(-1).eventId}});
    assert.equal((await request('/friday-next/v3/controls/'+encodeURIComponent(approvalId))).body.control?.generation,approval.generation,'ACK 后控制代际与归属必须保持');
    const approvalResponse={commandId:'approval-'+randomUUID(),generation:approval.generation,answer:{decision},expectedServerInstanceId:approvalPage.serverInstanceId};
    const responseRoute='/friday-next/v3/controls/'+encodeURIComponent(approvalId)+'/responses';
    const settled=await request(responseRoute,{method:'POST',body:approvalResponse});
    assert.equal(settled.status,200,JSON.stringify(settled.body));
    assert.equal((await callApproval('approval.get',{id:approvalId})).approval.status,decision==='deny'?'denied':'allowed');
    const terminal=(await request('/friday-next/v3/controls/'+encodeURIComponent(approvalId))).body.control;
    assert.equal(terminal?.status,'resolved');assert.deepEqual(terminal?.options,[]);
    const repeated=await request(responseRoute,{method:'POST',body:approvalResponse});
    assert.equal(repeated.status,200);assert.equal(repeated.body.replayed,true);
    assert.equal((await request(responseRoute,{method:'POST',body:{...approvalResponse,answer:{decision:decision==='deny'?'allow-once':'deny'}}})).status,409);
  }
  // 只登记短有效期审批，不运行命令；验证真实 SDK 到期事件能穿过公共控制链路。
  const expiringApprovalId=randomUUID(),expiringApprovalRun=randomUUID();
  await callApproval('exec.approval.request',{id:expiringApprovalId,command:'/usr/bin/true',cwd:root,host:'local',ask:'always',agentId:'main',sessionKey,runId:expiringApprovalRun,twoPhase:true,requireDeliveryRoute:false,timeoutMs:3000});
  const expiryRoute='/friday-next/v3/controls/'+encodeURIComponent(expiringApprovalId);
  const expiringControl=(await request(expiryRoute)).body.control;
  assert.equal(expiringControl?.status,'pending');
  assert.equal(expiringControl.generation,`${expiringApprovalRun}:${expiringApprovalId}`);
  let expiryEvent;
  const expiryDeadline=Date.now()+12000;
  while(Date.now()<expiryDeadline) {
    const page=(await request('/friday-next/v3/sync?deviceId=CONTRACT')).body;
    expiryEvent=page.events.find(event=>event.runId===expiringApprovalRun && event.payload.updates.some(update=>update.kind==='control' && update.id===expiringApprovalId && update.phase==='expired'));
    if(expiryEvent)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(expiryEvent,'真实 SDK 过期必须产生原审批的 canonical 过期事件');
  const expiredControl=(await request(expiryRoute)).body.control;
  if(expiredControl) {assert.equal(expiredControl.status,'expired');assert.deepEqual(expiredControl.options,[]);}
  const staleApproval=await request(expiryRoute+'/responses',{method:'POST',body:{commandId:'expired-'+randomUUID(),generation:expiringControl.generation,answer:{decision:'allow-once'},expectedServerInstanceId:expiryEvent.serverInstanceId}});
  assert.equal(staleApproval.status,409);assert.equal(staleApproval.body.code,'STALE_CONTROL');
  const approvalExpiry={id:expiringApprovalId,runId:expiringApprovalRun,generation:expiringControl.generation,eventId:expiryEvent.eventId,lateAnswerStatus:staleApproval.status,commandExecuted:false};
  fs.writeFileSync(path.join(root,'approval-expiry.json'),JSON.stringify(approvalExpiry,null,2));
  // 另一端直接经 SDK 解决审批后，旧客户端不能再用新命令身份提交原卡片。
  const peerApprovalId=randomUUID(),peerApprovalRun=randomUUID();
  await callApproval('exec.approval.request',{id:peerApprovalId,command:'/usr/bin/true',cwd:root,host:'local',ask:'always',agentId:'main',sessionKey,runId:peerApprovalRun,twoPhase:true,requireDeliveryRoute:false,timeoutMs:60000});
  const peerApprovalRoute='/friday-next/v3/controls/'+encodeURIComponent(peerApprovalId);
  const peerControl=(await request(peerApprovalRoute)).body.control;
  assert.equal(peerControl?.status,'pending');
  await callApproval('exec.approval.resolve',{id:peerApprovalId,decision:'deny'});
  const peerTerminal=(await request(peerApprovalRoute)).body.control;
  assert.equal(peerTerminal?.status,'resolved');assert.deepEqual(peerTerminal.options,[]);
  const peerLate=await request(peerApprovalRoute+'/responses',{method:'POST',body:{commandId:'peer-late-'+randomUUID(),generation:peerControl.generation,answer:{decision:'allow-once'},expectedServerInstanceId:expiryEvent.serverInstanceId}});
  assert.equal(peerLate.status,409);assert.equal(peerLate.body.code,'STALE_CONTROL');
  const approvalPeer={id:peerApprovalId,runId:peerApprovalRun,generation:peerControl.generation,decision:'deny',lateAnswerStatus:peerLate.status,commandExecuted:false};
  fs.writeFileSync(path.join(root,'approval-peer.json'),JSON.stringify(approvalPeer,null,2));
  let recoveredPage;
  const recoveryDeadline=Date.now()+20000;
  while(Date.now()<recoveryDeadline) {
    recoveredPage=(await request('/friday-next/v3/sync?deviceId=RECOVERY')).body;
    if(recoveredPage.runs.some(run=>run.runId === recovery.run.runId && ['completed','failed','cancelled'].includes(run.phase)))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(recoveredPage.runs.find(run=>run.runId === recovery.run.runId)?.phase,'completed');
  assert.equal(recoveredPage.events.filter(event=>event.runId === recovery.run.runId && event.eventType === 'dispatch.started').length,1);
  const recoveryReplay=await request('/friday-next/v3/messages',{method:'POST',body:recoveryCommand});
  assert.equal(recoveryReplay.body.runId,recovery.run.runId);assert.equal(recoveryReplay.body.replayed,true);
  const query='?sessionKey='+encodeURIComponent(sessionKey)+'&limit=100';
  // 2026.10.5 先绑定 HTTP、再完成会话库后台准入；路由可用不代表历史已就绪。
  let modern;
  const historyDeadline=Date.now()+30000;
  while(Date.now()<historyDeadline) {
    modern=await request('/friday-next/history/messages'+query);
    if(modern.status === 200 && modern.body.messages?.length === 4)break;
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  const legacy=await request('/friday-next/history/messages'+query,{canonical:false});
  assert.equal(modern.status,200);assert.equal(modern.body.messages.length,4);
  assert.ok(modern.body.messages.every(row=>row.format === 'canonical-v1'));
  assert.equal(modern.body.messages[0].clientRequestId,undefined);
  assert.equal(legacy.body.messages[0].clientRequestId,'fixture-request-0');
  assert.equal(legacy.body.messages.length,4);assert.ok(legacy.body.messages.every(row=>row.format === undefined));
  assert.equal(modern.body.messages[0].text,'测试消息1','历史页不能把模型附件正文投影为用户输入');
  assert.equal(legacy.body.messages[0].text,'测试消息1');
  const fileDetail=await request('/friday-next/history/message-detail?sessionKey='+encodeURIComponent(sessionKey)+'&id='+encodeURIComponent(modern.body.messages[0].id));
  assert.equal(fileDetail.body.message.text,'测试消息1');
  const fileSnapshot=await request('/friday-next/v3/sessions/'+encodeURIComponent(sessionKey)+'/snapshot?transcriptLimit=100');
  assert.equal(fileSnapshot.status,200);assert.equal(fileSnapshot.body.transcript[0].text,'测试消息1','恢复快照也必须使用相同文件展示规则');
  const detailRoute='/friday-next/history/message-detail?sessionKey='+encodeURIComponent(sessionKey)+'&id='+encodeURIComponent(modern.body.messages[1].id);
  const detail=await request(detailRoute),legacyDetail=await request(detailRoute,{canonical:false});
  assert.equal(detail.status,200);assert.equal(detail.body.message.format,'canonical-v1');
  assert.equal(detail.body.message.text,modern.body.messages[1].text);
  assert.equal(legacyDetail.body.message.text,'NO_REPLY');
  const title=await request('/friday-next/sessions/title',{method:'PUT',body:{sessionKey,title:'公共接口标题'}});
  assert.equal(title.status,200);assert.equal(title.body.title,'公共接口标题');
  const pin=await request('/friday-next/sessions/pin',{method:'PUT',body:{sessionKey,pinned:true}});
  assert.equal(pin.status,200);assert.equal(pin.body.pinned,true);
  const pinReplay=await request('/friday-next/sessions/pin',{method:'PUT',body:{sessionKey,pinned:true},canonical:false});
  assert.equal(pinReplay.status,200);assert.equal(pinReplay.body.pinnedAt,pin.body.pinnedAt);
  // 同时验证新版 SDK 的管理分发和工具发现；只读目录不触发模型或外部语音服务。
  for(const route of ['/friday-next/agents','/friday-next-admin/models?agentId=main','/friday-next-admin/commands?agentId=main','/friday-next-admin/tool-catalog?agentId=main','/friday-next-admin/cron/jobs?agentId=main','/friday-next-admin/cron/channels','/friday-next-admin/talk/catalog','/friday-next-admin/talk/config','/friday-next/agents/main/config','/friday-next/sessions/settings?sessionKey='+encodeURIComponent(sessionKey)]) {
    const result=await request(route);
    assert.equal(result.status,200,`${route} 状态异常：${JSON.stringify(result.body)}`);
    assert.equal(result.body.ok,true,`${route} 未完成真实宿主分发：${JSON.stringify(result.body)}`);
  }
  const unsupported={deviceId:'CONTRACT',sessionKey:randomUUID(),agentId:'main',clientRequestId:randomUUID(),text:'/help'};
  assert.equal((await request('/friday-next/v3/messages',{method:'POST',body:unsupported,eventFormat:'canonical-v99'})).status,426);
  const logical=randomUUID(),command={deviceId:'CONTRACT',sessionKey:logical,agentId:'main',clientRequestId:randomUUID(),text:'/help'};
  assert.equal((await request('/friday-next/sessions/bind',{method:'POST',body:{deviceId:'EARLY',sessionKey:logical}})).status,200);
  const first=await request('/friday-next/v3/messages',{method:'POST',body:command});assert.equal(first.status,202);
  const replay=await request('/friday-next/v3/messages',{method:'POST',body:command});assert.equal(replay.body.runId,first.body.runId);
  const conflict=await request('/friday-next/v3/messages',{method:'POST',body:{...command,text:'/status'}});assert.equal(conflict.status,409);
  let page;const end=Date.now()+20000;
  while(Date.now()<end) {
    page=(await request('/friday-next/v3/sync?deviceId=CONTRACT')).body;
    if(page.runs.some(run=>run.runId === first.body.runId && ['completed','failed','cancelled'].includes(run.phase)))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  const run=page.runs.find(run=>run.runId === first.body.runId);
  assert.equal(run?.phase,'completed');assert.equal(run.sessionKey,logical);
  assert.ok(page.events.every(event=>event.payload.format === 'canonical-v1'));
  const early=(await request('/friday-next/v3/sync?deviceId=EARLY')).body;
  assert.ok(early.events.some(event=>event.runId === first.body.runId && event.eventType === 'run.completed'));
  const binding=JSON.parse(fs.readFileSync(path.join(root,'channel','session-bindings.json'),'utf8')).sessions.find(value=>value.logical === logical);
  assert.ok(binding);
  let nativeEntry=sessions.getSessionEntry({agentId:'main',sessionKey:binding.native,env});
  if(!nativeEntry) {
    nativeEntry={sessionId:randomUUID(),updatedAt:Date.now()};
    await sessions.upsertSessionEntry({agentId:'main',sessionKey:binding.native,env,entry:nativeEntry});
  }
  // 复现真机：用户幂等键属于宿主，只有助手的原生元数据带 Friday 运行身份。
  await transcript.appendSessionTranscriptMessageByIdentityStrict({agentId:'main',sessionKey:binding.native,sessionId:nativeEntry.sessionId,env,config,eventId:randomUUID(),message:{role:'user',content:[{type:'text',text:'请求身份测试'}],idempotencyKey:'host-generated:user',timestamp:Date.now()}});
  await transcript.appendSessionTranscriptMessageByIdentityStrict({agentId:'main',sessionKey:binding.native,sessionId:nativeEntry.sessionId,env,config,eventId:randomUUID(),message:{role:'assistant',content:[{type:'text',text:'权威关联回复'}],__openclaw:{runId:first.body.runId},timestamp:Date.now()+1}});
  const bound=(await request('/friday-next/history/messages?sessionKey='+encodeURIComponent(logical)+'&limit=100')).body;
  assert.ok(bound.messages.some(message=>message.clientRequestId === command.clientRequestId));
  const associated=bound.messages.find(message=>message.clientRequestId === command.clientRequestId);
  const associatedTurn=bound.messages.filter(message=>message.clientRequestId === command.clientRequestId);
  assert.equal(associatedTurn.length,2,'真实 SDK 写入后的用户和助手必须归回同一请求');
  assert.ok(associatedTurn.every(message=>message.runId === first.body.runId));
  const associatedDetail=await request('/friday-next/history/message-detail?sessionKey='+encodeURIComponent(logical)+'&id='+encodeURIComponent(associated.id));
  assert.equal(associatedDetail.body.message.clientRequestId,command.clientRequestId);
  assert.equal((await request('/friday-next/sessions/bind',{method:'POST',body:{deviceId:'OTHER',sessionKey:logical}})).status,200);
  const observed=await request('/friday-next/v3/messages',{method:'POST',body:{...command,clientRequestId:randomUUID()}});
  let audience;
  const audienceDeadline=Date.now()+20000;
  while(Date.now()<audienceDeadline) {
    audience=(await request('/friday-next/v3/sync?deviceId=OTHER')).body;
    if(audience.events.some(event=>event.runId === observed.body.runId && event.eventType === 'run.completed'))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(audience.events.some(event=>event.runId === observed.body.runId && event.eventType === 'run.completed'));
  const sequence=audience.events.filter(event=>event.runId === observed.body.runId).map(event=>event.runSeq);
  assert.equal(new Set(sequence).size,sequence.length);
  assert.ok(!audience.runs.some(run=>run.clientRequestId === unsupported.clientRequestId));

  const oldPage=(await request('/friday-next/v3/sync?deviceId=CONTRACT',{canonical:false})).body;
  assert.ok(oldPage.events.some(event=>event.payload._sourceEventType || event.payload._sourceEventBatch),'旧输出必须能从原生归档恢复');
  const actionSnapshot='/friday-next/v3/sessions/'+encodeURIComponent(actionSessionKey)+'/snapshot';
  const parentBefore=(await request(actionSnapshot)).body;
  const readStates=(await request('/friday-next-admin/sessions/state')).body;
  const legacyReadStates=(await request('/friday-next-admin/sessions/state',{canonical:false})).body;
  assert.equal(readStates.complete,true);assert.equal(legacyReadStates.complete,true);
  const readRow=readStates.states.find(row=>row.sessionKey===actionSessionKey);
  assert.ok(readRow,'规范阅读状态必须包含通知使用的逻辑身份，不能被客户端误判为已删除');
  assert.ok(!readStates.states.some(row=>row.sessionKey===actionNativeKey));
  assert.ok(legacyReadStates.states.some(row=>row.sessionKey===actionNativeKey),'旧客户端继续使用原生身份');
  const unread=await request('/friday-next-admin/sessions/state',{method:'PATCH',body:{sessionKey:actionSessionKey,agentId:'main',expectedSessionId:readRow.sessionId,unread:true}});
  assert.equal(unread.status,200,JSON.stringify(unread.body));assert.equal(unread.body.sessionKey,actionSessionKey);
  const marked=(await request('/friday-next-admin/sessions/state')).body.states.find(row=>row.sessionKey===actionSessionKey);
  assert.equal(marked.unread,true);assert.equal(typeof marked.markedUnreadAt,'number');
  const acknowledged=await request('/friday-next-admin/sessions/state',{method:'PATCH',body:{sessionKey:actionSessionKey,agentId:'main',expectedSessionId:readRow.sessionId,expectedMarkedUnreadAt:marked.markedUnreadAt,unread:false}});
  assert.equal(acknowledged.status,200,JSON.stringify(acknowledged.body));
  const afterRead=(await request('/friday-next-admin/sessions/state')).body.states.find(row=>row.sessionKey===actionSessionKey);
  assert.equal(afterRead.unread,false);
  const sessionReadIdentity={logicalSessionKey:actionSessionKey,nativeSessionKey:actionNativeKey,canonicalContainsLogical:true,legacyContainsNative:true,markUnreadStatus:unread.status,acknowledgementStatus:acknowledged.status};
  fs.writeFileSync(path.join(root,'session-read-identity.json'),JSON.stringify(sessionReadIdentity,null,2));
  const pivot=parentBefore.transcript.find(message=>message.role==='user' && message.text==='切点消息3');
  assert.ok(pivot,'切点必须来自真实 SDK 写入的用户消息');
  const projected=rows=>rows.map(({id,role,text})=>({id,role,text}));
  const prefix=parentBefore.transcript.slice(0,parentBefore.transcript.indexOf(pivot));
  const actionBody={sessionKey:actionSessionKey,entryId:pivot.id,agentId:'main'};
  const forked=await request('/friday-next-admin/sessions/fork',{method:'POST',body:actionBody});
  assert.equal(forked.status,200,JSON.stringify(forked.body));
  assert.equal(typeof forked.body.sessionKey,'string');
  const childSnapshot=(await request('/friday-next/v3/sessions/'+encodeURIComponent(forked.body.sessionKey)+'/snapshot')).body;
  assert.deepEqual(childSnapshot.transcript.map(({role,text})=>({role,text})),prefix.map(({role,text})=>({role,text})));
  assert.deepEqual(projected((await request(actionSnapshot)).body.transcript),projected(parentBefore.transcript));
  const rewound=await request('/friday-next-admin/sessions/rewind',{method:'POST',body:actionBody});
  assert.equal(rewound.status,200,JSON.stringify(rewound.body));assert.equal(rewound.body.editorText,'切点消息3');
  assert.deepEqual(projected((await request(actionSnapshot)).body.transcript),projected(prefix));
  const sessionActions={logicalSessionKey:actionSessionKey,nativeSessionKey:actionNativeKey,forkStatus:forked.status,rewindStatus:rewound.status,prefixMessages:prefix.length,sourceUnchangedByFork:true};
  fs.writeFileSync(path.join(root,'session-actions.json'),JSON.stringify(sessionActions,null,2));
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({approvalExpiry,approvalPeer,sessionActions,sessionReadIdentity,npmInstallation,archiveInstallation,sdk:JSON.parse(fs.readFileSync(path.join(sdk,'package.json'),'utf8')).version,passed:['官方 SDK 标准停止入口绑定及空闲目标无副作用','真实注册与能力','审批权威查询、ACK 后恢复、批准与拒绝、终态及回执去重','真实 SDK 审批到期、canonical 终态及过期答案拒绝','真实 SDK 另一端解决审批及迟到旧卡片拒绝','持久准入后重建恢复且仅执行一次','官方 SDK 历史写入及新旧序列化','canonical 全文详情及请求身份','文件提取正文在历史页、全文及恢复快照中隔离','公共改名与置顶及旧接口','模型、命令和工具目录的宿主分发','定时任务和投递频道目录','Talk 目录及脱敏配置','Agent 配置及会话设置','UUID 会话绑定','UUID 逻辑会话分叉、前缀保留及回退','规范与旧版已读身份、标记未读和带代际确认','真实 /help 执行','第二设备订阅投递去重','未知格式拒绝准入','幂等与冲突','新旧 v3 输出'],modelCalls:false},null,2));
  console.log(`真实 OpenClaw 隔离验证通过：${root}`);
} finally {
  if(child && child.exitCode === null) {
    child.kill('SIGTERM');await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,10000))]);
    if(child.exitCode === null)child.kill('SIGKILL');
  }
  fs.closeSync(log);
  console.log(`隔离产物：${root}；未访问生产状态目录`);
}
