import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortSessionRunTargetFromCore,
  locateAbortSessionRunTargetInDist,
  __resetAbortSessionRunTargetCacheForTest,
  __setAbortSessionRunTargetFnForTest,
} from "./session-abort-bridge.js";

let tmpDir = "";

function makeDist(chunks: Record<string, string>): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fn-abort-dist-"));
  for (const [name, content] of Object.entries(chunks)) {
    fs.writeFileSync(path.join(tmpDir, name), content);
  }
  return tmpDir;
}

afterEach(() => {
  __resetAbortSessionRunTargetCacheForTest();
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  }
});

describe("locateAbortSessionRunTargetInDist", () => {
  it("按函数真名在混淆导出的 chunk 里定位 abortSessionRunTargetWithOutcome", async () => {
    const dist = makeDist({
      "unrelated-abc.mjs": "export const x = 1;\n",
      "abort-operation-xyz.mjs": [
        "function abortSessionRunTargetWithOutcome(params) { return { active: true, aborted: true, params }; }",
        "function other() {}",
        "export { abortSessionRunTargetWithOutcome as t, other as n };",
      ].join("\n"),
    });

    const fn = await locateAbortSessionRunTargetInDist(dist);
    expect(typeof fn).toBe("function");
    expect(fn?.({ key: "agent:main:demo" })).toMatchObject({
      active: true,
      aborted: true,
      params: { key: "agent:main:demo" },
    });
  });

  it("兼容 2026.10.5 的两阶段 prepareSessionRunTargetAbort，并且只提交一次", async () => {
    const dist = makeDist({
      "abort-operation-modern.mjs": [
        "let commits = 0;",
        "function prepareSessionRunTargetAbort(params) { return () => ({ active: true, aborted: true, params, commits: ++commits }); }",
        "export { prepareSessionRunTargetAbort as n };",
      ].join("\n"),
    });
    const fn = await locateAbortSessionRunTargetInDist(dist);
    expect(fn, "新版 SDK 已移除旧直接停止入口，不能静默回退普通 abort").not.toBeNull();
    const params = { agentId: "operator", key: "agent:operator:test" };
    expect(fn?.(params)).toMatchObject({ active: true, aborted: true, params, commits: 1 });
  });

  it("找不到定义 chunk 时返回 null", async () => {
    const dist = makeDist({ "unrelated.mjs": "export const x = 1;\n" });
    expect(await locateAbortSessionRunTargetInDist(dist)).toBeNull();
  });

  it("目录不存在时返回 null", async () => {
    expect(await locateAbortSessionRunTargetInDist("/nonexistent-fn-dist")).toBeNull();
  });
});

describe("abortSessionRunTargetFromCore", () => {
  it("调用注入的核心函数并归一化 outcome（retirement 不阻塞）", async () => {
    const retirement = Promise.reject(new Error("mcp retire failed"));
    const fn = vi.fn().mockReturnValue({ active: true, aborted: true, retirement });
    __setAbortSessionRunTargetFnForTest(fn);

    const outcome = await abortSessionRunTargetFromCore({
      sessionKey: "agent:main:demo",
      agentId: "main",
    });

    expect(fn).toHaveBeenCalledWith({ agentId: "main", key: "agent:main:demo" });
    expect(outcome).toEqual({ active: true, aborted: true });
    await Promise.resolve();
  });

  it("桥不可用时返回 null（调用方回退 plain abort）", async () => {
    __setAbortSessionRunTargetFnForTest(null);
    expect(
      await abortSessionRunTargetFromCore({ sessionKey: "agent:main:demo", agentId: "main" }),
    ).toBeNull();
  });

  it("核心函数抛错时返回 null，不让停止接口失败", async () => {
    __setAbortSessionRunTargetFnForTest(() => {
      throw new Error("boom");
    });
    expect(
      await abortSessionRunTargetFromCore({ sessionKey: "agent:main:demo", agentId: "main" }),
    ).toBeNull();
  });
});
