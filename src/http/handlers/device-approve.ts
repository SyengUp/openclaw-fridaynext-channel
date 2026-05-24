import type { IncomingMessage, ServerResponse } from "node:http";
import { listDevicePairing, approveDevicePairing } from "openclaw/plugin-sdk/device-bootstrap";
import { readJsonBody } from "../middleware/body.js";
import { extractBearerToken } from "../middleware/auth.js";
import { createFridayNextLogger } from "../../logging.js";

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

  let pairing;
  try {
    pairing = await listDevicePairing();
  } catch (err) {
    log.error(`listDevicePairing failed: ${err instanceof Error ? err.message : String(err)}`);
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Failed to list devices from gateway" }));
    return true;
  }

  const match = pairing.pending.find(
    (entry) => entry.deviceId.trim().toUpperCase() === normalizedDeviceId,
  );

  if (!match) {
    // Gateway may have already auto-approved the device (e.g. mode="local").
    // Check the paired list before returning 404.
    const pairedDevice = (pairing.paired ?? []).find(
      (entry) => entry.deviceId.trim().toUpperCase() === normalizedDeviceId,
    );
    if (pairedDevice) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        ok: true,
        deviceId: normalizedDeviceId,
        alreadyApproved: true,
        approvedAtMs: (pairedDevice as any).approvedAtMs,
      }));
      return true;
    }

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

  let approved;
  try {
    approved = await approveDevicePairing(requestId);
  } catch (err) {
    log.error(`approveDevicePairing failed: ${err instanceof Error ? err.message : String(err)}`);
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      error: "Device approval failed",
      detail: err instanceof Error ? err.message : "Unknown error",
    }));
    return true;
  }

  if (!approved) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Pending device request not found" }));
    return true;
  }

  if (approved.status === "forbidden") {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: `Device approval forbidden: ${(approved as any).reason ?? "unknown"}` }));
    return true;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({
    ok: true,
    deviceId: normalizedDeviceId,
    requestId: approved.requestId,
    approvedAtMs: (approved as any).device?.approvedAtMs,
  }));
  return true;
}
