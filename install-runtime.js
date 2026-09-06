import { exec } from "node:child_process";
import { request as httpRequest } from "node:http";

/**
 * Async shell execution for installer commands. `openclawCmd` may include a sudo prefix and
 * Windows relies on shell command resolution, so this intentionally accepts a command string.
 * Unlike execSync, it leaves the event loop free for the installer's spinner.
 */
export function runShellCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        ...options,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function requestGatewayStatus(url, token) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname,
        port,
        path: "/friday-next/status",
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        timeout: 5_000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

/**
 * Verify the exact plugin build we just installed. `version: "v2"` is only the HTTP protocol
 * version; accepting it used to let an old gateway process pass while restart was still pending.
 */
export async function verifyGateway({
  url,
  token,
  expectedVersion,
  retries = 30,
  retryDelayMs = 1_000,
  onRetry = () => {},
}) {
  let lastFailure = { ok: false, reason: "timeout" };
  let lastVersionMismatch;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await requestGatewayStatus(url, token);
      if (response.status === 401) return { ok: false, reason: "auth" };
      if (response.status === 404) {
        lastFailure = { ok: false, reason: "not-loaded" };
      } else if (response.status === 200) {
        try {
          const data = JSON.parse(response.body);
          if (!data.ok) return { ok: false, reason: "not-ok" };
          const actualVersion =
            typeof data.pluginVersion === "string" ? data.pluginVersion : undefined;
          if (data.channel === "friday-next" && actualVersion === expectedVersion) {
            return { ok: true, pluginVersion: actualVersion };
          }
          const mismatch = {
            ok: false,
            reason: "version-mismatch",
            expectedVersion,
            actualVersion,
          };
          lastFailure = mismatch;
          // Keep the last concrete running version even if that old process subsequently exits
          // and the remaining probes only see connection failures.
          if (actualVersion || !lastVersionMismatch) lastVersionMismatch = mismatch;
        } catch {
          lastFailure = { ok: false, reason: "invalid-response" };
        }
      } else {
        lastFailure = { ok: false, reason: "unreachable" };
      }
    } catch {
      lastFailure = { ok: false, reason: "unreachable" };
    }

    if (attempt < retries) {
      onRetry(attempt, retries, lastFailure);
      if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return lastVersionMismatch ?? lastFailure;
}

/** Fast first retry, then exponential backoff capped at the original three-second cadence. */
export function pairingPollDelayMs(failedAttempt) {
  return Math.min(250 * 2 ** failedAttempt, 3_000);
}

export async function pollPairingSuperset(
  fetchPairing,
  { timeoutMs, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
) {
  const deadline = now() + timeoutMs;
  let failedAttempt = 0;
  while (now() < deadline) {
    const pairing = await fetchPairing();
    if (pairing?.publicUrl && pairing?.pairingTicket) return pairing;

    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pairingPollDelayMs(failedAttempt), remaining));
    failedAttempt += 1;
  }
  return null;
}
