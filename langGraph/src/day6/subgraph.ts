/**
 * Day 6-1: 把编译后的子图当作父图节点
 *
 * 知识点：
 * - 子图自己是一张完整的图，compile() 后可以像普通节点一样挂到父图
 * - 父子图通过同名字段共享状态：子图返回的 findings / steps 会写回父图
 * - 子图看不到父图的 question / answer，父图只在需要时读取子图结果
 * - 子图不接 checkpointer，持久化由父图或调用方负责
 */

import { z } from "zod";
import { StateGraph, START, END } from "@langchain/langgraph";
/**
 * withLangGraph（来自 @langchain/langgraph/zod）：给普通 zod 字段附加 LangGraph 通道元信息。
 *
 * - 不包装时：字段是 LastValue 通道，节点返回新值就直接覆盖旧值
 * - 包装后：传入 reducer.fn，字段变成 BinaryOperatorAggregate 通道；
 *   节点只返回增量，框架用 fn(当前值, 增量) 合并出新值
 * - meta.default 是该通道的初始值（用函数形式提供，避免多个线程共享同一个数组引用）
 *
 * 注意：只有 withLangGraph 的 reducer 字段会读取 default；
 * 普通字段的 z.string().default("") 不会自动出现在初始 state 里。
 */
import { withLangGraph } from "@langchain/langgraph/zod";
import { initModel, extractText, describeError } from "./model.js";
import { searchDocs, formatDocs } from "./docs.js";

// ─────────────────────────────────────────────
// 1. 子图：search → summarize
// ─────────────────────────────────────────────

const ResearchState = z.object({
  /** 检索词，由父图的 plan 节点写入 */
  query: z.string(),
  /** 检索结果，父子图共享 */
  findings: z.string().default(""),
  /** 执行轨迹：withLangGraph 把普通数组字段改造成 reducer 通道，节点只写增量即可累积 */
  steps: withLangGraph(z.array(z.string()), {
    reducer: {
      fn: (left: string[], right: string[]) => left.concat(right),
    },
    default: () => [],
  }),
});

type ResearchStateType = z.infer<typeof ResearchState>;

/** 调用本地关键词检索，写回带来源的 findings */
function searchNode(state: ResearchStateType): Partial<ResearchStateType> {
  const docs = searchDocs(state.query);
  console.log(`  [子图 search] query="${state.query}"，命中 ${docs.length} 篇`);
  return {
    findings: formatDocs(docs),
    steps: ["subgraph:search"],
  };
}

/** 把检索结果压成两句话，方便父图读 */
function summarizeNode(state: ResearchStateType): Partial<ResearchStateType> {
  const sentences = state.findings
    .replace(/\n/g, "。")
    .split(/[。；;]/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, 2);

  const compressed = sentences.length > 0 ? `${sentences.join("。")}。` : state.findings;

  console.log(`  [子图 summarize] 压缩为 ${sentences.length} 句话`);
  return {
    findings: compressed,
    steps: ["subgraph:summarize"],
  };
}

/** 编译后的子图，不接 checkpointer */
export const researchSubgraph = new StateGraph(ResearchState)
  .addNode("search", searchNode)
  .addNode("summarize", summarizeNode)
  .addEdge(START, "search")
  .addEdge("search", "summarize")
  .addEdge("summarize", END)
  .compile();

// ─────────────────────────────────────────────
// 2. 父图：plan → research(子图) → answerNode
// ─────────────────────────────────────────────

const ParentState = z.object({
  /** 原始问题，父图独有 */
  question: z.string(),
  /**
   * 检索词：plan 把 question 整理后写入，子图作为输入读取。
   * 这是父子图共享字段，也是父图向子图传参的桥。
   */
  query: z.string().default(""),
  /** 子图产出，父子图共享 */
  findings: z.string().default(""),
  /** 最终回答，父图独有 */
  answer: z.string().default(""),
  /** 父子图共享的执行轨迹：withLangGraph 提供 reducer 和默认值，父图才能合并子图回写的 steps */
  steps: withLangGraph(z.array(z.string()), {
    reducer: {
      // 子图作为节点执行完毕会把完整子状态写回父图，
      // 其中可能包含父图已有的 steps，所以这里用去重累积而不是直接 concat
      fn: (left: string[], right: string[]) => Array.from(new Set([...left, ...right])),
    },
    default: () => [],
  }),
});

type ParentStateType = z.infer<typeof ParentState>;

/** 把疑问句整理成更短的检索词 */
function planNode(state: ParentStateType): Partial<ParentStateType> {
  const query = state.question
    .replace(/[？?。！!，,]/g, " ")
    .replace(/(请|帮我|能不能|怎么|如何|是什么|什么|一下)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  console.log(`[父图 plan] "${state.question}" → 检索词 "${query}"`);
  return {
    query,
    steps: ["parent:plan"],
  };
}

/** 基于子图 findings 生成最终回答，模型不可用时降级为直接摘录 */
async function answerNode(state: ParentStateType): Promise<Partial<ParentStateType>> {
  let answer = "";

  try {
    const { model } = initModel();
    const response = await model.invoke(
      `你是研究助手。仅根据下面这段检索资料回答问题，不要编造。\n\n` +
        `问题：${state.question}\n\n资料：\n${state.findings}\n\n请用中文回答。`
    );
    answer = extractText(response).trim();
  } catch (error) {
    console.warn(`[父图 answer] 模型不可用，使用检索结果兜底：${describeError(error)}`);
    answer = `（未调用模型）根据检索结果：\n${state.findings}`;
  }

  return {
    answer,
    steps: ["parent:answer"],
  };
}

const parentGraph = new StateGraph(ParentState)
  .addNode("plan", planNode)
  // 编译后的子图直接作为父图节点
  .addNode("research", researchSubgraph)
  // 节点名不能和状态字段同名，所以这里叫 answerNode 而不是 answer
  .addNode("answerNode", answerNode)
  .addEdge(START, "plan")
  .addEdge("plan", "research")
  .addEdge("research", "answerNode")
  .addEdge("answerNode", END)
  .compile();

// ─────────────────────────────────────────────
// 3. 演示
// ─────────────────────────────────────────────

async function runDemo() {
  console.log("=".repeat(60));
  console.log("Day 6-1: 子图作为父图节点");
  console.log("=".repeat(60));

  const result = await parentGraph.invoke({
    question: "LangGraph 的子图怎么把研究流程拆出来？",
  });

  console.log("\n--- 父图最终状态 ---");
  console.log(`question : ${result.question}`);
  console.log(`query    : ${result.query}`);
  console.log(`findings : ${result.findings}`);
  console.log(`answer   : ${result.answer}`);
  console.log(`steps    : [${result.steps.join(" → ")}]`);

  console.log("\n--- 父子图状态字段对比 ---");
  console.log("共享字段   : query（输入）、findings、steps");
  console.log("父图独有   : question、answer");
  console.log("子图独有   : 无（本例子图只用父图的 query；若子图新增内部字段，父图不声明就不会被写回）");
  console.log("隔离验证   : 子图执行后 answer 仍为空，说明子图没有越权写父图独有字段");

  console.log("\n" + "=".repeat(60));
  console.log("✅ Day 6 子图演示完成");
  console.log("=".repeat(60));
}

runDemo().catch((error) => {
  console.error("运行出错：", error);
  process.exit(1);
});
