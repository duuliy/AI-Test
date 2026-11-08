/**
 * Day 2: updateState 手动改状态
 *
 * 说明：
 * - updateState 不运行图，而是直接往某个线程的 checkpoint 里写一次「状态更新」，
 *   更新同样会经过字段的 reducer（score 取最大值、steps 追加）。
 * - 这里只是借用 MemorySaver 让 updateState 有线程可写。
 *   checkpointer 的细节（快照机制、持久化、thread_id 隔离、时间旅行）是 Day 4 的内容，
 *   今天不做线程隔离，也不持久化。
 */

import {
  MemorySaver,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { createGraph } from "./reducers.js";

async function main(): Promise<void> {
  // MemorySaver 只把 checkpoint 存在当前进程内存里，进程退出即丢
  const checkpointer = new MemorySaver();
  const graph = createGraph(checkpointer);

  const config: LangGraphRunnableConfig = {
    configurable: { thread_id: "day2" },
  };

  console.log("=".repeat(60));
  console.log("Day 2: updateState 演示");
  console.log("=".repeat(60));

  // 先正常跑一遍图，生成 thread_id="day2" 的 checkpoint
  const before = await graph.invoke({}, config);
  console.log("\n--- updateState 之前 ---");
  console.log(`score: ${before.score}`);
  console.log(`steps: [${before.steps.join(" → ")}]`);

  // 直接改状态：不跑 leftNode，而是以 "left" 节点的身份写入一次更新
  // score 经过 Math.max → 99；steps 经过 append → 末尾多一个 "manual"
  await graph.updateState(
    config,
    { score: 99, steps: "manual" },
    "left"
  );

  // getState 读取当前线程的最新状态快照
  const snapshot = await graph.getState(config);
  const values = snapshot.values as typeof before;

  console.log("\n--- updateState 之后（getState）---");
  console.log(`score: ${values.score}（已从 ${before.score} 改成 99）`);
  console.log(`steps: [${values.steps.join(" → ")}]（manual 是通过 reducer 追加的）`);
}

main().catch((error) => {
  console.error("运行出错：", error);
  process.exit(1);
});
