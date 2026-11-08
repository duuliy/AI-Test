/**
 * 聊天模型初始化 & 错误翻译
 *
 * modelProvider 固定为 "openai"，代表"符合 OpenAI Chat Completions 协议"的任何供应商。
 * 智谱 GLM、DeepSeek、Moonshot 等都不需要改 provider，只换 baseURL 和 model 名即可。
 *
 * 单例模式说明：
 *   所有需要模型的地方（router / middleware / agent）都调 getModel()。
 *   buildModel() 只在第一次调用时执行一次，后续直接复用同一个实例。
 *   如果第一次初始化失败（比如 env 没填），catch 里会把 modelPromise 清回 undefined，
 *   这样修好配置后下一次请求会重新建，不需要重启进程。
 */
import { initChatModel } from "langchain";
import { readModelConfig, REQUEST_TIMEOUT_MS } from "./env";

/** 把 Promise 解包后的实际类型暴露出去，避免调用方重复写 Awaited<...> */
export type AppModel = Awaited<ReturnType<typeof initChatModel>>;

/** 缓存"建模型"这个 Promise，而不是缓存模型实例本身。
 *  原因：并发首请求时，多个 getModel() 会共享同一个 Promise，
 *  不会触发多次 buildModel()。
 */
let modelPromise: Promise<AppModel> | undefined;

/**
 * 真正的模型构造。
 * 温度 0.2 偏高（纯 RAG 问答通常用 0），但这里模型还负责路由判断和工具选择，
 * 稍微留一点随机性能避免极端情况下总是走到同一条坏路径。
 * maxRetries=2 让 SDK 在网络抖动时自动重试一次，
 * 与 middleware 的 toolRetryMiddleware（工具级重试）互不重叠。
 */
async function buildModel(): Promise<AppModel> {
  const { apiKey, baseURL, model } = readModelConfig();

  return initChatModel(model, {
    modelProvider: "openai",
    apiKey,
    configuration: { baseURL },
    temperature: 0.2,
    maxRetries: 2,
    timeout: REQUEST_TIMEOUT_MS,
  });
}

/** 懒加载单例入口：getter 本身绝不抛错，所有异常透传给调用方 */
export function getModel(): Promise<AppModel> {
  if (!modelPromise) {
    modelPromise = buildModel().catch((error: unknown) => {
      // 关键：失败后清除缓存，让修好配置后的下一次调用能重新 build
      modelPromise = undefined;
      throw error;
    });
  }
  return modelPromise;
}

/**
 * 把底层 SDK / 网络错误翻译成中文提示，供 Route Handler 写进流里直接展示给用户。
 *
 * 判断顺序不能乱：
 *   Abort → Timeout → HTTP 状态码 → 网络错误码 → 兜底消息
 * 因为 SDK 可能同时设置 status 和 code，我们优先给更贴近用户认知的提示。
 * 兜底消息会把 error.message 原样带上，方便开发者在控制台搜关键字。
 */
export function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number }).status;
  const cause = (error as { cause?: { code?: string } }).cause;
  const code = (error as { code?: string }).code ?? cause?.code;

  // 用户主动取消（关页面 / 按 Ctrl+C）不算"出错"，只做轻提示
  if (name.includes("Abort") || /aborted/i.test(message)) {
    return "已中断当前请求。";
  }
  if (name === "TimeoutError" || name.includes("Timeout") || /timed out/i.test(message)) {
    return `请求超时（${REQUEST_TIMEOUT_MS / 1000}s）。请检查网络，或稍后重试。`;
  }
  if (status === 401 || status === 403) {
    return "鉴权失败（HTTP 401/403）：请检查 OPENAI_API_KEY 是否有效，以及它和 OPENAI_BASE_URL 是否属于同一平台。";
  }
  if (status === 404) {
    return "接口或模型不存在（HTTP 404）：请检查 OPENAI_BASE_URL 的版本路径和 OPENAI_MODEL。";
  }
  if (status === 429) {
    return "请求被限流或额度不足（HTTP 429）：请稍后重试，并检查账户余额。";
  }
  if (status !== undefined && status >= 500) {
    return `服务端错误（HTTP ${status}）：模型服务暂时不可用，请稍后重试。`;
  }
  if (code === "ENOTFOUND") {
    return "无法解析模型服务域名（ENOTFOUND）：请检查 OPENAI_BASE_URL 和本机网络/DNS。";
  }
  if (code === "ECONNREFUSED") {
    return "连接被拒绝（ECONNREFUSED）：请确认 OPENAI_BASE_URL 的地址和端口可访问。";
  }

  // 兜底：不知道是什么错，但把原始 message 带上，便于排查
  return `模型调用失败：${message}`;
}
