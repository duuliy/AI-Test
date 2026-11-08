/**
 * Day 9 · Agent 层（逐行注释版）
 *
 * 和根项目 Day 4 / Day 5 的写法一致：
 *   - initChatModel 走 OpenAI 兼容协议（baseURL 指向智谱等平台）
 *   - createAgent + MemorySaver，用 thread_id 区分会话
 *
 * 唯一的区别是「懒加载单例」：
 * 不在模块加载时读 env / 建 Agent，避免 `next build` 因缺少 .env.local 直接失败。
 */
import { tool } from "@langchain/core/tools"; // 工具构造器：把普通 async 函数包装成模型可调用的 tool
import { MemorySaver } from "@langchain/langgraph"; // 内存版 checkpointer：按 thread_id 保存消息历史
import { createAgent, initChatModel } from "langchain"; // Agent 工厂函数 + 模型工厂函数
import { z } from "zod"; // 用 zod 定义工具参数的运行时 schema
import { readConfig, REQUEST_TIMEOUT_MS } from "./env"; // 读取环境变量 + 单次模型请求的超时时间

/**
 * systemPrompt 写清楚「什么时候必须调用工具」。
 * 模型本身不知道当前时间，提示词里不强制要求，它很容易直接编一个时间出来。
 */
const SYSTEM_PROMPT = `你是一个中文助手。
- 用中文回答，简洁、准确。
- 用户询问时间、日期等实时信息时，必须调用 get_current_time 工具，不要凭空编造。
- 不知道就明确说不知道。`;

/**
 * 工具：查询指定 IANA 时区的当前时间。
 * 用 Intl.DateTimeFormat 而不是手拼字符串，能自动处理夏令时和当地格式。
 */
const getCurrentTime = tool(
  async ({ timezone }) => { // 模型调用工具时传入的参数；已被 schema 校验并补好默认值
    const formatter = new Intl.DateTimeFormat("zh-CN", { // 创建「中文格式」的日期时间格式化器
      timeZone: timezone, // 用模型传入的 IANA 时区，例如 Asia/Shanghai
      dateStyle: "full", // 日期部分：完整格式（年月日 + 星期）
      timeStyle: "long", // 时间部分：时:分:秒 + 时区名
    });
    return `${timezone} 当前时间：${formatter.format(new Date())}`; // 返回值会成为 ToolMessage 回给模型
  }, // 执行函数结束
  { // 下面是工具的元数据，会随工具定义一起发给模型
    name: "get_current_time", // 工具名：模型在 tool_calls 里靠它定位要调用哪个工具
    description: "查询指定 IANA 时区的当前日期和时间。用户问现在几点、今天几号时必须调用。", // 给模型看的说明，决定它愿不愿调用
    schema: z.object({ // 参数的运行时 schema：模型传错类型时这里会拦住
      timezone: z.string().default("Asia/Shanghai").describe("IANA 时区名，例如 Asia/Shanghai"), // 字符串参数 + 默认值 + 给模型的描述
    }),
  },
);

/** createAgent 的返回类型，其他模块无需重复推导这串复杂类型 */
type AppAgent = ReturnType<typeof createAgent>;

/** 真正创建 Agent；只有 getAgent() 第一次被调用时才会执行到这里 */
async function buildAgent(): Promise<AppAgent> {
  const { apiKey, baseURL, model: modelName } = readConfig(); // 缺变量时这里抛中文错误，route handler 会捕获

  // modelProvider 固定 "openai"：代表任意 OpenAI 兼容协议，
  // 智谱 GLM / DeepSeek / Moonshot 都复用这套协议，只靠 baseURL 区分平台。
  const model = await initChatModel(modelName, { // 按模型名创建 chat model 实例（异步）
    modelProvider: "openai", // 使用 OpenAI 兼容协议
    apiKey, // 平台 API Key
    configuration: { baseURL }, // 平台接口地址，例如智谱的 v4 地址
    temperature: 0.2, // 低温度：回答更稳定，减少随机发挥
    maxRetries: 2, // 网络抖动 / 限流时最多自动重试 2 次
    timeout: REQUEST_TIMEOUT_MS, // 单次模型请求超时时间
  });

  // MemorySaver 只存在进程内存：dev 模式下热更新可能重建模块，会话随之清空。
  // 生产环境应换成 SQLite / Postgres / Redis 之类的持久化 checkpointer。
  const checkpointer = new MemorySaver();

  // Agent 只创建一次，所有请求共享同一个 checkpointer；
  // 不同会话靠每次请求传入的 thread_id 区分，而不是靠多个 Agent 实例。
  return createAgent({ // 组装 Agent：模型 + 工具 + 系统提示词 + 记忆
    model, // 上面创建的 chat model
    tools: [getCurrentTime], // 工具数组，以后可以继续追加
    systemPrompt: SYSTEM_PROMPT, // Agent 的人设 / 行为约束
    checkpointer, // 会话记忆存储
  });
}

/**
 * 缓存的是 Promise 而不是 Agent 本身：
 * 并发请求同时进来时也只会创建一次，避免重复初始化模型和 checkpointer。
 */
let agentPromise: Promise<AppAgent> | undefined;

/** 懒加载单例：第一次请求时才创建 Agent，创建失败则清掉缓存，修好 env 后可直接重试 */
export function getAgent(): Promise<AppAgent> {
  if (!agentPromise) { // 第一次调用时缓存还是空的
    agentPromise = buildAgent(); // 立即开始创建，并把 Promise 存起来
    // 初始化失败（例如缺少 env）时清掉缓存，
    // 否则这个 rejected Promise 会被一直复用，修好配置也必须重启进程。
    agentPromise.catch(() => { // 注意：这里只是挂一个清理回调，不吞掉调用方拿到的错误
      agentPromise = undefined; // 允许下一次请求重新尝试创建
    });
  }
  return agentPromise; // 所有调用方复用同一个 Promise，也就复用同一个 Agent
}

/**
 * 从流式分片中取出文本。
 *
 * v1 的 content 有两种形状：
 *   - 简单文本：直接是 string，可以直接吐给前端；
 *   - 多模态 / 带元信息：ContentBlock[]，要过滤出 type === "text" 的块再拼接，
 *     tool_use、reasoning 等其它类型的块不能当正文显示。
 *
 * 参数用 unknown 而不是具体消息类型，是因为 route handler 只关心 "content" 字段，
 * 不依赖分片到底是 AIMessageChunk 还是别的消息子类。
 */
export function extractText(chunk: unknown): string {
  if (!chunk || typeof chunk !== "object" || !("content" in chunk)) { // 不是消息对象：没有正文
    return ""; // 返回空串，调用方会跳过
  }

  const content = (chunk as { content?: unknown }).content; // 取出 content 字段，类型仍是 unknown
  if (typeof content === "string") { // 形状 1：纯字符串，最常见
    return content; // 直接返回
  }
  if (!Array.isArray(content)) { // 形状 3：null / 数字 / 普通对象等，没有可展示文本
    return ""; // 返回空串
  }

  let text = ""; // 累加器：把所有 text 块拼成一个字符串
  for (const block of content as Array<{ type?: unknown; text?: unknown }>) { // 形状 2：遍历 ContentBlock[]
    if (block.type === "text" && typeof block.text === "string") { // 只处理 text 块，且 text 必须是字符串
      text += block.text; // 追加这段文本
    }
  }
  return text; // 返回拼好的正文
}
