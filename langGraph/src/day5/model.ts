/**
 * Day 5: 环境配置与模型初始化（独立复制自 Day 1）
 */

import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";

/**
 * 加载 .env 文件（Node 22 内置）
 * .env 不存在时忽略 ENOENT，其他错误抛出
 */
export function loadEnv(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    // ENOENT = .env 文件不存在，忽略
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

/**
 * 从环境变量读取配置
 * 缺失时 throw Error（由调用方决定是否 exit 或降级）
 */
export interface AppConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function readConfig(): AppConfig {
  const missing: string[] = [];
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL;
  const model = process.env.OPENAI_MODEL;

  if (!apiKey) missing.push("OPENAI_API_KEY");
  if (!baseUrl) missing.push("OPENAI_BASE_URL");
  if (!model) missing.push("OPENAI_MODEL");

  if (missing.length > 0) {
    throw new Error(
      `缺少环境变量: ${missing.join(", ")}\n请在项目根目录创建 .env 文件（参考 .env.example）`
    );
  }

  return { apiKey: apiKey!, baseUrl: baseUrl!, model: model! };
}

/**
 * 创建 chat model 实例
 */
export function createChatModel(config: AppConfig): BaseChatModel {
  return new ChatOpenAI({
    model: config.model,
    temperature: 0.2,
    configuration: {
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    },
  });
}

/**
 * 把常见错误翻译成中文
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message;
    // HTTP 状态码
    if (/401|403/.test(msg)) return `认证失败（${msg}）：请检查 API Key 是否正确`;
    if (/404/.test(msg)) return `模型不存在（${msg}）：请检查 OPENAI_MODEL 和 OPENAI_BASE_URL`;
    if (/429/.test(msg)) return `请求过于频繁（${msg}）：已触发限流，请稍后再试`;
    if (/5\d{2}/.test(msg)) return `服务端错误（${msg}）：上游服务暂时不可用`;
    // 网络错误
    if (/getaddrinfo|DNS/i.test(msg)) return `DNS 解析失败：无法连接到 ${extractHostFromUrl(process.env.OPENAI_BASE_URL ?? "")}`;
    if (/ECONNREFUSED/.test(msg)) return `连接被拒绝：${extractHostFromUrl(process.env.OPENAI_BASE_URL ?? "")} 没有在监听`;
    if (/timeout|ETIMEDOUT/.test(msg)) return `连接超时：网络不通或目标服务响应太慢`;
    return msg;
  }
  return String(error);
}

function extractHostFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * 提取 message 中的纯文本内容
 * 兼容 content 为 string 或 ContentBlock[]（多模态）
 */
export function extractText(message: BaseMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  // ContentBlock[] 类型：只取 type === "text" 的块
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
  return "";
}

/**
 * 一次性便捷初始化（组合 loadEnv + readConfig + createChatModel）
 */
export function initModel(): { config: AppConfig; model: BaseChatModel } {
  loadEnv();
  const config = readConfig();
  const model = createChatModel(config);
  return { config, model };
}
