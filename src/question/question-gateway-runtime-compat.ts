import { createFridayNextLogger } from "../logging.js";

type QuestionDeliveryRegistration = {
  questionId: string;
  deliveryId: string;
  finalize: (statusLine: string) => void | Promise<void>;
};

type QuestionGatewayRuntime = {
  registerChannelDelivery: (params: QuestionDeliveryRegistration) => void;
};

type QuestionGatewayRuntimeModule = {
  questionGatewayRuntime: QuestionGatewayRuntime;
};

type RuntimeLoader = () => Promise<QuestionGatewayRuntimeModule>;

const logger = createFridayNextLogger("question-runtime");
const defaultLoader: RuntimeLoader = () => import("openclaw/plugin-sdk/question-gateway-runtime");

let runtimeLoader: RuntimeLoader = defaultLoader;
let runtimePromise: Promise<QuestionGatewayRuntime | null> | null = null;
let missingRuntimeLogged = false;

function isMissingQuestionGatewayRuntime(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    (code === "MODULE_NOT_FOUND" ||
      code === "ERR_MODULE_NOT_FOUND" ||
      code === "ERR_PACKAGE_PATH_NOT_EXPORTED") &&
    /question-gateway-runtime/i.test(error.message)
  );
}

async function loadQuestionGatewayRuntime(): Promise<QuestionGatewayRuntime | null> {
  runtimePromise ??= runtimeLoader()
    .then((module) => module.questionGatewayRuntime)
    .catch((error: unknown) => {
      if (!isMissingQuestionGatewayRuntime(error)) throw error;
      // COMPAT(openclaw<=2026.7.1 question-gateway-runtime): 旧宿主没有 ask_user 的
      // question-gateway-runtime SDK 子路径。按需加载并仅关闭终态桥接，避免整插件加载失败。
      // CLEANUP: 最低宿主版本高于 2026.7.1 后恢复静态导入，并删除本文件及对应测试。
      if (!missingRuntimeLogged) {
        missingRuntimeLogged = true;
        logger.info("question gateway runtime unavailable; ask_user bridge is disabled");
      }
      return null;
    });
  return runtimePromise;
}

export async function getFridayQuestionDeliveryRegistrar(): Promise<
  QuestionGatewayRuntime["registerChannelDelivery"] | null
> {
  const runtime = await loadQuestionGatewayRuntime();
  return runtime?.registerChannelDelivery.bind(runtime) ?? null;
}

export function __setQuestionGatewayRuntimeLoaderForTest(loader: RuntimeLoader): void {
  runtimeLoader = loader;
  runtimePromise = null;
  missingRuntimeLogged = false;
}

export function __resetQuestionGatewayRuntimeLoaderForTest(): void {
  runtimeLoader = defaultLoader;
  runtimePromise = null;
  missingRuntimeLogged = false;
}
