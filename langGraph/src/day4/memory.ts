/**
 * Day 4: MemorySaver 线程隔离
 *
 * 知识点：
 * - MemorySaver 是纯内存 checkpointer：快照存在进程内存里，进程退出即全部丢失
 *   （这就是它「重启丢失」的原因——没有任何磁盘持久化）
 * - thread_id 是隔离单位：同一个图实例 + 同一个 MemorySaver，
 *   不同 thread_id 各有独立的 checkpoint 链，互不可见
 * - getState(config) 返回 StateSnapshot：values 是该线程当前完整状态
 */

import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createChatGraph, printTurn, extractText } from "./chat-graph.js";
import { loadEnv, describeError } from "./model.js";

async function main() {
  loadEnv();

  // 同一个图实例、同一个 MemorySaver —— 隔离完全靠 thread_id
  const checkpointer = new MemorySaver();
  const graph = createChatGraph(checkpointer);

  /**
   * 跑一轮对话并打印：thread_id、回答、getState 里的消息条数
   */
  async function turn(threadId: string, text: string): Promise<void> {
    const result = await graph.invoke(
      { messages: [new HumanMessage(text)] },
      { configurable: { thread_id: threadId } }
    );
    const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
    const reply = extractText(result.messages[result.messages.length - 1]);
    printTurn(threadId, text, reply, snapshot.values.messages.length);
  }

  console.log("=".repeat(60));
  console.log("Day 4: MemorySaver 线程隔离");
  console.log("=".repeat(60));

  // 期望：A 记得、B 不知道、A 仍记得
  await turn("A", "我叫小明"); // A 第一轮：告诉名字
  await turn("B", "我叫什么？"); // B 第一轮：线程 B 没有任何历史
  await turn("A", "我叫什么？"); // A 第二轮：历史累积（4 条消息）

  console.log("\n说明：MemorySaver 快照只在本进程内存中，进程退出后全部丢失。");
}

main().catch((err) => {
  console.error("运行出错：", describeError(err));
  process.exit(1);
});
