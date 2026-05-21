import type { IncomingMessage, ServerResponse } from "node:http";
import { exec } from "node:child_process";
import { readJsonBody } from "../middleware/body.js";
import { extractBearerToken } from "../middleware/auth.js";
import { createFridayNextLogger } from "../../logging.js";

const EXEC_ENV = process.platform === "win32"
  ? process.env
  : { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:${process.env.PATH ?? ""}` };

interface PendingDevice {
  requestId: string;
  deviceId: string;
}

interface DeviceListJson {
  pending?: PendingDevice[];
}

interface ApproveJson {
  requestId: string;
  device?: { deviceId: string; approvedAtMs?: number };
}

function execAsync(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = exec(command, { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 1024 * 1024, env: EXEC_ENV }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
    child.stdout?.on("data", () => { /* drain */ });
    child.stderr?.on("data", () => { /* drain */ });
  });
}

export async function handleDeviceApprove(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const log = createFridayNextLogger("device-approve");

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return true;
  }

  const token = extractBearerToken(req);
  if (!token) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Unauthorized: bearer token mismatch" }));
    return true;
  }

  const body = await readJsonBody(req);
  if (!body) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return true;
  }

  const rawDeviceId = typeof body.deviceId === "string" ? body.deviceId : "";
  if (!rawDeviceId.trim()) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing required field: deviceId" }));
    return true;
  }

  const normalizedDeviceId = rawDeviceId.trim().toUpperCase();

  let listStdout: string;
  try {
    const result = await execAsync("openclaw devices list --json", 15000);
    listStdout = result.stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr?.trim();
    log.error(`devices list failed: ${err instanceof Error ? err.message : String(err)}`);
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Failed to list devices from gateway", detail: stderr || undefined }));
    return true;
  }

  let listData: DeviceListJson;
  try {
    listData = JSON.parse(listStdout) as DeviceListJson;
  } catch {
    log.error(`devices list returned invalid JSON: ${listStdout.slice(0, 200)}`);
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Unexpected response from gateway device list" }));
    return true;
  }

  const pending = listData.pending ?? [];
  const match = pending.find(
    (entry) => entry.deviceId.trim().toUpperCase() === normalizedDeviceId,
  );

  if (!match) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      error: "No pending device found for this deviceId",
      deviceId: normalizedDeviceId,
    }));
    return true;
  }

  const requestId = match.requestId;
  log.info(`approving deviceId=${normalizedDeviceId} requestId=${requestId}`);

  let approveStdout: string;
  try {
    const result = await execAsync(`openclaw devices approve ${requestId} --json`, 15000);
    approveStdout = result.stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr?.trim();
    log.error(`devices approve failed: ${err instanceof Error ? err.message : String(err)}`);
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      error: "Device approval command failed",
      detail: stderr || (err instanceof Error ? err.message : "Unknown error"),
    }));
    return true;
  }

  let approveData: ApproveJson;
  try {
    approveData = JSON.parse(approveStdout) as ApproveJson;
  } catch {
    log.error(`devices approve returned non-JSON: ${approveStdout.slice(0, 200)}`);
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Unexpected response from device approval" }));
    return true;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({
    ok: true,
    deviceId: normalizedDeviceId,
    requestId: approveData.requestId,
    approvedAtMs: approveData.device?.approvedAtMs,
  }));
  return true;
}
