/**
 * Pure helper (no SDK imports, unit-testable in isolation) that recognises an
 * OpenClaw *operator/admin tool result envelope* in an outbound text send.
 *
 * When an agent invokes a core operator/admin tool (`gateway.restart`,
 * `gateway.stop`, config mutations, …) the core delivers a fixed confirmation
 * template through the channel outbound — indistinguishable, by session key /
 * kind / agentId, from a real reply (verified against a real captured record:
 * `sourceSessionKey: agent:main:friday-next-<deviceId>`, `kind: "push"`). The
 * ONLY stable discriminator is the text envelope itself, e.g.:
 *
 *   Gateway restart ok (gateway.restart)
 *   网关正在重启，我会等它恢复后确认一下。        ← LLM narration (varies — never matched)
 *   Reason: User requested gateway restart
 *   Recommended follow-up: run openclaw doctor --non-interactive …
 *
 * These infra receipts carry no reading value for the user, so the channel
 * silences them (skips both the SSE broadcast and the durable notification).
 *
 * Detection uses a DOUBLE anchor to stay precise (a real reply that merely
 * quotes one signal in prose is not suppressed):
 *   A) a parenthesised dotted operator method, e.g. `(gateway.restart)`, AND
 *   B) the core advisory boilerplate (`Reason:` or `Recommended follow-up:`).
 * The variable narration line is deliberately NOT part of the signature.
 */

/** Parenthesised dotted operator/admin method, e.g. `(gateway.restart)`, `(config.set)`. */
const OPERATOR_METHOD_HEADER =
  /\((?:gateway|config|node|plugin|agent|approvals?|host|runtime)\.[a-z0-9_.-]+\)/i;

/** Core-generated advisory lines that accompany an operator tool result. */
const OPERATOR_ADVISORY = /^[ \t]*(?:Reason|Recommended follow-up):/im;

/**
 * True when `text` is a core operator/admin tool-result confirmation that the
 * channel should silence (no broadcast, no notification). Requires BOTH the
 * parenthesised method header AND a core advisory line.
 */
export function isOperatorToolResultEnvelope(text: string | null | undefined): boolean {
  if (!text) return false;
  return OPERATOR_METHOD_HEADER.test(text) && OPERATOR_ADVISORY.test(text);
}
