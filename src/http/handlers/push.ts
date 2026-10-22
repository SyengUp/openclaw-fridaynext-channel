import {createPushHandler} from "@syengup/fridaynext-channel-kit/transport/push";
import {extractBearerToken} from "../middleware/auth.js";
import {readJsonBody} from "../middleware/body.js";
import {getPushRuntime,PUSH_ORIGIN} from "../../push/push-runtime.js";
export const {handlePush}=createPushHandler({authenticate:req=>extractBearerToken(req)!==null,runtime:getPushRuntime,pushOrigin:PUSH_ORIGIN,readBody:readJsonBody});
