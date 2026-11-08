/**
 * Day 10 的独立配置模块。
 * 严格来说这部分和 `src/shared/model.ts` 很像，但 Day 10 的约束是“不 import 其他 day / shared”，
 * 所以把环境读取、模型初始化和错误翻译在这里各复制一份，保证本目录可以独立运行。
 */
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { join } from "node:path";
import { initChatModel } from "langchain";

/** 单次模型请求的超时时间，与 Day 1 保持一致 */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * 追踪开关变量。
 * LangSmith 改过命名：旧版是 LANGCHAIN_TRACING_V2 / LANGCHAIN_TRACING，
 * 新版是 LANGSMITH_TRACING / LANGSMITH_TRACING_V2；
 * LangChain 内部是“任意一个等于 true 就算开启”，这里保持同样的判断口径。
 */
const TRACING_FLAGS = [
  "LANGSMITH_TRACING",
  "LANGSMITH_TRACING_V2",
  "LANGCHAIN_TRACING_V2",
  "LANGCHAIN_TRACING",
] as const;

/**
 * API key 变量。
 * 新版 LANGSMITH_API_KEY 与旧版 LANGCHAIN_API_KEY 都接受，
 * langsmith SDK 自己也是先读 LANGSMITH_ 再回落到 LANGCHAIN_。
 * ！！！LANGSMITH_TRACING和LANGSMITH_API_KEY是V1自己`@langchain/core` 在初始化 global callbacks 时会 require 它（只要 node_modules 里有这个包）
 */
const API_KEY_VARS = ["LANGSMITH_API_KEY", "LANGCHAIN_API_KEY"] as const;

/**
 * 初始化入口：这两份示例脚本一启动就先调用它。
 * 顺序很重要：
 * 1. 先读 .env，否则后面读不到 OPENAI_* 和 LANGSMITH_*；
 * 2. 再补全局 crypto，LangChain 生成 run id 时会用到；
 * 3. 最后做追踪开关和 key 的一致性检查，避免“开了追踪却没 key”带来无谓的上报失败。
 * 外部显式设置的环境变量优先于 .env，方便临时用命令行覆盖。
 */
export function loadEnv(): void {
  loadEnvFile();

  ensureGlobalCrypto();

  // 追踪开关为 true 但缺 key 时，直接关掉开关：
  // 否则 LangSmith SDK 仍会尝试上传 run，反复打印鉴权失败，干扰示例输出。
  // 注意这只是“本次进程内”的降级，不会写回 .env，用户补上 key 后下次即可正常追踪。
  if (hasTracingFlag() && !hasApiKey()) {
    for (const name of TRACING_FLAGS) {
      process.env[name] = "false";
    }
  }
}

/**
 * 读取 .env：优先用内置能力，低版本 Node 退回手写解析。
 * 内置 process.loadEnvFile 从 Node 20.12 开始提供；
 * 本机若还是 Node 18，就只能自己按 KEY=VALUE 解析，够用即可，不引入 dotenv。
 */
