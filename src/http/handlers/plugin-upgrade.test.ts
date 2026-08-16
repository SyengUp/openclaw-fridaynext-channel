// Tests for the async plugin upgrade:
//   POST /friday-next/plugin/upgrade — 202 immediately, install runs in background
//   GET  /friday-next/plugin/upgrade/status — progress of the in-flight upgrade
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { extractBearerToken } = vi.hoisted(() => ({
  extractBearerToken: vi.fn(() => "test-token"),
}));
vi.mock("../middleware/auth.js", () => ({ extractBearerToken }));

const { getInstallSource, fetchLatestVersion } = vi.hoisted(() => ({
  getInstallSource: vi.fn(() => "npm"),
  fetchLatestVersion: vi.fn(async () => "1.0.99"),
}));
vi.mock("../../plugin-install-info.js", () => ({ getInstallSource, fetchLatestVersion }));

const { npmRegistryEnv, resolveNpmRegistry, alternateRegistry } = vi.hoisted(() => ({
  npmRegistryEnv: vi.fn(async () => undefined),
  resolveNpmRegistry: vi.fn(async () => "https://registry.npmjs.org/"),
  alternateRegistry: vi.fn(() => "https://registry.npmmirror.com/"),
}));
vi.mock("../../npm-registry.js", () => ({ npmRegistryEnv, resolveNpmRegistry, alternateRegistry }));

const { getUpgradeRuntime } = vi.hoisted(() => ({
  getUpgradeRuntime: vi.fn(),
}));
vi.mock("../../upgrade-runtime.js", () => ({ getUpgradeRuntime }));

import {
  handlePluginUpgrade,
  handlePluginUpgradeStatus,
  resetUpgradeStateForTest,
} from "./plugin-upgrade.js";

type IncomingMessageLike = import("node:http").IncomingMessage;
type ServerResponseLike = import("node:http").ServerResponse;
type Captured = { statusCode: number; body: string };

function makeReq(method: string): IncomingMessageLike {
  const req = Readable.from([]) as unknown as IncomingMessageLike;
  req.method = method;
  req.url = "/friday-next/plugin/upgrade";
  req.headers = { authorization: "Bearer test-token" };
  return req;
}

function makeRes(): { res: ServerResponseLike; captured: Captured } {
  const captured: Captured = { statusCode: 200, body: "" };
  const res = {
    get statusCode() {
      return captured.statusCode;
    },
    set statusCode(v: number) {
      captured.statusCode = v;
    },
    setHeader() {},
    end(chunk?: string | Buffer) {
      captured.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : (chunk ?? "");
    },
  } as unknown as ServerResponseLike;
  return { res, captured };
}

async function postUpgrade() {
  const { res, captured } = makeRes();
  await handlePluginUpgrade(makeReq("POST"), res);
  return { status: captured.statusCode, json: captured.body ? JSON.parse(captured.body) : undefined };
}

async function getStatus() {
  const { res, captured } = makeRes();
  await handlePluginUpgradeStatus(makeReq("GET"), res);
  return { status: captured.statusCode, json: captured.body ? JSON.parse(captured.body) : undefined };
}

/** A promise that never settles — stands in for a long-running install. */
function neverSettles<T = unknown>(): Promise<T> {
  return new Promise<T>(() => {});
}

const runtime = {
  runCommandWithTimeout: vi.fn(),
  mutateConfigFile: vi.fn(async () => undefined),
  currentConfig: vi.fn(() => ({})),
  pluginSource: "/root/.openclaw/npm/projects/x/node_modules/@syengup/friday-channel-next",
};

