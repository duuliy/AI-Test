/**
 * Day 10 / 任务二：用 LangGraph 的 StateGraph 写一个最小状态图。
 *
 * 三个概念先摆清楚：
 * - State（状态）：一张共享的“数据黑板”，每个节点读它、返回增量更新它；
 * - Node（节点）：一个普通函数，输入是当前 State，输出是 State 的部分更新；
 * - Edge（边）：节点之间的固定顺序，START / END 是图自带的两个哨兵节点。
 *
 * 本图固定走 START → classifyNode → answerNode → reviewNode → END，
 * 重点是观察 State 的合并规则：普通字段覆盖，ReducedValue 字段累积。
 */
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { END, ReducedValue, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { createChatModel, describeError, loadEnv } from "./model.js";

/** 分类结果只有三种；answer 节点里用它缩小分支，避免字符串到处飘 */
type Category = "time" | "rag" | "general";

/**
 * 状态定义（StateSchema 的每个字段都会被转换成一个 channel）：
 *
 * - question：输入字段，必填字符串，运行期间不会被任何节点改写；
 * - category：普通字段，默认 "unknown"，classify 节点写入后覆盖默认值；
 * - answer：普通字段，默认空字符串，answer 节点写入，review 节点可能再补一次；
 * - steps：用 ReducedValue，输入类型是 string，存储类型是 string[]。
 *
 * ReducedValue 的三个要点：
 * 1. valueSchema 描述“存下来是什么样”（这里 string[]，默认空数组）；
 * 2. inputSchema 描述“节点每次能提交什么”（这里单个 string）；
 * 3. reducer 负责合并：`(current, next) => [...current, next]`，
 *    每次返回新数组而不是 push，避免原地修改共享状态。
 * 所以三个节点各提交一次后，steps 是 ["classify", "answer", "review"]，
 * 而不是最后只剩一个字符串。
 */
const GraphState = new StateSchema({
  question: z.string(),
  category: z.string().default("unknown"),
  answer: z.string().default(""),
  steps: new ReducedValue(z.array(z.string()).default(() => []), {
    inputSchema: z.string(),
    reducer: (current, next) => [...current, next],
  }),
});

/**
 * v1 中 content 可能是 string，也可能是 ContentBlock[]（文本、图片等混合）。
 * answer 节点要把模型返回的消息塞进字符串状态，这里统一抽 text 块。
 */
function textOf(message: BaseMessage): string {
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
 * 关键词分类，不做模型分类：
 * 先判断更具体的 RAG 关键词（rag / 检索 / 向量 / 知识库 / embedding），
 * 再判断时间关键词，“现在”“今天”这类太宽泛的放在后面，避免抢走 RAG 的问题；
 * 都不命中就归 general，交给模型自由回答。
 */
function classifyQuestion(question: string): Category {
  if (/rag|检索|向量|知识库|embedding/i.test(question)) {
    return "rag";
  }
  if (/几点|时间|日期|时区|现在|今天|明天|昨天/.test(question)) {
    return "time";
  }
  return "general";
}

/**
 * time 分支的答案：直接读本机时间，不调用模型。
 * 用 Intl.DateTimeFormat 明确格式，避免 toLocaleString 在不同环境下输出差异太大。
 */
function answerTime(): string {
  const now = new Date();
  const local = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);

  return `现在是 ${local}（本机时区）。`;
}

/**
 * rag 分支的答案：一段固定说明。
 * Day 10 不做真实检索，重点是演示“不同分类走不同处理逻辑”，
 * 真正的 RAG 链路在第二周 Day 1～2 已经写过。
 */
function answerRag(): string {
  return "RAG 是“检索增强生成”：先把文档切分并向量化写入向量库；提问时用问题去检索最相关的片段，再把片段拼进提示词交给模型生成回答。这样模型能基于外部知识作答，减少胡编。";
}

/** 三个问题，覆盖 time / rag / general 三种分类分支 */
const QUESTIONS = ["现在几点？", "RAG 是什么？", "用一句话解释 Agent"];

async function main(): Promise<void> {
  // .env、crypto、追踪开关都在这里准备好；day10:graph 不关心 LangSmith，但复用同一份配置
  loadEnv();

  // 模型只在 general 分支用到，先创建好，供 answer 节点闭包捕获
  const model = await createChatModel();

  // ---------- 节点 1：classify ----------
  // 节点的输入是完整 State，返回的是“要改哪些字段”的部分更新；
  // 这里只写 category 和 steps，question 原样保留。
  const classifyNode: typeof GraphState.Node = (state) => {
    const category = classifyQuestion(state.question);
    console.log(`[classify] 问题「${state.question}」→ ${category}`);
    // steps 提交的是字符串 "classify"，由 ReducedValue 追加进数组
    return { category, steps: "classify" };
  };

  // ---------- 节点 2：answer ----------
  // 这是唯一一个异步节点：general 分支要 await 模型调用。
  // 三个分支都保证返回 answer 字符串 + steps: "answer"。
  const answerNode: typeof GraphState.Node = async (state) => {
    // StateSchema 把 category 声明成 string，这里用断言收窄到 Category；
    // classify 节点只可能写入这三个值，所以断言是安全的。
    const category = state.category as Category;

    let answer: string;
    switch (category) {
      case "time":
        // 本地时间直接答，省一次模型调用
        answer = answerTime();
        break;
      case "rag":
        // 固定说明，不接真实检索
        answer = answerRag();
        break;
      case "general":
        // 只有这里才真正调用模型；HumanMessage 承载用户原问题
        answer = textOf(await model.invoke([new HumanMessage(state.question)]));
        break;
      default:
        // 理论上不会出现：category 默认 "unknown" 时故意留空，
        // 交给后面的 review 节点兜底
        answer = "";
    }

    console.log(`[answer] 分类 ${category} → 已生成回答`);
    return { answer, steps: "answer" };
  };

  // ---------- 节点 3：review ----------
  // 兜底节点：只做两件事——检查 answer 是否为空、记录自己跑过。
  // 回答非空时只提交 steps，不重复写 answer，避免无意义的覆盖。
  const reviewNode: typeof GraphState.Node = (state) => {
    const answer = state.answer.trim();
    if (!answer) {
      console.log("[review] 回答为空，填入兜底文案");
      return {
        answer: "（暂无可用回答，已由 review 节点补齐兜底文案。）",
        steps: "review",
      };
    }

    console.log("[review] 回答非空，检查通过");
    return { steps: "review" };
  };

  // ---------- 组装图 ----------
  // addNode(节点名, 节点函数)：节点名是边的引用标识；
  // addEdge(起点, 终点)：固定边，从起点跑完必定进入终点；
  // START / END 是图自带的哨兵，编译后入口从 START 开始、出口回到 END。
  //
  // 注意：LangGraph 不允许节点名与状态字段同名，而状态里已经有 answer 字段，
  // 所以节点键统一加 Node 后缀；steps 里记录的仍是 classify / answer / review。
  //
  // compile() 才会做真正的校验（节点是否都存在、边是否合法）并返回可 invoke 的图。
  const graph = new StateGraph(GraphState)
    .addNode("classifyNode", classifyNode)
    .addNode("answerNode", answerNode)
    .addNode("reviewNode", reviewNode)
    .addEdge(START, "classifyNode")
    .addEdge("classifyNode", "answerNode")
    .addEdge("answerNode", "reviewNode")
    .addEdge("reviewNode", END)
    .compile();

  for (const [index, question] of QUESTIONS.entries()) {
    console.log(`\n=== 第 ${index + 1} 个问题 ===`);

    // invoke 的入参只需要必填字段 question；
    // category / answer / steps 都有默认值，不传也会由 channel 自动初始化。
    // 返回值是“所有节点跑完后的完整 State”，不是增量更新。
    const result = await graph.invoke({ question });

    console.log(`question：${result.question}`);
    console.log(`category：${result.category}`);
    console.log(`answer：${result.answer}`);
    // steps.join 只是为了好读；它本质是累积数组，长度固定为 3，顺序就是节点执行顺序
    console.log(`steps：${result.steps.join(" → ")}（共 ${result.steps.length} 步）`);
  }
}

// 顶层 await 跑 main；错误统一翻译成中文，图运行出错时不至于只看到一大段堆栈
try {
  await main();
} catch (error) {
  console.error(describeError(error));
  process.exit(1);
}
