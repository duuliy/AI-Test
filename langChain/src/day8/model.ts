/**
 * Day 8 · 模型与环境配置（独立于其他 day 目录）
 *
 * 按 Day 8 约束，这里不 import src/shared，环境读取、模型初始化、错误翻译全部复制一份。
 * 阅读顺序：loadEnv → readConfig → createChatModel → describeError。
 */
import { existsSync, readFileSync } from "node:fs"; // existsSync 判断 .env 是否存在；readFileSync 读取文件内容
import { resolve } from "node:path"; // resolve 把相对路径拼成绝对路径
import { initChatModel } from "langchain"; // initChatModel：按 provider + model 名初始化聊天模型

/** 单次模型请求的超时时间 */
export const REQUEST_TIMEOUT_MS = 60_000; // 60 秒；超时后 SDK 抛 TimeoutError，交给 describeError 翻译

/**
 * 加载项目根目录的 .env。
 * 这里手写一个最小解析器，不依赖 process.loadEnvFile（需要 Node 20.12+），
 * 文件不存在时静默跳过，缺失变量交给 readConfig 报错。
 *
 * 解析规则（够用就好，不做完整 dotenv 语法）：
 * - 空行、以 # 开头的注释行直接跳过；
 * - 只按第一个 "=" 切分，避免值里本身带 "="（如 base64）被截断；
 * - 去掉成对的首尾引号；
 * - 不覆盖已存在的环境变量，方便 CI / 临时 export 覆盖 .env。
 */
export function loadEnv(): void {
  // 无返回值：直接修改 process.env
  const envPath = resolve(process.cwd(), ".env"); // 当前工作目录下的 .env（npm run 时就是项目根目录）
  if (!existsSync(envPath)) {
    // 文件不存在
    return; // 静默返回，让 readConfig 在缺变量时统一报错
  }

  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    // 按行读取，兼容 \n 和 \r\n
    const line = rawLine.trim(); // 去掉首尾空白（缩进、回车）
    if (!line || line.startsWith("#")) continue; // 空行和注释行跳过

    const separator = line.indexOf("="); // 找第一个等号的位置
    if (separator <= 0) continue; // 等号不存在（-1）或在开头（key 为空）都跳过

    const key = line.slice(0, separator).trim(); // 等号左边是变量名
    let value = line.slice(separator + 1).trim(); // 等号右边是值（用 let 因为后面可能去引号）

    // 去掉成对的引号，避免把引号当成值的一部分
    if (
      // 值被双引号包裹
      (value.startsWith('"') && value.endsWith('"')) ||
      // 或者被单引号包裹
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      // 两种引号都支持
      value = value.slice(1, -1); // 掐掉首尾各一个字符
    }

    // 已存在的环境变量优先，不覆盖外部注入的配置
    if (!(key in process.env)) {
      // 只在当前未设置时写入
      process.env[key] = value; // 写入 process.env，供 readConfig 读取
    }
  }
}

/**
 * 读取并校验环境变量，缺失时打印可读提示并退出。
 *
 * 为什么不用非空断言（process.env.X!）？
 * 缺失配置是「使用者会真实踩到的错误」，提前给出明确提示，
 * 比让 SDK 在深处抛出难懂的鉴权错误友好得多。
 */
function readConfig(): { apiKey: string; baseURL: string; model: string } {
  // 返回三个必填配置
  const apiKey = process.env.OPENAI_API_KEY?.trim(); // 读取密钥并去空格；可能为 undefined
  const baseURL = process.env.OPENAI_BASE_URL?.trim(); // 读取兼容网关地址；可能为 undefined
  const model = process.env.OPENAI_MODEL?.trim(); // 读取模型名；可能为 undefined

  const missing: string[] = []; // 收集缺失的变量名，一次性提示
  if (!apiKey) missing.push("OPENAI_API_KEY"); // 密钥缺失
  if (!baseURL) missing.push("OPENAI_BASE_URL"); // 地址缺失
  if (!model) missing.push("OPENAI_MODEL"); // 模型名缺失

  if (!apiKey || !baseURL || !model) {
    // 只要有一个缺失就终止
    console.error(`缺少环境变量：${missing.join(", ")}`); // 打印缺了哪些
    console.error("请先执行 `cp .env.example .env`，然后在 .env 中填入真实配置。"); // 给出可执行的修复步骤
    process.exit(1); // 退出进程；类型收窄后下面的返回值才能保证是 string
  }

  return { apiKey, baseURL, model }; // 三者都确认存在后返回
}

