/**
 * research 子图：search → compress
 * 输入单个 query，输出带来源的片段，由父图的 Send 并行调度。
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { ResearchSubgraphState, type ResearchSubgraphStateType } from "./state.js";
import { searchChunks } from "./retrieval.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 检索节点：模拟一点 IO 延迟，便于观察多个分支是否并行 */
async function searchNode(
  state: ResearchSubgraphStateType,
  config: LangGraphRunnableConfig,
): Promise<Partial<ResearchSubgraphStateType>> {
  const startedAt = Date.now();
  config.writer?.({ node: "research", message: `检索「${state.query}」` });

  await sleep(120);

  const hits = searchChunks(state.query, 2).map((chunk) => ({
    text: chunk.text,
    source: chunk.source,
    chunkIndex: chunk.chunkIndex,
  }));

  config.writer?.({
    node: "research",
    message: `「${state.query}」命中 ${hits.length} 段，耗时 ${Date.now() - startedAt}ms`,
  });

  return { hits, steps: [`research:search:${state.query}`] };
}

/** 压缩节点：每条片段截断到 180 字，保留来源信息 */
function compressNode(
  state: ResearchSubgraphStateType,
  config: LangGraphRunnableConfig,
): Partial<ResearchSubgraphStateType> {
  const findings = (state.hits ?? []).slice(0, 2).map((hit) => ({
    text: hit.text.length > 120 ? `${hit.text.slice(0, 120)}…` : hit.text,
    source: hit.source,
    chunkIndex: hit.chunkIndex,
  }));

  config.writer?.({
    node: "research",
    message: `「${state.query}」压缩为 ${findings.length} 条带来源片段`,
  });

  return { findings, steps: [`research:compress:${state.query}`] };
}

/** 编译后的子图不接 checkpointer，持久化由父图负责 */
export const researchSubgraph = new StateGraph(ResearchSubgraphState)
  .addNode("search", searchNode)
  .addNode("compress", compressNode)
  .addEdge(START, "search")
  .addEdge("search", "compress")
  .addEdge("compress", END)
  .compile();
