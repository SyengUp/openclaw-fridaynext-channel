import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindFridayDeviceToSession,
  forwardAgentEventRaw,
  registerFridaySessionDeviceMapping,
  resetOpenClawRunDeviceMappingForTest,
  resetSessionBindingsForTest,
  resetThinkingStreamAccumStateForTest,
} from "./friday-session.js";
import { getRunRoute, registerRunRoute, resetRunMetadataForTest } from "./run-metadata.js";
import { sseEmitter } from "./sse/emitter.js";
import { resetActiveRunsForTest } from "./agent/active-runs.js";
import { resetFridayAgentForwardRuntimeForTest } from "./agent-forward-runtime.js";

/**
 * 复现真机事故(2026-09-09):run 在会话 A 中启动后,用户切到会话 B(bind 覆盖
 * `deviceIdToLatestHistorySessionKey`),core 随后剥离了 A 的 assistant/tool 帧上的
 * sessionKey——缺标帧被回退到"设备最近会话"B,导致 A 的输出(含 progress_card
 * 工具帧)串进 B 的会话。回归口径:缺标帧必须按 run 的确定性归属(dispatch 时
 * `registerRunRoute` 记录、lifecycle.start 补记)路由,而不是设备最近 bind 的会话。
 */
describe("forwardAgentEventRaw (sessionKey attribution for stripped frames)", () => {
  const deviceId = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
  const sessionKeyA = "agent:main:fridaynext:mtu2thuk";
  const sessionKeyB = "agent:main:fridaynext:mttyru64";
  const runA = "run-route-attribution-posted";
  const runExternal = "run-route-attribution-external";

  beforeEach(() => {
    sseEmitter.resetForTest();
    resetThinkingStreamAccumStateForTest();
    resetOpenClawRunDeviceMappingForTest();
    resetSessionBindingsForTest();
    resetRunMetadataForTest();
    resetActiveRunsForTest();
    resetFridayAgentForwardRuntimeForTest();
    vi.spyOn(sseEmitter, "broadcastToRun").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attributes a stripped frame to the run's dispatch route, not the session bound later", () => {
    // 1) POST dispatch:run A 属于会话 A(与 messages.ts 同序——route 在 202 可见前就存在)。
    registerFridaySessionDeviceMapping(sessionKeyA, deviceId);
    registerRunRoute({ runId: runA, deviceId, sessionKey: sessionKeyA });
    // 2) lifecycle.start 到达时仍带正确的 sessionKey(core 尚未剥离),建立 run→device 映射。
    forwardAgentEventRaw({
      runId: runA,
      seq: 1,
      ts: 100,
      stream: "lifecycle",
      sessionKey: sessionKeyA,
      data: { phase: "start" },
    });
    // 3) 用户在 run 进行中切到会话 B:bind 把"设备最近会话"覆盖为 B。
    bindFridayDeviceToSession(sessionKeyB, deviceId);
    // 4) core 剥离了 sessionKey 的 assistant delta 到达。
    forwardAgentEventRaw({
      runId: runA,
      seq: 2,
      ts: 101,
      stream: "assistant",
      data: { delta: "homeassistant diagnostic output" },
    });

    expect(sseEmitter.broadcastToRun).toHaveBeenCalledTimes(2);
    const stripped = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[1][1]
      .data as Record<string, unknown>;
    expect(stripped.sessionKey).toBe(sessionKeyA);
  });

  it("backfills the route from lifecycle.start so later stripped frames of an externally started run stay attributed", () => {
    // Control UI / WebChat 启动的 run 不经过 POST dispatch,没有预注册 route;app 之前
    // 打开过 A 与 B(bind 顺序:A 先、B 后 → 设备最近会话是 B)。
    bindFridayDeviceToSession(sessionKeyA, deviceId);
    bindFridayDeviceToSession(sessionKeyB, deviceId);
    forwardAgentEventRaw({
      runId: runExternal,
      seq: 1,
      ts: 100,
      stream: "lifecycle",
      sessionKey: sessionKeyA,
      data: { phase: "start" },
    });
    expect(getRunRoute(runExternal)?.sessionKey).toBe(sessionKeyA);

    forwardAgentEventRaw({
      runId: runExternal,
      seq: 2,
      ts: 101,
      stream: "assistant",
      data: { delta: "output" },
    });
    const stripped = (sseEmitter.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[1][1]
      .data as Record<string, unknown>;
    expect(stripped.sessionKey).toBe(sessionKeyA);
  });
});
