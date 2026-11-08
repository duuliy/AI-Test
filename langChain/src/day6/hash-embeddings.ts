/**
 * Day 6 · 本地哈希 embedding（兜底方案）
 *
 * 当前 provider 可能没有 embedding 接口，这时用它把流程跑通。
 * 实现方式是「词袋 + 哈希」：把文本拆成字符与相邻字符组合，
 * 每个 token 用 sha256 映射到固定维度的某个下标，最后做 L2 归一化。
 *
 * 注意：本地哈希只适合跑通流程，语义检索质量远不如真实 embedding。
 * 它只能捕捉字面重叠，同义改写、跨语言、长距离语义关系都识别不了，
 * 任何正式场景都应换成真实的向量模型。
 */
// Embeddings 是 LangChain 的抽象基类，继承后就能被 MemoryVectorStore 使用
import { Embeddings } from "@langchain/core/embeddings";
// Node 内置的哈希工具，用来把任意 token 稳定地映射到固定下标
import { createHash } from "node:crypto";

/** 向量维度；维度越高冲突越少，但也越占内存 */
const DIMENSIONS = 256;

/** 把文本拆成 token：英文按单词，中文按单字与相邻二字组合 */
function tokenize(text: string): string[] {
  // 统一转小写，让 "RAG" 和 "rag" 产生相同的 token
  const normalized = text.toLowerCase();
  // 收集所有 token
  const tokens: string[] = [];

  // 英文单词与数字：匹配字母/数字/下划线/点/短横组成的连续片段
  for (const match of normalized.matchAll(/[a-z0-9_.-]+/g)) {
    // match[0] 是完整匹配文本，例如 "embedding"
    tokens.push(match[0]);
  }

  // 中文等非空白字符：保留单字，并补上相邻二字组合，缓解单字歧义
  // [...normalized] 按 Unicode 码点拆分，避免把 emoji / 生僻字拆坏
  const chars = [...normalized].filter((char) => !/\s/.test(char));
  // 逐个字符处理
  for (let index = 0; index < chars.length; index += 1) {
    // 当前字符
    const char = chars[index];
    // noUncheckedIndexedAccess 下这里可能是 undefined，跳过
    if (!char) continue;
    // 单字入 token 列表
    tokens.push(char);

    // 看下一个字符是否存在
    const next = chars[index + 1];
    // 存在就补一个二字组合，例如 "检索"
    if (next) tokens.push(char + next);
  }

  // 返回 token 列表
  return tokens;
}

/** 单个 token 映射到 (下标, 符号)，符号用于降低哈希碰撞带来的偏差 */
function hashToken(token: string): { index: number; sign: number } {
  // sha256 输出固定 32 字节；同一 token 每次结果都相同
  const digest = createHash("sha256").update(token).digest();
  // 取前 4 字节作为无符号整数，按维度取模得到下标
  const value = digest.readUInt32BE(0);
  // 0 ~ DIMENSIONS-1 之间的稳定下标
  const index = value % DIMENSIONS;
  // 再取第 5 字节的最低位决定正负号
  // 正负号的作用类似「随机投影」，让不同 token 的碰撞不至于都做加法
  const sign = (digest.readUInt8(4) & 1) === 1 ? 1 : -1;
  // 返回下标与符号
  return { index, sign };
}

/** 计算文本向量并做 L2 归一化，使余弦相似度等价于点积 */
function embedText(text: string): number[] {
  // 先建一个全 0 的 256 维向量
  const vector = new Array<number>(DIMENSIONS).fill(0);

  // 遍历每个 token，把对应维度加 1 或 -1
  for (const token of tokenize(text)) {
    // 解构出下标与符号
    const { index, sign } = hashToken(token);
    // 累加；?? 0 只是为了满足 noUncheckedIndexedAccess 的类型要求
    vector[index] = (vector[index] ?? 0) + sign;
  }

  // 计算 L2 范数（向量长度）
  let norm = 0;
  // 平方和
  for (const value of vector) {
    norm += value * value;
  }
  // 开平方得到长度
  norm = Math.sqrt(norm);

  // 空文本 / 全是空白时向量全 0，直接返回，避免除以 0
  if (norm === 0) {
    return vector;
  }
  // 每个分量除以长度，得到单位向量
  return vector.map((value) => value / norm);
}

/** 本地哈希 embedding，用来在真实 embedding 不可用时跑通整条链路 */
// 继承 Embeddings 后，只需要实现下面两个抽象方法
export class LocalHashEmbeddings extends Embeddings {
  constructor() {
    // Embeddings 构造器需要一个参数对象，这里不需要重试/并发配置，传空对象即可
    super({});
  }

  // 建库时被 MemoryVectorStore 调用：一次传入所有 chunk 文本
  async embedDocuments(documents: string[]): Promise<number[][]> {
    // 逐条计算向量，和真实 embedding 的返回结构保持一致
    return documents.map((document) => embedText(document));
  }

  // 检索时被调用：只需要把问题转成一个向量
  async embedQuery(document: string): Promise<number[]> {
    // 单条文本直接算出向量
    return embedText(document);
  }
}
