import { openClawSessionHandlers } from "../../adapters/openclaw/session-http-compatibility.js";
export const handleSessionsPin = (
  ...args: Parameters<typeof openClawSessionHandlers.handleSessionPin>
) => openClawSessionHandlers.handleSessionPin(...args);
