import type { IncomingMessage, ServerResponse } from "node:http";
import { exec } from "node:child_process";
import { readJsonBody } from "../middleware/body.js";
import { extractBearerToken } from "../middleware/auth.js";
import { createFridayNextLogger } from "../../logging.js";

const EXEC_ENV = process.platform === "win32"
  ? process.env
  : { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:${process.env.PATH ?? ""}` };

interface PendingNode {
  requestId: string;
  nodeId: string;
}

interface PairedNode {
  nodeId: string;
  approvedAtMs?: number;
  caps?: string[];
  commands?: string[];
}

interface NodeListJson {
  pending?: PendingNode[];
  paired?: PairedNode[];
}

interface ApproveJson {
  requestId: string;
  node?: { nodeId: string; approvedAtMs?: number };
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

  let listStdout: string;
  try {
    const result = await execAsync("openclaw nodes list --json", 15000);
    listStdout = result.stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr?.trim();
    log.error(`nodes list failed: ${err instanceof Error ? err.message : String(err)}`);
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Failed to list nodes from gateway", detail: stderr || undefined }));
    return true;
  }

  let listData: NodeListJson;
  try {
    listData = JSON.parse(listStdout) as NodeListJson;
  } catch {
    log.error(`nodes list returned invalid JSON: ${listStdout.slice(0, 200)}`);
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Unexpected response from gateway node list" }));
    return true;
  }

  const pending = listData.pending ?? [];
  const pendingMatch = pending.find(
    (entry) => entry.nodeId.trim().toUpperCase() === normalizedNodeId,
  );

  if (pendingMatch) {
    const requestId = pendingMatch.requestId;
    log.info(`approving nodeId=${normalizedNodeId} requestId=${requestId}`);

    let approveStdout: string;
    try {
      const result = await execAsync(`openclaw nodes approve ${requestId} --json`, 15000);
      approveStdout = result.stdout;
    } catch (err) {
      const stderr = (err as { stderr?: string })?.stderr?.trim();
      log.error(`nodes approve failed: ${err instanceof Error ? err.message : String(err)}`);
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        error: "Node approval command failed",
        detail: stderr || (err instanceof Error ? err.message : "Unknown error"),
      }));
      return true;
    }

    let approveData: ApproveJson;
    try {
      approveData = JSON.parse(approveStdout) as ApproveJson;
    } catch {
      log.error(`nodes approve returned non-JSON: ${approveStdout.slice(0, 200)}`);
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Unexpected response from node approval" }));
      return true;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      nodeId: normalizedNodeId,
      requestId: approveData.requestId,
      approvedAtMs: approveData.node?.approvedAtMs,
    }));
    return true;
  }

  // Not in pending — check if already paired with non-empty caps/commands
  const paired = listData.paired ?? [];
  const pairedMatch = paired.find(
    (entry) => entry.nodeId.trim().toUpperCase() === normalizedNodeId,
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
