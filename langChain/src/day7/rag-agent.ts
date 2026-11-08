/**
 * Day 7 · RAG Agent
 *
 * 把检索封装成工具交给 createAgent，由模型自己决定什么时候查知识库。
 * 复用策略：
 * - 入库、切分、embedding 直接复用 Day 6 的 src/day6/ingest.ts；
 * - .env 加载、聊天模型、错误翻译复用 src/shared/model.ts；
 * - Day 7 只保留 Agent、检索工具以及“懒建库 + 缓存”这一层。
 *
 * 运行方式：
 *   npm run day7                  # 跑 4 个内置问题
 *   npm run day7 -- "自定义问题"   # 只跑一个问题
 * 阅读顺序建议从这里开始：main() 就是整个 Demo 的主流程。
 */
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"; // 四种消息类型
import { createAgent } from "langchain"; // v1 创建 Agent 的入口，内部封装了工具循环
import { createModel as createChatModel, describeError, loadEnv } from "../shared/model.js"; // 复用共享的聊天模型、env 加载与错误翻译
import { searchKnowledgeBaseTool } from "./retriever-tool.js"; // 我们要交给 Agent 的检索工具

/** 默认演示问题：前 3 个能命中知识库，最后一个用于验证“不知道就说不知道” */
const DEFAULT_QUESTIONS = [
  "RAG 的流程分哪几步？", // 应当命中 rag.md
  "createAgent 和 middleware 是什么关系？", // 应当命中 agents.md
  "checkpointer 的作用是什么？", // 应当命中 agents.md
  "LangChain 支持哪些向量数据库？", // 知识库里没有答案，用来测试拒答
];

/**
 * 系统提示词是 RAG Agent 的“约束层”：
 * 检索工具只负责把片段拿回来，是否引用、是否拒答由这里的规则决定。
 * 规则写得越具体，模型越不容易拿常识补全检索不到的内容。
 */
const SYSTEM_PROMPT = `你是一个基于本地知识库回答问题的中文助手，必须遵守以下规则：
1. 只依据 search_knowledge_base 工具返回的检索结果回答，不要使用你自己的常识或推测补充内容。
2. 每个结论后面必须标注来源，格式为 [来源: 文件名#chunkIndex]，例如 [来源: rag.md#2]。
3. 如果检索结果与问题无关、信息不足或没有命中，直接回答“根据现有知识库无法回答”，不要编造，也不要猜测。
4. 每次提问最多调用一次检索工具，不要为了凑引用反复检索；一次检索结果不够就以“根据现有知识库无法回答”收尾。
5. 用中文简洁作答。`;

/** content 可能是 string，也可能是 ContentBlock[]，统一抽出纯文本 */
function textOf(message: BaseMessage): string {
  // 大多数情况下 content 就是普通字符串，可以直接返回
  if (typeof message.content === "string") {
    return message.content;
  }

  let text = ""; // 用于拼接内容块里的文本
  // content 是数组时，只挑 type === "text" 的块，忽略图片等其它块
  for (const block of message.content) {
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text; // 按原顺序拼接每段文本
    }
  }
  return text; // 返回纯文本结果
}

/** 压成单行并截断：工具返回的正文可能很长，直接打印会刷屏 */
function truncate(text: string, max = 160): string {
  const singleLine = text.replace(/\s+/g, " ").trim(); // 把换行和连续空白压成一个空格
  return singleLine.length > max ? `${singleLine.slice(0, max)}…` : singleLine; // 超长就截断并加省略号
}

/** 按消息顺序打印“模型发起工具调用 → 工具返回结果”的轨迹 */
function printToolTrace(messages: BaseMessage[]): void {
  let count = 0; // 统计本轮一共发起几次工具调用

  // 消息数组是按时间顺序排列的，直接顺序遍历即可
  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      // 一条 AIMessage 里可能同时包含多个工具调用
      for (const call of message.tool_calls ?? []) {
        count += 1; // 调用次数加一
        // 这里只打印模型“想调用什么”，真正返回的内容在后面的 ToolMessage 里
        console.log(`  [${count}] 调用 ${call.name}(${JSON.stringify(call.args)})`); // 打印工具名与参数
      }
      continue; // AIMessage 处理完，跳到下一条消息
    }

    // ToolMessage 是工具执行后回填给模型的结果
    if (ToolMessage.isInstance(message)) {
      console.log(`      ← ${message.name ?? "unknown"} 返回：${truncate(textOf(message))}`); // 打印工具名和截断后的结果
    }
  }

  // 本轮完全没有工具调用，说明模型直接作答了
  if (count === 0) {
    console.log("  （本轮没有调用检索工具）"); // 明确提示，便于对比不同问题
  }
}

async function main(): Promise<void> {
  loadEnv(); // 先把 .env 写进 process.env，后面才能读到配置

  const cliQuestion = process.argv.slice(2).join(" ").trim(); // 取命令行参数，允许不带引号的多个单词
  const questions = cliQuestion ? [cliQuestion] : DEFAULT_QUESTIONS; // 有参数就只跑一个，否则跑内置 4 个

  console.log("LangChain.js Day 7 · RAG Agent（检索工具化）"); // 打印标题
  console.log(`模型：${process.env.OPENAI_MODEL ?? "unknown"}`); // 打印当前使用的聊天模型
  console.log(`问题数：${questions.length}`); // 打印本轮要跑几个问题

  const model = await createChatModel(); // 创建聊天模型（内部会校验配置）
  // createAgent 内部完成“模型 → 工具 → ToolMessage → 模型”的循环，
  // 这里不需要手写 while，也不需要自己判断何时结束。
  const agent = createAgent({
    model, // 用哪个模型来思考和决定是否调用工具
    tools: [searchKnowledgeBaseTool], // 工具列表，模型只能调用这里注册的工具
    systemPrompt: SYSTEM_PROMPT, // 行为约束，规则写在这里
  }); // Agent 创建完成后可以直接 invoke

  for (const [index, question] of questions.entries()) {
    console.log(`\n—— 问题 ${index + 1}/${questions.length} ——`); // 分隔每个问题，方便看输出
    console.log(`问题：${question}`); // 回显当前问题

    // 每个问题独立 invoke，不传 thread_id，所以 4 个问题互不共享上下文；
    // 是否检索、检索几次，由工具 description + 系统提示词共同引导模型决定。
    const result = await agent.invoke({
      messages: [new HumanMessage(question)], // 新问题作为本轮唯一的用户消息
    }); // result.messages 包含完整的调用轨迹

    printToolTrace(result.messages); // 打印模型发起的工具调用和工具返回

    // 消息数组里既有发起工具调用的 AIMessage，也有工具返回的 ToolMessage；
    // 最后一条不带 tool_calls 的 AIMessage 才是给用户的自然语言答复。
    const finalAnswer = [...result.messages]
      .reverse() // 从后往前找，最后一条才是最终答复
      .find(
        (message): message is AIMessage =>
          AIMessage.isInstance(message) && (message.tool_calls?.length ?? 0) === 0, // 必须是 AIMessage 且没有再调工具
      );

    // 找到就打印文本，找不到说明流程异常，给出明确提示
    console.log(`最终回答：${finalAnswer ? textOf(finalAnswer) : "（没有拿到自然语言回答）"}`); // 输出最终回答
  }
}

// 顶层 try/catch：任何一步失败都统一翻译成中文提示
try {
  await main(); // 运行主流程
} catch (error) {
  // 统一把 SDK / 网络错误翻译成中文提示，不把原始堆栈直接抛给用户
  console.error(describeError(error)); // 打印可读的错误原因
  process.exit(1); // 用非 0 退出码表示失败
}
