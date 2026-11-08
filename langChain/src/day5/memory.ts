/**
 * Day 5 · 会话记忆：checkpointer + thread_id
 *
 * 与 Day 1 的 Map<sessionId, messages> 对比：
 *   Day 1 的多轮对话由我们自己维护一个数组，每次请求前把历史拼进 messages。
 *   Day 5 把这件事交给 LangChain 的 checkpointer：
 *   - checkpointer 在每个节点执行后，把「完整状态」（这里主要是 messages 数组）写入存储；
 *   - invoke 时传入的 thread_id 就是这份状态的唯一主键（相当于 Day 1 的 sessionId）；
 *   - 下一轮用同一个 thread_id 调用时，框架先把历史读出来，再追加新消息。
 *
 * 注意：保存的是消息历史，不是「模型记住了」。模型本身无状态，
 * 每一轮仍然是「把历史消息 + 新问题一起发给模型」。
 *
 * 执行流程：
 *   1. 初始化聊天模型和 MemorySaver；
 *   2. createAgent 时把 checkpointer 交给框架；
 *   3. 每轮 invoke 只传「本轮新消息」和 thread_id，不手动拼历史；
 *   4. 框架按 thread_id 自动读取历史、追加新消息、执行后再写回快照。
 */
import { HumanMessage, isAIMessage, type AIMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, initChatModel } from "langchain";
import { z } from "zod";

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * systemPrompt 是 Agent 的固定配置，每次调用都会注入到消息列表最前面。
 * 它不会被当成普通聊天消息存进历史，而是作为「行为约束」一直生效。
 */
const SYSTEM_PROMPT = `你是一个中文助手。
- 回答简洁、准确。
- 需要实时信息或计算时优先调用工具，不要凭空编造。
- 不知道就明确说不知道。`;

/** 加载项目根目录的 .env；文件不存在时静默跳过，缺失检查交给 readConfig */
function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

/** 读取并校验环境变量，缺失时打印可读提示并退出 */
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
 * 从 AI 消息中取出纯文本。
 * v1 的 content 有两种形态：
 * - string：普通文本回复；
 * - ContentBlock[]：多模态 / 推理模型的内容块数组，其中 type === "text" 才是正文。
 * 这里只拼接 text 块，推理过程等其它块直接忽略。
 */
function extractText(message: AIMessage): string {
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
 * 取本轮最后一条 AI 消息的文本。
 * 带工具的 Agent 一轮可能产生多条 AI 消息（先发起 tool_calls，再给出最终回答），
 * 所以从后往前找第一条 AI 消息，拿到的才是最终答复；ToolMessage 会被跳过。
 */
function lastAIText(messages: BaseMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isAIMessage(message)) {
      return extractText(message);
    }
  }
  return "（本轮没有 AI 文本）";
}

/**
 * 最小工具集（内联定义）。
 * tool() 的用法和 Day 3 一致：第一个参数是普通函数，第二个参数是 name / description / schema。
 * Day 3 / Day 4 的源码文件目前不存在，按 Day 5 提示词的兜底要求，
 * 这里内联两个最小工具，保证 Agent 有工具可调，又不额外创建文件。
 * description 会进入模型上下文，写得越清楚，模型越容易选对工具。
 *
 * 工具一：查询当前时间。
 */
const getCurrentTime = tool(
  async ({ timeZone }) => {
    // Intl.DateTimeFormat 直接按 IANA 时区格式化，不需要自己换算时差
    const formatter = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      dateStyle: "full",
      timeStyle: "long",
    });
    return `${timeZone} 当前时间：${formatter.format(new Date())}`;
  },
  {
    name: "get_current_time",
    description: "查询指定 IANA 时区的当前日期和时间，默认 Asia/Shanghai。",
    // schema 同时用于两件事：校验模型传参、生成 JSON Schema 供模型理解参数
    schema: z.object({
      timeZone: z.string().default("Asia/Shanghai").describe("IANA 时区名，例如 Asia/Shanghai"),
    }),
  },
);

/** 工具二：四则运算。只支持基础算术，不引入额外依赖 */
const calculate = tool(
  async ({ expression }) => {
    // 只允许数字和四则运算符号，避免把任意代码交给 Function 执行
    if (!/^[\d\s+\-*/().%]+$/.test(expression)) {
      return "表达式只支持数字和 + - * / ( ) %";
    }

    const value: unknown = Function(`"use strict"; return (${expression});`)();
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return "计算结果不是有限数字";
    }
    return `${expression} = ${value}`;
  },
  {
    name: "calculate",
    description: "计算一个只包含数字和 + - * / ( ) % 的算术表达式。",
    schema: z.object({
      expression: z.string().describe("算术表达式，例如 42 * 17"),
    }),
  },
);

