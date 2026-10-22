import { openClawSessionHandlers } from "../../adapters/openclaw/session-http-compatibility.js";
export const handleSessionsBind = (
  ...args: Parameters<typeof openClawSessionHandlers.handleSessionBind>
) => openClawSessionHandlers.handleSessionBind(...args);
