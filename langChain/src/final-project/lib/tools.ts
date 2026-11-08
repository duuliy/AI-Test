/**
 * 工具定义：知识库检索、当前时间、计算器
 *
 * tool() 工厂的三个核心要素：
 *   name       — 模型在 tool_calls 里引用的标识符，必须是 snake_case
 *   description — 模型"什么时候用这个工具"的唯一信息来源，必须写清楚
 *   schema     — Zod schema，约束参数形状；同时也作为模型的参数填写参考
 *
 * 可预期的业务错误（时区非法、除以零、检索为空）统一返回**字符串**，
 * 不抛异常。原因：toolErrorMiddleware 会把异常转成 ToolMessage，
 * 但如果工具自己能合理处理，返回错误字符串让模型决定怎么告诉用户，体验更好。
 */
import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { searchDocs } from "./rag";

/** getCurrentTime 的默认时区：上海东八区 */
const DEFAULT_TIMEZONE = "Asia/Shanghai";

/**
 * 知识库检索工具。
 * 调用 searchDocs(query, 4) 取前 4 条，格式化成模型可直接抄进回答的文本。
 * 每条格式：
 *   序号. [来源: 文件名#chunkIndex] 相似度 X.XXX
 *   正文
 *
 * description 里特意写明了"检索结果与问题无关时，说明知识库没有依据"，
 * 这是给模型的关键约束 —— 否则模型拿到一段看似相关的片段，
 * 可能会从中硬抠一个答案出来。
 */
export const searchKnowledgeBase = tool(
  async ({ query }) => {
    const results = await searchDocs(query, 4);

    if (results.length === 0) {
      return "知识库中没有找到相关内容。";
    }

    const lines: string[] = [];
    for (const [index, hit] of results.entries()) {
      lines.push(
        `${index + 1}. [来源: ${hit.source}#${hit.chunkIndex}] 相似度 ${hit.score.toFixed(3)}`,
      );
      lines.push(hit.content.trim());
      lines.push("");
    }

    return lines.join("\n").trim();
  },
  {
    name: "search_knowledge_base",
    description:
      "检索本地个人知识库，知识库包含 langchain.md（LangChain 基础概念）、rag.md（RAG 完整流程）、agent.md（Agent / middleware / checkpointer）。" +
      "当问题涉及这些文档的概念或流程时调用；返回按相似度排序的片段，每段带 [来源: 文件名#chunkIndex]、相似度和正文。" +
      "如果检索结果与问题无关，说明知识库没有依据，应直接回答不知道，不要用常识补全。",
    schema: z.object({
      query: z.string().min(1).describe("检索用的问题或关键词，尽量具体，例如“RAG 的切分步骤”"),
    }),
  },
);

/**
 * 当前时间工具。
 * Intl.DateTimeFormat 遇到非法时区（比如 "Shanghai" 而不是 "Asia/Shanghai"）
 * 会抛 RangeError，try/catch 把它转成提示字符串回填给模型。
 * 返回同时带本地时间和 UTC ISO —— 模型如果需要跨时区计算，ISO 更方便。
 */
export const getCurrentTime = tool(
  ({ timezone }) => {
    const tz = timezone?.trim() || DEFAULT_TIMEZONE;
    const now = new Date();

    try {
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
      // Intl 遇到非法时区抛 RangeError，这里转成字符串回填给模型
      return `错误：无法识别的时区 "${tz}"。请使用 IANA 时区名，例如 Asia/Shanghai、Asia/Tokyo、America/New_York。`;
    }
  },
  {
    name: "get_current_time",
    description:
      "获取指定 IANA 时区的当前本地时间和 UTC ISO 时间。用户询问“现在几点”“今天几号”“某地时间”时必须调用。timezone 省略时默认 Asia/Shanghai。",
    schema: z.object({
      timezone: z
        .string()
        .optional()
        .describe("IANA 时区名，例如 Asia/Shanghai、Asia/Tokyo；省略时默认 Asia/Shanghai"),
    }),
  },
);

/**
 * 计算器：两个数字 + 一个枚举运算符，禁止 eval。
 * 只支持二元运算 +、-、*、/，不支持嵌套表达式 ——
 * 让模型必须一次只算一步，避免它把复杂算式塞给我们然后解析出错。
 */
export const calculate = tool(
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
      "对两个数字做一次四则运算。op 只能是 +、-、*、/。用户要求算数时必须调用，不要心算。",
    schema: z.object({
      a: z.number().describe("第一个操作数"),
      b: z.number().describe("第二个操作数"),
      op: z.enum(["+", "-", "*", "/"]).describe("运算符，只能是 +、-、*、/"),
    }),
  },
);

/**
 * 把三个具体 tool 的联合类型擦成统一的 StructuredToolInterface。
 * 这样 toolsByRoute[route] 数组类型就是统一的 AppTool[]，
 * createAgent({ tools }) 不用再做类型兼容。
 */
export type AppTool = StructuredToolInterface;

/**
 * 按路由预组装的工具集合。
 * knowledge 路由放开三个工具（检索为主、时间和计算为辅）；
 * time 和 general 只放时间和计算 —— 不放检索是为了避免模型"拿知识库回答闲聊"。
 */
export const knowledgeTools: AppTool[] = [searchKnowledgeBase, getCurrentTime, calculate];
export const basicTools: AppTool[] = [getCurrentTime, calculate];
