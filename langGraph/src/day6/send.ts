/**
 * Day 6-2: 用 Send 把列表动态分发成并行分支
 *
 * 知识点：
 * - Send(node, args) 不是普通边，它把一份独立输入发给指定节点，可以一次发多个
 * - 每个 Send 分支只拿到 args，拿不到完整父状态，所以 researchOne 只读 query
 * - 并行分支的结果要用 reducer 汇总，默认覆盖会丢掉先完成的分支
 * - 并行分支必须幂等：同一份输入重复执行，结果要一致
 */

import { z } from "zod";
import { StateGraph, START, END, Send } from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import { searchDocs } from "./docs.js";

const SendState = z.object({
  /** 用户给的大主题 */
  topic: z.string(),
  /** plan 拆出来的三个子问题 */
  queries: z.array(z.string()).default([]),
  /** 并行检索结果：累积并去重 */
  findings: withLangGraph(z.array(z.string()), {
    reducer: {
      fn: (left: string[], right: string[]) => Array.from(new Set([...left, ...right])),
    },
    default: () => [],
  }),
  /** 汇总后的总结 */
  summary: z.string().default(""),
});

type SendStateType = z.infer<typeof SendState>;

/** Send 只传一个 query，所以研究节点的输入类型单独定义 */
interface ResearchOneInput {
  query: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** plan：把 topic 拆成 3 个检索子问题 */
function planNode(state: SendStateType): Partial<SendStateType> {
  const queries = [
    `${state.topic} 的核心概念`,
    `${state.topic} 的执行流程`,
    `${state.topic} 的实际应用`,
  ];

  console.log(`[plan] topic="${state.topic}"，拆成 ${queries.length} 个子问题`);
  for (const query of queries) console.log(`  - ${query}`);

  return { queries };
}

/** researchOne：接收单个 query，模拟一次检索 */
async function researchOne(state: ResearchOneInput): Promise<Partial<SendStateType>> {
  const startedAt = Date.now();
  console.log(`[researchOne] ${new Date().toLocaleTimeString("zh-CN")} 开始 query="${state.query}"`);

  // 200ms 模拟网络检索，用来观察三个分支是否同时开始
  await sleep(200);

  const docs = searchDocs(state.query);
  // 只保留来源标识：三个子问题可能命中同一篇文档，方便观察 reducer 去重
  const findings = docs.map((doc) => `[${doc.id}] ${doc.title}`);

  console.log(
    `[researchOne] ${new Date().toLocaleTimeString("zh-CN")} 结束 query="${state.query}"，` +
      `命中 ${findings.length} 篇，耗时 ${Date.now() - startedAt}ms`
  );

  return { findings };
}

/** summarize：读取并行分支汇总后的 findings，生成总结 */
function summarizeNode(state: SendStateType): Partial<SendStateType> {
  const summary =
    `共并行完成 ${state.queries.length} 个检索子任务，得到 ${state.findings.length} 条去重结果：\n` +
    state.findings.map((item, index) => `${index + 1}. ${item}`).join("\n");

  return { summary };
}

/** 路由函数：把 queries 列表展开成多个 Send */
function dispatchQueries(state: SendStateType): Send[] {
  return state.queries.map((query) => new Send("researchOne", { query }));
}

const graph = new StateGraph(SendState)
  .addNode("plan", planNode)
  .addNode<"researchOne", ResearchOneInput>("researchOne", researchOne)
  .addNode("summarize", summarizeNode)
  .addEdge(START, "plan")
  // 条件边返回 Send[]：每个 query 都向 researchOne 发一份独立输入
  .addConditionalEdges("plan", dispatchQueries, ["researchOne"])
  // Send 的多个分支全部完成后，才进入 summarize（自动 fan-in）
  .addEdge("researchOne", "summarize")
  .addEdge("summarize", END)
  .compile();

async function runDemo() {
  console.log("=".repeat(60));
  console.log("Day 6-2: Send 并行分发");
  console.log("=".repeat(60));

  const topic = "LangGraph 和 RAG 怎么做研究助手";
  console.log(`\n主题：${topic}`);

  const startedAt = Date.now();
  const result = await graph.invoke({ topic });
  const total = Date.now() - startedAt;

  console.log("\n--- 汇总结果 ---");
  console.log(`queries  : ${result.queries.length} 个`);
  console.log(`findings : ${result.findings.length} 条（已去重）`);
  for (const item of result.findings) console.log(`  - ${item}`);
  console.log(`summary  :\n${result.summary}`);

  console.log("\n--- 并行证明 ---");
  console.log(`三个分支各 sleep 200ms，串行至少需要 ${3 * 200}ms`);
  console.log(`本次总耗时 ${total}ms（含图调度开销），应明显小于 ${3 * 200}ms`);

  console.log("\n" + "=".repeat(60));
  console.log("✅ Day 6 Send 演示完成");
  console.log("=".repeat(60));
}

runDemo().catch((error) => {
  console.error("运行出错：", error);
  process.exit(1);
});
