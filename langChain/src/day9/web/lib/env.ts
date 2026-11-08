/**
 * Day 9 · 环境变量读取
 *
 * Next.js 会自动加载 `.env.local`，所以这里不再调用 `process.loadEnvFile()`。
 * 缺少变量时抛出带中文说明的错误，route handler 会把错误文本写进流，页面上能直接看到。
 */
export type EnvConfig = {
  apiKey: string; // 平台 API Key → OPENAI_API_KEY
  baseURL: string; // 平台接口地址 → OPENAI_BASE_URL
  model: string; // 模型名 → OPENAI_MODEL
};

/** 单次模型请求的超时时间，与根项目保持一致 */
export const REQUEST_TIMEOUT_MS = 60_000; // 60 秒；数值下划线只是提高可读性

/**
 * 读取并校验环境变量。
 *
 * 注意这里只抛 Error、不调用 process.exit：
 * 在 Next 的请求上下文里 exit 会直接杀掉整个 dev server，抛错则能被 route handler 捕获。
 */
export function readConfig(): EnvConfig {
  // trim 防止复制粘贴 .env 时带进首尾空格
  const apiKey = process.env.OPENAI_API_KEY?.trim(); // 可选链：变量不存在时得到 undefined
  const baseURL = process.env.OPENAI_BASE_URL?.trim(); // 同上
  const model = process.env.OPENAI_MODEL?.trim(); // 同上

  // 先收集所有缺失项，一次性报全，省得用户改一个重启一次
  const missing: string[] = []; // 缺失的变量名列表
  if (!apiKey) missing.push("OPENAI_API_KEY"); // 空字符串也视为缺失
  if (!baseURL) missing.push("OPENAI_BASE_URL"); // 同上
  if (!model) missing.push("OPENAI_MODEL"); // 同上

  // 分开写是为了让 TypeScript 在下面收窄成 string
  if (!apiKey || !baseURL || !model) { // 任意一个缺失就抛错
    throw new Error(
      `缺少环境变量：${missing.join("、")}。请在 src/day9/web 目录下执行 ` + // 用顿号拼出缺失项
        "`cp .env.local.example .env.local`，填入真实配置后重启 `npm run dev`。", // 拼出修复步骤
    );
  }

  return { apiKey, baseURL, model }; // 到这里三个值都已是 string
}
