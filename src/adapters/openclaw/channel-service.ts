import { ChannelService } from "@syengup/fridaynext-channel-kit";
import path from "node:path";
import * as attest from "../../attest/attest-store.js";
import { resolveFridayNextConfig } from "../../config.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { handleAgentsList } from "../../http/handlers/agents-list.js";
import { handleCancel } from "../../http/handlers/cancel.js";
import { readHostMedia } from "../../http/handlers/files-download.js";
import { getAttachmentStore } from "../../http/handlers/files.js";
import { handleHealth } from "../../http/handlers/health.js";
import { handleHistoryMessages, handleHistoryMessageDetail } from "../../http/handlers/history-messages.js";
import { handleHistorySessions } from "../../http/handlers/history-sessions.js";
import { handleMessages } from "../../http/handlers/messages.js";
import { handleModelsList } from "../../http/handlers/models-list.js";
import { handleSessionsSettings } from "../../http/handlers/sessions-settings.js";
import { handleSseStream } from "../../http/handlers/sse.js";
import { extractBearerToken } from "../../http/middleware/auth.js";
import { isPublicRequest } from "../../http/middleware/public-surface.js";
import { getLinkPreviewService } from "../../link-preview/preview-service.js";
import { createFridayNextLogger } from "../../logging.js";
import { processRef } from "../../process-state.js";
import * as capsules from "../../prompt-capsules/capsules-store.js";
import { getPublicAccessManager } from "../../public-access/frpc-manager.js";
import * as vouchers from "../../public-access/pairing-voucher.js";
import { getPushRuntime, PUSH_ORIGIN } from "../../push/push-runtime.js";
import { getRuntimeV3Store, resolveRuntimeV3Root } from "../../runtime-v3/runtime-store.js";
import { getFridayNextRuntime } from "../../runtime.js";
import * as serverName from "../../server-name/server-name-store.js";
import { OpenClawBackendAdapter } from "./backend-adapter.js";
import { OPENCLAW_PUBLIC_POLICY } from "./public-policy.js";
import { handleOpenClawExtensionRoute } from "./routes.js";
import { openClawTransportOptions } from "./transport-compatibility.js";

const slot = processRef<
  { store: ReturnType<typeof getRuntimeV3Store>; service: ChannelService } | undefined
>(Symbol.for("@syengup/friday-channel-next/channel-service"), undefined);

// 同一宿主的路由、工具与热加载实例共享一个 Kit 服务；不再各自调度或恢复。
export function getOpenClawChannelService(): ChannelService {
  const store = getRuntimeV3Store();
  if (slot.value?.store === store) return slot.value.service;
  const predecessor = slot.value?.service;
  const config = () =>
    resolveFridayNextConfig(getHostOpenClawConfigSnapshot(getFridayNextRuntime().config));
  const logger = createFridayNextLogger("channel-service");
  const waitForStop = predecessor?.stop();
  void waitForStop?.catch((error) =>
    logger.warn(`旧服务停止失败：${error instanceof Error ? error.message : String(error)}`),
  );
  const service = new ChannelService({
    dataDir: path.dirname(resolveRuntimeV3Root()),
    authToken: "",
    store,
    authenticate: (req) => extractBearerToken(req) !== null,
    adapter: new OpenClawBackendAdapter(),
    files: getAttachmentStore(),
    transport: openClawTransportOptions,
    allowLegacy: true,
    waitForStop,
    cors: () => ({ enabled: config().corsEnabled, allowOrigin: config().corsAllowOrigin }),
    gate: {
      required: () => config().appAttest.required,
      isPublic: isPublicRequest,
      policy: OPENCLAW_PUBLIC_POLICY.attest,
    },
    legacy: {
      messages: handleMessages,
      events: handleSseStream,
      cancel: handleCancel,
      health: handleHealth,
      agents: handleAgentsList,
      models: handleModelsList,
      sessions: handleHistorySessions,
      history: handleHistoryMessages,
      detail: handleHistoryMessageDetail,
      settings: handleSessionsSettings,
    },
    extensions: handleOpenClawExtensionRoute,
    infrastructure: {
      attest: {
        store: attest,
        policy: () => config().appAttest,
        warn: (message) => logger.warn(message),
      },
      preview: getLinkPreviewService(),
      pairing: { vouchers },
      push: { runtime: getPushRuntime(), origin: PUSH_ORIGIN },
      capsules,
      serverName,
      readHostMedia,
      logger,
      publicAccess: {
        manager: getPublicAccessManager(),
        config: () => {
          const cfg = config();
          return {
            ...cfg.publicAccess,
            subdomain: cfg.publicAccess.subdomain || undefined,
            authToken: cfg.authToken,
          };
        },
      },
    },
  });
  slot.value = { store, service };
  return service;
}