beforeEach(() => {
  resetUpgradeStateForTest();
  vi.useFakeTimers();
  vi.mocked(extractBearerToken).mockReturnValue("test-token");
  vi.mocked(getInstallSource).mockReturnValue("npm");
  vi.mocked(fetchLatestVersion).mockResolvedValue("1.0.99");
  vi.mocked(npmRegistryEnv).mockResolvedValue(undefined);
  vi.mocked(resolveNpmRegistry).mockResolvedValue("https://registry.npmjs.org/");
  vi.mocked(alternateRegistry).mockReturnValue("https://registry.npmmirror.com/");
  vi.mocked(getUpgradeRuntime).mockReturnValue(runtime as never);
  runtime.runCommandWithTimeout.mockReset();
  runtime.mutateConfigFile.mockReset();
  runtime.mutateConfigFile.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /friday-next/plugin/upgrade", () => {
  it("returns 202 immediately without waiting for the install to finish", async () => {
    runtime.runCommandWithTimeout.mockReturnValue(neverSettles());
    const { status, json } = await postUpgrade();
    expect(status).toBe(202);
    expect(json).toMatchObject({ status: "upgrading", from: expect.any(String), to: "1.0.99" });
    // The install command was spawned, but the response did not wait on it.
    expect(runtime.runCommandWithTimeout).toHaveBeenCalledWith(
      ["openclaw", "plugins", "install", "@syengup/friday-channel-next@1.0.99", "--force"],
      expect.any(Number),
      undefined,
    );
    expect(runtime.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("rejects a second POST while an upgrade is installing (409)", async () => {
    runtime.runCommandWithTimeout.mockReturnValue(neverSettles());
    const first = await postUpgrade();
    expect(first.status).toBe(202);
    const second = await postUpgrade();
    expect(second.status).toBe(409);
    expect(second.json).toMatchObject({ error: "upgrade already in progress" });
    // Only one install was ever spawned.
    expect(runtime.runCommandWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("rejects concurrent POSTs once the install finished but before restart (409)", async () => {
    runtime.runCommandWithTimeout.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const first = await postUpgrade();
    expect(first.status).toBe(202);
    await vi.advanceTimersByTimeAsync(2_000); // let the background install finish
    const second = await postUpgrade();
    expect(second.status).toBe(409);
    expect(second.json.phase).toBe("installed");
  });

  it("returns 401 without a valid bearer token", async () => {
    vi.mocked(extractBearerToken).mockReturnValue(null);
    const { status } = await postUpgrade();
    expect(status).toBe(401);
  });

  it("returns 405 for non-POST", async () => {
    const { res, captured } = makeRes();
    await handlePluginUpgrade(makeReq("GET"), res);
    expect(captured.statusCode).toBe(405);
  });

  it("returns 409 for dev/path installs", async () => {
    vi.mocked(getInstallSource).mockReturnValue("path");
    const { status, json } = await postUpgrade();
    expect(status).toBe(409);
    expect(json.error).toBe("auto-upgrade not available");
  });

  it("returns 502 when the latest version cannot be resolved", async () => {
    vi.mocked(fetchLatestVersion).mockResolvedValue(null);
    const { status, json } = await postUpgrade();
    expect(status).toBe(502);
    expect(json.error).toBe("could not resolve latest version");
    expect(runtime.runCommandWithTimeout).not.toHaveBeenCalled();
  });
});

describe("upgrade status machine", () => {
  it("reports installing → installed and schedules the gateway restart", async () => {
    let resolveInstall!: (v: unknown) => void;
    runtime.runCommandWithTimeout.mockReturnValue(
      new Promise((resolve) => {
        resolveInstall = resolve;
      }),
    );
    await postUpgrade();
    // Install still running → status stays installing.
    expect((await getStatus()).json).toMatchObject({ phase: "installing", to: "1.0.99" });

    resolveInstall({ code: 0, stdout: "", stderr: "" });
    await vi.advanceTimersByTimeAsync(1_000); // background install resolves
    const mid = await getStatus();
    expect(mid.json.phase).toBe("installed");

    await vi.advanceTimersByTimeAsync(2_000); // restart delay elapses
    expect(runtime.mutateConfigFile).toHaveBeenCalledTimes(1);
    const mutateCall = runtime.mutateConfigFile.mock.calls[0]?.[0] as {
      afterWrite?: { mode?: string };
    };
    expect(mutateCall?.afterWrite?.mode).toBe("restart");
  });

  it("reports failed with the stderr tail when the install exits non-zero", async () => {
    runtime.runCommandWithTimeout.mockResolvedValue({ code: 1, stdout: "", stderr: "npm ERR! boom" });
    await postUpgrade();
    await vi.advanceTimersByTimeAsync(1_000);
    const { json } = await getStatus();
    expect(json).toMatchObject({
      phase: "failed",
      error: "install-exit-nonzero",
      to: "1.0.99",
    });
    expect(json.detail).toContain("npm ERR! boom");
    expect(runtime.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("reports failed when the command times out (code 124)", async () => {
    runtime.runCommandWithTimeout.mockResolvedValue({ code: 124, stdout: "", stderr: "" });
    await postUpgrade();
    await vi.advanceTimersByTimeAsync(1_000);
    const { json } = await getStatus();
    expect(json.phase).toBe("failed");
    expect(json.error).toBe("install-exit-nonzero");
  });

  it("retries once on the alternate registry when the first install fails", async () => {
    runtime.runCommandWithTimeout
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "registry timeout" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    await postUpgrade();
    await vi.advanceTimersByTimeAsync(1_000);
    const { json } = await getStatus();
    expect(json.phase).toBe("installed");
    expect(runtime.runCommandWithTimeout).toHaveBeenCalledTimes(2);
    // The retry env was built for the alternate registry.
    expect(npmRegistryEnv).toHaveBeenLastCalledWith(expect.any(Number), "https://registry.npmmirror.com/");
  });

  it("reports failed when both the install and the alternate retry fail", async () => {
    runtime.runCommandWithTimeout
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "first: slow channel" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "second: mirror down" });
    await postUpgrade();
    await vi.advanceTimersByTimeAsync(1_000);
    const { json } = await getStatus();
    expect(json).toMatchObject({ phase: "failed", error: "install-exit-nonzero" });
    expect(json.detail).toContain("second: mirror down"); // last failure wins
    expect(runtime.runCommandWithTimeout).toHaveBeenCalledTimes(2);
  });

  it("does not retry on a spawn failure (code -1)", async () => {
    runtime.runCommandWithTimeout.mockResolvedValueOnce({ code: -1, stdout: "", stderr: "ENOENT" });
    await postUpgrade();
    await vi.advanceTimersByTimeAsync(1_000);
    const { json } = await getStatus();
    expect(json).toMatchObject({ phase: "failed", error: "spawn-failed" });
    expect(runtime.runCommandWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("allows a retry after both channels failed", async () => {
    runtime.runCommandWithTimeout
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "first failure" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "alternate failure" });
    await postUpgrade();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await getStatus()).json.phase).toBe("failed");

    // A user retry spawns a fresh install and moves back to installing.
    runtime.runCommandWithTimeout.mockReturnValueOnce(neverSettles());
    const retry = await postUpgrade();
    expect(retry.status).toBe(202);
    expect((await getStatus()).json.phase).toBe("installing");
    expect(runtime.runCommandWithTimeout).toHaveBeenCalledTimes(3);
  });
});

describe("GET /friday-next/plugin/upgrade/status", () => {
  it("returns idle with no upgrade in flight", async () => {
    const { status, json } = await getStatus();
    expect(status).toBe(200);
    expect(json).toEqual({ phase: "idle", from: "", to: "" });
  });

  it("requires a bearer token", async () => {
    vi.mocked(extractBearerToken).mockReturnValue(null);
    const { status } = await getStatus();
    expect(status).toBe(401);
  });
});
