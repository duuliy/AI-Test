/**
 * Day 6-3: 手写 supervisor 多 Agent 循环
 *
 * 知识点：
 * - supervisor 本身也是一个节点，只负责「下一步交给谁」
 * - 路由用 withStructuredOutput 拿到结构化决策，再交给条件边
 * - worker 执行完必须回到 supervisor，形成 supervisor → worker → supervisor 的循环
 * - 两道保护：业务层 hops 上限 + 框架层 recursionLimit
 */

import { z } from "zod";
import { StateGraph, START, END } from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import { initModel, extractText, describeError } from "./model.js";
import { searchDocs } from "./docs.js";

// ─────────────────────────────────────────────
// 1. 状态
// ─────────────────────────────────────────────

const RouteSchema = z.object({
  next: z.enum(["research", "write", "finish"]),
  reason: z.string().describe("为什么选择这一步，用一句中文说明"),
});

type RouteNext = z.infer<typeof RouteSchema>["next"];

const SupervisorState = z.object({
  /** 用户任务 */
  task: z.string(),
  /** 下一步交给谁，supervisor 每次覆盖它 */
  next: z.enum(["research", "write", "finish"]).default("research"),
  /** 研究笔记：多个 worker 共享，累积并去重 */
  notes: withLangGraph(z.array(z.string()), {
    reducer: {
      fn: (left: string[], right: string[]) => Array.from(new Set([...left, ...right])),
    },
    default: () => [],
  }),
  /** 最终回答 */
  answer: z.string().default(""),
  /** supervisor 调用次数，避免死循环 */
  hops: z.number().default(0),
});

type SupervisorStateType = z.infer<typeof SupervisorState>;

/** 记录本次运行的决策序列，最后统一打印 */
const decisionTrace: string[] = [];

// ─────────────────────────────────────────────
// 2. 三个 Agent 节点
// ─────────────────────────────────────────────

/** 模型不可用时的兜底决策：先 research，再 write，最后 finish */
function fallbackDecision(state: SupervisorStateType): { next: RouteNext; reason: string } {
  if (state.notes.length === 0) {
    return { next: "research", reason: "还没有研究笔记，先检索资料" };
  }
  if (state.answer.trim() === "") {
    return { next: "write", reason: "笔记已经足够，可以写最终回答" };
  }
  return { next: "finish", reason: "回答已经生成，可以结束" };
}

/** supervisor：决定下一步，并把 hops + 1 */
async function supervisorNode(state: SupervisorStateType): Promise<Partial<SupervisorStateType>> {
  const hops = state.hops + 1;
  const prefix = `[supervisor hop ${hops}]`;

  // 第一道保护：业务层硬上限
  if (hops > 5) {
    const reason = "hops 超过 5，强制收尾";
    console.log(`${prefix} 决策：finish | ${reason}`);
    decisionTrace.push(`finish | ${reason}`);
    return { next: "finish", hops };
  }

  let next: RouteNext;
  let reason: string;

  try {
    const { model } = initModel();
    const router = model.withStructuredOutput(RouteSchema);
    const decision = await router.invoke(
      `你是多 Agent 调度器，只能选择下面三种下一步之一：\n` +
        `- research：检索资料，补充笔记\n` +
        `- write：基于已有笔记写最终回答\n` +
        `- finish：任务已经完成，结束\n\n` +
        `任务：${state.task}\n` +
        `已有笔记：${state.notes.length > 0 ? `\n${state.notes.join("\n")}` : "（无）"}\n` +
        `已有回答：${state.answer.trim() === "" ? "（无）" : state.answer}\n\n` +
        `请给出下一步和理由。`
    );
    next = decision.next;
    reason = decision.reason;
  } catch (error) {
    const fallback = fallbackDecision(state);
    next = fallback.next;
    reason = `模型不可用（${describeError(error)}），兜底选择：${fallback.reason}`;
  }

  // 第二道保护：状态层面的强制规则
  if (state.notes.length === 0 && next !== "research") {
    next = "research";
    reason += "；保护规则：还没有笔记，必须先 research";
  }
  if (state.answer.trim() !== "" && next !== "finish") {
    next = "finish";
    reason += "；保护规则：回答已存在，直接 finish";
  }

  console.log(`${prefix} 决策：${next} | 理由：${reason}`);
  decisionTrace.push(`${next} | ${reason}`);

  return { next, hops };
}

