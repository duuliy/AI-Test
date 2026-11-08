/**
 * Day 10 / 任务一：用 LangSmith 观察一次 Agent 调用的完整链路。
 *
 * 关键点：
 * - Agent 只挂一个 get_current_time 工具，链路短，LangSmith 里的模型调用 / 工具调用一眼能对上；
 * - 不手动创建 tracer、不手动包 callback，只依赖 .env 里的 LANGSMITH_* 环境变量；
 * - 没有配置 key 时降级为普通运行，只在开头提示一句“跳过追踪”。
 */
import { createAgent } from "langchain";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createChatModel, describeError, isTracingEnabled, loadEnv } from "./model.js";

const DEFAULT_TIMEZONE = "Asia/Shanghai";

/**
 * 工具定义分两部分：
 * - 第一个参数是本地真正执行的函数，入参已经按 schema 校验过；
 * - 第二个参数是给模型看的元信息：name 是模型发起调用时的标识，description 决定“何时调用”，
 *   schema 会被转成 JSON Schema 随请求发给模型。
 * 工具只在本地执行，模型本身不会直接运行任何代码。
 */
const getCurrentTimeTool = tool(
  ({ timezone }) => {
    // 模型可能省略 timezone 或传空字符串，统一回落到默认时区
    const tz = timezone?.trim() || DEFAULT_TIMEZONE;

    try {
      // 显式列出每个字段，避免 dateStyle/timeStyle 与 hour12 的组合限制
      const formatter = new Intl.DateTimeFormat("zh-CN", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });

      // 工具返回值会被包装成 ToolMessage 回填给模型，所以直接返回字符串即可
      return `时区 ${tz} 的当前时间：${formatter.format(new Date())}`;
    } catch {
      // 非法时区会让 Intl 抛 RangeError；转成可读错误回填，让 Agent 循环继续而不是中断
      return `错误：无法识别的时区 "${tz}"。请使用 IANA 时区名，例如 Asia/Shanghai、America/New_York。`;
    }
  },
  {
    name: "get_current_time",
    description:
      "获取指定 IANA 时区的当前本地时间。用户询问“现在几点”“某地时间”时调用。timezone 省略时默认 Asia/Shanghai。",
    schema: z.object({
      timezone: z
        .string()
        .optional()
        .describe("IANA 时区名，例如 Asia/Shanghai、America/New_York；省略时默认 Asia/Shanghai"),
    }),
  },
);

/**
 * systemPrompt 写清三件事：语言、何时必须调用工具、如何转述工具结果。
 * 第 2 条能显著减少模型“自己编一个时间”的情况，也让 LangSmith 里的工具调用更稳定。
 */
const SYSTEM_PROMPT = `你是一个乐于助人的中文 AI 助手，请遵守以下规则：
1. 用中文回答，简洁准确。
2. 涉及实时时间时必须调用 get_current_time 工具，不要凭空编造。
3. 工具结果要转述成自然语言，不要原样粘贴。`;

/** 连续问两个问题：第二个问题带“那纽约呢”，用来观察多轮里工具参数的变化 */
const QUESTIONS = ["现在上海几点？", "那纽约呢？"];

/**
 * v1 中 content 可能是 string，也可能是 ContentBlock[]（文本、图片等混合）。
 * 这里只抽 text 块，统一成纯字符串，方便直接打印。
 */
function textOf(message: BaseMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  let text = "";
  for (const block of message.content) {
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}

/**
 * 打印追踪入口，告诉用户去哪里看本次 run。
 * - 项目名：LANGSMITH_PROJECT / LANGCHAIN_PROJECT，没有就落到 SDK 默认的 "default"；
 * - key 只显示前 4 位，避免把密钥写进终端日志。
 */
function printTracingInfo(): void {
  const project =
    process.env.LANGSMITH_PROJECT?.trim() || process.env.LANGCHAIN_PROJECT?.trim() || "default";
  const key = process.env.LANGSMITH_API_KEY?.trim() || process.env.LANGCHAIN_API_KEY?.trim() || "";

  console.log("\n=== LangSmith 追踪已开启 ===");
  console.log(`项目名：${project}`);
  console.log(`API key：${key.slice(0, 4)}****`);
  console.log("入口：https://smith.langchain.com");
  console.log("在 Projects 里查看本次 run 的模型调用和工具调用。");
}

async function main(): Promise<void> {
  // 所有环境变量都在这里一次性准备好：.env、crypto、追踪开关的一致性
  loadEnv();

  const tracing = isTracingEnabled();
  if (!tracing) {
    // loadEnv 已把“开关为 true 但缺 key”的情况关掉，这里只负责提示
    console.log("未配置 LangSmith，本次跳过追踪（示例照常运行）。");
  }

  const model = await createChatModel();

  // createAgent 内部已经封装好“模型 → 工具 → 回填 ToolMessage → 再调模型”的循环，
  // 我们只需要提供模型、工具和 systemPrompt；
  // 不手动创建 tracer：追踪由环境变量自动接管。
  const agent = createAgent({
    model,
    tools: [getCurrentTimeTool],
    systemPrompt: SYSTEM_PROMPT,
  });

  for (const [index, question] of QUESTIONS.entries()) {
    console.log(`\n=== 问题 ${index + 1}：${question} ===`);

    // 每次 invoke 都是一次独立的 Agent 运行：
    // messages 里只放本轮的用户问题，返回的 result.messages 才是完整轨迹
    // （包含 HumanMessage、若干次工具调用的 AIMessage / ToolMessage，以及最终 AIMessage）。
    const result = await agent.invoke({
      messages: [new HumanMessage(question)],
    });

    // 最后一条“没有 tool_calls”的 AIMessage 才是给用户的自然语言答复；
    // 中间那些带 tool_calls 的 AIMessage 只是模型在请求工具，不是最终答案。
    const finalAnswer = [...result.messages]
      .reverse()
      .find(
        (message): message is AIMessage =>
          AIMessage.isInstance(message) && (message.tool_calls?.length ?? 0) === 0,
      );

    console.log(`回答：${finalAnswer ? textOf(finalAnswer) : "（没有拿到自然语言回答）"}`);
  }

  // 提示放在最后，这样即使中途模型报错，也能先看到错误信息
  if (tracing) {
    printTracingInfo();
  }
}

// 顶层 await 直接跑 main；统一 catch 后把错误翻译成中文，避免抛出一大段 SDK 堆栈
try {
  await main();
} catch (error) {
  console.error(describeError(error));
  process.exit(1);
}
