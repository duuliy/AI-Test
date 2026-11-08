/**
 * 环境变量读取（Next.js 服务端专用）
 *
 * Next.js 自动从项目根往上查找 .env.local，不需要手动 loadEnvFile()。
 * 所有读取函数都会在变量缺失时抛出中文错误，
 * 调用方（model / embeddings / agent / route handler）应决定如何向用户呈现。
 *
 * 为什么不在顶部一次性读全部 env：
 *   OpenAIEmbeddings 的构造阶段不强制要求 baseURL，但本地哈希 fallback 不需要任何 env。
 *   按"按需读取"分组，能让 USE_LOCAL_EMBEDDINGS=1 时跳过 OPENAI_EMBEDDING_MODEL 的校验。
 */
export type ModelConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
};

/** 单次模型 / embedding / 网络中间件请求的超时时间（毫秒） */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * 核心模型配置。
 * 把三个字段一起校验是为了"改完所有变量再重启一次"，
 * 避免"改了 API_KEY → 重启 → 发现 MODEL 也没填 → 再改 → 再重启"的来回折腾。
 */
export function readModelConfig(): ModelConfig {
  // trim 掉前后空白：用户不小心在值里敲了空格也能工作
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const baseURL = process.env.OPENAI_BASE_URL?.trim();
  const model = process.env.OPENAI_MODEL?.trim();

  // 收集所有缺失项再一次性报错；而不是遇到第一个就 throw
  const missing: string[] = [];
  if (!apiKey) missing.push("OPENAI_API_KEY");
  if (!baseURL) missing.push("OPENAI_BASE_URL");
  if (!model) missing.push("OPENAI_MODEL");

  // 这里必须分开 if 而不是 if (missing.length > 0)：
  // TypeScript 的控制流分析需要显式引用这三个变量，
  // 才能在 return 处把它们从 string | undefined 收窄成 string。
  if (!apiKey || !baseURL || !model) {
    throw new Error(
      `缺少环境变量：${missing.join("、")}。请在 src/final-project 下执行 ` +
        "`cp .env.local.example .env.local`，填入真实配置后重启 `npm run dev`。",
    );
  }

  // 只返回配置对象，绝不打印 key：日志里出现完整密钥是常见的信息泄露渠道
  return { apiKey, baseURL, model };
}

/**
 * Embedding 模型名。
 * 注意：只在 useLocalEmbeddings() 返回 false 时才调用它；
 * 本地哈希路径不需要任何 env，因此即使没填 OPENAI_EMBEDDING_MODEL 也能跑通。
 */
export function readEmbeddingModel(): string {
  const model = process.env.OPENAI_EMBEDDING_MODEL?.trim();
  if (!model) {
    throw new Error(
      "缺少环境变量：OPENAI_EMBEDDING_MODEL。请参考 .env.local.example 填写，" +
        "或设置 USE_LOCAL_EMBEDDINGS=1 改用本地哈希 embedding。",
    );
  }
  return model;
}

/**
 * 是否显式选择本地哈希 embedding。
 * 值为字符串 "1" 才返回 true，空值或任何其他值都视为 false。
 * 这种设计允许 .env 里"注释掉这一行就自动回到真实 embedding 路径"。
 */
export function useLocalEmbeddings(): boolean {
  return process.env.USE_LOCAL_EMBEDDINGS?.trim() === "1";
}
