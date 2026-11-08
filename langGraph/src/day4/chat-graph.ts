/**
 * Day 4: 可复用的对话图（START → chat → END，支持注入 checkpointer）
 *
 * 知识点：
 * - checkpointer 在 compile({ checkpointer }) 时注入，图结构本身不变
 * - 运行时通过 configurable.thread_id 区分不同会话线程
 * - messages 字段用 messagesStateReducer：节点只返回「增量」（新 AIMessage），reducer 负责追加
 * - 提示词里的 `messages: MessagesValue` 在当前版本（@langchain/langgraph 0.2.74）
 *   没有这个导出；等价写法是 z.custom<BaseMessage[]>() + withLangGraph + messagesStateReducer，
 *   与官方 MessagesZodState / MessagesAnnotation 的实现一致
 */

import { z } from "zod";
import { StateGraph, START, END, messagesStateReducer } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import type { BaseMessage } from "@langchain/core/messages";
import { initModel, extractText } from "./model.js";

// ─────────────────────────────────────────────
// 1. 状态定义
// ─────────────────────────────────────────────

/**
 * messages 是带 reducer 的字段（等价于 MessagesValue 的语义）：
 *   - 节点返回 BaseMessage[] 增量
 *   - messagesStateReducer 负责把增量追加到历史，并处理消息 id 合并
 */
const ChatState = z.object({
  messages: withLangGraph(z.custom<BaseMessage[]>(), {
    reducer: {
      fn: (left: BaseMessage[], right: BaseMessage[]): BaseMessage[] =>
        messagesStateReducer(left, right),
    },
    default: () => [],
  }),
});

type ChatStateType = z.infer<typeof ChatState>;

// ─────────────────────────────────────────────
// 2. 节点
// ─────────────────────────────────────────────

/**
 * chat 节点：把完整消息历史交给模型，只把新产生的 AIMessage 写回状态
 */
async function chat(state: ChatStateType): Promise<Partial<ChatStateType>> {
  const { model } = initModel();
  const response = await model.invoke(state.messages);
  return { messages: [response] }; // 增量，由 reducer 追加
}

// ─────────────────────────────────────────────
// 3. 图工厂：checkpointer 由调用方注入
// ─────────────────────────────────────────────

export function createChatGraph(checkpointer: BaseCheckpointSaver) {
  return new StateGraph(ChatState)
    .addNode("chat", chat)
    .addEdge(START, "chat")
    .addEdge("chat", END)
    .compile({ checkpointer });
}

/**
 * 打印一轮对话：thread_id、模型回答、当前线程里的消息条数
 */
export function printTurn(
  threadId: string,
  userText: string,
  reply: string,
  messageCount: number
): void {
  console.log(`[线程 ${threadId}] 用户: ${userText}`);
  console.log(`[线程 ${threadId}] 回答: ${reply}`);
  console.log(`[线程 ${threadId}] getState 消息条数: ${messageCount}`);
  console.log("-".repeat(60));
}

export { extractText };
