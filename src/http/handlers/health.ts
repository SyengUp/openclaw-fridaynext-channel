import type { IncomingMessage, ServerResponse } from "node:http";
import { extractBearerToken } from "../middleware/auth.js";
import { listDevicePairing, approveDevicePairing } from "openclaw/plugin-sdk/device-bootstrap";
import { loadNodePairingModule } from "../../agent/node-pairing-bridge.js";
import { createFridayNextLogger } from "../../logging.js";
import { PLUGIN_VERSION } from "../../version.js";

const REQUIRED_NODE_CAPS = ["location", "canvas"];
const REQUIRED_NODE_COMMANDS = [
  "location.get",
  "canvas.present",
  "canvas.hide",
  "canvas.navigate",
  "canvas.eval",
  "canvas.snapshot",
  "canvas.a2ui.push",
  "canvas.a2ui.pushJSONL",
  "canvas.a2ui.reset",
];

export interface HealthComponentStatus {
  status: "ok" | "degraded" | "failed" | "pending" | "not_found";
  detail: string;
  [key: string]: unknown;
}

interface RepairAction {
  component: string;
  action: string;
  result: "ok" | "failed";
  detail: string;
}

export interface HealthCheckResult {
  ok: boolean;
  timestamp: number;
  deviceId: string;
  nodeDeviceId: string;
  pluginVersion: string;
  nodePairing?: HealthComponentStatus;
  repairActions?: RepairAction[];
}

