import type {
  BackendAdapter,
  ControlResponse,
  DurableRunCommand,
  DurableRunRecord,
  HistoryQuery,
  JSONObject,
  SessionSnapshot,
} from "@syengup/fridaynext-channel-kit";
import { ChannelError } from "@syengup/fridaynext-channel-kit";
import { normalizeAgentId } from "../../agent-id.js";
import { abortRunForSessionKey } from "../../agent/abort-run.js";
import { hasActiveSession } from "../../agent/active-runs.js";
import { loadDetachedWebhookWork } from "../../agent/detached-webhook-work.js";
import {
  ensureGatewayRequestScopes,
  ensureSubagentSpawnScope,
} from "../../agent/operator-scope.js";
import { markUserAbort } from "../../agent/recent-aborts.js";
import { resolveFridayNextConfig } from "../../config.js";
import { registerFridaySessionDeviceMapping } from "../../friday-session.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { resolveConfiguredAgents } from "../../http/handlers/agents-list.js";
import { readOpenClawHealth } from "../../http/handlers/health.js";
import { readOpenClawHistory, readOpenClawHistoryMessage } from "../../http/handlers/history-messages.js";
import { listOpenClawSessions } from "../../http/handlers/history-sessions.js";
import {
  fetchCoreModelsList,
  resolveConfiguredDefaultModel,
  resolveConfiguredModels,
} from "../../http/handlers/models-list.js";
import { updateOpenClawSessionSettings } from "../../http/handlers/sessions-settings.js";
import { hasPendingFridayQuestion } from "../../question/friday-question.js";
import { registerRunRoute } from "../../run-metadata.js";
import { getFridayNextRuntime } from "../../runtime.js";
import { getSessionSettings, toSessionStoreKey } from "../../session/session-manager.js";
import { sseEmitter } from "../../sse/emitter.js";
import {
  lookupOpenClawControl,
  openClawControls,
  respondOpenClawDevice,
} from "./control-adapter.js";
import { openClawDescriptor } from "./descriptor.js";
import { executeOpenClawRun } from "./execution.js";
import { inspectOpenClawRun } from "./run-inspection.js";
import { describeSession, ensureLogicalSession, logicalSessionKey } from "./session-metadata.js";
import { readOpenClawSnapshot } from "./transport-compatibility.js";
import { bindOpenClawSession, setOpenClawSessionTitle, setOpenClawSessionPinned } from "./session-actions.js";

const json = (value: unknown): JSONObject => JSON.parse(JSON.stringify(value)) as JSONObject;

// 唯一宿主适配器：只提供 SDK 操作与宿主事实，运行状态机属于公共库。
export class OpenClawBackendAdapter implements BackendAdapter {
  get descriptor() {
    return openClawDescriptor();
  }

  resolveCommand(command: DurableRunCommand): DurableRunCommand {
    const agentId = normalizeAgentId(command.agentId);
    try {
      if (!/^agent:/i.test(command.sessionKey)) ensureLogicalSession(command.sessionKey, agentId);
    } catch {
      throw new ChannelError(409, "SESSION_AGENT_CONFLICT", "会话已绑定其他 Agent");
    }
    const sessionKey = toSessionStoreKey(command.sessionKey);
    return {
      ...command,
      agentId: describeSession(sessionKey).agentId,
      sessionKey,
      text: command.text.trim(),
    };
  }

  attachRun(run: DurableRunRecord): void {
    registerFridaySessionDeviceMapping(logicalSessionKey(run.sessionKey), run.deviceId);
    sseEmitter.trackDeviceForRun(run.deviceId, run.runId);
    registerRunRoute({ runId: run.runId, deviceId: run.deviceId, sessionKey: run.sessionKey });
  }

  dispatchReadiness(run: DurableRunRecord) {
    return hasPendingFridayQuestion(run.sessionKey)
      ? ("control-response" as const)
      : hasActiveSession(run.sessionKey)
        ? ("blocked" as const)
        : ("ready" as const);
  }

  async reserveExecution(work: () => Promise<void>) {
    ensureSubagentSpawnScope();
    const start = await loadDetachedWebhookWork();
    return { completion: start(work) };
  }

