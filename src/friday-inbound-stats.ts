/** Last accepted POST /friday/messages timestamp for Control UI channel health. */
let lastInboundAtMs: number | null = null;

export function touchFridayInbound(): void {
  lastInboundAtMs = Date.now();
}

export function getLastFridayInboundAt(): number | null {
  return lastInboundAtMs;
}
