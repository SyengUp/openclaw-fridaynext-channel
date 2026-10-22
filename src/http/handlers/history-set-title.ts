import { openClawSessionHandlers } from "../../adapters/openclaw/session-http-compatibility.js";
export const handleHistorySetTitle = (
  ...args: Parameters<typeof openClawSessionHandlers.handleSessionTitle>
) => openClawSessionHandlers.handleSessionTitle(...args);
