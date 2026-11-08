/**
 * Day 6 · 独立配置：环境变量、embedding 初始化、错误翻译
 *
 * 按 Day 6 提示词的要求，本目录不依赖 src/shared 或其他 day 目录，
 * 因此这里把 Day 1 / Day 5 中的 env 读取与错误处理风格单独复制一份。
 */
// OpenAI 兼容协议的 embedding 实现；不同厂商只靠 baseURL 区分
import { OpenAIEmbeddings } from "@langchain/openai";

/** 单次 embedding 请求的超时时间 */
const REQUEST_TIMEOUT_MS = 60_000; // 60 秒，避免网络异常时无限等待

/** embedding 的默认模型名，具体取值请按 provider 调整，可用 OPENAI_EMBEDDING_MODEL 覆盖 */
const DEFAULT_EMBEDDING_MODEL = "embedding-3"; // 智谱等兼容端点用这个名字；OpenAI 官方应改为 text-embedding-3-small

/**
 * 加载项目根目录的 .env。
 * process.loadEnvFile 是 Node 20.12+ 的内置能力，不需要 dotenv；
 * 文件不存在时静默跳过，缺失变量统一交给 readEmbeddingConfig 报错。
 */
export function loadEnv(): void {
  // 把 .env 中的键值对写进 process.env
  try {
    process.loadEnvFile();
  } catch (error) {
    // 文件不存在（ENOENT）时不算错误：可能用户直接用系统环境变量
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // 其他错误（例如权限问题、语法问题）照常抛出
      throw error;
    }
  }
}

/** 读取并校验 embedding 需要的环境变量，缺失时给出中文提示并退出 */
function readEmbeddingConfig(): { apiKey: string; baseURL: string; model: string } {
  // 读取并 trim；?.trim() 让变量不存在时返回 undefined 而不是报错
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  // 接口地址：不同 provider 的版本路径不同，例如智谱是 /api/paas/v4
  const baseURL = process.env.OPENAI_BASE_URL?.trim();
  // OPENAI_EMBEDDING_MODEL 未设置时回落到默认值；不同 provider 的名字不一样，需要时自行覆盖
  const model = process.env.OPENAI_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;

  // 收集缺失的变量名，一次性告诉用户
  const missing: string[] = [];
  // 缺 key 就记录
  if (!apiKey) missing.push("OPENAI_API_KEY");
  // 缺 baseURL 就记录
  if (!baseURL) missing.push("OPENAI_BASE_URL");

  // 任意一个缺失都直接退出（Day 1 的统一风格）
  if (!apiKey || !baseURL) {
    // 打印缺了哪些
    console.error(`缺少环境变量：${missing.join(", ")}`);
    // 打印补救步骤
    console.error("请先执行 `cp .env.example .env`，然后在 .env 中填入真实配置。");
    // 非 0 退出码
    process.exit(1);
  }

  // 到这里类型已经收窄，返回配置
  return { apiKey, baseURL, model };
}

/**
 * 创建 OpenAI 兼容接口的 embedding 模型。
 * modelProvider 不写死，OpenAI / 智谱 / DeepSeek 等都复用这套协议，只靠 baseURL 区分。
 */
export function createEmbeddings(): OpenAIEmbeddings {
  // 先拿到并校验配置
  const { apiKey, baseURL, model } = readEmbeddingConfig();

  // 构造 embedding 客户端
  return new OpenAIEmbeddings({
    apiKey, // 鉴权
    model, // 模型名，来自 OPENAI_EMBEDDING_MODEL 或默认值
    configuration: { baseURL }, // 覆盖 SDK 默认地址，指向兼容端点
    timeout: REQUEST_TIMEOUT_MS, // 单次请求超时
    maxRetries: 2, // 网络抖动时自动重试 2 次
  });
}

/**
 * 把底层 SDK / 网络错误翻译成中文可读提示。
 * 保留 status 和 cause.code 两条线索，足以区分鉴权、模型不存在、限流和网络问题。
 */
export function describeError(error: unknown): string {
  // 错误名（如 TimeoutError / AbortError）用于判断超时和中断
  const name = error instanceof Error ? error.name : "";
  // 原始错误消息，兜底输出时用
  const message = error instanceof Error ? error.message : String(error);
  // OpenAI SDK 的 HTTP 错误通常带 status 字段
  const status = (error as { status?: number }).status;
  // 网络错误通常藏在 cause 里
  const cause = (error as { cause?: { code?: string } }).cause;
  // 同时兼容顶层 code 和 cause.code
  const code = (error as { code?: string }).code ?? cause?.code;

  // 主动中断（connect 被 abort）
  if (name.includes("Abort") || /aborted/i.test(message)) {
    return "已中断当前请求。";
  }
  // 超时
  if (name === "TimeoutError" || name.includes("Timeout") || /timed out/i.test(message)) {
    return `请求超时（${REQUEST_TIMEOUT_MS / 1000}s）。请检查网络，或稍后重试。`;
  }
  // 鉴权失败：key 无效或 key 与 baseURL 不属于同一平台
  if (status === 401 || status === 403) {
    return "鉴权失败（HTTP 401/403）：请检查 OPENAI_API_KEY 是否有效，以及它和 OPENAI_BASE_URL 是否属于同一平台。";
  }
  // 404：常见于 baseURL 少了版本路径，或 embedding 模型名不存在
  if (status === 404) {
    return "接口或模型不存在（HTTP 404）：请检查 OPENAI_BASE_URL 是否包含正确的版本路径（如智谱的 /api/paas/v4），以及 OPENAI_EMBEDDING_MODEL 是否存在。";
  }
  // 限流 / 余额不足
  if (status === 429) {
    return "请求被限流或额度不足（HTTP 429）：请稍后重试，并检查账户余额。";
  }
  // 5xx 服务端错误
  if (status !== undefined && status >= 500) {
    return `服务端错误（HTTP ${status}）：模型服务暂时不可用，请稍后重试。`;
  }
  // DNS 解析失败：baseURL 写错或断网
  if (code === "ENOTFOUND") {
    return "无法解析模型服务域名（ENOTFOUND）：请检查 OPENAI_BASE_URL 和本机网络/DNS。";
  }
  // 端口/地址不可达
  if (code === "ECONNREFUSED") {
    return "连接被拒绝（ECONNREFUSED）：请确认 OPENAI_BASE_URL 的地址和端口可访问。";
  }
  // TLS 证书问题：常见于公司代理或系统时间不对
  if (code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return `TLS 证书校验失败（${code}）：请检查网络代理或系统证书。`;
  }

  // 都不匹配时，至少把原始消息透出来
  return `embedding 调用失败：${message}`;
}
