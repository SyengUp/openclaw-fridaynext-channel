declare module "openclaw/plugin-sdk/agent-harness" {
  /** Abort the active embedded run keyed by its internal `sessionId` (NOT the channel runId). */
  export const abortAgentHarnessRun: (sessionId: string) => boolean;
  /** Abort the active embedded run and wait for it to actually settle. */
  export const abortAndDrainAgentHarnessRun: (params: {
    sessionId: string;
    sessionKey?: string;
    settleMs?: number;
    forceClear?: boolean;
    reason?: string;
  }) => Promise<{ aborted: boolean; drained: boolean; forceCleared: boolean }>;
  /** Map a channel sessionKey → the active embedded run's internal sessionId. */
  export const resolveActiveEmbeddedRunSessionId: (sessionKey: string) => string | undefined;
  export const runAgentHarness: (...args: any[]) => any;
}

declare module "openclaw/plugin-sdk/device-bootstrap" {
  export const listDevicePairing: (baseDir?: string) => Promise<DevicePairingList>;
  export const approveDevicePairing: (
    requestId: string,
    options?: { callerScopes?: readonly string[] },
    baseDir?: string,
  ) => Promise<ApproveDevicePairingResult>;

  interface DevicePairingPendingRequest {
    requestId: string;
    deviceId: string;
    publicKey: string;
    displayName?: string;
    platform?: string;
    ts: number;
  }
  interface PairedDevice {
    deviceId: string;
    approvedAtMs: number;
  }
  interface DevicePairingList {
    pending: DevicePairingPendingRequest[];
    paired: PairedDevice[];
  }
  type ApproveDevicePairingResult =
    | {
        status: "approved";
        requestId: string;
        device: PairedDevice;
      }
    | {
        status: "forbidden";
        reason: string;
      }
    | null;
}

declare module "openclaw/plugin-sdk/core" {
  export const defineChannelPluginEntry: (...args: any[]) => any;
  export const createChatChannelPlugin: (...args: any[]) => any;
  export type ChannelPlugin = any;
}

declare module "openclaw/plugin-sdk/media-store" {
  export const saveMediaBuffer: (...args: any[]) => any;
}

declare module "openclaw/plugin-sdk/channel-lifecycle" {
  export const runPassiveAccountLifecycle: (params: {
    abortSignal?: AbortSignal;
    start: () => Promise<unknown>;
    stop?: (handle: unknown) => void | Promise<void>;
    onStop?: () => void | Promise<void>;
  }) => Promise<void>;
}

declare module "openclaw/plugin-sdk/channel-contract" {
  export interface ChannelGatewayContext {
    accountId: string;
    abortSignal: AbortSignal;
    channelRuntime?: unknown;
  }

  export interface ChannelApprovalCapability {
    native: {
      describeDeliveryCapabilities: (params: { request: unknown }) => unknown;
      resolveOriginTarget: (params: { request: unknown }) => unknown;
    };
    nativeRuntime?: unknown;
  }
}

declare module "openclaw/plugin-sdk/channel-runtime-context" {
  export const registerChannelRuntimeContext: (params: {
    channelRuntime: unknown;
    channelId: string;
    accountId: string;
    capability: unknown;
    context: unknown;
    abortSignal?: AbortSignal;
  }) => void;
}

declare module "openclaw/plugin-sdk/approval-handler-adapter-runtime" {
  export const CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY: unknown;
}

declare module "openclaw/plugin-sdk/approval-handler-runtime" {
  export const createChannelApprovalNativeRuntimeAdapter: <
    PendingPayload,
    PreparedTarget,
    Entry,
    _DeletePayload,
    UpdatePayload,
  >(options: {
    eventKinds: string[];
    availability: {
      isConfigured: () => boolean;
      shouldHandle: (params: { request: unknown }) => boolean;
    };
    presentation: {
      buildPendingPayload: (params: { request: unknown; view: unknown }) => PendingPayload;
      buildResolvedResult: (params: { request: unknown; view: unknown }) => unknown;
      buildExpiredResult: (params: { request: unknown; view: unknown }) => unknown;
    };
    transport: {
      prepareTarget: (params: {
        plannedTarget?: { target?: { to?: string } };
        request: unknown;
      }) => { dedupeKey: string; target: PreparedTarget } | null;
      deliverPending: (params: {
        preparedTarget: PreparedTarget;
        pendingPayload: PendingPayload;
      }) => Entry;
      updateEntry: (params: { entry: Entry; payload: UpdatePayload }) => void | Promise<void>;
      deleteEntry: (params: {
        entry: Entry;
        phase: "resolved" | "expired";
      }) => void | Promise<void>;
    };
    observe?: { onDeliveryError?: (params: { error: unknown }) => void };
  }) => unknown;
}

declare module "openclaw/plugin-sdk/approval-gateway-runtime" {
  export const resolveApprovalOverGateway: (params: {
    cfg: unknown;
    approvalId: string;
    decision: "allow-once" | "allow-always" | "deny";
    senderId: string | null;
    allowPluginFallback: boolean;
    clientDisplayName: string;
  }) => Promise<unknown>;
}

declare module "openclaw/plugin-sdk/gateway-method-runtime" {
  export const dispatchGatewayMethod: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<{
    ok: boolean;
    error?: { code?: string; message?: string };
    payload?: unknown;
  }>;
}

declare module "openclaw/plugin-sdk/media-runtime" {
  export type MediaKind = "image" | "audio" | "video" | "document";
  export const mediaKindFromMime: (mime?: string | null) => MediaKind | undefined;
  export const maxBytesForKind: (kind: MediaKind) => number;
}

declare module "openclaw/plugin-sdk/plugin-entry" {
  export type OpenClawPluginApi = any;
}

declare module "openclaw/plugin-sdk/plugins/types" {
  export type PluginHookBeforeToolCallEvent = any;
  export type PluginHookAfterToolCallEvent = any;
  export type PluginHookToolContext = any;
  export type PluginHookSubagentSpawningEvent = any;
  export type PluginHookSubagentSpawnedEvent = any;
  export type PluginHookSubagentEndedEvent = any;
  export type PluginHookSubagentDeliveryTargetEvent = any;
  export type PluginHookSubagentContext = any;
}

declare module "openclaw/plugin-sdk/reply-dispatch-runtime" {
  export const dispatchReplyWithDispatcher: (...args: any[]) => any;
}

declare module "openclaw/plugin-sdk/plugin-runtime" {
  /**
   * Returns the request-local plugin gateway-request-scope (operator client/scopes,
   * context) when called from within a plugin HTTP-route handler's async context.
   */
  export const getPluginRuntimeGatewayRequestScope: () =>
    | { client?: { connect?: { scopes?: string[] } } }
    | undefined;
}

declare module "openclaw/plugin-sdk/status-helpers" {
  export const buildBaseChannelStatusSummary: (...args: any[]) => any;
  export const createComputedAccountStatusAdapter: (...args: any[]) => any;
  export const createDefaultChannelRuntimeState: (...args: any[]) => any;
}

declare module "openclaw/plugin-sdk/config-runtime" {
  /** A single scheduled (cron) job — only the fields the channel reads. */
  interface CronJob {
    id: string;
    name: string;
  }
  interface CronStoreFile {
    version: number;
    jobs: CronJob[];
  }
  /** Resolves the default cron-jobs store path (SQLite-backed). */
  export const resolveCronStorePath: (storePath?: string) => string;
  /** Loads the persisted cron job store. */
  export const loadCronStore: (storePath: string) => Promise<CronStoreFile>;
}
