/**
 * 子项目内的环境配置与模型初始化（不依赖 src/day* 或 src/shared）。
 */

import { ChatOpenAI } from "@langchain/openai";
import type { BaseMessage } from "@langchain/core/messages";

export interface AppConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** 加载子项目根目录的 .env（Node 22 内置） */
export function loadEnv(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    // ENOENT 表示 .env 不存在，允许继续用本地规则兜底
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/** 读取 OPENAI_* 配置；缺少任意一项时返回 null，由调用方降级 */
export function readConfig(): AppConfig | null {
  loadEnv();

  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL;
  const model = process.env.OPENAI_MODEL;

  if (!apiKey || !baseUrl || !model) return null;
  return { apiKey, baseUrl, model };
}

/** 尝试创建模型；未配置环境变量时返回 null */
export function tryCreateModel(): ChatOpenAI | null {
  const config = readConfig();
  if (!config) return null;

  return new ChatOpenAI({
    model: config.model,
    temperature: 0.2,
    timeout: 60_000,
    maxRetries: 0,
    // 当前使用的 GLM 模型始终会思考；降低思考强度可以明显加快响应
    modelKwargs: { reasoning_effort: "low" },
    configuration: {
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    },
  });
}

/** 提取消息中的纯文本，兼容 content 为字符串或内容块数组 */
export function extractText(message: BaseMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
  return "";
}

/** 把常见错误翻译成中文，便于定位配置问题 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message;
    if (/401|403/.test(msg)) return `认证失败（${msg}）：请检查 OPENAI_API_KEY`;
    if (/404/.test(msg)) return `模型不存在（${msg}）：请检查 OPENAI_MODEL 和 OPENAI_BASE_URL`;
    if (/429/.test(msg)) return `请求过于频繁（${msg}）：请稍后再试`;
    if (/5\d{2}/.test(msg)) return `服务端错误（${msg}）：上游服务暂时不可用`;
    if (/ECONNREFUSED/.test(msg)) return `连接被拒绝（${msg}）：请检查 OPENAI_BASE_URL`;
    if (/timeout|ETIMEDOUT/i.test(msg)) return `连接超时（${msg}）：网络不通或响应太慢`;
    return msg;
  }
  return String(error);
}
