import type { FridayNextLogLevel } from "./config.js";

const levelOrder: Record<FridayNextLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createFridayNextLogger(scope: string, level: FridayNextLogLevel = "info") {
  const base = `[friday-next:${scope}]`;
  const enabled = (current: FridayNextLogLevel) => levelOrder[current] >= levelOrder[level];
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
