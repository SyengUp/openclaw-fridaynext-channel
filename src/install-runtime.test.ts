import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  pairingPollDelayMs,
  pollPairingSuperset,
  runShellCommand,
  verifyGateway,
} from "../install-runtime.js";

async function withStatusServer(
  bodies: Array<Record<string, unknown>>,
  run: (url: string) => Promise<void>,
): Promise<void> {
  let requestCount = 0;
  const server = createServer((_req, res) => {
    const body = bodies[Math.min(requestCount, bodies.length - 1)];
    requestCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server port");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

describe("installer runtime", () => {
  it("does not accept an old gateway process, then succeeds only on the expected plugin version", async () => {
    await withStatusServer(
      [
        { ok: true, channel: "friday-next", version: "v2", pluginVersion: "2026.9.2-beta.4" },
        { ok: true, channel: "friday-next", version: "v2", pluginVersion: "2026.9.2-beta.5" },
      ],
      async (url) => {
        const onRetry = vi.fn();
        const result = await verifyGateway({
          url,
          token: "secret",
          expectedVersion: "2026.9.2-beta.5",
          retries: 2,
          retryDelayMs: 0,
          onRetry,
        });
        expect(result).toEqual({ ok: true, pluginVersion: "2026.9.2-beta.5" });
        expect(onRetry).toHaveBeenCalledWith(
          1,
          2,
          expect.objectContaining({ reason: "version-mismatch", actualVersion: "2026.9.2-beta.4" }),
        );
      },
    );
  });

  it("reports the expected and actual plugin versions when the old process never exits", async () => {
    await withStatusServer(
      [{ ok: true, channel: "friday-next", version: "v2", pluginVersion: "2026.9.2-beta.4" }],
      async (url) => {
        const result = await verifyGateway({
          url,
          token: "secret",
          expectedVersion: "2026.9.2-beta.5",
          retries: 2,
          retryDelayMs: 0,
        });
        expect(result).toEqual({
          ok: false,
          reason: "version-mismatch",
          expectedVersion: "2026.9.2-beta.5",
          actualVersion: "2026.9.2-beta.4",
        });
      },
    );
  });

  it("keeps the observed old version when later probes no longer return version data", async () => {
    await withStatusServer(
      [
        { ok: true, channel: "friday-next", pluginVersion: "2026.9.2-beta.4" },
        { ok: true, channel: "friday-next" },
      ],
      async (url) => {
        const result = await verifyGateway({
          url,
          token: "secret",
          expectedVersion: "2026.9.2-beta.5",
          retries: 2,
          retryDelayMs: 0,
        });
        expect(result).toMatchObject({
          ok: false,
          reason: "version-mismatch",
          expectedVersion: "2026.9.2-beta.5",
          actualVersion: "2026.9.2-beta.4",
        });
      },
    );
  });

  it("uses a short adaptive pairing poll instead of sleeping three seconds after the first 503", async () => {
    expect([0, 1, 2, 3, 4, 5].map(pairingPollDelayMs)).toEqual([
      250, 500, 1_000, 2_000, 3_000, 3_000,
    ]);
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const fetchPairing = vi
      .fn<() => Promise<Record<string, string> | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ publicUrl: "https://ready.example", pairingTicket: "ticket" });

    const result = await pollPairingSuperset(fetchPairing, {
      timeoutMs: 5_000,
      now: () => now,
      sleep,
    });

    expect(result).toMatchObject({ publicUrl: "https://ready.example" });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("runs long shell commands without blocking timer-driven spinner updates", async () => {
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 5);
    try {
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => {}, 80)")}`;
      await runShellCommand(command, { timeout: 2_000 });
      expect(ticks).toBeGreaterThan(2);
    } finally {
      clearInterval(timer);
    }
  });
});
