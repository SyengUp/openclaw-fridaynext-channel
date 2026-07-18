import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setFridayNextRuntime } from "../runtime.js";
import { setOfflineQueueBaseDirForTest } from "../sse/offline-queue.js";
import { setAttachmentsDirForTest } from "../http/handlers/files.js";
import { sseEmitter } from "../sse/emitter.js";
import { resetActiveRunsForTest } from "../agent/active-runs.js";
import { resetRunMetadataForTest } from "../run-metadata.js";
import { resetForTest as resetSubagentRegistryForTest } from "../agent/subagent-registry.js";

export type MockRuntimeOptions = {
  authToken?: string;
  corsEnabled?: boolean;
  allowOrigin?: string;
  historyDir?: string;
  sseKeepaliveSec?: number;
  sseBacklogPerDevice?: number;
  /** Enable publicAccess in the resolved config (OSS side-channel tests). */
  publicAccessEnabled?: boolean;
  /** Control-plane base URL for publicAccess (tests point it at a stubbed fetch). */
  controlPlaneUrl?: string;
};

export function createTempHistoryDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "friday-next-e2e-"));
}

export function removeTempHistoryDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export function setMockRuntime(opts: MockRuntimeOptions = {}): void {
  sseEmitter.resetForTest();
  resetActiveRunsForTest();
  resetRunMetadataForTest();
  resetSubagentRegistryForTest();
  const historyDir = opts.historyDir ?? createTempHistoryDir();
  setOfflineQueueBaseDirForTest(path.join(historyDir, "events-queue"));
  setAttachmentsDirForTest(path.join(historyDir, "attachments"));
  const cfg = {
    gateway: {
      auth: {
        token: opts.authToken ?? "test-token",
      },
    },
    channels: {
      "friday-next": {
        enabled: true,
        historyLimit: 25,
        historyDir,
        logLevel: "info",
        authToken: opts.authToken ?? "test-token",
        cors: {
          enabled: opts.corsEnabled ?? false,
          allowOrigin: opts.allowOrigin ?? "*",
        },
        sse: {
          keepaliveSec: opts.sseKeepaliveSec ?? 30,
          backlogPerDevice: opts.sseBacklogPerDevice ?? 200,
        },
        ...(opts.publicAccessEnabled
          ? {
              publicAccess: {
                enabled: true,
                ...(opts.controlPlaneUrl ? { controlPlaneUrl: opts.controlPlaneUrl } : {}),
              },
            }
          : {}),
      },
    },
  };
  setFridayNextRuntime({
    config: {
      // Mirror modern OpenClaw (current()) plus the deprecated alias so both paths resolve.
      current: () => cfg,
      loadConfig: () => cfg,
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  } as never);
}
