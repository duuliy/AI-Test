/**
 * Day 1: 最小状态图
 *
 * 知识点：
 * - 节点接收完整 State，但只返回「部分更新」（update），图框架负责合并
 * - Reducer 字段不覆盖，而是累积/合并
 * - StateGraph 需要 compile() 才能运行，compile 会校验图的连通性
 * - invoke 返回最终完整 state；stream({ streamMode: "updates" }) 每个节点只推送自己做的部分更新
 */

import { z } from "zod";
import { StateGraph, START, END } from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import { initModel, extractText } from "./model.js";

// ─────────────────────────────────────────────
// 1. 定义状态
// ─────────────────────────────────────────────

/**
 * 普通字段：没有 reducer，节点返回什么就覆盖什么（类似 LastValue channel）
 * ReducedValue（有 reducer 的字段）：用 withLangGraph 包装，传入 reducer 函数
 *
 * 为什么 ReducedValue 接受单个值却能累积成数组？
 *   reducer 签名是 (left: 当前值, right: 节点返回的增量) => 新值
 *   节点只写增量，reducer 负责合并
 */
const GraphState = z.object({
  /** 原始问题 */
  question: z.string(),
  /** 分类标签（time / rag / general / unknown） */
  category: z.string().default("unknown"),
  /** 最终答案 */
  answer: z.string().default(""),
  /** 执行步骤轨迹：用 reducer 把每个节点返回的单个步骤累积成数组 */
  steps: withLangGraph(z.array(z.string()), {
    reducer: {
      fn: (left: string[], right: string[]) => left.concat(right),
    },
    default: () => [],
  }),
});

type GraphStateType = z.infer<typeof GraphState>;

// ─────────────────────────────────────────────
// 2. 三个节点（注意：节点名不能和状态字段同名）
// ─────────────────────────────────────────────

/**
 * 节点函数签名：(state: 完整 State) => Partial<State>
 * 只返回需要更新的字段，没返回的字段保持原值
 */
function classifyQuestion(state: GraphStateType): Partial<GraphStateType> {
  const q = state.question;

  let category = "general";
  if (/几点|时间|日期|今天|现在/.test(q)) {
    category = "time";
  } else if (/RAG|rag|检索增强/.test(q)) {
    category = "rag";
  }

  return {
    category,
    steps: ["classify"], // reducer 字段写的是增量（单个步骤）
  };
}

async function generateAnswer(state: GraphStateType): Promise<Partial<GraphStateType>> {
  const { category, question } = state;

  let answer = "";

  if (category === "time") {
    // 时间类：直接用本地时间回答，不调用模型
    const now = new Date();
    answer = `现在是 ${now.toLocaleString("zh-CN")}`;
  } else if (category === "rag") {
    // RAG 类：固定文字
    answer =
      "RAG（Retrieval-Augmented Generation，检索增强生成）的流程是：\n" +
      "1. 将知识文档切分成小块（chunk）\n" +
      "2. 为每个 chunk 生成 embedding 并存入向量数据库\n" +
      "3. 用户提问时，将问题也做 embedding\n" +
      "4. 在向量数据库中检索相似度最高的 N 个 chunk\n" +
      "5. 把问题和检索到的 chunk 一起拼成 prompt 交给 LLM 生成答案";
  } else {
    // general：尝试调用模型，失败则兜底
    try {
      const { model } = initModel();
      const response = await model.invoke(question);
      answer = extractText(response);
    } catch {
      answer = "（模型未配置，占位回答）Agent 是一种能自主规划步骤、调用工具并迭代执行来完成复杂任务的 AI 程序。";
    }
  }

  return {
    answer,
    steps: ["answer"],
  };
}

function finalReview(state: GraphStateType): Partial<GraphStateType> {
  // 兜底：如果 answer 还是空的，填一个占位
  let answer = state.answer;
  if (!answer || answer.trim() === "") {
    answer = "抱歉，我暂时无法回答这个问题。";
  }
  return {
    answer,
    steps: ["review"],
  };
}

// ─────────────────────────────────────────────
// 3. 组装图
// ─────────────────────────────────────────────

const graphBuilder = new StateGraph(GraphState)
  .addNode("classifyQuestion", classifyQuestion)
  .addNode("generateAnswer", generateAnswer)
  .addNode("finalReview", finalReview)
  // 直线边：START → classifyQuestion → generateAnswer → finalReview → END
  .addEdge(START, "classifyQuestion")
  .addEdge("classifyQuestion", "generateAnswer")
  .addEdge("generateAnswer", "finalReview")
  .addEdge("finalReview", END);

// compile() 做了什么？校验图连通性（所有节点都有入度出度），然后冻结结构
const graph = graphBuilder.compile();

// ─────────────────────────────────────────────
// 4. 演示
// ─────────────────────────────────────────────

async function runDemo() {
  console.log("=".repeat(60));
  console.log("Day 1: 最小状态图");
  console.log("=".repeat(60));

  // 三个测试问题
  const questions = [
    "现在几点？",
    "RAG 是什么？",
    "用一句话解释 Agent",
  ];

  // invoke：一次性拿到最终完整 state
  console.log("\n--- invoke 演示（最终结果）---");
  for (const question of questions) {
    const result = await graph.invoke({ question });
    console.log(`\n📝 问题: ${result.question}`);
    console.log(`🏷️  分类: ${result.category}`);
    console.log(`💬 答案: ${result.answer}`);
    console.log(`👣 步骤: [${result.steps.join(" → ")}]`);
  }

  // stream({ streamMode: "updates" })：每个节点推一次，只推它做的部分更新
  console.log("\n--- stream({ streamMode: 'updates' }) 演示 ---");
  const streamQuestion = "现在几点？";
  const stream = await graph.stream({ question: streamQuestion }, { streamMode: "updates" });

  for await (const chunk of stream) {
    // chunk 结构：{ [节点名]: { 字段更新... } }
    for (const [nodeName, updates] of Object.entries(chunk)) {
      console.log(`\n🔄 节点: ${nodeName}`);
      console.log(`   更新字段: ${Object.keys(updates as object).join(", ")}`);
      // 把更新内容也打印出来（steps 可能是数组片段）
      const u = updates as Record<string, unknown>;
      if (u.steps) console.log(`   steps 增量: [${(u.steps as string[]).join(", ")}]`);
      if (u.category) console.log(`   category: ${u.category}`);
      if (u.answer && typeof u.answer === "string") {
        console.log(`   answer: ${u.answer.slice(0, 50)}${u.answer.length > 50 ? "…" : ""}`);
      }
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("✅ Day 1 完成");
  console.log("=".repeat(60));
}

runDemo().catch((err) => {
  console.error("运行出错：", err);
  process.exit(1);
});
