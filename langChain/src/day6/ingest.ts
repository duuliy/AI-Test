/**
 * Day 6 · 加载、切分与内存向量库
 *
 * 只做「文档 → 切分 → embedding → 内存向量库 → 相似度检索」，
 * 不接入 Agent，也不把检索封装成工具（那是 Day 7 的内容）。
 *
 * 本文件包含 5 个可复用函数，按调用顺序阅读：
 * loadDocuments → splitDocuments → resolveEmbeddings → buildVectorStore → 检索（在 rag.ts 里调用）
 */
// Document 是 LangChain 统一的数据容器：pageContent 放正文，metadata 放来源等信息
import { Document } from "@langchain/core/documents";
// 只导入类型，运行时会被擦除（verbatimModuleSyntax 要求类型导入必须显式标注）
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
// 内存向量库放在 @langchain/classic 里，注意路径是 vectorstores/memory
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
// 递归字符切分器：优先按段落/换行/句子等自然边界切，避免把句子切碎
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
// Node 内置的 Promise 版文件 API，不需要额外的文件加载库
import { readdir, readFile } from "node:fs/promises";
// 路径工具：取目录名、拼接路径、去掉扩展名
import { basename, dirname, join } from "node:path";
// 把 import.meta.url（file:// 开头）转成真正的文件系统路径
import { fileURLToPath } from "node:url";

// 本地哈希 embedding，USE_LOCAL_EMBEDDINGS=1 时使用
import { LocalHashEmbeddings } from "./hash-embeddings.js"; // 相对导入必须带 .js 后缀
// 真实 embedding 的构造函数，以及错误翻译函数
import { createEmbeddings, describeError } from "./model.js";

/** 文档目录：相对当前模块定位，避免依赖 cwd */
// dirname(fileURLToPath(import.meta.url)) 拿到当前文件所在目录，再拼上 docs
const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), "docs");

/** 切分参数：块大小与相邻块重叠长度 */
export const CHUNK_SIZE = 400; // 每块最多约 400 个字符
export const CHUNK_OVERLAP = 80; // 相邻块重叠 80 个字符，避免关键句被切断

/** 从 Markdown 第一个一级标题取标题，取不到时回落到文件名 */
function extractTitle(text: string, fallback: string): string {
  // 正则含义：行首 # + 空白 + 捕获行尾内容；m 让 ^ 匹配每一行的行首
  const match = text.match(/^#\s+(.+)$/m);
  // 取第 1 个捕获组并 trim；取不到就用 fallback（文件名）
  return match?.[1]?.trim() ?? fallback;
}

/** 读取 src/day6/docs 下的所有 Markdown，转成带 metadata 的 Document */
export async function loadDocuments(): Promise<Document[]> {
  // 读目录列表，只留 .md，再按文件名排序，保证每次输出顺序稳定
  const files = (await readdir(DOCS_DIR)).filter((file) => file.endsWith(".md")).sort();
  // 用一个数组收集所有 Document
  const documents: Document[] = [];

  // 逐篇处理：这里的 file 是文件名，例如 "rag.md"
  for (const file of files) {
    // 读文件内容；utf8 让它直接返回字符串而不是 Buffer
    const text = await readFile(join(DOCS_DIR, file), "utf8");
    // 标题缺失时的兜底值：去掉 .md 后缀的文件名
    const fallbackTitle = basename(file, ".md");
    // 构造一个 Document 并塞进数组
    documents.push(
      new Document({
        pageContent: text, // 正文：整篇 Markdown 的原始文本
        metadata: {
          source: `docs/${file}`, // 来源：相对 docs 目录的文件名，便于打印与过滤
          title: extractTitle(text, fallbackTitle), // 标题：优先取一级标题
        },
      }),
    );
  }

  // 返回加载结果，交给 splitDocuments
  return documents;
}

/**
 * 用递归字符切分器把每篇文档切成 chunk。
 * 逐篇切分而不是一次性切全部，这样 chunkIndex 的语义是「在当前文档内的序号」。
 */
export async function splitDocuments(documents: Document[]): Promise<Document[]> {
  // 创建切分器：400 字符一块，相邻块重叠 80 字符
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE, // 块目标大小
    chunkOverlap: CHUNK_OVERLAP, // 块之间的重叠长度
  });

  // 收集所有文档的 chunk
  const chunks: Document[] = [];

  // 逐篇切分，保证 chunkIndex 只在本篇内递增
  for (const document of documents) {
    // splitDocuments 会自动复制原 Document 的 metadata（source / title 会带过来）
    const pieces = await splitter.splitDocuments([document]);

    // 打印本篇的 chunk 数量，方便核对「文档被切成了多少块」
    console.log(`—— ${document.metadata.source}（${document.metadata.title}）：${pieces.length} 个 chunk ——`);
    // 取第一块用于预览
    const first = pieces[0];
    // 有内容才打印；noUncheckedIndexedAccess 要求先判空
    if (first) {
      // preview 会把换行压成空格并截断，保证预览只占一行
      console.log(`首块预览：${preview(first.pageContent, 120)}\n`);
    }

    // 给每块补上「在本篇文档内的序号」，同时收集到总数组
    pieces.forEach((piece, index) => {
      // metadata 是可写的普通对象，直接加字段即可
      piece.metadata.chunkIndex = index;
      // 追加到总数组
      chunks.push(piece);
    });
  }

  // 返回所有 chunk（顺序：按文件排序 → 按块序号）
  return chunks;
}