type Turn = {
  threadId: string;
  text: string;
};

/**
 * 四轮演示，故意交叉使用两个线程：
 * - 第 1、2、4 轮共用 user-a，用来验证同一线程能记住前文；
 * - 第 3 轮切到 user-b，用来验证线程之间互相隔离。
 * 预期结果：第 2 轮答出「小明」，第 3 轮不知道，第 4 轮仍然记得。
 */
const TURNS: Turn[] = [
  // 第 1 轮：写入名字，checkpointer 会保存 Human + AI 两条消息
  { threadId: "user-a", text: "我叫小明，请记住。" },
  // 第 2 轮：同一线程追问，历史里已经有名字
  { threadId: "user-a", text: "我叫什么？" },
  // 第 3 轮：换线程，user-b 读不到 user-a 的历史
  { threadId: "user-b", text: "我叫什么？" },
  // 第 4 轮：回到 user-a，历史仍然在
  { threadId: "user-a", text: "再说一次，我叫什么？" },
];

async function main(): Promise<void> {
  loadDotEnv();
  const { apiKey, baseURL, model: modelName } = readConfig();

  let model: Awaited<ReturnType<typeof initChatModel>>;
  try {
    // initChatModel 走 OpenAI 兼容协议，baseURL 指向实际服务商（例如智谱）
    model = await initChatModel(modelName, {
      modelProvider: "openai",
      apiKey,
      configuration: { baseURL },
      temperature: 0.2,
      maxRetries: 2,
      timeout: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    console.error(`模型初始化失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  /**
   * MemorySaver 是 LangGraph 提供的内存版 checkpointer：
   * 数据只放在当前进程里，进程一退出就没了。
   * 生产环境应换成基于 SQLite / Postgres / Redis 的持久化 checkpointer。
   */
  const checkpointer = new MemorySaver();

  /**
   * createAgent 的四个关键配置：
   * - model：负责推理和生成回复的聊天模型；
   * - tools：模型可以主动调用的工具，这里是内联的最小工具集；
   * - systemPrompt：每轮注入的行为约束；
   * - checkpointer：状态持久化器。只有传了它，Agent 才会在每次执行后写快照。
   */
  const agent = createAgent({
    model,
    tools: [getCurrentTime, calculate],
    systemPrompt: SYSTEM_PROMPT,
    checkpointer,
  });

  console.log("LangChain.js Day 5 · checkpointer + thread_id");
  console.log(`模型：${modelName}`);
  console.log(`checkpointer：${checkpointer.constructor.name}（仅进程内存，重启即丢）\n`);

  for (const [index, turn] of TURNS.entries()) {
    console.log(`—— 第 ${index + 1} 轮 · thread_id=${turn.threadId} ——`);
    console.log(`用户：${turn.text}`);

    try {
      /**
       * 第一参数只传「本轮新增的用户消息」，不要手动拼历史：
       * checkpointer 会根据 thread_id 自动把该线程的历史读出来，
       * 和新消息合并后再送给模型。
       */
      const result = await agent.invoke(
        { messages: [new HumanMessage(turn.text)] },
        /**
         * 第二参数是运行配置：
         * - configurable.thread_id：会话主键，决定读写哪一份历史；
         * - signal：超时中断，避免网络异常时一直等。
         */
        {
          configurable: { thread_id: turn.threadId },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );

      console.log(`助手：${lastAIText(result.messages)}`);

      /**
       * 用 graph.getState 读取该 thread 的最新快照，确认 checkpointer 里确实存了历史。
       * snapshot.values.messages 是完整消息列表：每轮正常产生 Human + AI 两条，
       * 所以 user-a 的消息数会依次是 2 → 4 → 6；
       * user-b 是独立线程，从 0 开始，所以第 3 轮只有 2 条。
       */
      const snapshot = await agent.graph.getState({
        configurable: { thread_id: turn.threadId },
      });
      const messageCount = Array.isArray(snapshot.values.messages) ? snapshot.values.messages.length : 0;
      console.log(`当前线程消息数：${messageCount}\n`);
    } catch (error) {
      console.error(`调用失败：${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  console.log("演示结束。同一个 thread_id 共享历史，不同 thread_id 互相隔离；进程重启后记忆全部丢失。");
}

await main();
