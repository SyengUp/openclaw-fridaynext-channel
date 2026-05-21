import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody } from "../middleware/body.js";
import { extractBearerToken } from "../middleware/auth.js";
import { createFridayNextLogger } from "../../logging.js";
import { loadNodePairingModule } from "../../agent/node-pairing-bridge.js";

interface PendingNodeEntry {
  requestId: string;
  nodeId: string;
}
interface PairedNodeEntry {
  nodeId: string;
  approvedAtMs: number;
  caps?: string[];
  commands?: string[];
}
interface NodePairingList {
  pending: PendingNodeEntry[];
  paired: PairedNodeEntry[];
}
type ApproveNodePairingResult =
  | { requestId: string; node: PairedNodeEntry }
  | { status: "forbidden"; missingScope: string }
  | null;

export async function handleNodesApprove(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const log = createFridayNextLogger("nodes-approve");

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

  const rawNodeId = typeof body.nodeId === "string" ? body.nodeId : "";
  if (!rawNodeId.trim()) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing required field: nodeId" }));
    return true;
  }

  const normalizedNodeId = rawNodeId.trim().toUpperCase();

const { listNodePairing, approveNodePairing } = loadNodePairingModule();

  let listData;
  try {
    listData = await listNodePairing();
  } catch (err) {
    log.error(`listNodePairing failed: ${err instanceof Error ? err.message : String(err)}`);
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Failed to list nodes from gateway" }));
    return true;
  }

  const pending = listData.pending ?? [];
  const pendingMatch = pending.find(
    (entry: PendingNodeEntry) => entry.nodeId.trim().toUpperCase() === normalizedNodeId,
  );

  if (pendingMatch) {
    const requestId = pendingMatch.requestId;
    log.info(`approving nodeId=${normalizedNodeId} requestId=${requestId}`);

    const callerScopes = [
      "operator.admin",
      "operator.pairing",
      "operator.read",
      "operator.write",
    ];

    let approved;
    try {
      approved = await approveNodePairing(requestId, { callerScopes });
    } catch (err) {
      log.error(`approveNodePairing failed: ${err instanceof Error ? err.message : String(err)}`);
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        error: "Node approval failed",
        detail: err instanceof Error ? err.message : "Unknown error",
      }));
      return true;
    }

    if (!approved) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Pending node request not found" }));
      return true;
    }

    if ("status" in approved && approved.status === "forbidden") {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: `Node approval forbidden: ${(approved as any).missingScope ?? "unknown"}` }));
      return true;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      nodeId: normalizedNodeId,
      requestId: (approved as any).requestId,
      approvedAtMs: (approved as any).node?.approvedAtMs,
    }));
    return true;
  }

  // Check if already paired with non-empty caps/commands
  const paired = listData.paired ?? [];
  const pairedMatch = paired.find(
    (entry: PairedNodeEntry) => entry.nodeId.trim().toUpperCase() === normalizedNodeId,
  );

  if (pairedMatch) {
    const caps = pairedMatch.caps ?? [];
    const commands = pairedMatch.commands ?? [];
    if (caps.length > 0 || commands.length > 0) {
      log.info(`nodeId=${normalizedNodeId} already paired with caps=${caps.length} commands=${commands.length}`);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        ok: true,
        nodeId: normalizedNodeId,
        alreadyApproved: true,
        approvedAtMs: pairedMatch.approvedAtMs,
        caps,
        commands,
      }));
      return true;
    }
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({
    error: "No pending node found for this nodeId",
    nodeId: normalizedNodeId,
  }));
  return true;
}
