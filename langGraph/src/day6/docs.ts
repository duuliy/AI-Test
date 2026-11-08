/**
 * Day 6: 本地短文档与关键词检索
 *
 * 这里不做 embedding，只提供可检索的固定内容，让子图和 supervisor 有真实一点的输入。
 */

export interface Doc {
  id: string;
  title: string;
  content: string;
}

/** 三篇短文档，覆盖 LangGraph、RAG、前端流式 */
export const DOCS: Doc[] = [
  {
    id: "doc-langgraph",
    title: "LangGraph 状态图",
    content:
      "LangGraph 用状态图编排 Agent：状态是跨节点共享的数据结构，节点返回部分更新，边决定执行顺序。" +
      "条件边负责分支与循环，Send 可以把列表动态分发成多个并行分支，编译后的子图还能作为父图的一个节点复用。",
  },
  {
    id: "doc-rag",
    title: "RAG 检索增强生成",
    content:
      "RAG 先按语义把用户问题检索到相关文档片段，再把片段和问题一起交给模型生成答案。" +
      "工程上需要 chunk、embedding、向量检索和引用来源；没有检索命中的问题应当明确说明，而不是编造。",
  },
  {
    id: "doc-streaming",
    title: "前端流式输出",
    content:
      "前端流式通常使用 SSE 或 fetch + ReadableStream 读取服务端逐字返回的 token。" +
      "需要处理 AbortController 取消、连接断开重试，以及把 JSON 事件映射成界面上的进度状态。",
  },
];

/** 用于打分的领域关键词 */
const KEYWORDS = [
  "langgraph",
  "rag",
  "检索",
  "引用",
  "状态图",
  "子图",
  "并行",
  "supervisor",
  "流式",
  "前端",
  "sse",
  "abortcontroller",
  "embedding",
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 按查询词命中次数打分；同分时保持文档原始顺序 */
function scoreDoc(doc: Doc, query: string): number {
  const q = query.toLowerCase();
  const text = `${doc.title}\n${doc.content}`.toLowerCase();
  let score = 0;

  for (const keyword of KEYWORDS) {
    if (!q.includes(keyword)) continue;
    const matches = text.match(new RegExp(escapeRegExp(keyword), "gi"));
    score += matches ? matches.length : 0;
  }

  // 英文查询词直接参与匹配（例如 "LangGraph"）
  const queryTokens = q.match(/[a-z][a-z0-9+#.-]*/g) ?? [];
  for (const token of queryTokens) {
    const matches = text.match(new RegExp(escapeRegExp(token), "gi"));
    score += matches ? matches.length : 0;
  }

  return score;
}

/** 关键词检索，返回得分最高的两条 */
export function searchDocs(query: string): Doc[] {
  return [...DOCS]
    .map((doc) => ({ doc, score: scoreDoc(doc, query) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map(({ doc }) => doc);
}

/** 把检索结果格式化成一段带来源的文本 */
export function formatDocs(docs: Doc[]): string {
  if (docs.length === 0) return "（没有检索到相关文档）";
  return docs.map((doc) => `[${doc.id}] ${doc.title}：${doc.content}`).join("\n");
}
