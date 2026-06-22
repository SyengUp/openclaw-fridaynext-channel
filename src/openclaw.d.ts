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
  export const waitUntilAbort: (
    signal?: AbortSignal,
    onAbort?: () => void | Promise<void>,
  ) => Promise<void>;
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
  export type ChannelAccountSnapshot = any;
}
