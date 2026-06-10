/**
 * Captures the full plugin runtime (`api.runtime`) at `registerFull` time so the
 * plugin-info / plugin-upgrade HTTP handlers can reach `system.runCommandWithTimeout`
 * and `config.mutateConfigFile` — capabilities the narrow `getFridayNextRuntime()`
 * store does NOT expose (it only carries `config`/`logger`).
 *
 * Mirrors the `setFridayAgentForwardRuntime` capture pattern in agent-forward-runtime.ts.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export type SpawnResultLike = {
  code: number | null;
  stdout: string;
  stderr: string;
  [key: string]: unknown;
};

export type ConfigAfterWrite =
  | { mode: "auto" }
  | { mode: "restart"; reason: string }
  | { mode: "none"; reason: string };

export type UpgradeRuntime = {
  /** Run a command (argv) with a timeout in ms; resolves with stdout/stderr/code. */
  runCommandWithTimeout: (argv: string[], timeoutMs: number) => Promise<SpawnResultLike>;
  /** Read the current (deep-readonly) OpenClaw config snapshot. */
  currentConfig: () => unknown;
  /** Mutate the config file; `afterWrite: { mode: "restart" }` triggers a safe gateway restart. */
  mutateConfigFile: (params: {
    afterWrite: ConfigAfterWrite;
    mutate: (draft: unknown) => unknown | void;
  }) => Promise<unknown>;
  /**
   * Filesystem path of THIS loaded plugin (`api.source`). Used to infer the install
   * source (npm vs dev) on OpenClaw builds (2026.6.x+) that no longer surface
   * `plugins.installs` in the config snapshot. See `getInstallSource`.
   */
  pluginSource: string | undefined;
};

let upgradeRuntime: UpgradeRuntime | null = null;

export function setUpgradeRuntime(api: OpenClawPluginApi): void {
  const runtime = api.runtime as unknown as {
    system?: { runCommandWithTimeout?: (argv: string[], opts: unknown) => Promise<SpawnResultLike> };
    config: {
      current: () => unknown;
      mutateConfigFile?: (params: unknown) => Promise<unknown>;
    };
  };

  upgradeRuntime = {
    runCommandWithTimeout: async (argv, timeoutMs) => {
      const run = runtime.system?.runCommandWithTimeout;
      if (!run) throw new Error("runtime.system.runCommandWithTimeout unavailable");
      // `runCommandWithTimeout(argv, number | CommandOptions)` — pass the bare ms.
      return run(argv, timeoutMs);
    },
    currentConfig: () => runtime.config.current(),
    mutateConfigFile: async (params) => {
      const mutate = runtime.config.mutateConfigFile;
      if (!mutate) throw new Error("runtime.config.mutateConfigFile unavailable");
      return mutate(params);
    },
    pluginSource: typeof api.source === "string" ? api.source : undefined,
  };
}

export function getUpgradeRuntime(): UpgradeRuntime | null {
  return upgradeRuntime;
}

/** Vitest-only */
export function resetUpgradeRuntimeForTest(): void {
  upgradeRuntime = null;
}
