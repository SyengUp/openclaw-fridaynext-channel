import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { readJsonBody } from "../middleware/body.js";
import { extractBearerToken } from "../middleware/auth.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { getFridayNextRuntime } from "../../runtime.js";
import { createFridayNextLogger } from "../../logging.js";

const VALID_DECISIONS = new Set(["allow-once", "allow-always", "deny"]);

/**
 * POST /friday-next/approvals/{approvalId}
 * Body: { decision: "allow-once" | "allow-always" | "deny", deviceId?: string }
 *
 * Submits the app user's decision for a pending exec/plugin approval back to the gateway. The bearer
 * token gates auth (the device owner is the approver); the gateway then resumes / aborts the run.
 */
export async function handleApprovalDecision(
  req: IncomingMessage,
  res: ServerResponse,
  approvalId: string,
): Promise<boolean> {
  const log = createFridayNextLogger("approvals");
  const json = (status: number, body: Record<string, unknown>) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
    return true;
  };

  if (req.method !== "POST") return json(405, { error: "Method Not Allowed" });
  if (!extractBearerToken(req)) return json(401, { error: "Unauthorized: bearer token mismatch" });
  if (!approvalId.trim()) return json(400, { error: "Missing approvalId" });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: "Invalid JSON body" });

  const decision = typeof body.decision === "string" ? body.decision.trim() : "";
  if (!VALID_DECISIONS.has(decision)) {
    return json(400, { error: "decision must be allow-once | allow-always | deny" });
  }
  const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim().toUpperCase() : "";

  const cfg = getHostOpenClawConfigSnapshot(getFridayNextRuntime().config);
  try {
    await resolveApprovalOverGateway({
      cfg: cfg as Parameters<typeof resolveApprovalOverGateway>[0]["cfg"],
      approvalId: approvalId.trim(),
      decision: decision as "allow-once" | "allow-always" | "deny",
      senderId: deviceId || null,
      allowPluginFallback: true,
      clientDisplayName: deviceId ? `Friday Next (${deviceId})` : "Friday Next",
    });
  } catch (err) {
    log.error(`resolveApprovalOverGateway failed: ${err instanceof Error ? err.message : String(err)}`);
    return json(502, { error: "Approval resolution failed", detail: String(err) });
  }

  log.info(`approval ${approvalId} resolved decision=${decision} device=${deviceId || "(none)"}`);
  return json(200, { ok: true, approvalId: approvalId.trim(), decision });
}