/** 建内存向量库：内存实现只在当前进程有效，重启即丢 */
export async function buildVectorStore(
  chunks: Document[], // 切分后的所有块
  embeddings: EmbeddingsInterface, // 实现了 embedDocuments/embedQuery 的对象
): Promise<MemoryVectorStore> {
  // fromDocuments 会调用 embeddings.embedDocuments 批量向量化，再建索引
  return MemoryVectorStore.fromDocuments(chunks, embeddings);
}

/** 把换行压成空格，方便单行打印 */
function preview(text: string, length: number): string {
  // \s+ 匹配所有空白字符，替换成单个空格；slice 截断到指定长度
  return text.replace(/\s+/g, " ").slice(0, length);
}

// 选择结果：embedding 实例 + 可读名称（名称用于明确打印当前用的是哪一种）
export type EmbeddingChoice = {
  embeddings: EmbeddingsInterface; // 真正传给向量库的 embedding 对象
  label: string; // 中文标签，例如「本地哈希（LocalHashEmbeddings）」
};

/**
 * 选择 embedding 实现，并明确打印当前用的是哪一种（不做静默 fallback）。
 * - 设置 USE_LOCAL_EMBEDDINGS=1 时使用本地哈希；
 * - 否则先发一次探测请求，失败时打印可读错误并退出。
 */
export async function resolveEmbeddings(): Promise<EmbeddingChoice> {
  // 环境变量为字符串 "1" 时走本地哈希，不需要网络，也不需要 API Key
  if (process.env.USE_LOCAL_EMBEDDINGS === "1") {
    // 直接返回本地实现和标签；这是显式选择，不是静默降级
    return { embeddings: new LocalHashEmbeddings(), label: "本地哈希（LocalHashEmbeddings）" };
  }

  // 默认路径：创建真实 embedding（内部会校验 OPENAI_API_KEY / OPENAI_BASE_URL）
  const embeddings = createEmbeddings();
  // 先发一条极短的探测请求：接口不存在、鉴权失败、模型名错误都会在这里暴露
  try {
    // embedQuery 只需要一个字符串，成本最低
    await embeddings.embedQuery("embedding 可用性探测");
    // 探测通过才返回，后面的建库就不会白跑
    return { embeddings, label: "OpenAIEmbeddings（真实向量模型）" };
  } catch (error) {
    // 把 401/404/429/超时等底层错误翻译成中文
    console.error(`OpenAIEmbeddings 调用失败：${describeError(error)}`);
    // 给出明确的自救方案，而不是偷偷换成哈希
    console.error("如果当前 provider 没有 embedding 接口，可设置 USE_LOCAL_EMBEDDINGS=1 改用本地哈希跑通流程。");
    // 以失败状态退出，避免上层拿到半成品
    process.exit(1);
  }
}