export async function handleHealth(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "GET") {
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

  const url = new URL(req.url ?? "/", "http://localhost");
  const deviceId = (url.searchParams.get("deviceId") ?? "").trim();
  const nodeDeviceId = (url.searchParams.get("nodeDeviceId") ?? "").trim();
  const selfHeal = (url.searchParams.get("selfHeal") ?? "").toLowerCase() === "true";

  const result: HealthCheckResult = {
    ok: true,
    timestamp: Date.now(),
    deviceId,
    nodeDeviceId,
    pluginVersion: PLUGIN_VERSION,
  };

  const log = createFridayNextLogger("health");

  if (nodeDeviceId) {
    result.nodePairing = await checkNodePairing(nodeDeviceId, selfHeal, result, log);
  }

  result.ok =
    !result.nodePairing ||
    result.nodePairing.status === "ok" ||
    result.nodePairing.status === "pending";

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(result));
  return true;
}
async function checkNodePairing(
  nodeDeviceId: string,
  selfHeal: boolean,
  result: HealthCheckResult,
  log: ReturnType<typeof createFridayNextLogger>,
): Promise<HealthComponentStatus> {
  const normalizedNodeId = nodeDeviceId.trim().toUpperCase();

  let listData, listNodePairing, approveNodePairing;
  try {
    ({ listNodePairing, approveNodePairing } = await loadNodePairingModule());
  } catch (err) {
    log.error(`loadNodePairingModule failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      status: "failed",
      detail: `loadNodePairingModule failed: ${err instanceof Error ? err.message : String(err)}`,
      nodePaired: false,
    };
  }

  try {
    listData = await listNodePairing();
  } catch (err) {
    log.error(`listNodePairing failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      status: "failed",
      detail: `listNodePairing failed: ${err instanceof Error ? err.message : String(err)}`,
      nodePaired: false,
    };
  }

  const pairedNodes: Array<{ nodeId: string; caps?: string[]; commands?: string[] }> =
    listData?.paired ?? [];
  const pairedMatch = pairedNodes.find(
    (entry) => entry.nodeId?.trim().toUpperCase() === normalizedNodeId,
  );

  if (pairedMatch) {
    const caps = pairedMatch.caps ?? [];
    const commands = pairedMatch.commands ?? [];
    const hasRequiredCaps = REQUIRED_NODE_CAPS.every((c) => caps.includes(c));
    const hasRequiredCommands = REQUIRED_NODE_COMMANDS.every((c) => commands.includes(c));
    const capsValid = caps.length > 0 && hasRequiredCaps;
    const commandsValid = commands.length > 0 && hasRequiredCommands;

    if (capsValid && commandsValid) {
      return {
        status: "ok",
        detail: `Node paired with ${caps.length} caps, ${commands.length} commands`,
        nodePaired: true,
        capsCount: caps.length,
        commandsCount: commands.length,
        capsValid: true,
        commandsValid: true,
      };
    }

    return {
      status: "degraded",
      detail: `Node paired but caps/commands incomplete: caps=${caps.length} (valid=${capsValid}), commands=${commands.length} (valid=${commandsValid})`,
      nodePaired: true,
      capsCount: caps.length,
      commandsCount: commands.length,
      capsValid,
      commandsValid,
    };
  }

  const pendingNodes: Array<{ nodeId: string; requestId: string }> = listData?.pending ?? [];
  const pendingMatch = pendingNodes.find(
    (entry) => entry.nodeId?.trim().toUpperCase() === normalizedNodeId,
  );

  if (pendingMatch && selfHeal) {
    try {
      const callerScopes = [
        "operator.admin",
        "operator.pairing",
        "operator.read",
        "operator.write",
      ];
      const approved = await approveNodePairing(pendingMatch.requestId, { callerScopes });
      const succeeded =
        approved != null &&
        !("status" in approved && approved.status === "forbidden") &&
        "requestId" in approved;
      (result.repairActions ??= []).push({
        component: "nodePairing",
        action: "approveNodePairing",
        result: succeeded ? "ok" : "failed",
        detail: succeeded
          ? `Auto-approved node ${normalizedNodeId}`
          : `approveNodePairing returned status=${approved?.status ?? "null"}`,
      });
      if (succeeded) {
        log.info(`Auto-approved node ${normalizedNodeId}`);
        return { status: "ok", detail: "Node was pending, auto-approved", nodePaired: true };
      }
    } catch (err) {
      log.error(`approveNodePairing failed: ${err instanceof Error ? err.message : String(err)}`);
      (result.repairActions ??= []).push({
        component: "nodePairing",
        action: "approveNodePairing",
        result: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return {
      status: "degraded",
      detail: "Node pending but auto-approve failed",
      nodePaired: false,
    };
  }

  if (pendingMatch) {
    return { status: "pending", detail: "Node is pending approval", nodePaired: false };
  }

  // Not in the node-pairing store — look in the DEVICE store before giving up.
  //
  // An iOS node connects as a *device* with `role: "node"`, so its first-ever pairing request
  // lands in `devices/pending.json`; `nodes/` is not even created until something is approved
  // there. Reporting `not_found` on that basis strands every fresh install: the app's node
  // socket is refused pre-handshake, the refusal is what would have created the entry, and
  // both the app- and plugin-side repair paths only act on `pending`. Chat still works over
  // HTTP, so the user sees a working app with silently dead canvas and location.
  return await checkNodePairingViaDeviceStore(normalizedNodeId, selfHeal, result, log);
}

/** Node-role device fallback for `checkNodePairing` — see the call site for why this exists. */
async function checkNodePairingViaDeviceStore(
  normalizedNodeId: string,
  selfHeal: boolean,
  result: HealthCheckResult,
  log: ReturnType<typeof createFridayNextLogger>,
): Promise<HealthComponentStatus> {
  let devices;
  try {
    devices = await listDevicePairing();
  } catch (err) {
    log.error(`listDevicePairing failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      status: "not_found",
      detail: `Node ${normalizedNodeId} not registered`,
      nodePaired: false,
    };
  }

  const sameId = (id: unknown) => String(id ?? "").trim().toUpperCase() === normalizedNodeId;
  const isNodeRole = (entry: { role?: string; roles?: string[] }) =>
    entry.role === "node" || (entry.roles ?? []).includes("node");

  if ((devices.paired ?? []).some((entry) => sameId(entry.deviceId) && isNodeRole(entry))) {
    return { status: "ok", detail: "Node paired as a node-role device", nodePaired: true };
  }

  const pending = (devices.pending ?? []).find(
    (entry) => sameId(entry.deviceId) && isNodeRole(entry),
  );
  if (!pending) {
    return {
      status: "not_found",
      detail: `Node ${normalizedNodeId} not registered`,
      nodePaired: false,
    };
  }

  if (!selfHeal) {
    return { status: "pending", detail: "Node is pending approval", nodePaired: false };
  }

  try {
    const approved = await approveDevicePairing(pending.requestId, {
      callerScopes: ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
    });
    const succeeded = approved != null && (approved as { status?: string }).status !== "forbidden";
    (result.repairActions ??= []).push({
      component: "nodePairing",
      action: "approveDevicePairing",
      result: succeeded ? "ok" : "failed",
      detail: succeeded
        ? `Auto-approved node-role device ${normalizedNodeId}`
        : `approveDevicePairing returned status=${(approved as { status?: string })?.status ?? "null"}`,
    });
    if (succeeded) {
      log.info(`Auto-approved node-role device ${normalizedNodeId}`);
      return {
        status: "ok",
        detail: "Node was pending as a node-role device, auto-approved",
        nodePaired: true,
      };
    }
  } catch (err) {
    log.error(`approveDevicePairing failed: ${err instanceof Error ? err.message : String(err)}`);
    (result.repairActions ??= []).push({
      component: "nodePairing",
      action: "approveDevicePairing",
      result: "failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return { status: "degraded", detail: "Node pending but auto-approve failed", nodePaired: false };
}
