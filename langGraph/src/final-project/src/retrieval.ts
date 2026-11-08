/**
 * 本地知识库检索：按关键词命中数打分，返回 Top 3 段落。
 * 不做 embedding，也不接外部检索 API。
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export interface Chunk {
  /** 文件名，例如 checkpointing.md */
  source: string;
  /** 段落序号（从 1 开始） */
  chunkIndex: number;
  /** 段落正文 */
  text: string;
}

/** docs 目录相对本文件解析，不依赖进程启动目录 */
const DOCS_DIR = fileURLToPath(new URL("../docs", import.meta.url));

/** 启动时把三篇 Markdown 切成段落，空段落和纯标题段落跳过 */
function loadChunks(): Chunk[] {
  const files = readdirSync(DOCS_DIR)
    .filter((file) => file.endsWith(".md"))
    .sort();

  const chunks: Chunk[] = [];

  for (const file of files) {
    const raw = readFileSync(join(DOCS_DIR, file), "utf8");
    const paragraphs = raw
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length > 0)
      .filter((paragraph) => !/^#{1,6}\s/.test(paragraph));

    paragraphs.forEach((text, index) => {
      chunks.push({ source: file, chunkIndex: index + 1, text });
    });
  }

  return chunks;
}

const CHUNKS = loadChunks();

/**
 * 从查询里抽关键词：
 * - 英文/数字按单词切分
 * - 中文按二元组切分，避免引进分词库
 */
function keywordsOf(query: string): string[] {
  const lower = query.toLowerCase();

  const latin = (lower.match(/[a-z0-9][a-z0-9.+#_-]*/g) ?? []).filter((token) => token.length >= 2);
  const cjkRuns = lower.match(/[\u4e00-\u9fff]+/g) ?? [];
  const cjk: string[] = [];

  for (const run of cjkRuns) {
    if (run.length === 1) cjk.push(run);
    for (let index = 0; index + 1 < run.length; index += 1) {
      cjk.push(run.slice(index, index + 2));
    }
  }

  return Array.from(new Set([...latin, ...cjk]));
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);

  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }

  return count;
}

/** 命中关键词越多分越高；同分时保持文档与段落原始顺序 */
function scoreChunk(chunk: Chunk, keywords: string[]): number {
  const text = `${chunk.source}\n${chunk.text}`.toLowerCase();
  let score = 0;

  for (const keyword of keywords) {
    score += countOccurrences(text, keyword);
  }

  return score;
}

/** 按关键词命中数打分，返回得分最高的 limit 条（默认 3） */
export function searchChunks(query: string, limit = 3): Chunk[] {
  const keywords = keywordsOf(query);

  return CHUNKS.map((chunk) => ({ chunk, score: scoreChunk(chunk, keywords) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ chunk }) => chunk);
}
