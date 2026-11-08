/**
 * Embedding 实现选择
 *
 * 默认走 OpenAIEmbeddings（走真实向量模型）；
 * 设置 USE_LOCAL_EMBEDDINGS=1 时改用本地哈希。
 *
 * 关键约束：两种实现都必须在控制台明确打印自己是谁。
 * 不做静默 fallback —— 否则用户看到检索结果很差时，
 * 完全不知道是"选了本地哈希"还是"真实 embedding 质量就是不行"。
 */
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { Embeddings } from "@langchain/core/embeddings";
import { OpenAIEmbeddings } from "@langchain/openai";
import { createHash } from "node:crypto";
import {
  readEmbeddingModel,
  readModelConfig,
  REQUEST_TIMEOUT_MS,
  useLocalEmbeddings,
} from "./env";

/**
 * 本地哈希向量维度。
 * 256 是经验值：太低（64）时"RAG"和"Agent"容易撞到同一个槽位，
 * 太高（1024）时 build 阶段的 hash 计算也变慢。
 * 真实 embedding 模型的维度通常是 768~1536，这里故意选低一个量级来强调"这只是占位"。
 */
const LOCAL_DIMENSIONS = 256;

/**
 * 把一段文本切成 token 列表。
 * 英文按单词/符号切，中文按单字 + 相邻二字组合。
 * 相邻二字组合的作用：缓解单字歧义。
 * 比如"RAG"单字切出来是 R、A、G，加上相邻组合就是 R、RA、A、AG、G，
 * 同义词 "检索增强生成" 里的 "增强" 两个字就能和这段文本产生重叠。
 */
function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const tokens: string[] = [];

  // 英文 / 数字 / 下划线 / 点号：regex 一次性匹配整个单词
  for (const match of normalized.matchAll(/[a-z0-9_.-]+/g)) {
    tokens.push(match[0]);
  }

  // 按字符遍历（扩展运算符能正确处理 emoji / 中文）
  const chars = [...normalized].filter((char) => !/\s/.test(char));
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (!char) continue;
    tokens.push(char); // 单字

    const next = chars[index + 1];
    if (next) tokens.push(char + next); // 相邻二字组合
  }

  return tokens;
}

/**
 * 确定性 hash：同一个 token 永远映射到同一个维度下标 + 同一个正负号。
 * 前 4 字节 → 下标（模 LOCAL_DIMENSIONS），第 5 字节最低位 → 符号（+1 / -1）。
 * 用 sha256 而不是简单的 String.prototype.charCodeAt 循环：
 * 后者很容易让"ab"和"ba"撞下标，sha256 的雪崩效应能避免。
 */
function hashToken(token: string): { index: number; sign: number } {
  const digest = createHash("sha256").update(token).digest();
  const index = digest.readUInt32BE(0) % LOCAL_DIMENSIONS;
  const sign = (digest.readUInt8(4) & 1) === 1 ? 1 : -1;
  return { index, sign };
}

/**
 * 组装向量：每个 token 往对应槽位 ±1，然后做 L2 归一化。
 * 归一化后，向量长度恒为 1，余弦相似度就直接等于两个归一化向量的点积。
 * 这让 MemoryVectorStore 内部的 similaritySearch 逻辑完全不用改。
 * 如果文本全是空白（norm === 0），直接返回全零向量，避免除以 0。
 */
function embedText(text: string): number[] {
  const vector = new Array<number>(LOCAL_DIMENSIONS).fill(0);

  for (const token of tokenize(text)) {
    const { index, sign } = hashToken(token);
    vector[index] = (vector[index] ?? 0) + sign;
  }

  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);

  return norm === 0 ? vector : vector.map((value) => value / norm);
}

/**
 * 本地哈希 embedding 实现。
 * 继承 LangChain 抽象基类，只实现 embedDocuments（批量建库）和 embedQuery（搜索）。
 * 语义检索质量远不如真实向量模型，但能让"建库 → 检索 → 问答"整条链路跑通，
 * 适合在没有 embedding 接口时做演示。
 */
class LocalHashEmbeddings extends Embeddings {
  constructor() {
    super({});
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    return documents.map((document) => embedText(document));
  }

  async embedQuery(document: string): Promise<number[]> {
    return embedText(document);
  }
}

export type EmbeddingChoice = {
  embeddings: EmbeddingsInterface;
  /** 人类可读的实现标签，用于日志打印 */
  label: string;
};

/** 和 modelPromise 同模式：缓存 Promise 或值，失败后允许重试 */
let embeddingChoice: EmbeddingChoice | undefined;

/** 单例入口；和 getModel() 不同，embeddingChoice 本身不是 Promise（构造都是同步的） */
export function createEmbeddings(): EmbeddingChoice {
  if (embeddingChoice) {
    return embeddingChoice;
  }

  if (useLocalEmbeddings()) {
    const label = "本地哈希 embedding（LocalHashEmbeddings，仅用于演示）";
    // 明确打印当前实现，方便排查"为什么检索结果看起来不对"
    console.log(`[embeddings] 当前使用：${label}`);
    embeddingChoice = { embeddings: new LocalHashEmbeddings(), label };
    return embeddingChoice;
  }

  // 走真实 embedding 路径时，才需要校验 OPENAI_EMBEDDING_MODEL
  const { apiKey, baseURL } = readModelConfig();
  const model = readEmbeddingModel();
  const label = `OpenAIEmbeddings（模型 ${model}）`;

  console.log(`[embeddings] 当前使用：${label}`);

  embeddingChoice = {
    embeddings: new OpenAIEmbeddings({
      apiKey,
      model,
      configuration: { baseURL },
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 2,
    }),
    label,
  };
  return embeddingChoice;
}
