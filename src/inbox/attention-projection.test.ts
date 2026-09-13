import { describe, expect, it } from "vitest";
import {
  projectApprovals,
  projectAutomationAttention,
  projectModelAuthAttention,
  projectUpdateAttention,
} from "./attention-projection.js";

describe("Inbox v2 Control UI parity projection", () => {
  it("聚合三类审批、过滤过期项并按创建时间升序", () => {
    const approvals = projectApprovals(
      {
        exec: [
          {
            id: "exec-1",
            createdAtMs: 20,
            expiresAtMs: 2_000,
            request: { command: "pnpm test" },
          },
        ],
        plugin: {
          approvals: [
            {
              id: "plugin-1",
              createdAtMs: 10,
              expiresAtMs: 2_000,
              request: { title: "安装插件" },
            },
          ],
        },
        "system-agent": [
          {
            id: "system-1",
            createdAtMs: 5,
            expiresAtMs: 50,
            request: {
              title: "系统代理",
              description: "确认变更",
              command: "apply",
              proposalHash: "sha",
            },
          },
        ],
      },
      100,
    );
    expect(approvals.map((item) => item.kind)).toEqual(["pluginApproval", "execApproval"]);
  });

  it("人工暂停的历史失败不算，自动停用仍算失败", () => {
    const items = projectAutomationAttention({
      schedulerEnabled: true,
      nowMs: 1_000_000,
      jobs: [
        { id: "paused", enabled: false, state: { lastRunStatus: "error" } },
        {
          id: "auto",
          enabled: false,
          state: {
            lastRunStatus: "error",
            autoDisabled: { reason: "consecutive-failures", consecutiveErrors: 10 },
          },
        },
        { id: "enabled", enabled: true, state: { lastStatus: "error" } },
      ],
    });
    expect(items.map((item) => item.signature)).toEqual(["auto", "enabled"]);
  });

  it("调度器停用或任务运行中时不判 overdue，恢复计划后签名变化", () => {
    const job = { id: "late", enabled: true, state: { nextRunAtMs: 1 } };
    expect(
      projectAutomationAttention({ jobs: [job], schedulerEnabled: false, nowMs: 300_002 }),
    ).toEqual([]);
    expect(
      projectAutomationAttention({
        jobs: [{ ...job, state: { nextRunAtMs: 1, runningAtMs: 2 } }],
        schedulerEnabled: true,
        nowMs: 300_002,
      }),
    ).toEqual([]);
    expect(
      projectAutomationAttention({ jobs: [job], schedulerEnabled: true, nowMs: 300_002 })[0]
        ?.signature,
    ).toBe("late@1");
  });

  it("只提示 OAuth/token 或明确 missing，并折叠 provider alias", () => {
    const items = projectModelAuthAttention(
      {
        ts: 10,
        providers: [
          {
            provider: "claude-cli",
            displayName: "Claude CLI",
            status: "expired",
            profiles: [{ profileId: "cli", type: "oauth", status: "expired" }],
          },
          {
            provider: "anthropic",
            displayName: "Anthropic",
            status: "ok",
            profiles: [{ profileId: "api", type: "api_key", status: "static" }],
          },
          {
            provider: "api-only",
            displayName: "API only",
            status: "expired",
            profiles: [{ profileId: "api", type: "api_key", status: "expired" }],
          },
          { provider: "missing", displayName: "Missing", status: "missing", profiles: [] },
        ],
      },
      "writer",
      100,
    );
    expect(items.map((item) => item.signature)).toEqual([
      "agent:writer\nanthropic",
      "agent:writer\nmissing",
    ]);
  });

  it("update 运行中、失败及 24 小时内结果可见，旧结果消失", () => {
    expect(
      projectUpdateAttention(
        { activeRun: { runId: "11111111-1111-4111-8111-111111111111", status: "running" } },
        "server",
        100,
      )[0]?.requiresAction,
    ).toBe(true);
    expect(
      projectUpdateAttention(
        {
          lastRun: {
            runId: "22222222-2222-4222-8222-222222222222",
            status: "failed",
            finishedAtMs: 90,
          },
        },
        "server",
        100,
      )[0],
    ).toMatchObject({
      severity: "error",
      requiresAction: false,
      payload: { forced: false, canDismiss: true },
    });
    expect(
      projectUpdateAttention(
        { lastRun: { runId: "old", status: "succeeded", finishedAtMs: 1 } },
        "server",
        24 * 60 * 60 * 1_000 + 2,
      ),
    ).toEqual([]);
  });

  it("update 失败条目携带可展示的结构化诊断，而不是把信息只埋在原始状态里", () => {
    const item = projectUpdateAttention(
      {
        sentinel: null,
        lastRun: {
          runId: "49294e91-e80f-4b8f-9319-2eca3f983c10",
          createdAtMs: 100,
          finishedAtMs: 200,
          phase: "finished",
          status: "failed",
          reason: "post-update-plugins",
          target: { kind: "package", version: "2026.9.4" },
          origin: {
            doctorHint: "Run openclaw doctor --non-interactive.",
            nextAction: "Run `openclaw triage` to repair the installation.",
          },
          steps: [
            { step: "validating", status: "failed" },
            { step: "post-update verification", status: "failed", detail: "plugin check failed" },
          ],
          verification: {
            runningVersion: "2026.9.4",
            serviceRunning: true,
            pluginErrors: ["friday-next failed to load"],
          },
        },
        updateAvailable: null,
      },
      "server",
      300,
    )[0];

    expect(item?.detail).toBe("post-update-plugins · 2026.9.4");
    expect(item?.payload?.diagnostic).toEqual({
      runId: "49294e91-e80f-4b8f-9319-2eca3f983c10",
      status: "failed",
      phase: "finished",
      reason: "post-update-plugins",
      targetVersion: "2026.9.4",
      failedSteps: ["validating", "post-update verification: plugin check failed"],
      runningVersion: "2026.9.4",
      serviceRunning: true,
      pluginErrors: ["friday-next failed to load"],
      nextAction: "Run `openclaw triage` to repair the installation.",
      doctorHint: "Run openclaw doctor --non-interactive.",
      finishedAtMs: 200,
    });
  });

  it("只投影真实可用更新和失败的 update sentinel", () => {
    expect(
      projectUpdateAttention(
        {
          updateAvailable: {
            currentVersion: "2026.9.4",
            latestVersion: "2026.9.4",
            commitsBehind: 0,
          },
        },
        "server",
      ),
    ).toEqual([]);
    expect(
      projectUpdateAttention({ sentinel: { kind: "update", status: "ok", ts: 10 } }, "server"),
    ).toEqual([]);
    expect(
      projectUpdateAttention(
        {
          sentinel: {
            kind: "update",
            status: "error",
            ts: 10,
            stats: { reason: "build-failed" },
          },
        },
        "server",
      )[0],
    ).toMatchObject({ requiresAction: true, severity: "error" });
  });
});
