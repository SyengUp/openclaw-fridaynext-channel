import type { FridayNextLogLevel } from "./config.js";

const levelOrder: Record<FridayNextLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// Process-wide active level, honored by every logger at call time. Handlers call
// setFridayNextLogLevel() once the friday-next channel config resolves, so
// `channels.friday-next.logLevel: "debug"` turns the full per-message trace back on.
let activeLevel: FridayNextLogLevel = "info";

export function setFridayNextLogLevel(level: FridayNextLogLevel): void {
  activeLevel = level;
}

// The optional `level` arg is accepted for call-site compatibility but the effective
// threshold is the process-wide active level (single knob driven by config.logLevel).
export function createFridayNextLogger(scope: string, _level?: FridayNextLogLevel) {
  const base = `[friday-next:${scope}]`;
  const enabled = (current: FridayNextLogLevel) => levelOrder[current] >= levelOrder[activeLevel];
  return {
    debug: (message: string) => {
      if (enabled("debug")) console.debug(`${base} ${message}`);
    },
    info: (message: string) => {
      if (enabled("info")) console.info(`${base} ${message}`);
    },
    warn: (message: string) => {
      if (enabled("warn")) console.warn(`${base} ${message}`);
    },
    error: (message: string) => {
      if (enabled("error")) console.error(`${base} ${message}`);
    },
  };
}
