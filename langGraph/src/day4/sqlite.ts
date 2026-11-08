/**
 * Day 4: SqliteSaver 跨进程持久化
 *
 * 知识点：
 * - SqliteSaver 把 checkpoint 链写到本地 SQLite 文件，进程退出后仍在
 * - 两个独立进程用同一个 thread_id + 同一个数据库文件，就能接上同一段历史
 *
 * 用法：
 *   npm run day4:sqlite -- --phase=write   # 第 1 个进程：告诉名字，然后退出
 *   npm run day4:sqlite -- --phase=ask     # 第 2 个进程：只问名字，应该答得出
 *
 * 数据库文件 src/day4/checkpoints.db 可随时删除重建。
 */

import { HumanMessage } from "@langchain/core/messages";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";
import { createChatGraph, printTurn, extractText } from "./chat-graph.js";
import { loadEnv, describeError } from "./model.js";

/** 数据库文件路径：相对本文件解析，不依赖进程启动目录 */
const DB_PATH = fileURLToPath(new URL("./checkpoints.db", import.meta.url));

/**
 * 解析 --phase=write|ask，默认 write
 */
function parsePhase(): "write" | "ask" {
  const arg = process.argv.find((a) => a.startsWith("--phase="));
  const value = arg?.slice("--phase=".length);
  if (value === undefined || value === "write") return "write";
  if (value === "ask") return "ask";
  throw new Error(`未知 --phase=${value}，只支持 write | ask`);
}

async function main() {
  loadEnv();
  const phase = parsePhase();

  // SqliteSaver.fromConnString：传本地文件路径，不存在则自动创建
  const checkpointer = SqliteSaver.fromConnString(DB_PATH);
  const graph = createChatGraph(checkpointer);
  const threadConfig = { configurable: { thread_id: "persist-demo" } };

  console.log("=".repeat(60));
  console.log(`Day 4: SqliteSaver 跨进程持久化（phase=${phase}）`);
  console.log("=".repeat(60));

  if (phase === "write") {
    // 第 1 个进程：告诉名字，写完 checkpoint 后进程直接结束
    const result = await graph.invoke(
      { messages: [new HumanMessage("我叫小明")] },
      threadConfig
    );
    const snapshot = await graph.getState(threadConfig);
    printTurn("persist-demo", "我叫小明", extractText(result.messages[result.messages.length - 1]), snapshot.values.messages.length);
  } else {
    // 第 2 个进程（全新进程）：同一个 thread_id，从磁盘上的 checkpoint 链接续
    const result = await graph.invoke(
      { messages: [new HumanMessage("我叫什么？")] },
      threadConfig
    );
    const snapshot = await graph.getState(threadConfig);
    printTurn("persist-demo", "我叫什么？", extractText(result.messages[result.messages.length - 1]), snapshot.values.messages.length);
  }

  // 关闭数据库连接后再看文件大小（better-sqlite3 同步写，事务提交即落盘）
  checkpointer.db.close();

  const { size } = statSync(DB_PATH);
  console.log(`\n数据库文件: ${DB_PATH}（${size} 字节）`);
  console.log("提示：该文件可随时删除重建；删掉后重跑 --phase=write 即可重新开始。");
}

main().catch((err) => {
  console.error("运行出错：", describeError(err));
  process.exit(1);
});