/**
 * 创建聊天模型，temperature 固定 0.2：
 * 既要它稳定地按指令调用工具，又不要完全死板。
 *
 * 各配置项的作用：
 * - modelProvider: "openai" 表示走 OpenAI 兼容协议（多数国产平台也兼容）；
 * - configuration.baseURL 指向兼容网关，换平台时只改环境变量；
 * - maxRetries 是 SDK 层的网络重试，和 Day 8 的 toolRetryMiddleware 无关：
 *   前者重试「模型 HTTP 请求」，后者重试「工具执行」，两层各管一摊；
 * - timeout 防止网络挂起时一直等，配合 describeError 给出超时提示。
 */
export async function createChatModel() {
  // 异步：initChatModel 内部会动态加载对应 provider 的实现
  const { apiKey, baseURL, model } = readConfig(); // 先校验并解构配置

  return initChatModel(model, {
    // 返回模型实例（ConfigurableModel）
    modelProvider: "openai", // 使用 OpenAI 兼容协议
    apiKey, // 鉴权密钥
    configuration: { baseURL }, // SDK 级配置：把请求指向兼容网关
    temperature: 0.2, // 低温度：工具调用更稳定，回答不至于呆板
    maxRetries: 2, // SDK 网络重试次数（与工具重试 middleware 无关）
    timeout: REQUEST_TIMEOUT_MS, // 单次请求超时
  });
}

/** 模型实例的类型别名，供 middleware.ts 推导 */
export type Day8Model = Awaited<ReturnType<typeof createChatModel>>; // 把 async 函数的返回类型提取出来

/**
 * 把底层 SDK / 网络错误翻译成中文可读提示（与 Day 1～5 保持一致的思路）。
 *
 * 判断顺序有讲究：先看中止/超时，再看 HTTP 状态码，最后看网络错误码。
 * 因为一个错误可能同时带 status 和 code，先匹配更具体、更容易行动的提示，
 * 避免把「鉴权失败」误报成「网络问题」。
 */
export function describeError(error: unknown): string {
  // 入参是 unknown：异常可能不是 Error
  const name = error instanceof Error ? error.name : ""; // 错误类名，例如 TimeoutError
  const message = error instanceof Error ? error.message : String(error); // 错误文案或字符串化结果
  const status = (error as { status?: number }).status; // HTTP 状态码（可能不存在）
  const cause = (error as { cause?: { code?: string } }).cause; // Node 网络错误常把错误码放在 cause 里
  const code = (error as { code?: string }).code ?? cause?.code; // 优先取顶层 code，其次取 cause.code

  if (name.includes("Abort") || /aborted/i.test(message)) {
    // 用户主动中断请求
    return "已中断当前请求。"; // 返回简洁提示
  }
  if (name === "TimeoutError" || name.includes("Timeout") || /timed out/i.test(message)) {
    // 超时类错误
    return `请求超时（${REQUEST_TIMEOUT_MS / 1000}s）。请检查网络，或稍后重试。`; // 把毫秒换算成秒展示
  }
  if (status === 401 || status === 403) {
    // 鉴权失败
    return "鉴权失败（HTTP 401/403）：请检查 OPENAI_API_KEY 是否有效，以及它和 OPENAI_BASE_URL 是否属于同一平台。";
  }
  if (status === 404) {
    // 接口或模型不存在
    return "接口或模型不存在（HTTP 404）：请检查 OPENAI_BASE_URL 是否包含正确的版本路径，以及 OPENAI_MODEL 是否存在。";
  }
  if (status === 429) {
    // 限流或额度不足
    return "请求被限流或额度不足（HTTP 429）：请稍后重试，并检查账户余额。";
  }
  if (status !== undefined && status >= 500) {
    // 服务端 5xx
    return `服务端错误（HTTP ${status}）：模型服务暂时不可用，请稍后重试。`;
  }
  if (code === "ENOTFOUND") {
    // DNS 解析失败
    return "无法解析模型服务域名（ENOTFOUND）：请检查 OPENAI_BASE_URL 和本机网络/DNS。";
  }
  if (code === "ECONNREFUSED") {
    // 端口拒绝连接
    return "连接被拒绝（ECONNREFUSED）：请确认 OPENAI_BASE_URL 的地址和端口可访问。";
  }

  return `调用失败：${message}`; // 其余情况：原样透出错误信息，至少不丢细节
}
