/**
 * Day 6 · RAG 检索 CLI
 *
 * 用法：npm run day6 -- "问题"
 * 默认问题：RAG 的完整流程是什么？
 *
 * 阅读顺序建议：先看 rag.ts 的 main（整体流程），再跳到 ingest.ts 的各个函数，
 * 最后看 hash-embeddings.ts（只在兜底时才用得到）。
 */
// 从同目录的 ingest 模块导入：加载文档、切分、建库、选择 embedding，以及切分参数
import {
  CHUNK_OVERLAP, // 相邻 chunk 的重叠字符数
  CHUNK_SIZE, // 每个 chunk 的目标字符数
  buildVectorStore, // 把 chunk 转成向量并写入内存向量库
  loadDocuments, // 读取 docs/*.md 并转成 Document
  resolveEmbeddings, // 选择真实 embedding 还是本地哈希
  splitDocuments, // 把长文档切成 chunk
} from "./ingest.js"; // NodeNext 模块解析要求相对导入带 .js 后缀
// 导入错误翻译与 .env 加载：这两个函数是从 Day 1/Day 5 复制到本目录的
import { describeError, loadEnv } from "./model.js";
// 只导入类型：用来给调试打印函数的参数标注类型，运行时会被擦除
import type { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";

// 没有传命令行参数时使用的默认问题
const DEFAULT_QUERY = "RAG 的完整流程是什么？";
// 检索返回的条数（Top K）
const TOP_K = 3;

/** 取命令行第一个参数作为问题 */
function readQuery(): string {
  // process.argv[2] 才是「npm run day6 -- "问题"」里传进来的问题（argv[0] 是 node，argv[1] 是脚本）
  const query = process.argv[2]?.trim();
  // 参数为空或全是空格时回落到默认问题
  return query && query.length > 0 ? query : DEFAULT_QUERY;
}

/**
 * 打印「文本 → 向量」的映射，用来直观看到 embedding 到底产出了什么。
 * 直接读取 store.memoryVectors（MemoryVectorStore 的公开字段），不会额外发请求。
 */
function printEmbeddingMapping(store: MemoryVectorStore, full: boolean): void {
  // 每条记录包含 content（原文）、embedding（向量）、metadata（source/chunkIndex）
  const vectors = store.memoryVectors;
  // 维度从第一条向量取；没有数据时记 0，避免访问 undefined
  const dimensions = vectors[0]?.embedding.length ?? 0;

  // 打印标题，把当前模式也带上，方便区分输出
  console.log(`\n—— embedding 映射（DEBUG_EMBEDDINGS=${full ? "full" : "1"}）——`);
  // 先给出整体信息：条数与维度（真实模型通常是 1024/1536/2048，本地哈希是 256）
  console.log(`向量条数：${vectors.length}，维度：${dimensions}`);

  // 逐条打印映射关系
  vectors.forEach((vector, index) => {
    // 从 metadata 里取出定位信息
    const { source, chunkIndex } = vector.metadata;
    // 取前 8 维或全部维度，统一保留 4 位小数，负号便于观察正负分布
    const shown = (full ? vector.embedding : vector.embedding.slice(0, 8)).map((value) => value.toFixed(4)).join(", ");
    // 计算 L2 范数：真实 embedding 通常接近 1，本地哈希经归一化后严格为 1
    const norm = Math.sqrt(vector.embedding.reduce((sum, value) => sum + value * value, 0));
    // 第一行：序号、来源、块序号、原文长度、范数
    console.log(`\n${index + 1}. ${source}#${chunkIndex}（原文 ${vector.content.length} 字）范数=${norm.toFixed(4)}`);
    // 第二行：向量本身（前 8 维或全量）
    console.log(`   ${full ? "完整向量" : "前 8 维"}：[${shown}]`);
    // 第三行：原文开头，和向量放在一起才能在输出里对上号
    console.log(`   文本：${vector.content.replace(/\s+/g, " ").slice(0, 80)}`);
  });
}

// 主流程：加载 → 切分 → 选 embedding → 建库 → 检索 → 打印
async function main(): Promise<void> {
  // 先读 .env，把 OPENAI_API_KEY 等变量装进 process.env
  loadEnv();

  // 调试开关在读完 .env 之后读取，这样写在 .env 里也生效："1" 打印前 8 维，"full" 打印完整向量
  const debugEmbeddings = process.env.DEBUG_EMBEDDINGS;

  // 解析本次要检索的问题
  const query = readQuery();

  // 打印标题
  console.log("LangChain.js Day 6 · RAG 入库与检索");
  // 打印当前切分参数，方便对照结果解释 chunk 数量
  console.log(`切分参数：chunkSize=${CHUNK_SIZE}，chunkOverlap=${CHUNK_OVERLAP}\n`);

  // 第 1 步：加载 3 篇 Markdown，每篇变成一个 Document（带 source/title）
  const documents = await loadDocuments();
  // 打印文档数量
  console.log(`文档数：${documents.length}\n`);

  // 第 2 步：切分；函数内部会打印每篇的 chunk 数和首块预览
  const chunks = await splitDocuments(documents);
  // 第 3 步：决定用真实 embedding 还是本地哈希，label 用来告诉用户当前是哪一种
  const { embeddings, label } = await resolveEmbeddings();
  // 第 4 步：把所有 chunk 向量化并放进内存向量库（这一步会真正发起 embedding 请求）
  const store = await buildVectorStore(chunks, embeddings);

  // 打印 chunk 总数（换行符让前面的预览和这段汇总之间空一行）
  console.log(`\nchunk 总数：${chunks.length}`);
  // 明确打印当前使用的 embedding，避免静默 fallback
  console.log(`embedding：${label}`);
  // 打印本次检索的问题
  console.log(`问题：${query}\n`);

  // 设置了 DEBUG_EMBEDDINGS 时，把 chunk 文本与向量的映射打印出来
  if (debugEmbeddings) {
    // full 打印完整向量，其他真值打印前 8 维
    printEmbeddingMapping(store, debugEmbeddings === "full");
  }

  // 第 5 步：把问题也转成向量，返回分数最高的 TOP_K 个 chunk；每项是 [Document, 分数]
  const results = await store.similaritySearchWithScore(query, TOP_K);

  // 打印结果标题
  console.log(`Top ${results.length} 检索结果：`);
  // 解构出文档和分数；index 从 0 开始，打印时 +1
  results.forEach(([document, score], index) => {
    // 分数保留 4 位小数；metadata 里的 source 和 chunkIndex 用来定位原文位置
    console.log(`\n${index + 1}. 分数 ${score.toFixed(4)} | ${document.metadata.source} | chunkIndex=${document.metadata.chunkIndex}`);
    // 把换行压成空格并截断到 120 字，保证每条结果只占一行
    console.log(`   ${document.pageContent.replace(/\s+/g, " ").slice(0, 120)}`);
  });
}

// 顶层 await 调用主流程；失败时统一走 describeError 的中文提示
try {
  // 等待整个异步流程跑完
  await main();
} catch (error) {
  // 把网络 / 鉴权 / 超时等底层错误翻译成中文
  console.error(`执行失败：${describeError(error)}`);
  // 以非 0 退出码结束，方便 npm 脚本判断失败
  process.exit(1);
}
