import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LegacyApprovalStore } from "./legacy-approval-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeStore(): { root: string; store: LegacyApprovalStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-legacy-approvals-"));
  roots.push(root);
  return { root, store: new LegacyApprovalStore(root) };
}

describe("LegacyApprovalStore", () => {
  it("把结构化生命周期持久化为 projectApprovals 可消费的原始契约", () => {
    const { root, store } = makeStore();
    store.upsert({
      op: "request",
      approvalId: "exec-1",
      kind: "exec",
      title: "命令审批",
      commandText: "pnpm test",
      cwd: "/workspace",
      metadata: [],
      actions: [],
      expiresAtMs: 2_000,
      deviceId: "",
      ts: 1_000,
    });

    expect(new LegacyApprovalStore(root).list("exec", 1_500)).toEqual([
      {
        id: "exec-1",
        createdAtMs: 1_000,
        expiresAtMs: 2_000,
        request: { command: "pnpm test", cwd: "/workspace" },
      },
    ]);
  });

  it("终态删除、过期清理和不同 kind 的同 id 隔离", () => {
    const { store } = makeStore();
    const base = {
      op: "request" as const,
      approvalId: "same-id",
      title: "插件审批",
      description: "说明",
      metadata: [],
      actions: [],
      expiresAtMs: 2_000,
      deviceId: "",
      ts: 1_000,
    };
    store.upsert({ ...base, kind: "plugin" });
    store.upsert({
      ...base,
      kind: "system-agent",
      commandText: "apply",
      proposalHash: "sha256:abc",
    });

    expect(store.remove("plugin", "same-id")).toBe(true);
    expect(store.list("plugin", 1_500)).toEqual([]);
    expect(store.list("system-agent", 1_500)).toHaveLength(1);
    expect(store.list("system-agent", 2_001)).toEqual([]);
  });

  it("新 gateway 进程代次不会恢复旧进程已经失效的 pending 审批", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-legacy-approvals-"));
    roots.push(root);
    const firstProcess = new LegacyApprovalStore(root, "process-1");
    firstProcess.upsert({
      op: "request",
      approvalId: "exec-before-restart",
      kind: "exec",
      title: "命令审批",
      commandText: "pnpm test",
      metadata: [],
      actions: [],
      expiresAtMs: 2_000,
      deviceId: "",
      ts: 1_000,
    });

    expect(new LegacyApprovalStore(root, "process-1").list("exec", 1_500)).toHaveLength(1);
    expect(new LegacyApprovalStore(root, "process-2").list("exec", 1_500)).toEqual([]);
  });
});
