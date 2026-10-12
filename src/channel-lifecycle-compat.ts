/**
 * 兼容加载 `runPassiveAccountLifecycle`。
 *
 * 2026-09-30 OpenClaw 提前退休了兼容子路径 `openclaw/plugin-sdk/channel-lifecycle`
 * （2026.10.1 起宿主 exports 不再包含），函数原样迁到 `channel-outbound`
 * （该子路径自 2026.6.9 起存在）。任一侧静态 import 都会在另一侧版本的宿主上
 * 以 ERR_PACKAGE_PATH_NOT_EXPORTED 让整个插件加载失败，所以按需动态 import：
 * 新路径优先，旧宿主回退旧路径。两档都不可用时退回本地被动保持——语义与 SDK
 * 实现一致（start 后等待 abort），保证账号不会被健康监控误判为 stopped。
 *
 * CLEANUP: 最低宿主版本升至 >=2026.6.9 后恢复静态导入并删除本文件。
 */
import { createFridayNextLogger } from "./logging.js";

const logger = createFridayNextLogger("channel-lifecycle");

export type RunPassiveAccountLifecycle = (params: {
  abortSignal?: AbortSignal;
  start: () => Promise<unknown>;
  stop?: (handle: unknown) => void | Promise<void>;
  onStop?: () => void | Promise<void>;
}) => Promise<void>;

type RuntimeImporter = (specifier: string) => Promise<unknown>;

const MODERN_SPECIFIER = "openclaw/plugin-sdk/channel-outbound";
const LEGACY_SPECIFIER = "openclaw/plugin-sdk/channel-lifecycle";

function pickRunPassiveAccountLifecycle(module: unknown): RunPassiveAccountLifecycle | null {
  const fn = (module as { runPassiveAccountLifecycle?: unknown } | null | undefined)
    ?.runPassiveAccountLifecycle;
  return typeof fn === "function" ? (fn as RunPassiveAccountLifecycle) : null;
}

function waitUntilAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise<void>(() => undefined);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** 与 SDK `runPassiveAccountLifecycle` 同语义的最小本地实现（最后兜底）。 */
const localPassiveHold: RunPassiveAccountLifecycle = async (params) => {
  const handle = await params.start();
  try {
    await waitUntilAbort(params.abortSignal);
  } finally {
    await params.stop?.(handle);
    await params.onStop?.();
  }
};

let importer: RuntimeImporter = (specifier) => import(specifier);
let cached: Promise<RunPassiveAccountLifecycle> | null = null;

async function load(): Promise<RunPassiveAccountLifecycle> {
  for (const specifier of [MODERN_SPECIFIER, LEGACY_SPECIFIER]) {
    try {
      const fn = pickRunPassiveAccountLifecycle(await importer(specifier));
      if (fn) return fn;
    } catch {
      // 宿主没有该子路径 → 尝试下一档
    }
  }
  logger.warn("channel lifecycle SDK subpath unavailable on this host; using local passive hold");
  return localPassiveHold;
}

export function loadRunPassiveAccountLifecycle(): Promise<RunPassiveAccountLifecycle> {
  cached ??= load();
  return cached;
}

/** Test-only: replace the module importer (resets the cache). */
export function __setChannelLifecycleImporterForTest(next: RuntimeImporter): void {
  importer = next;
  cached = null;
}

/** Test-only: restore the default importer (resets the cache). */
export function __resetChannelLifecycleImporterForTest(): void {
  importer = (specifier) => import(specifier);
  cached = null;
}
