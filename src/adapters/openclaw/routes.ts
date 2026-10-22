import type { IncomingMessage, ServerResponse } from "node:http";
import { handleAgentConfig } from "../../http/handlers/agent-config.js";
import { handleAgentFiles } from "../../http/handlers/agent-files.js";
import { handleAgentGreeting } from "../../http/handlers/agent-greetings.js";
import { handleAgentToolsCatalog } from "../../http/handlers/agent-tools-catalog.js";
import { handleApprovalDecision } from "../../http/handlers/approvals.js";
import { handleCalendarResult } from "../../http/handlers/calendar-result.js";
import { handleDeviceApprove } from "../../http/handlers/device-approve.js";
import { handleHealthQueryResult } from "../../http/handlers/health-query-result.js";
import { handleLocationQueryResult } from "../../http/handlers/location-query-result.js";
import { handleNodesApprove } from "../../http/handlers/nodes-approve.js";
import {
  handleNotificationDelete,
  handleNotifications,
} from "../../http/handlers/notifications.js";
import { handlePluginInfo } from "../../http/handlers/plugin-info.js";
import {
  handlePluginUpgrade,
  handlePluginUpgradeStatus,
} from "../../http/handlers/plugin-upgrade.js";
import { handleProgressCardGet } from "../../http/handlers/progress-card.js";
import {
  handlePendingQuestions,
  handleQuestionAnswer,
  handleQuestionLookup,
} from "../../http/handlers/questions.js";
import { handleStatus } from "../../http/handlers/status.js";

export async function handleOpenClawExtensionRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  if (req.method === "POST" && pathname === "/friday-next/device-approve") {
    return await handleDeviceApprove(req, res);
  }

  if (req.method === "POST" && pathname === "/friday-next/nodes-approve") {
    return await handleNodesApprove(req, res);
  }

  // Route: POST /friday-next/approvals/{approvalId} (submit exec/plugin approval decision)
  if (req.method === "POST" && pathname.startsWith("/friday-next/approvals/")) {
    const approvalId = decodeURIComponent(pathname.slice("/friday-next/approvals/".length));
    return await handleApprovalDecision(req, res, approvalId);
  }

  if (req.method === "GET" && pathname === "/friday-next/questions") {
    return await handlePendingQuestions(req, res);
  }
  // Route: POST /friday-next/questions/{questionId} (submit ask_user question answer)
  if (req.method === "POST" && pathname.startsWith("/friday-next/questions/")) {
    const questionId = decodeURIComponent(pathname.slice("/friday-next/questions/".length));
    return await handleQuestionAnswer(req, res, questionId);
  }

  // Route: GET /friday-next/questions/{questionId} (re-check ask_user question state)
  if (req.method === "GET" && pathname.startsWith("/friday-next/questions/")) {
    const questionId = decodeURIComponent(pathname.slice("/friday-next/questions/".length));
    return await handleQuestionLookup(req, res, questionId);
  }

  if (req.method === "POST" && pathname === "/friday-next/health-query/result") {
    return await handleHealthQueryResult(req, res);
  }

  if (req.method === "POST" && pathname === "/friday-next/calendar/result") {
    return await handleCalendarResult(req, res);
  }

  if (req.method === "POST" && pathname === "/friday-next/location/result") {
    return await handleLocationQueryResult(req, res);
  }

  // Routes: GET/PUT /friday-next/agents/{id}/config
  //         GET     /friday-next/agents/{id}/files
  //         GET/PUT /friday-next/agents/{id}/files/{name}
  if (pathname.startsWith("/friday-next/agents/")) {
    const segs = pathname
      .slice("/friday-next/agents/".length)
      .split("/")
      .filter(Boolean)
      .map((s) => decodeURIComponent(s));
    const [id, sub, name] = segs;
    if (id && sub === "config" && segs.length === 2) {
      return await handleAgentConfig(req, res, id);
    }
    if (id && sub === "greeting" && segs.length === 2) {
      return await handleAgentGreeting(req, res, id);
    }
    if (id && sub === "files" && (segs.length === 2 || segs.length === 3)) {
      return await handleAgentFiles(req, res, id, name);
    }
    if (id && sub === "tools" && name === "catalog" && segs.length === 3) {
      return await handleAgentToolsCatalog(req, res, id);
    }
  }

  if (req.method === "GET" && pathname === "/friday-next/status") {
    return await handleStatus(req, res);
  }

  // Route: GET /friday-next/notifications (durable user-visible cron/background pushes)
  if (req.method === "GET" && pathname === "/friday-next/notifications") {
    return await handleNotifications(req, res);
  }

  // Route: DELETE /friday-next/notifications/:seq (permanent server-side removal)
  if (req.method === "DELETE" && pathname.startsWith("/friday-next/notifications/")) {
    const seqRaw = decodeURIComponent(pathname.slice("/friday-next/notifications/".length));
    return await handleNotificationDelete(req, res, seqRaw);
  }

  // Route: GET /friday-next/progress-card?sessionKey= (authoritative session progress card)
  if (req.method === "GET" && pathname === "/friday-next/progress-card") {
    return await handleProgressCardGet(req, res);
  }

  // Route: GET /friday-next/plugin/info (current/latest version + upgradability)
  if (req.method === "GET" && pathname === "/friday-next/plugin/info") {
    return await handlePluginInfo(req, res);
  }

  // Route: POST /friday-next/plugin/upgrade (async npm install @latest + gateway restart)
  if (req.method === "POST" && pathname === "/friday-next/plugin/upgrade") {
    return await handlePluginUpgrade(req, res);
  }

  // Route: GET /friday-next/plugin/upgrade/status (async upgrade progress)
  if (req.method === "GET" && pathname === "/friday-next/plugin/upgrade/status") {
    return await handlePluginUpgradeStatus(req, res);
  }

  // Not found
  return false;
}