function loadEnvFile(): void {
  if (typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile();
    } catch (error) {
      // .env 不存在不算错误，后面的 readConfig 会给出缺变量的提示
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return;
  }

  // ---------- 低版本 Node 的兜底解析 ----------
  // 只支持最简单的格式：整行注释、空行、KEY=VALUE；
  // 不支持 export 前缀、多行值、变量插值等高级语法，学习项目用不到。
  let content: string;
  try {
    content = readFileSync(join(process.cwd(), ".env"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // 只按第一个等号切分，值里可能还有 "="
    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    // 去掉成对的引号，和 loadEnvFile 的行为保持一致
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // 已存在的环境变量优先，不覆盖用户显式设置的网络/密钥配置
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * 补上全局 crypto。
 * Node 18 的 ESM 运行环境里没有挂载 globalThis.crypto（CJS 才有），
 * 而 @langchain/core 生成 uuid v7 时直接引用裸 `crypto`，缺了会报 "crypto is not defined"。
 * 这里用 node:crypto 导出的 webcrypto 补一个同语义实现；Node 19+ 已有则直接跳过。
 */
function ensureGlobalCrypto(): void {
  if ((globalThis as { crypto?: unknown }).crypto !== undefined) {
    return;
  }
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
}

/** 追踪开关是否至少有一个为 true */
function hasTracingFlag(): boolean {
  return TRACING_FLAGS.some((name) => process.env[name]?.trim() === "true");
}

/** 是否能读到 API key（新旧变量任一即可） */
function hasApiKey(): boolean {
  return API_KEY_VARS.some((name) => Boolean(process.env[name]?.trim()));
}

/**
 * 读取并校验模型配置，缺失时给出中文提示并退出。
 * Day 10 只需要“能跑起来”的配置校验，不做更细的格式检查。
 */
function readConfig(): { apiKey: string; baseURL: string; model: string } {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const baseURL = process.env.OPENAI_BASE_URL?.trim();
  const model = process.env.OPENAI_MODEL?.trim();

  const missing: string[] = [];
  if (!apiKey) missing.push("OPENAI_API_KEY");
  if (!baseURL) missing.push("OPENAI_BASE_URL");
  if (!model) missing.push("OPENAI_MODEL");

  if (!apiKey || !baseURL || !model) {
    console.error(`缺少环境变量：${missing.join(", ")}`);
    console.error("请先执行 `cp .env.example .env`，然后在 .env 中填入真实配置。");
    process.exit(1);
  }

  return { apiKey, baseURL, model };
}

/**
 * 创建聊天模型。
 * - modelProvider 固定为 "openai"：它代表“任意 OpenAI 兼容协议”，
 *   智谱 GLM / DeepSeek / Moonshot 等都复用这套协议，只靠 baseURL 区分；
 * - temperature 0.2：示例希望输出稳定，同时保留一点措辞灵活性；
 * - maxRetries / timeout：网络抖动时自动重试，单次请求不超过 60s；
 * - configuration.baseURL 才是 v1 里传自定义端点的位置，不是顶层 baseURL。
 */
export async function createChatModel() {
  const { apiKey, baseURL, model } = readConfig();

  return initChatModel(model, {
    modelProvider: "openai",
    apiKey,
    configuration: { baseURL },
    temperature: 0.2,
    maxRetries: 2,
    timeout: REQUEST_TIMEOUT_MS,
  });
}

/**
 * 是否具备完整的 LangSmith 追踪条件：
 * 1. 追踪开关为 true（新变量 LANGSMITH_TRACING 或旧变量 LANGCHAIN_TRACING_V2 等）
 * 2. 能读到 API key（LANGSMITH_API_KEY 或旧版 LANGCHAIN_API_KEY）
 * 两者缺一，本次示例就跳过追踪，不影响主流程。
 *
 * 这里只做“判断”，不负责创建 tracer：
 * LangChain 的 callback 体系会在运行时直接读这些环境变量，开启后自动上报。
 */
export function isTracingEnabled(): boolean {
  return hasTracingFlag() && hasApiKey();
}

/**
 * 把底层 SDK / 网络错误翻译成中文可读提示。
 * 两条线索最关键：
 * - status：HTTP 状态码，能区分鉴权（401/403）、资源不存在（404）、限流（429）、服务端故障（5xx）；
 * - code（或 cause.code）：Node 网络层错误码，能区分 DNS、连接被拒、证书校验失败。
 * 判断顺序从“具体”到“笼统”，最后兜底返回原始 message，避免吞掉信息。
 */
export function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number }).status;
  const cause = (error as { cause?: { code?: string } }).cause;
  const code = (error as { code?: string }).code ?? cause?.code;

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
    return "接口或模型不存在（HTTP 404）：请检查 OPENAI_BASE_URL 是否包含正确的版本路径（如智谱的 /api/paas/v4），以及 OPENAI_MODEL 是否存在。";
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
  if (code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return `TLS 证书校验失败（${code}）：请检查网络代理或系统证书。`;
  }

  return `模型调用失败：${message}`;
}