/** research worker：调用本地检索，把结果追加到 notes */
function researchNode(state: SupervisorStateType): Partial<SupervisorStateType> {
  const docs = searchDocs(state.task);
  const notes = docs.map((doc) => `[${doc.id}] ${doc.title}：${doc.content}`);

  console.log(`[research] 检索到 ${notes.length} 篇资料，写入 notes`);
  return { notes };
}

/** write worker：基于 notes 生成带引用的回答 */
async function writeNode(state: SupervisorStateType): Promise<Partial<SupervisorStateType>> {
  let answer = "";

  try {
    const { model } = initModel();
    const response = await model.invoke(
      `根据下面的笔记回答任务，每个关键结论后标出来源（如 [doc-rag]），不要编造。\n\n` +
        `任务：${state.task}\n\n笔记：\n${state.notes.join("\n")}\n\n请用中文输出。`
    );
    answer = extractText(response).trim();
  } catch (error) {
    console.warn(`[write] 模型不可用，使用笔记兜底：${describeError(error)}`);
    answer = `（未调用模型）基于以下资料整理：\n${state.notes.join("\n")}`;
  }

  console.log("[write] 已生成最终回答");
  return { answer };
}

// ─────────────────────────────────────────────
// 3. 组装图
// ─────────────────────────────────────────────

/** 条件边路由函数：只读 supervisor 写下的 next */
function routeByNext(state: SupervisorStateType): RouteNext {
  return state.next;
}

const graph = new StateGraph(SupervisorState)
  .addNode("supervisor", supervisorNode)
  .addNode("research", researchNode)
  .addNode("write", writeNode)
  .addEdge(START, "supervisor")
  .addConditionalEdges("supervisor", routeByNext, {
    research: "research",
    write: "write",
    finish: END,
  })
  // worker 执行完都回到 supervisor
  .addEdge("research", "supervisor")
  .addEdge("write", "supervisor")
  .compile();

// ─────────────────────────────────────────────
// 4. 演示
// ─────────────────────────────────────────────

async function runDemo() {
  console.log("=".repeat(60));
  console.log("Day 6-3: 手写 supervisor 多 Agent");
  console.log("=".repeat(60));

  const task = "用 LangGraph 和 RAG 做一个带引用的问答助手";
  console.log(`\n任务：${task}`);

  // 第二道保护：框架层 recursionLimit
  // 注意：LangGraph 的 zod schema 只会为 withLangGraph 的 reducer 字段建默认值通道，
  // 普通字段的 .default() 不会自动出现在初始 state 里，所以要显式传入
  const result = await graph.invoke(
    {
      task,
      next: "research",
      notes: [],
      answer: "",
      hops: 0,
    },
    { recursionLimit: 12 }
  );

  console.log("\n--- 最终状态 ---");
  console.log(`next     : ${result.next}`);
  console.log(`hops     : ${result.hops}`);
  console.log(`notes    : ${result.notes.length} 条`);
  console.log(`answer   : ${result.answer}`);

  console.log("\n--- supervisor 决策序列 ---");
  decisionTrace.forEach((item, index) => console.log(`${index + 1}. ${item}`));

  console.log("\n" + "=".repeat(60));
  console.log("✅ Day 6 supervisor 演示完成");
  console.log("=".repeat(60));
}

runDemo().catch((error) => {
  console.error("运行出错：", error);
  process.exit(1);
});
