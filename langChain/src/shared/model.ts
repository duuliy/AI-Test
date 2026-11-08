import { readFileSync } from "node:fs";
import { initChatModel } from "langchain";

/** 单次模型请求的超时时间，与 Day 1 保持一致 */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * 加载项目根目录的 .env。
 * Node 20.12+ 自带 process.loadEnvFile；Node 18 没有这个 API，
 * 这里用最小实现兜底，避免 npm run day2 直接 TypeError 崩溃。
 * 文件不存在时静默跳过，缺失变量统一交给 readConfig 报错。
 */
export function loadEnv(): void {
  if (typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return;
  }

  // Node 18 兼容分支：手动解析 KEY=VALUE，支持注释、export 前缀和成对引号
  try {
    const content = readFileSync(".env", "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
      if (!match) continue;

      const key = match[1];
      if (!key) continue;

      let value = match[2] ?? "";
      const quote = value[0];
      if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
        value = value.slice(1, -1);
      }

      // 与 dotenv 行为一致：已存在的环境变量优先，不被 .env 覆盖
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

/** 读取并校验环境变量，缺失时给出中文提示并退出 */
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
 * modelProvider 固定为 "openai"：它代表“任意 OpenAI 兼容协议”，
 * 智谱 GLM / DeepSeek / Moonshot 等都复用这套协议，只靠 baseURL 区分。
 */
export async function createModel(temperature = 0) {
  const { apiKey, baseURL, model } = readConfig();

  // temperature=0 保证工具选择稳定；maxRetries 只重试可恢复错误；timeout 防止请求悬挂
  return initChatModel(model, {
    modelProvider: "openai",
    apiKey,
    configuration: { baseURL },
    temperature,
    maxRetries: 2,
    timeout: REQUEST_TIMEOUT_MS,
  });
}

/**
 * 模型实例的类型别名。
 * initChatModel 返回 ConfigurableModel 包装器，其他模块无需重复推导这串类型。
 */
export type AppModel = Awaited<ReturnType<typeof createModel>>;

/**
 * 把底层 SDK / 网络错误翻译成中文可读提示。
 * 保留 status 和 cause.code 两条线索，足以区分鉴权、模型不存在、限流和网络问题。
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
