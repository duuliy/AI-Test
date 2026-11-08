/**
 * Day 3 · 手动 Tool Calling 循环：
 * invoke → tool_calls → 本地执行 → 回填 ToolMessage → 再 invoke，
 * 直到模型不再返回 tool_calls。这里刻意不用 createAgent，保留协议细节。
 */
import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type AIMessageChunk,
  type BaseMessage,
  type ToolCall,
} from "@langchain/core/messages";
import { createModel, describeError, loadEnv } from "../shared/model.js";
import { findTool, tools } from "./tools.js";

const SYSTEM_PROMPT =
  "你是一个可以使用工具的中文助手。遇到时间、算术或 LangChain 概念问题时，必须先调用合适的工具，不要凭记忆编造。工具返回错误时，如实向用户说明错误原因。";

// 安全阀：防止模型反复调用失败工具导致死循环
const MAX_ROUNDS = 5;

// 覆盖单工具、检索、同轮多工具三种路径
const DEFAULT_QUESTIONS = [
  "现在上海几点？",
  "帮我算 37 * 19",
  "checkpointer 是什么？",
  "现在北京时间几点？再帮我算 128 / 4",
];

/** bindTools 之后的模型类型；单独起别名，避免在函数签名里展开一长串泛型 */
type ToolCallingModel = ReturnType<Awaited<ReturnType<typeof createModel>>["bindTools"]>;

// content 可能是 string 或 ContentBlock[]；只取 text 块，忽略 reasoning
function extractText(message: AIMessageChunk): string {
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
 * 回填 ToolMessage 的三个不变量：
 * tool_call_id 必须与 call.id 一致；每个 tool_call 都必须有响应；错误也要回填而不是抛出。
 */
async function executeToolCall(call: ToolCall, round: number, index: number): Promise<ToolMessage> {
  // 兜底 id 无法与模型原始调用配对，只用于让流程不崩；正常不应走到这里
  const toolCallId = call.id ?? `call_round${round}_${index}`;
  console.log(`[tool call] 第 ${round} 轮 · ${call.name}(${JSON.stringify(call.args)}) · id=${toolCallId}`);

  const selectedTool = findTool(call.name);
  if (!selectedTool) {
    const content = `错误：未知工具 "${call.name}"。可用工具：${tools.map((item) => item.name).join(", ")}`;
    console.log(`[tool result] ${content}`);
    return new ToolMessage({
      content,
      tool_call_id: toolCallId,
      name: call.name,
      status: "error",
    });
  }

  try {
    // 这里才真正执行本地代码；call.args 会先经过工具的 Zod schema 校验
    const output: unknown = await selectedTool.invoke(call.args);
    // ToolMessage.content 只接受字符串，非字符串输出需要序列化
    const content = typeof output === "string" ? output : JSON.stringify(output);
    console.log(`[tool result] ${content}`);
    return new ToolMessage({
      content,
      tool_call_id: toolCallId,
      name: call.name,
      status: "success",
    });
  } catch (error) {
    // 参数校验失败、工具内部异常都在这里转成错误文本，让模型有机会重试或解释
    const content = `工具执行失败：${error instanceof Error ? error.message : String(error)}`;
    console.log(`[tool result] ${content}`);
    return new ToolMessage({
      content,
      tool_call_id: toolCallId,
      name: call.name,
      status: "error",
    });
  }
}

/**
 * messages 是本次对话的完整记录：System → Human → AI(tool_calls) → ToolMessage → … → AI。
 * 顺序不能反；每个问题独立，不带历史（记忆是 Day 5 的事）。
 */
async function ask(model: ToolCallingModel, question: string): Promise<void> {
  console.log(`\n${"=".repeat(64)}`);
  console.log(`问题：${question}`);
  console.log("=".repeat(64));

  const messages: BaseMessage[] = [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(question)];
  let finalAnswer: string | null = null;

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    console.log(`[round] 第 ${round} 轮：调用模型`);

    // 每轮都发送当前完整的 messages
    let ai: AIMessageChunk;
    try {
      ai = await model.invoke(messages);
    } catch (error) {
      console.log(`[error] ${describeError(error)}`);
      return;
    }
    // 先把 AI 回复放进历史，再追加工具结果，顺序不能反
    messages.push(ai);

    // 没有 tool_calls 说明模型已经给出最终回答；有的话，可能是单个，也可能是同轮并行多个
    const toolCalls = ai.tool_calls ?? [];
    if (toolCalls.length === 0) {
      finalAnswer = extractText(ai);
      break;
    }

    // 同一轮里的每个 tool_call 都必须有一条 ToolMessage 响应，缺一条都会被服务端判为不合法
    for (const [index, call] of toolCalls.entries()) {
      messages.push(await executeToolCall(call, round, index));
    }

    if (round === MAX_ROUNDS) {
      console.warn(`[warn] 已达到 ${MAX_ROUNDS} 轮上限，模型仍在请求工具，停止循环以避免死循环。`);
    }
  }

  if (finalAnswer !== null) {
    console.log(`\n最终回答：\n${finalAnswer.trim() || "（模型没有返回文本内容）"}`);
  } else {
    console.warn("[warn] 没有得到最终回答。");
  }
}

/**
 * 入口：加载 .env → 创建模型 → 绑定工具 → 逐个问题执行。
 */
async function main(): Promise<void> {
  loadEnv();
  const model = await createModel(0);

  console.log("LangChain.js Day 3 · 手动 Tool Calling");
  console.log(`模型：${process.env.OPENAI_MODEL ?? "未知"}`);
  console.log(`工具：${tools.map((item) => item.name).join(", ")}`);

  // bindTools 只附加工具定义，不执行工具，也不自动循环
  const modelWithTools = model.bindTools(tools);

  // 支持 `npm run day3 -- "自定义问题"`；未传参数时跑默认的 4 个问题
  const customQuestion = process.argv.slice(2).join(" ").trim();
  const questions = customQuestion ? [customQuestion] : DEFAULT_QUESTIONS;

  for (const question of questions) {
    await ask(modelWithTools, question);
  }

  console.log("\n全部演示结束。");
}

await main();