  execute(run: DurableRunRecord) {
    return executeOpenClawRun(run);
  }
  inspect(run: DurableRunRecord) {
    return inspectOpenClawRun(run);
  }
  async cancel(run: DurableRunRecord) {
    markUserAbort(run.sessionKey);
    await abortRunForSessionKey(run.sessionKey);
    // 停止回执只表示请求已提交，真正终态由宿主事件或执行 Promise 确认。
    return { state: "unknown" as const };
  }
  flushRun(runId: string): void {
    sseEmitter.flushRuntimeV3Run(runId);
  }
  releaseRun(run: DurableRunRecord): void {
    sseEmitter.untrackRun(run.runId);
  }

  async snapshot(key: string, limit: number): Promise<SessionSnapshot> {
    const native = toSessionStoreKey(key);
    const value = await readOpenClawSnapshot(native, limit);
    if (!("sessionId" in value)) throw new ChannelError(503, "UNAVAILABLE", "会话身份持续变化");
    return {
      session: value.session ?? describeSession(native, value.sessionId),
      transcript: value.transcript.map(json),
      controls: value.controls,
      usage: value.sessionUsage ? json(value.sessionUsage) : undefined,
    };
  }
  async listSessions() {
    return listOpenClawSessions().map((row) => ({
      ...row,
      ...describeSession(row.sessionKey, row.sessionId),
    }));
  }
  async healthDetails(query: Record<string, string>) {
    return json(await readOpenClawHealth(query));
  }
  async historyPage(query: HistoryQuery) {
    const page = await readOpenClawHistory({
      ...query,
      sessionKey: toSessionStoreKey(query.sessionKey),
    });
    return {
      ...page,
      sessionKey: query.sessionKey,
      messages: page.messages.map(json),
      sessionUsage: page.sessionUsage ? json(page.sessionUsage) : undefined,
    };
  }
  async historyMessage(key: string, id: string) {
    const value = readOpenClawHistoryMessage(key, id);
    return value ? json(value) : null;
  }
  setSessionTitle(key: string, title: string) { return setOpenClawSessionTitle(key, title); }
  setSessionPinned(key: string, pinned: boolean) { return setOpenClawSessionPinned(key, pinned); }
  bindSession(key: string, deviceId: string) { return bindOpenClawSession(key, deviceId); }

  async agentCatalog() {
    const catalog = resolveConfiguredAgents();
    return {
      ...catalog,
      agents: catalog.agents.map((row) => ({ ...row, name: row.name ?? row.id })),
      ...(catalog.permissionModes
        ? {
            permissionOptions: catalog.permissionModes.map((id) => ({
              id,
              label:
                (
                  {
                    "read-only": "Read only",
                    guarded: "Approval required",
                    workspace: "Automatic approval",
                    full: "Full access",
                  } as Record<string, string>
                )[id] ?? id,
              ...(id === "full" ? { scope: "unrestricted" } : {}),
            })),
          }
        : {}),
    };
  }
  async listAgents() {
    return resolveConfiguredAgents().agents.map((row) => ({ ...row, name: row.name ?? row.id }));
  }
  async listModels(agentId?: string) {
    ensureGatewayRequestScopes(["operator.read"]);
    const models = (await fetchCoreModelsList(agentId)) ?? resolveConfiguredModels(agentId).models;
    return {
      models: models.map((model) => ({ ...model, name: model.name ?? model.id })),
      defaultModel: resolveConfiguredDefaultModel(agentId),
    };
  }
  async sessionSettings(key: string, patch?: JSONObject): Promise<JSONObject> {
    const sessionKey = toSessionStoreKey(key);
    const cfg = resolveFridayNextConfig(
      getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
    );
    return json(
      patch
        ? await updateOpenClawSessionSettings(sessionKey, patch)
        : getSessionSettings(sessionKey, cfg.historyDir),
    );
  }

  lookupControl(id: string) {
    return lookupOpenClawControl(id);
  }
  respondControl(id: string, response: ControlResponse) {
    return openClawControls().respondControl(id, response);
  }
  respondDevice(_id: string, result: JSONObject) {
    return respondOpenClawDevice(result);
  }
}
