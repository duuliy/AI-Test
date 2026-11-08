/**
 * RAG 链路：文档加载 → 切分 → embedding → 内存向量库 → 检索
 *
 * 为什么"建库"必须单例：
 *   建库需要对每个 chunk 跑一次 embedding（调用真实 embedding API 或本地 hash），
 *   而且 MemoryVectorStore.fromDocuments() 内部还会把所有向量一次性塞进去。
 *   每请求都重建一次，光是模型冷启动 + embed 三篇文档 × N 个 chunk，
 *   每次对话要浪费几秒到几十秒。所以用模块级 Promise 单例缓存。
 *
 * 为什么不用持久化向量库（SQLite / Postgres pgvector）：
 *   final-project 目标是"跑通 RAG 全流程"，不是做生产级搜索服务。
 *   进程重启即丢，反而让"改了 docs 目录后，重新建库生效"这件事变得直观。
 */
import { Document } from "@langchain/core/documents";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { loadDocuments } from "./docs";
import { createEmbeddings } from "./embeddings";

/**
 * 块大小与重叠。
 * chunkSize=400 约覆盖一个小节（按中文，约 200-300 字）。
 * chunkOverlap=80 保证跨块的句子不被硬切断 ——
 * 否则一句完整的话刚好落在两个 chunk 边界上，检索时就会被拆成两半、都不够像。
 */
const CHUNK_SIZE = 400;
const CHUNK_OVERLAP = 80;

/** 检索结果：业务友好的 flat 类型，屏蔽 LangChain 原始的 [Document, score] 元组 */
export type DocHit = {
  content: string;
  source: string;
  /** 在**当前文档内**的 chunk 序号（从 0 开始），用于溯源标注 */
  chunkIndex: number;
  /** 余弦相似度；越高越相似 */
  score: number;
};

/**
 * 切分 + 给每个 chunk 打 chunkIndex。
 * chunkIndex 是"当前文档内的序号"，不是全局序号 ——
 * 这样引用格式 [来源: rag.md#2] 的语义就清晰可独立。
 *
 * LangChain 的 splitter 默认不打 chunkIndex，需要自己遍历后写入 metadata。
 */
async function loadAndSplit(): Promise<Document[]> {
  const documents = await loadDocuments();

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });
  const chunks = await splitter.splitDocuments(documents);

  // 按 source 分组计数：每篇文档从 0 开始重新编号
  const counters = new Map<string, number>();
  for (const chunk of chunks) {
    const source = String(chunk.metadata.source ?? "unknown");
    const index = counters.get(source) ?? 0;
    chunk.metadata.chunkIndex = index;
    counters.set(source, index + 1);
  }

  return chunks;
}

/** 缓存"建库"这个 Promise。模式同 modelPromise / runnerPromise：失败时清缓存 */
let vectorStorePromise: Promise<MemoryVectorStore> | undefined;

async function buildVectorStore(): Promise<MemoryVectorStore> {
  const chunks = await loadAndSplit();
  const { embeddings, label } = createEmbeddings();

  // 启动时打印 chunk 数量和 embedding 实现，方便肉眼确认"建库是否正常"
  console.log(`[rag] 建库：${chunks.length} 个 chunk，embedding=${label}`);
  const store = await MemoryVectorStore.fromDocuments(chunks, embeddings);
  console.log("[rag] 内存向量库就绪");

  return store;
}

/**
 * 获取向量库单例。
 * 缓存 Promise 而不是实例：并发首请求也只会建一次库。
 * 和 getModel() 一样，catch 里把 vectorStorePromise 清回 undefined，
 * 让修好 env 或 embedding 配置后的下一次调用能重试。
 */
export function getVectorStore(): Promise<MemoryVectorStore> {
  if (!vectorStorePromise) {
    vectorStorePromise = buildVectorStore().catch((error: unknown) => {
      vectorStorePromise = undefined;
      throw error;
    });
  }
  return vectorStorePromise;
}

/**
 * 检索知识库。
 * k=4 是经验值：太少时覆盖不足，太多时给模型塞太多片段反而干扰判断。
 * 调用方（search_knowledge_base 工具）会把 DocHit[] 格式化成模型可读的文本。
 */
export async function searchDocs(query: string, k = 4): Promise<DocHit[]> {
  const store = await getVectorStore();
  // similaritySearchWithScore 返回 [Document, score][]，score 是余弦相似度（0~1，越高越像）
  const results = await store.similaritySearchWithScore(query, k);

  return results.map(([document, score]) => ({
    content: document.pageContent,
    source: String(document.metadata.source ?? "unknown"),
    chunkIndex: Number(document.metadata.chunkIndex ?? 0),
    score,
  }));
}
