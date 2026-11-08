/**
 * Day 3 · 工具定义：模型只负责“选工具 + 填参数”，执行发生在本地。
 * name / description / schema 就是发给模型的使用说明。
 */
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

const DEFAULT_TIMEZONE = "Asia/Shanghai";

/* -------------------------------------------------------------------------- */
/* 工具 A：get_current_time                                                     */
/* -------------------------------------------------------------------------- */

const getCurrentTimeTool = tool(
  ({ timezone }) => {
    // 模型可能传空字符串或省略字段，统一回落到默认时区
    const tz = timezone?.trim() || DEFAULT_TIMEZONE;
    const now = new Date();

    try {
      // 显式写出各字段，避免 dateStyle/timeStyle 与 hour12 的组合限制
      const formatter = new Intl.DateTimeFormat("zh-CN", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });

      return `时区 ${tz} 的当前时间：${formatter.format(now)}（UTC ISO：${now.toISOString()}）`;
    } catch {
      // Intl 遇到非法时区会抛 RangeError，这里转成字符串回填给模型，让循环继续
      return `错误：无法识别的时区 "${tz}"。请使用 IANA 时区名，例如 Asia/Shanghai、Asia/Tokyo、America/New_York。`;
    }
  },
  {
    name: "get_current_time",
    // description 决定“何时调用”，schema 决定“参数怎么填”
    description:
      "获取指定 IANA 时区的当前本地时间和 UTC ISO 时间。用户询问“现在几点”“今天几号”“某地时间”时调用。timezone 省略时默认 Asia/Shanghai。",
    schema: z.object({
      timezone: z
        .string()
        .optional()
        .describe("IANA 时区名，例如 Asia/Shanghai、Asia/Tokyo；省略时默认 Asia/Shanghai"),
    }),
  },
);

/* -------------------------------------------------------------------------- */
/* 工具 B：calculate                                                            */
/* -------------------------------------------------------------------------- */

// 用 enum 限死四种运算，不用 eval，避免执行模型生成的任意代码
const calculateTool = tool(
  ({ a, b, op }) => {
    switch (op) {
      case "+":
        return `${a} + ${b} = ${a + b}`;
      case "-":
        return `${a} - ${b} = ${a - b}`;
      case "*":
        return `${a} * ${b} = ${a * b}`;
      case "/":
        if (b === 0) {
          return "错误：除数不能为 0。";
        }
        return `${a} / ${b} = ${a / b}`;
    }
  },
  {
    name: "calculate",
    description:
      "对两个数字做一次四则运算。op 只能是 +、-、*、/。用户要求算数时调用，不要心算。",
    schema: z.object({
      a: z.number().describe("第一个操作数"),
      b: z.number().describe("第二个操作数"),
      op: z.enum(["+", "-", "*", "/"]).describe("运算符，只能是 +、-、*、/"),
    }),
  },
);

/* -------------------------------------------------------------------------- */
/* 工具 C：search_knowledge                                                     */
/* -------------------------------------------------------------------------- */

interface KnowledgeNote {
  title: string;
  content: string;
  keywords: string[];
}

