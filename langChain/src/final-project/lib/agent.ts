/**
 * Agent 组装 —— 所有能力的汇合点
 *
 * 设计要点：
 *   1. 按路由缓存三个 Agent（knowledge / time / general），
 *      每个 Agent 有自己的工具集合和 systemPrompt 变体。
 *   2. 三个 Agent 共享：同一个 model 实例、同一套 middleware、
 *      同一个 MemorySaver checkpointer。
 *   3. 会话隔离靠 thread_id（Route Handler 里由前端生成的 UUID），
 *      不是靠不同的 checkpointer —— 一个 MemorySaver 内部就是按 thread_id 分桶存的。
 *
 * 为什么不直接一个 Agent 放所有工具、一个超长 systemPrompt 覆盖三种情况：
 *   放所有工具时，模型容易选错（比如"现在几点"也去调知识库检索）。
 *   systemPrompt 里塞三种规则时，模型可能在 knowledge 路由下仍然"允许自己闲聊"。
 *   分开三个 Agent，每个的规则边界清晰，决策空间更小。
 */
import { MemorySaver } from "@langchain/langgraph";
import { createAgent } from "langchain";
import { createMiddlewareStack } from "./middleware";
import { getModel } from "./model";
import type { Route } from "./router";
import {
  basicTools,
  calculate,
  getCurrentTime,
  knowledgeTools,
  searchKnowledgeBase,
  type AppTool,
} from "./tools";

/**
 * 模块级 checkpointer：所有 Agent 共享。
 * MemorySaver 内部用 Map<string, State> 按 thread_id 分桶存状态，
 * 所以不同路由的 Agent 对同一个 thread_id 写入的历史是**串在一起**的。
 * 这是有意为之 —— 用户上一轮问了知识库问题，这一轮问时间，
 * 我们希望模型能参考上一轮的上下文，而不是完全隔离。
 *
 * 进程退出即清空：服务端不重启、但模型进程退出时会丢记忆。
 * 生产环境换 SQLite / Postgres checkpointer 可持久化。
 */
const checkpointer = new MemorySaver();

/** 把 createAgent 的复杂泛型解包成一个可读的别名，避免别处重复写 */
type AppAgent = ReturnType<typeof createAgent>;

/**
 * 路由 → 工具数组的映射。
 * knowledge 放三个工具（检索为主，时间/计算为辅）；
 * time / general 只放时间和计算，不放检索 ——
 * 否则模型遇到闲聊也可能硬调知识库检索，浪费一次 embedding 调用。
 */
const toolsByRoute: Record<Route, AppTool[]> = {
  knowledge: [searchKnowledgeBase, getCurrentTime, calculate],
  time: basicTools,
  general: basicTools,
};

/**
 * 三段式 systemPrompt：BASE_RULES 是三个路由共享的底层约束，
 * KNOWLEDGE_RULES / TIME_RULES / GENERAL_RULES 各自 append 路由特有的规则。
 * 这样改共享规则只改一处，改某路由专属规则也不影响其它。
 *
 * knowledge 路由特别强调：
 *   "只依据 search_knowledge_base 的检索结果回答" + "标注 [来源: 文件名#chunkIndex]" +
 *   "检索不足时说根据现有知识库无法回答" —— 这三条共同防止模型"拿着知识库当万能知识源"。
 */
const BASE_RULES = `你是一个个人知识库助手。
- 用中文回答，简洁准确。
- 用户询问时间、日期、时区时，必须先调用 get_current_time 工具，不要凭空编造。
- 用户要求算数时，必须先调用 calculate 工具，不要心算。
- 工具返回错误时，如实说明该工具暂时不可用。`;

const KNOWLEDGE_RULES = `${BASE_RULES}
- 本轮是知识库问答：只依据 search_knowledge_base 的检索结果回答，不要补充常识。
- 每条结论后标注 [来源: 文件名#chunkIndex]，chunkIndex 直接取自检索结果。
- 检索结果与问题无关或信息不足时，明确回答"根据现有知识库无法回答"，不要编造。`;

const TIME_RULES = `${BASE_RULES}
- 本轮主要处理时间或计算问题，先调用对应工具，再把结果转述成自然语言。`;

const GENERAL_RULES = `${BASE_RULES}
- 本轮是闲聊或一般问题，可以直接回答；无法确认的事实时说明不知道，不要编造。`;

function systemPromptFor(route: Route): string {
  switch (route) {
    case "knowledge":
      return KNOWLEDGE_RULES;
    case "time":
      return TIME_RULES;
    case "general":
      return GENERAL_RULES;
  }
}

/**
 * 缓存"三个 Agent 一起初始化"的 Promise。
 * 模式同 modelPromise / runnerPromise / vectorStorePromise：
 *   首次 getAgent() 触发 buildAgents()，并发请求共享同一个 Promise；
 *   初始化失败时 catch 里清掉 agentsPromise = undefined，允许后续重试。
 *
 * 注意：三个 Agent 是**同时初始化**的，因为它们共享同一个 model、middleware 和 checkpointer。
 * 分开初始化反而会让第一次请求（不管路由是什么）都等完整套初始化。
 */
let agentsPromise: Promise<Record<Route, AppAgent>> | undefined;

async function buildAgents(): Promise<Record<Route, AppAgent>> {
  const model = await getModel();
  // middleware 只建一次，三个 Agent 共用同一套重试 / 错误处理 / 摘要策略
  const middleware = createMiddlewareStack(model);

  // makeAgent 闭包捕获 route，三次调用分别组装三个 Agent
  const makeAgent = (route: Route): AppAgent =>
    createAgent({
      model,
      tools: toolsByRoute[route],
      systemPrompt: systemPromptFor(route),
      checkpointer,
      middleware,
    });

  return {
    knowledge: makeAgent("knowledge"),
    time: makeAgent("time"),
    general: makeAgent("general"),
  };
}

/**
 * 按路由取 Agent。
 * 首次调用触发 buildAgents()，后续直接从缓存的 Record 里取对应路由。
 * 失败时清 agentsPromise，让修好配置后的下一次请求能重建。
 */
export async function getAgent(route: Route): Promise<AppAgent> {
  if (!agentsPromise) {
    agentsPromise = buildAgents().catch((error: unknown) => {
      agentsPromise = undefined;
      throw error;
    });
  }
  return (await agentsPromise)[route];
}
