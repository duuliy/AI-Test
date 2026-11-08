/**
 * Day 2: 并行分支与 reducer 合并演示
 *
 * 图结构：
 *        ┌─ left  ─┐
 * START ─┤         ├─ join ─ END
 *        └─ right ─┘
 *
 * 注意：本地 @langchain/langgraph 是 0.2.x，`addEdge(START, ["left", "right"])`
 * 不支持「起点是 START、终点是数组」的写法（只有「起点是数组」才会被处理）。
 * 所以并行扇出写成两条 START 边，汇聚写成 addEdge(["left", "right"], "join")。
 */

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  END,
  START,
  StateGraph,
  type BaseCheckpointSaver,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { pathToFileURL } from "node:url";
import {
  Day2StateSchema,
  type Day2State,
  type Day2Update,
} from "./state.js";

/**
 * 关于普通字段的一个真实限制：
 * 同一个超步里两个并行节点都写同一个 LastValue 字段，LangGraph 会抛
 * InvalidUpdateError（LastValue can only receive one value per step），
 * 而不是“后写覆盖先写”。LastValue 的覆盖只成立于不同超步之间。
 *
 * 所以这里让 left 先写 plainMessages，再由下一个超步的 join 覆盖它，
 * 才能真正看到“后写覆盖先写”；messages 之所以能被两个并行分支同时写，
 * 正是因为它是 reducer 字段。
 */
const LEFT_PLAIN_MESSAGE = "left 写入的普通字段值";
const JOIN_PLAIN_MESSAGE = "join 最后写入，覆盖掉了 left 的值";

/** 未传 configurable.userId 时的回落值 */
const DEFAULT_USER_ID = "anonymous";

// ─────────────────────────────────────────────
// 1. 节点：每个节点只返回自己负责的「部分更新」
// ─────────────────────────────────────────────

/**
 * 左分支：
 * - messages 写入 HumanMessage（reducer 追加）
 * - plainMessages 写入普通字段值（会被后续超步的 join 覆盖）
 * - findings 写入自己的发现（reducer 去重）
 * - steps 写入单个步骤（reducer 累积）
 * - score 给 20（比右分支大，用来验证取最大值而不是取最后写入）
 */
function leftNode(_state: Day2State): Partial<Day2Update> {
  return {
    messages: [new HumanMessage("left：我是 HumanMessage")],
    plainMessages: [LEFT_PLAIN_MESSAGE],
    findings: "left 发现了 A",
    steps: "left",
    score: 20,
  };
}

/**
 * 右分支：
 * - messages 写入 AIMessage（reducer 追加）
 * - 不写 plainMessages：与 left 同一超步写 LastValue 会报错，原因见上方注释
 * - findings 写入不同的发现
 * - score 给 10（比左分支小）
 */
function rightNode(_state: Day2State): Partial<Day2Update> {
  return {
    messages: [new AIMessage("right：我是 AIMessage")],
    findings: "right 发现了 B",
    steps: "right",
    score: 10,
  };
}

/**
 * 汇聚节点：
 * - steps 再追加一个 "join"
 * - 覆盖 plainMessages，演示普通字段的后写覆盖
 * - 演示 configurable 传参：从 runtime 读 userId
 * - 没传时回落到 "anonymous"
 *   （0.2.x 的 LastValue 通道不会初始化 zod 的 default，所以回落写在节点里）
 */
function joinNode(
  _state: Day2State,
  runtime: LangGraphRunnableConfig
): Partial<Day2Update> {
  console.log("  [join] 执行（汇聚节点在本图只应出现一次）");

  const configuredUserId = runtime.configurable?.userId;
  const userId =
    typeof configuredUserId === "string" && configuredUserId.length > 0
      ? configuredUserId
      : DEFAULT_USER_ID;

  return {
    steps: "join",
    plainMessages: [JOIN_PLAIN_MESSAGE],
    userId,
  };
}

// ─────────────────────────────────────────────
// 2. 组装图
// ─────────────────────────────────────────────

/**
 * 创建并编译图。
 * update-state.ts 传入 checkpointer 复用同一张图；本文件演示时不传。
 */
export function createGraph(checkpointer?: BaseCheckpointSaver) {
  const builder = new StateGraph(Day2StateSchema)
    .addNode("left", leftNode)
    .addNode("right", rightNode)
    .addNode("join", joinNode)
    // 并行扇出：START 同时指向 left 和 right
    .addEdge(START, "left")
    .addEdge(START, "right")
    // 汇聚：left 和 right 都完成后才执行 join
    .addEdge(["left", "right"], "join")
    .addEdge("join", END);

  return checkpointer ? builder.compile({ checkpointer }) : builder.compile();
}

// ─────────────────────────────────────────────
// 3. 演示
// ─────────────────────────────────────────────

/** 打印完整状态，便于一眼看出 reducer 字段和普通字段的差异 */
function printState(title: string, state: Day2State): void {
  console.log(`\n--- ${title} ---`);
  console.log(`userId:        ${state.userId}`);
  console.log(
    `messages:      ${state.messages.length} 条 → [${state.messages
      .map((message) => `${message.getType()}(${String(message.content)})`)
      .join(", ")}]`
  );
  console.log(
    `plainMessages: ${state.plainMessages.length} 条 → [${state.plainMessages.join(", ")}]`
  );
  console.log(`steps:         [${state.steps.join(" → ")}]`);
  console.log(`findings:      [${state.findings.join(", ")}]`);
  console.log(`score:         ${state.score}`);
}

async function runDemo(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Day 2: 状态设计与 Reducer");
  console.log("=".repeat(60));

  const graph = createGraph();

  // ① 传 configurable：join 节点从 runtime.configurable 读取 userId
  const configured = await graph.invoke(
    {},
    { configurable: { userId: "user-42" } }
  );
  printState("传入 configurable: { userId: 'user-42' }", configured);

  // ② 不传 configurable：join 不写 userId，回落到 schema 默认值
  const defaulted = await graph.invoke({});
  printState("不传 configurable（回落到默认值）", defaulted);

  // ③ 把关键对比结论打印出来
  console.log("\n--- 结论 ---");
  console.log(
    `messages 与 plainMessages 对比：messages 保留 ${configured.messages.length} 条（reducer 追加），` +
      `plainMessages 只剩 ${configured.plainMessages.length} 条，值为「${configured.plainMessages[0]}」` +
      `（普通字段被后写的 join 覆盖）`
  );
  console.log(
    `score = ${configured.score}（left 写入 20、right 写入 10，取最大值而不是最后写入的值 10）`
  );
  console.log(
    `steps = [${configured.steps.join(" → ")}]（两个分支 + join 都追加进来了）`
  );
  console.log(
    `findings = [${configured.findings.join(", ")}]（两条不同的发现都在，去重规则已生效）`
  );
}

/** 只有直接执行 `tsx src/day2/reducers.ts` 时才跑演示，被 import 时不跑 */
function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(entry).href === import.meta.url;
}

if (isDirectInvocation()) {
  runDemo().catch((error) => {
    console.error("运行出错：", error);
    process.exit(1);
  });
}