// 内置学习笔记，不接真实搜索 API：Day 3 的重点是 tool calling 循环，不是检索质量
const NOTES: readonly KnowledgeNote[] = [
  {
    title: "Checkpointer：Agent 的记忆存储",
    content:
      "checkpointer 负责把 LangGraph 每一步的 State 快照持久化，配合 thread_id 就能让同一会话的多轮对话延续上下文。LangChain v1 的 createAgent 通过 checkpointer 自动读写历史。",
    keywords: ["checkpointer", "记忆", "thread_id", "持久化", "state"],
  },
  {
    title: "withStructuredOutput：让模型返回结构化数据",
    content:
      "withStructuredOutput 把 Zod schema 转成模型可理解的 JSON Schema，调用后直接拿到已解析的对象。若当前 provider 不支持默认的 JSON 模式（常见 HTTP 400），应改用 function calling 模式。",
    keywords: ["withstructuredoutput", "结构化输出", "zod", "schema", "function calling"],
  },
  {
    title: "Tool Calling：模型只发起调用，执行在本地",
    content:
      "bindTools 把工具定义随请求发给模型，模型返回 AIMessage.tool_calls（name / args / id）。本地执行工具后，必须用带相同 tool_call_id 的 ToolMessage 回填，再调用模型生成最终回答。",
    keywords: ["tool", "工具", "bindtools", "tool_calls", "tool_call_id"],
  },
  {
    title: "createAgent：把工具循环封装起来",
    content:
      "createAgent 在内部完成“调用模型 → 执行工具 → 回填 ToolMessage → 再调用模型”的循环，并支持 systemPrompt、responseFormat 和 stream。先把手动循环写一遍，才能看清它替你做了什么。",
    keywords: ["createagent", "agent", "智能体", "循环"],
  },
  {
    title: "RAG：先检索，再交给模型",
    content:
      "RAG 的流程是文档加载、切分、embedding、写入向量库；提问时先检索相关片段，再把片段拼进提示词。第二周会把检索封装成工具交给 Agent。",
    keywords: ["rag", "检索", "embedding", "向量库", "文档"],
  },
];

/** 把查询切成关键词；中英文标点和空白都当分隔符 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，。．.!！?？;；:：、"'“”‘’()（）[\]【】]+/)
    .filter((token) => token.length > 0);
}

/** 命中关键词计 1 分，命中标题额外加 2 分，让标题更相关的笔记排在前面 */
function scoreNote(note: KnowledgeNote, tokens: readonly string[]): number {
  const title = note.title.toLowerCase();
  const haystack = `${title}\n${note.content.toLowerCase()}\n${note.keywords.join(" ")}`;

  let score = 0;
  for (const token of tokens) {
    if (!haystack.includes(token)) continue;
    score += 1;
    if (title.includes(token)) score += 2;
  }
  return score;
}

// 内置笔记模拟本地检索；换成向量库时协议不变，模型仍只看到 query → 字符串
const searchKnowledgeTool = tool(
  ({ query }) => {
    const tokens = tokenize(query);
    const matched = NOTES.map((note) => ({ note, score: scoreNote(note, tokens) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 3);

    if (matched.length === 0) {
      // 明确告知未命中，禁止模型自行编造内容
      return `未找到与「${query}」相关的笔记。请换一个更具体的关键词，例如 checkpointer、tool calling、RAG。`;
    }

    const lines: string[] = [`找到 ${matched.length} 条相关笔记：`];
    for (const [index, item] of matched.entries()) {
      lines.push(`${index + 1}. ${item.note.title}`);
      lines.push(`   ${item.note.content}`);
    }
    return lines.join("\n");
  },
  {
    name: "search_knowledge",
    description:
      "在内置的 LangChain 学习笔记中做大小写不敏感的关键词检索，返回最相关的 3 条。用户询问 checkpointer、tool calling、createAgent、RAG、结构化输出等概念时调用。没有命中会明确返回“未找到”，不会编造。",
    schema: z.object({
      query: z.string().min(1).describe("要检索的关键词或问题，例如 checkpointer"),
    }),
  },
);

/* -------------------------------------------------------------------------- */
/* 导出                                                                         */
/* -------------------------------------------------------------------------- */

// 三个工具 schema 不同，擦除成统一接口后才能用同一个 invoke 调用
export const tools: StructuredToolInterface[] = [getCurrentTimeTool, calculateTool, searchKnowledgeTool];

// 模型只返回工具名，需要靠这张表找回实现函数
const toolsByName = new Map<string, StructuredToolInterface>(
  tools.map((item) => [item.name, item] as const),
);

/** 按名称查找工具；找不到时返回 undefined，由调用方决定如何回填错误 */
export function findTool(name: string): StructuredToolInterface | undefined {
  return toolsByName.get(name);
}
