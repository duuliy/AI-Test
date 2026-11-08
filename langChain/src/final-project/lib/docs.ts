/**
 * 本地知识库加载
 *
 * 读取 docs/*.md，每篇转成一个 Document 对象。
 * Document 是 LangChain 的通用载体：pageContent 存正文，metadata 存溯源信息。
 * 为什么 metadata 里必须带 source：
 *   检索阶段模型要引用来源，我们在 tool 的 description 里明确告诉模型
 *   "返回 [来源: 文件名#chunkIndex]"，source 就是那个文件名。
 *
 * Docs 目录的硬编码说明：
 *   process.cwd() 在 Next.js dev / build 时都是 project root（src/final-project），
 *   所以 join(process.cwd(), "docs") 就是 src/final-project/docs。
 *   如果把 docs 移到别处，改这里的 join 即可。
 */
import { Document } from "@langchain/core/documents";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

const DOCS_DIR = join(process.cwd(), "docs");

/**
 * 从 Markdown 第一个一级标题抽标题。
 * 用 /m（多行模式）让 ^ 匹配行首。
 * 取不到时回落到文件名（去掉 .md 后缀），这样即使文档没写标题也不会出错。
 */
function extractTitle(content: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(content);
  return match?.[1]?.trim() ?? fallback;
}

/**
 * 加载所有 .md 文件。
 * sort() 保证每次加载顺序一致，让 chunkIndex 编号稳定（第一篇文档永远从 0 开始）。
 * 空目录直接抛错，让问题尽早暴露——总不能让模型"不知道答什么"而默默乱说。
 */
export async function loadDocuments(): Promise<Document[]> {
  const files = (await readdir(DOCS_DIR)).filter((file) => file.endsWith(".md")).sort();

  if (files.length === 0) {
    throw new Error(`docs 目录下没有 Markdown 文件：${DOCS_DIR}`);
  }

  const documents: Document[] = [];

  for (const file of files) {
    const content = await readFile(join(DOCS_DIR, file), "utf8");
    const fallbackTitle = basename(file, ".md");

    documents.push(
      new Document({
        pageContent: content,
        metadata: {
          source: file, // 文件名，如 "rag.md"；检索后直接拼进引用格式
          title: extractTitle(content, fallbackTitle),
        },
      }),
    );
  }

  return documents;
}
