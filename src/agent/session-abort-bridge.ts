/**
 * 会话级标准停止桥 —— 兼容旧直接停止入口与 2026.10.5 的两阶段停止入口。
 *
 * 这是 core 自己的停止链路（`/stop` 命令、reset 等走的就是它）：先对会话的 reply
 * operation 调 `abortByUser()`（把派发终点标记为 `aborted_by_user` → SILENT reply），
 * 再 plain abort 嵌入式 run。2026.10.1 起只调 `abortAgentHarnessRun(sessionId)` 不再
 * 能让派发终点进入 SILENT 分支（run 停了，但 dispatch 判定「无可见回复」，向 App
 * 推送核心的 no-visible-reply fallback「⚠️ OpenClaw couldn't produce or deliver a
 * reply…」）。该函数不在公开 plugin-sdk，按 tool-catalog 的既有模式深导入：扫核心
 * dist 找定义 chunk（函数名未混淆），按 `function.name` 取导出并缓存。
 *
 * 2026.10.5 改为 prepareSessionRunTargetAbort(params) 返回提交函数，需要准备并提交一次。
 * 找不到（旧核心 / 无法定位安装目录）时返回 null，调用方回退旧的 plain abort，
 * 行为与 2026.10.1 之前一致。
 */
import fs from "node:fs";
import path from "node:path";
import { importAbsoluteModule } from "../import-absolute-module.js";
import { createFridayNextLogger } from "../logging.js";
import { resolveOpenClawRoot } from "../skills-discovery.js";

const logger = createFridayNextLogger("session-abort");

interface AbortSessionRunTargetOutcome {
  active?: boolean;
  aborted?: boolean;
  retirement?: Promise<unknown>;
}

type SessionAbortTarget = {
  agentId?: string;
  key?: string;
  sessionId?: string;
};

type AbortSessionRunTargetFn = (params: SessionAbortTarget) => AbortSessionRunTargetOutcome;
type PrepareSessionRunTargetAbortFn = (
  params: SessionAbortTarget,
) => () => AbortSessionRunTargetOutcome;

export interface SessionAbortOutcome {
  active: boolean;
  aborted: boolean;
}

let cachedFn: AbortSessionRunTargetFn | null | undefined;

function findExport(module: Record<string, unknown>): AbortSessionRunTargetFn | null {
  // 定义 chunk 以混淆名导出（如 `t`），但函数声明保留真名 —— 按 name 匹配。
  for (const value of Object.values(module)) {
    if (typeof value === "function" && value.name === "abortSessionRunTargetWithOutcome") {
      return value as AbortSessionRunTargetFn;
    }
  }
  // 新版 SDK 将捕获目标与执行停止拆开；仍在适配桥内归一为一次标准停止。
  for (const value of Object.values(module)) {
    if (typeof value === "function" && value.name === "prepareSessionRunTargetAbort") {
      const prepare = value as PrepareSessionRunTargetAbortFn;
      return (params) => prepare(params)();
    }
  }
  return null;
}

/** 扫 dist 目录找定义 chunk；导出供测试用临时目录驱动。 */
export async function locateAbortSessionRunTargetInDist(
  distDir: string,
): Promise<AbortSessionRunTargetFn | null> {
  let files: string[];
  try {
    files = fs
      .readdirSync(distDir)
      .filter((file) => file.endsWith(".mjs") || file.endsWith(".js"))
      .sort();
  } catch {
    return null;
  }
  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(distDir, file), "utf8");
    } catch {
      continue;
    }
    if (
      !content.includes("function abortSessionRunTargetWithOutcome") &&
      !content.includes("function prepareSessionRunTargetAbort")
    )
      continue;
    try {
      const module = (await importAbsoluteModule(path.join(distDir, file))) as Record<
        string,
        unknown
      >;
      const fn = findExport(module);
      if (fn) return fn;
    } catch {
      // 不可导入的候选 chunk → 继续扫
    }
  }
  return null;
}

async function locateAbortSessionRunTarget(): Promise<AbortSessionRunTargetFn | null> {
  if (cachedFn !== undefined) return cachedFn;
  const root = resolveOpenClawRoot();
  cachedFn = root ? await locateAbortSessionRunTargetInDist(path.join(root, "dist")) : null;
  return cachedFn;
}

/**
 * 执行 core 的标准会话停止。返回 null 表示桥不可用（调用方回退 plain abort）。
 * `retirement`（MCP runtime 清理）不阻塞停止响应：abort 部分是同步完成的，
 * 清理失败只记日志。
 */
export async function abortSessionRunTargetFromCore(params: {
  sessionKey: string;
  agentId: string;
}): Promise<SessionAbortOutcome | null> {
  try {
    const fn = await locateAbortSessionRunTarget();
    if (!fn) return null;
    const outcome = fn({ agentId: params.agentId, key: params.sessionKey });
    if (outcome?.retirement && typeof outcome.retirement.catch === "function") {
      outcome.retirement.catch((error: unknown) => {
        logger.debug(
          `session abort retirement failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    return { active: Boolean(outcome?.active), aborted: Boolean(outcome?.aborted) };
  } catch {
    return null;
  }
}

/** Test-only: inject a fake core function (undefined = force re-locate). */
export function __setAbortSessionRunTargetFnForTest(
  fn: AbortSessionRunTargetFn | null | undefined,
): void {
  cachedFn = fn;
}

/** Test-only: reset the cached locator result. */
export function __resetAbortSessionRunTargetCacheForTest(): void {
  cachedFn = undefined;
}
