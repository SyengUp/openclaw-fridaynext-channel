import { createServerNameHandler } from "@syengup/fridaynext-channel-kit/transport/server-name";
import { extractBearerToken } from "../middleware/auth.js";
import * as store from "../../server-name/server-name-store.js";

export const handleServerName = createServerNameHandler({ authenticate: (req) => extractBearerToken(req) !== null, store }).handleServerName;
