/**
 * Day 7 · 复用 Day 6 的入库流程
 *
 * Day 6 已经实现了完整链路：读取 docs → 切分 → 选择 embedding → 建内存向量库。
 * Day 7 不再复制这些代码，只做一层「懒加载 + 缓存」的薄封装：
 * 第一次检索时调用 Day 6 的函数建库，之后的检索复用同一个 MemoryVectorStore。
 *
 * 注意：loadDocuments() 读取的是 src/day6/docs 下的三篇文档，
 * 因此 Day 7 的知识库与 Day 6 完全一致（langchain-basics / rag / agents）。
 */
// 内存向量库的类型，用于给缓存 Promise 标注返回类型
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
// 从 Day 6 直接复用四个函数，避免重复实现加载、切分和 embedding 逻辑
import {
  buildVectorStore, // 把 chunk 转成向量并写入内存向量库
  loadDocuments, // 读取 src/day6/docs/*.md 并转成 Document
  resolveEmbeddings, // 真实 embedding 与本地哈希二选一
  splitDocuments, // 400/80 递归切分并补 chunkIndex
} from "../day6/ingest.js"; // NodeNext 要求相对导入带 .js 后缀

/** 模块级缓存：整个进程只建一次库 */
let vectorStorePromise: Promise<MemoryVectorStore> | undefined; // 缓存的是 Promise，而不是建好的实例

/** 调用 Day 6 的三个步骤完成建库；只在第一次检索时执行 */
async function buildFromDay6(): Promise<MemoryVectorStore> {
  console.log("\n首次建库：复用 Day 6 的加载 → 切分 → embedding → 内存向量库"); // 明确提示这是复用而非重写
  const documents = await loadDocuments(); // 第 1 步：Day 6 读取 docs 目录下的三篇 Markdown
  const chunks = await splitDocuments(documents); // 第 2 步：Day 6 切分，并打印每篇的 chunk 数与首块预览
  const { embeddings, label } = await resolveEmbeddings(); // 第 3 步：Day 6 决定用真实 embedding 还是本地哈希
  console.log(`embedding：${label}`); // 打印当前 embedding 类型，避免静默 fallback
  const store = await buildVectorStore(chunks, embeddings); // 第 4 步：批量向量化并建索引，这一步会真正发网络请求
  console.log(`建库完成：${chunks.length} 个 chunk\n`); // 打印总块数，作为建库完成的标志
  return store; // 返回可检索的 MemoryVectorStore
}

/**
 * 获取内存向量库。
 * 第一次调用时通过 Day 6 建库，之后的调用直接复用同一个实例，不会重复 embed。
 * 缓存 Promise 而不是结果：并发的检索工具调用也会等待同一次建库。
 */
export function getVectorStore(): Promise<MemoryVectorStore> {
  // 还没有缓存过建库任务时才真正去建库
  if (!vectorStorePromise) {
    // 把建库 Promise 存起来，后续调用直接复用
    vectorStorePromise = buildFromDay6().catch((error: unknown) => {
      // 建库失败时清空缓存，允许调用方重试
      vectorStorePromise = undefined; // 避免把失败状态永久缓存
      throw error; // 把错误抛给当前调用方，由 rag-agent 统一翻译
    });
  }
  return vectorStorePromise; // 所有调用方共享同一个建库 Promise / 实例
}
