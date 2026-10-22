import {
  createSessionHandlers,
  bindSessionToDevice,
} from "@syengup/fridaynext-channel-kit/transport/sessions";
import { extractBearerToken } from "../../http/middleware/auth.js";
import { getRuntimeV3Store } from "../../runtime-v3/runtime-store.js";
import {
  setOpenClawSessionTitle,
  setOpenClawSessionPinned,
  bindOpenClawSession,
} from "./session-actions.js";

// 旧导出复用相同公共处理器，保留测试和兼容入口，不复制 HTTP 规则。
export const openClawSessionHandlers = createSessionHandlers({
  authenticate: (req) => extractBearerToken(req) !== null,
  adapter: { setSessionTitle: setOpenClawSessionTitle, setSessionPinned: setOpenClawSessionPinned },
  bind: (key, deviceId) =>
    bindSessionToDevice(getRuntimeV3Store(), { bindSession: bindOpenClawSession }, key, deviceId),
});
