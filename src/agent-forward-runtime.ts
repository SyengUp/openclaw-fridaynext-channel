import { createRequire } from "node:module";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { importAbsoluteModule } from "./import-absolute-module.js";

const requireSdk = createRequire(import.meta.url);

export type SessionTranscriptEventReader = (params: {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}) => Promise<unknown[]>;

/** O(1) transcript counters without materializing event rows (2026.9+ SDK). */
export type SessionTranscriptStatsReader = (params: {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}) => { eventCount: number; maxSeq: number; sizeBytes: number } | undefined;

export type FridayAgentForwardRuntime = {
  /** Control UI-equivalent session projection (`sessions.list`). */
  gatewayIsAvailable?: () => Promise<boolean>;
  gatewayRequest?: <T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; scopes?: string[] },
  ) => Promise<T>;
  resolveStorePath: (store?: string, opts?: { agentId?: string }) => string;
  /**
   * COMPAT(openclaw<2026.8.1): whole-store JSON map. 2026.8.1+ may omit this
   * from `api.runtime.agent.session` (SQLite row APIs replaced it).
   */
  loadSessionStore?: (
    path: string,
    options?: { skipCache?: boolean; maintenanceConfig?: unknown; clone?: boolean },
  ) => Record<string, unknown>;
  /** 旧宿主的会话条目写入器；仅在按身份写入能力不可用时回退。 */
  updateSessionStoreEntry?: (params: {
    storePath: string;
    sessionKey: string;
    update: (
      entry: Record<string, unknown>,
    ) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
  }) => Promise<Record<string, unknown> | null>;
  /**
   * Canonical session-store read (SQLite-first on OpenClaw 2026.8.1+). Optional on
   * older hosts that only expose `loadSessionStore`.
   */
  getSessionEntry?: (params: {
    sessionKey: string;
    agentId?: string;
    storePath?: string;
  }) => Record<string, unknown> | undefined;
  /** Identity-based list; used to resolve Control UI sessionId → store key. */
  listSessionEntries?: (params?: {
    agentId?: string;
    storePath?: string;
    /** 2026.8.1+: skip writable DB lifecycle; safe for GET/introspection. */
    readOnly?: boolean;
  }) => Array<{ sessionKey: string; entry: Record<string, unknown> }>;
  /** Public async transcript reader; optional on older supported hosts. */
  readSessionTranscriptEvents?: SessionTranscriptEventReader;
  /** Transcript counters (2026.9+). Optional: older hosts don't expose it. */
  readTranscriptStatsSync?: SessionTranscriptStatsReader;
  /** 按会话身份写入规范存储；权限、置顶等会话属性都应优先走此路径。 */
  patchSessionEntry?: (params: {
    sessionKey: string;
    agentId?: string;
    storePath?: string;
    preserveActivity?: boolean;
    /** Seed entry used to CREATE the SQLite row when the session does not exist yet
     *  (brand-new session's first message). Mirrors core's `RuntimeSessionStoreEntryPatchParams`. */
    fallbackEntry?: Record<string, unknown>;
    update: (
      entry: Record<string, unknown>,
      context: { existingEntry?: Record<string, unknown> },
    ) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
  }) => Promise<Record<string, unknown> | null>;
  /** Resolves an agent's workspace dir — used to read IDENTITY.md for the name fallback. */
  resolveAgentWorkspaceDir?: (cfg: unknown, agentId: string) => string;
  /**
   * Resolves the thinking-level options + default for a provider/model pair, driven by the running
   * gateway's provider plugins + model catalog (so the option set varies per model). Optional: older
   * gateways don't expose it, in which case callers fall back to the base five levels.
   */
  resolveThinkingPolicy?: (params: { provider?: string | null; model?: string | null }) => {
    levels: Array<{ id: string; label: string }>;
    defaultLevel?: string | null;
  };
  getConfig: () => unknown;
};

let forwardRuntime: FridayAgentForwardRuntime | null = null;

function resolveReadSessionTranscriptEvents(): SessionTranscriptEventReader | undefined {
  let modulePath: string;
  try {
    modulePath = requireSdk.resolve("openclaw/plugin-sdk/session-transcript-runtime");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error &&
      (error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" || error.code === "MODULE_NOT_FOUND")) {
      return undefined;
    }
    throw error;
  }
  return async (params) => {
    const mod = await importAbsoluteModule(modulePath) as {
      readSessionTranscriptEvents: SessionTranscriptEventReader;
    };
    return await mod.readSessionTranscriptEvents(params);
  };
}

/** Optional counters from the session-store SDK; injected in unit fixtures. */
function resolveReadTranscriptStatsSync(
  session: Record<string, unknown>,
): SessionTranscriptStatsReader | undefined {
  if (typeof session.readTranscriptStatsSync === "function") {
    return session.readTranscriptStatsSync as SessionTranscriptStatsReader;
  }
  if (process.env.VITEST === "true") return undefined;
  try {
    const mod = requireSdk("openclaw/plugin-sdk/session-store-runtime") as {
      readTranscriptStatsSync?: SessionTranscriptStatsReader;
    };
    return typeof mod.readTranscriptStatsSync === "function"
      ? mod.readTranscriptStatsSync
      : undefined;
  } catch {
    return undefined;
  }
}

/** Called from `registerFull` so terminal lifecycle forwards can read the session store after persist. */
export function setFridayAgentForwardRuntime(api: OpenClawPluginApi): void {
  const session = api.runtime.agent.session as Record<string, unknown>;
  const readSessionTranscriptEvents = resolveReadSessionTranscriptEvents();
  const gateway = (
    api.runtime as unknown as {
      gateway?: {
        isAvailable?: () => Promise<boolean>;
        request?: FridayAgentForwardRuntime["gatewayRequest"];
      };
    }
  ).gateway;
  forwardRuntime = {
    ...(typeof gateway?.isAvailable === "function"
      ? { gatewayIsAvailable: () => gateway.isAvailable!() }
      : {}),
    ...(typeof gateway?.request === "function"
      ? {
          gatewayRequest: <T = unknown>(
            method: string,
            params?: Record<string, unknown>,
            options?: { timeoutMs?: number; scopes?: string[] },
          ) => gateway.request!<T>(method, params, options),
        }
      : {}),
    resolveStorePath: api.runtime.agent.session.resolveStorePath,
    loadSessionStore: api.runtime.agent.session.loadSessionStore,
    updateSessionStoreEntry:
      session.updateSessionStoreEntry as FridayAgentForwardRuntime["updateSessionStoreEntry"],
    getSessionEntry: session.getSessionEntry as FridayAgentForwardRuntime["getSessionEntry"],
    listSessionEntries:
      session.listSessionEntries as FridayAgentForwardRuntime["listSessionEntries"],
    readSessionTranscriptEvents,
    readTranscriptStatsSync: resolveReadTranscriptStatsSync(session),
    patchSessionEntry: session.patchSessionEntry as FridayAgentForwardRuntime["patchSessionEntry"],
    resolveAgentWorkspaceDir: (api.runtime.agent as Record<string, unknown>)
      .resolveAgentWorkspaceDir as FridayAgentForwardRuntime["resolveAgentWorkspaceDir"],
    resolveThinkingPolicy: (api.runtime.agent as Record<string, unknown>)
      .resolveThinkingPolicy as FridayAgentForwardRuntime["resolveThinkingPolicy"],
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
