/**
 * Ack-first HTTP dispatch must not inherit a released gateway admission root.
 *
 * COMPAT(openclaw<2026.8.1) — keep this module so hosts without
 * `runDetachedWebhookWork` still load. `minHostVersion` stays on the older
 * floor (compat is the point); grep this tag when no install still lacks the
 * named export (BJ was 2026.6.11 on 2026-08-31).
 *
 * Cleanup:
 * 1. In `messages.ts`, statically `import { runDetachedWebhookWork } from
 *    "openclaw/plugin-sdk/webhook-request-guards"` and call it directly
 *    (`void runDetachedWebhookWork(() => runAgent())`). No await/load.
 * 2. Delete this file and `detached-webhook-work.test.ts`.
 *
 * Why: 2026.8.1+ exports `runDetachedWebhookWork`. Older hosts still export
 * the `webhook-request-guards` subpath without that named export — a static
 * import throws SyntaxError at module evaluation. They also do not wrap plugin
 * HTTP in admission, so identity fire-and-forget is the old, correct path.
 * Resolve lazily so a missing named export cannot fail module evaluation.
 */

type DetachedWork = <T>(run: () => Promise<T>) => Promise<T>;

type WebhookRequestGuardsModule = {
  runDetachedWebhookWork?: DetachedWork;
};

/** COMPAT(openclaw<2026.8.1): identity = pre-admission fire-and-forget. */
const identity: DetachedWork = (run) => run();

let importGuards: () => Promise<WebhookRequestGuardsModule> = () =>
  import("openclaw/plugin-sdk/webhook-request-guards");

let resolved: Promise<DetachedWork> | null = null;

export async function loadDetachedWebhookWork(): Promise<DetachedWork> {
  resolved ??= importGuards()
    .then((m) =>
      typeof m.runDetachedWebhookWork === "function" ? m.runDetachedWebhookWork : identity,
    )
    .catch(() => identity);
  return resolved;
}

export function __setDetachedWebhookWorkImporterForTests(
  fn: (() => Promise<WebhookRequestGuardsModule>) | null,
): void {
  importGuards = fn ?? (() => import("openclaw/plugin-sdk/webhook-request-guards"));
  resolved = null;
}
