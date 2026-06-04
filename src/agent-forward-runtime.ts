import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export type FridayAgentForwardRuntime = {
  resolveStorePath: (store?: string, opts?: { agentId?: string }) => string;
  loadSessionStore: (
    path: string,
    options?: { skipCache?: boolean; maintenanceConfig?: unknown; clone?: boolean },
  ) => Record<string, unknown>;
  /** Cache-owning entry write (syncs the app session name → server `displayName`). */
  updateSessionStoreEntry?: (params: {
    storePath: string;
    sessionKey: string;
    update: (
      entry: Record<string, unknown>,
    ) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
  }) => Promise<Record<string, unknown> | null>;
  getConfig: () => unknown;
};

let forwardRuntime: FridayAgentForwardRuntime | null = null;

/** Called from `registerFull` so terminal lifecycle forwards can read `sessions.json` after persist. */
export function setFridayAgentForwardRuntime(api: OpenClawPluginApi): void {
  forwardRuntime = {
    resolveStorePath: api.runtime.agent.session.resolveStorePath,
    loadSessionStore: api.runtime.agent.session.loadSessionStore,
    updateSessionStoreEntry: (api.runtime.agent.session as Record<string, unknown>)
      .updateSessionStoreEntry as FridayAgentForwardRuntime["updateSessionStoreEntry"],
    getConfig: () => api.runtime.config.current(),
  };
}

export function getFridayAgentForwardRuntime(): FridayAgentForwardRuntime | null {
  return forwardRuntime;
}

/** Vitest-only */
export function resetFridayAgentForwardRuntimeForTest(): void {
  forwardRuntime = null;
}
