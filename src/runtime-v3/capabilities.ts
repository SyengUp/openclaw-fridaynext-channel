export const FRIDAY_NEXT_PROTOCOL_VERSIONS = [2, 3] as const;

export const FRIDAY_NEXT_RUNTIME_CAPABILITIES = [
  "durable-runtime",
  "idempotent-messages",
  "session-serial-queue",
  "runtime-event-replay",
  "runtime-event-ack",
] as const;
