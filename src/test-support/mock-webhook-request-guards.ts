import { vi } from "vitest";

/** Identity stand-in: unit tests do not exercise OpenClaw admission. */
export const runDetachedWebhookWork = vi.fn(<T>(run: () => Promise<T>): Promise<T> => run());
