/**
 * Day 3: 工具定义
 *
 * 知识点：
 * - tool() 把「函数 + 参数 schema + 描述」包装成模型可识别的工具
 * - 模型只看到 name / description / schema，不会看到函数实现
 * - 工具函数的返回值会被序列化成 ToolMessage.content 回填给模型
 */

import { z } from "zod";
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";

// 模块内固定的小文档库，用来模拟检索，不接真实搜索 API
const DOCS = [
  "LangGraph 是一套用图结构编排 AI 工作流的库：节点是函数，边定义执行顺序。",
  "条件边 addConditionalEdges 让图根据当前状态选择下一个节点，从而实现分支与循环。",
  "ReAct 模式让模型先思考、再调用工具、再根据工具结果继续思考，直到不再需要工具。",
  "ToolMessage 用来把工具执行结果回填给模型，tool_call_id 必须与模型发起的调用一一对应。",
  "recursionLimit 限制图的最大执行步数，防止循环图因为路由错误陷入死循环。",
];

/**
 * 最简单的关键词打分：把查询按空白和标点切开，统计命中多少个词
 */
function scoreDoc(doc: string, query: string): number {
  const terms = query
    .toLowerCase()
    .split(/[\s，,。.?？!！、]+/)
    .filter((term) => term.length > 0);

  const lowerDoc = doc.toLowerCase();
  return terms.reduce((score, term) => (lowerDoc.includes(term) ? score + 1 : score), 0);
}

/**
 * 工具 1：获取当前时间
 */
export const getCurrentTimeTool = tool(
  async ({ timezone }: { timezone?: string }) => {
    const now = new Date();
    if (timezone) {
      try {
        return now.toLocaleString("zh-CN", { timeZone: timezone });
      } catch {
        return `无效的时区：${timezone}（请使用 IANA 名称，例如 Asia/Shanghai）`;
      }
    }
    return now.toLocaleString("zh-CN");
  },
  {
    name: "get_current_time",
    description:
      "获取当前日期和时间。当用户询问现在几点、今天几号、某个城市的当前时间时调用；支持可选的时区参数。",
    schema: z.object({
      timezone: z
        .string()
        .optional()
        .describe("IANA 时区名称，例如 Asia/Shanghai；不传则使用系统本地时区"),
    }),
  }
);

/**
 * 工具 2：四则运算
 * 禁止使用 eval / new Function，直接按 op 分支计算
 */
export const calculateTool = tool(
  async ({ a, b, op }: { a: number; b: number; op: "+" | "-" | "*" | "/" }) => {
    switch (op) {
      case "+":
        return String(a + b);
      case "-":
        return String(a - b);
      case "*":
        return String(a * b);
      case "/":
        if (b === 0) return "错误：除数不能为 0";
        return String(a / b);
    }
  },
  {
    name: "calculate",
    description:
      "执行两个数字的四则运算。当用户要求加、减、乘、除，或给出了需要计算的算式时调用；除数为 0 时返回错误文案。",
    schema: z.object({
      a: z.number().describe("第一个数字"),
      b: z.number().describe("第二个数字"),
      op: z.enum(["+", "-", "*", "/"]).describe("运算符"),
    }),
  }
);

/**
 * 工具 3：本地文档检索
 */
export const searchDocsTool = tool(
  async ({ query }: { query: string }) => {
    const matched = DOCS.map((doc) => ({ doc, score: scoreDoc(doc, query) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 2)
      .map((item) => item.doc);

    if (matched.length === 0) return "没有找到相关内容";
    return matched.join("\n---\n");
  },
  {
    name: "search_docs",
    description:
      "在本地固定的 LangGraph 学习文档里做关键词检索，返回最相关的前两条。当用户询问 LangGraph 的概念、条件边、ReAct、ToolMessage、recursionLimit 时调用。",
    schema: z.object({
      query: z.string().describe("检索关键词或问题"),
    }),
  }
);

/**
 * 工具 4：故意失败的工具，用于验证异常兜底
 */
export const brokenLookupTool = tool(
  async ({ query }: { query: string }) => {
    // 参数只是为了让 schema 和真实工具一致
    void query;
    throw new Error("检索服务不可用");
  },
  {
    name: "broken_lookup",
    description:
      "一个故意不可用的检索服务，调用必定抛出异常。仅用于演示工具异常兜底；当用户明确提到 broken lookup 时调用。",
    schema: z.object({
      query: z.string().describe("要检索的内容"),
    }),
  }
);

/** 传给 bindTools 的工具数组 */
export const tools = [getCurrentTimeTool, calculateTool, searchDocsTool, brokenLookupTool];

/** 工具名 → 工具实例，供 toolsNode 按名字查找 */
export const toolMap: Record<string, StructuredToolInterface> = Object.fromEntries(
  tools.map((item) => [item.name, item])
);
