/**
 * ============================================================
 * Day 1 · 命令行流式多轮对话（NODE 版）
 * 运行：npm run day1
 *
 * 启动到出结果的完整链路（先看这里，再看代码）：
 *   1. tsx 执行本文件 → 顶层 await main()
 *   2. loadDotEnv() 把 .env 写进 process.env
 *   3. readConfig() 从 process.env 读出三个配置
 *   4. initChatModel() 创建模型客户端（只建对象，还不发请求）
 *   5. messages = [SystemMessage]   ← 这就是“记忆”
 *   6. readline 等待用户输入
 *   7. 每轮：model.stream([...历史, 新 HumanMessage]) 发 HTTP 请求
 *   8. LangChain 内部走 OpenAI 兼容协议 → POST /chat/completions（stream:true）
 *   9. 服务端按 SSE 逐块回包 → SDK 解析 → 你收到 AIMessageChunk
 *  10. 拼接 chunk → 打印 → 成功后 push 一对 Human/AI → 等下一轮
 * ============================================================
 * 
 * 
 * tips：node文件都是一次性执行的，为啥你还能反复聊天？
 * `node chat.ts` 的顶层代码确实只跑一遍，但跑完之后：
 * 如果没有任何待处理的任务（比如只`console.log` 一下），事件循环空了， 进程立刻退出 ；
 * 如果还有“挂着的事”（等待 stdin 输入、监听端口、定时器）， 进程不退出 ，事件循环继续空转，等事情发生。
 * for await (const raw of rl) {   // ← 这一行是 await，会挂起
 * ...处理一句话...
 * }
 * 
 * 进程启动 → 顶层代码执行一次
 * → 走到 for await (rl)
 * → 此时没有下一行输入，await 挂起，把控制权交回事件循环
 * → 进程不退出，静静等待
 * → 你在终端敲一行 + 回车      
 * → stdin 事件唤醒它，循环体执行一次
 * → 处理完，回到 for await，再次挂起
 * → …… 重复 N 次 ……
 * → 你输入 exit / rl.close()
 * → 没有待处理任务了，事件循环清空，进程退出
 */

// 【Node 内置模块】不是 Express，也不是 LangChain。
// node:readline/promises 的 promises 后缀表示提供“异步迭代”版本，
// createInterface() 返回一个行读取器，支持 for await (const line of rl)。
import { createInterface } from "node:readline/promises";
// 【Node 内置模块】stdin 是标准输入（键盘），stdout 是标准输出（终端）。
// 这两个同样与 Express 无关：Express 版操作的是 req/res，不会用到它们。
import { stdin, stdout } from "node:process";

// 【LangChain 消息类型】LangChain 用消息对象而不是纯字符串表示对话，
// 每种角色一个类，SDK 序列化时会映射成 OpenAI 的 role 字段。
import {
  // 助手的一条【完整】回复，成功后写进历史用这个
  AIMessage,
  // 用户的一条输入
  HumanMessage,
  // 系统提示词（人设/规则），固定放在 messages[0]
  SystemMessage,
  // 流式返回的【增量块】，不是完整消息；这里只用于类型标注
  type AIMessageChunk,
  // 上面三种消息的公共父类型，历史数组统一用它做类型
  type BaseMessage,
} from "@langchain/core/messages";
// 【LangChain 入口】initChatModel 是 v1 的统一模型工厂：
// 传“模型名 + provider”，内部动态构造对应模型类（此处会构造 ChatOpenAI）。
import { initChatModel } from "langchain";

// 系统提示词：模型无状态，所以它必须每轮都重新出现在 messages 最前面
const SYSTEM_PROMPT = "你是一个乐于助人的中文 AI 助手。回答简洁、准确，必要时给出示例。";
// 单次模型请求的总超时（毫秒）：60_000 即 60 秒
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * 读取项目根目录的 .env。
 * 注意：这里用的是 Node 20.12+ 的内置能力，不需要 dotenv 包。
 */
function loadDotEnv(): void {
  // 用 try 包住：.env 可能不存在，读取会抛错
  try {
    // 内置方法：解析 cwd 下的 .env，把 KEY=VALUE 写进 process.env
    process.loadEnvFile();
  // 捕获读取失败
  } catch (error) {
    // ENOENT = 文件不存在，属于预期情况，忽略即可
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // 其他错误（如权限不足）说明环境真有问题，继续抛出，不要掩盖
      throw error;
    }
  }
}

/**
 * 从 process.env 读取并校验三个配置。
 * 在启动时校验而不是请求时校验 —— 配置错误应该 fail fast。
 */
function readConfig(): { apiKey: string; baseURL: string; model: string } {
  // 读 key；?.trim() 防御复制粘贴带来的首尾空格/换行
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  // 读服务地址（OpenAI 兼容端点，必须带版本路径）
  const baseURL = process.env.OPENAI_BASE_URL?.trim();
  // 读模型 ID
  const model = process.env.OPENAI_MODEL?.trim();

  // 用数组收集缺失项，避免“改一个跑一次”
  const missing: string[] = [];
  // 缺 key 就记下来
  if (!apiKey) missing.push("OPENAI_API_KEY");
  // 缺地址就记下来
  if (!baseURL) missing.push("OPENAI_BASE_URL");
  // 缺模型就记下来
  if (!model) missing.push("OPENAI_MODEL");

  // 任意一项缺失 → 统一报错退出
  if (!apiKey || !baseURL || !model) {
    // 一次性列出所有缺失的变量名
    console.error(`缺少环境变量：${missing.join(", ")}`);
    // 给出修复动作
    console.error("请先执行 `cp .env.example .env`，然后在 .env 中填入真实配置。");
    // 退出码 1 表示异常退出
    process.exit(1);
  }

  // 走到这里 TS 已把三者收窄为 string（不是 string | undefined）
  return { apiKey, baseURL, model };
}

/**
 * 从流式 chunk 中取出正文文本。
 * chunk.content 有两种形态：string，或 ContentBlock[]（多模态/推理模型）。
 */
function extractText(chunk: AIMessageChunk): string {
  // 形态 1：纯字符串，直接返回
  if (typeof chunk.content === "string") {
    // 这是最常见的情况（OpenAI 兼容协议默认如此）
    return chunk.content;
  }

  // 形态 2：内容块数组，需要遍历挑出文本块
  let text = "";
  // 逐块检查
  for (const block of chunk.content) {
    // 只要文本块；reasoning 等块被跳过
    if (block.type === "text" && typeof block.text === "string") {
      // 累加这一块的文本
      text += block.text;
    }
  }
  // 返回本 chunk 的文本（增量，不是全文）
  return text;
}

/**
 * 把 LangChain / OpenAI SDK / 网络层错误翻译成中文提示。
 */
function describeError(error: unknown): string {
  // 错误对象不一定规范，先判断是不是 Error
  const name = error instanceof Error ? error.name : "";
  // 取错误信息；取不到就用 String() 兜底
  const message = error instanceof Error ? error.message : String(error);
  // OpenAI SDK 的错误对象上带着 HTTP 状态码
  const status = (error as { status?: number }).status;
  // 底层网络错误码可能被 fetch 包在 cause 里
  const cause = (error as { cause?: { code?: string } }).cause;
  // 两处都查，取到哪个算哪个
  const code = (error as { code?: string }).code ?? cause?.code;

  // 用户主动中断（Ctrl+C 触发 AbortController）
  if (name.includes("Abort") || /aborted/i.test(message)) {
    // 友好提示，不算故障
    return "已中断当前回复。";
  }
  // 超时（AbortSignal.timeout 触发）
  if (name === "TimeoutError" || name.includes("Timeout") || /timed out/i.test(message)) {
    // 明确告诉用户超时时长
    return `请求超时（${REQUEST_TIMEOUT_MS / 1000}s）。请检查网络，或稍后重试。`;
  }
  // 401/403：key 无效，或 key 与服务地址不属于同一平台
  if (status === 401 || status === 403) {
    return "鉴权失败（HTTP 401/403）：请检查 OPENAI_API_KEY 是否有效，以及它和 OPENAI_BASE_URL 是否属于同一平台。";
  }
  // 404：地址路径不对，或模型 ID 不存在
  if (status === 404) {
    return "接口或模型不存在（HTTP 404）：请检查 OPENAI_BASE_URL 是否包含正确的版本路径（如智谱的 /api/paas/v4），以及 OPENAI_MODEL 是否存在。";
  }
  // 429：限流或余额不足
  if (status === 429) {
    return "请求被限流或额度不足（HTTP 429）：请稍后重试，并检查账户余额。";
  }
  // 5xx：服务端暂时故障
  if (status !== undefined && status >= 500) {
    return `服务端错误（HTTP ${status}）：模型服务暂时不可用，请稍后重试。`;
  }
  // DNS 解析失败：域名写错或没网
  if (code === "ENOTFOUND") {
    return "无法解析模型服务域名（ENOTFOUND）：请检查 OPENAI_BASE_URL 和本机网络/DNS。";
  }
  // 连接被拒绝：地址/端口不可达（如本地 Ollama 没启动）
  if (code === "ECONNREFUSED") {
    return "连接被拒绝（ECONNREFUSED）：请确认 OPENAI_BASE_URL 的地址和端口可访问。";
  }
  // TLS 证书问题：常见于公司代理或自签证书
  if (code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return `TLS 证书校验失败（${code}）：请检查网络代理或系统证书。`;
  }

  // 兜底：把原始信息透出来，方便排查
  return `模型调用失败：${message}`;
}

/**
 * 程序主流程：初始化 → 循环读输入 → 流式请求 → 写回历史。
 */
async function main(): Promise<void> {
  // 第一步：加载 .env（必须在读配置之前）
  loadDotEnv();
  // 第二步：读配置；这里把 model 重命名为 modelName，避免和下面的模型实例重名
  const { apiKey, baseURL, model: modelName } = readConfig();

  // 声明模型变量；类型由 initChatModel 的返回值推导，便于下面有完整提示
  let model: Awaited<ReturnType<typeof initChatModel>>;
  // 初始化可能失败（如 key 格式错误），单独 try
  try {
    // 创建模型客户端：这一步只是构造对象，不会发起网络请求
    model = await initChatModel(modelName, {
      // "openai" 表示 OpenAI 兼容协议，兼容智谱/DeepSeek/Moonshot/Ollama
      modelProvider: "openai",
      // 鉴权 key
      apiKey,
      // baseURL 必须含版本路径，否则请求会 404
      configuration: { baseURL },
      // 采样温度：0 更确定，1 更发散
      temperature: 0.7,
      // 网络/5xx 失败时自动重试次数
      maxRetries: 2,
      // 单次请求超时
      timeout: REQUEST_TIMEOUT_MS,
    });
  // 初始化失败就翻译错误并退出
  } catch (error) {
    // 打印中文提示
    console.error(describeError(error));
    // 异常退出
    process.exit(1);
  }

  // 第三步：创建历史数组。这就是多轮对话的全部“记忆”。
  // 模型本身无状态，每轮必须把整个数组重发给它。
  const messages: BaseMessage[] = [new SystemMessage(SYSTEM_PROMPT)];

  // 启动提示
  console.log("LangChain.js Day 1 · 流式多轮对话");
  // 显示当前模型，便于确认 .env 生效
  console.log(`模型：${modelName}`);
  // 告知退出与中断方式
  console.log("输入 exit 退出；回复过程中按 Ctrl+C 可中断当前回复。\n");

  // 创建行读取器：input 是键盘，output 是终端，terminal 开启行编辑/回显
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  // 当前正在进行的请求的中断器；空闲时为 null
  let activeAbort: AbortController | null = null;

  // Ctrl+C 处理：生成中 → 只中断本次请求；空闲 → 退出程序
  const onSigint = (): void => {
    // 有正在进行的请求
    if (activeAbort) {
      // 触发中断，模型请求会被取消
      activeAbort.abort();
      // 不退出程序，回到输入提示
      return;
    }
    // 空闲状态：打印告别语
    console.log("\n再见。");
    // 关闭读取器
    rl.close();
    // 正常退出，退出码 0
    process.exit(0);
  };

  // readline 自身也会捕获 SIGINT（Ctrl+C）
  rl.on("SIGINT", onSigint);
  // 进程级兜底，确保终端里任何 Ctrl+C 都能被处理
  process.on("SIGINT", onSigint);

  // 用 try/finally 保证退出时一定清理监听器
  try {
    // 打印第一个输入提示
    stdout.write("你: ");
    // 异步逐行读取：每输入一行，循环体执行一次
    for await (const raw of rl) {
      // 去掉首尾空白
      const line = raw.trim();
      // 空行：不发给模型，直接重新提示
      if (!line) {
        // 重新打印提示
        stdout.write("你: ");
        // 跳到下一行输入
        continue;
      }
      // exit 命令：跳出循环，结束会话
      if (line.toLowerCase() === "exit") break;

      // 为本轮创建独立的中断器（用户 Ctrl+C 时用它）
      const controller = new AbortController();
      // 为本轮创建超时信号（到时自动 abort）
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      // 把中断器暴露给 onSigint，让 Ctrl+C 能找到当前请求
      activeAbort = controller;

      // 打印助手前缀
      stdout.write("助手: ");
      // 本轮完整回复的累加器（chunk 是增量，必须自己拼）
      let reply = "";
      // 本轮请求可能失败，单独 try
      try {
        // 发请求：
        // 第一个参数是 messages —— 历史 + 本轮输入（浅拷贝，不直接改历史）
        // 第二个参数是 signal —— 合并“用户中断”和“超时”两路信号
        const stream = await model.stream(
          // 用展开运算符复制数组，末尾追加本轮提问
          [...messages, new HumanMessage(line)],
          // AbortSignal.any：任一信号触发就中断
          { signal: AbortSignal.any([controller.signal, timeout]) },
        );

        // 逐块消费服务端返回的流
        for await (const chunk of stream) {
          // 从 chunk 里挑出文本
          const text = extractText(chunk);
          // 空块（推理块/心跳）跳过
          if (!text) continue;
          // 累加到本轮全文
          reply += text;
          // 立即打印 → 形成打字机效果
          stdout.write(text);
        }
        // 流结束，换行
        stdout.write("\n");

        // 模型返回了空内容：不写历史
        if (reply.length === 0) {
          // 提示用户本轮未记录
          console.log("（模型返回了空内容，本轮未写入历史）");
        } else {
          // 只有成功才写历史，保证 Human/AI 成对
          // 写入的是完整 AIMessage，不是零散的 AIMessageChunk
          messages.push(new HumanMessage(line), new AIMessage(reply));
        }
      // 捕获本轮失败/中断
      } catch (error) {
        // 先换行，避免错误信息接在回复后面
        stdout.write("\n");
        // 超时触发、且用户没主动中断 → 报超时
        if (timeout.aborted && !controller.signal.aborted) {
          // 超时提示
          console.error(`请求超时（${REQUEST_TIMEOUT_MS / 1000}s）。请检查网络，或稍后重试。`);
        } else {
          // 其他错误（中断/鉴权/网络）统一翻译
          console.error(describeError(error));
        }
      // 无论成功失败都要清理
      } finally {
        // 清空中断器引用，表示本轮已结束
        activeAbort = null;
      }

      // 下一轮输入提示
      stdout.write("你: ");
    }
  // 退出循环（exit）或异常时清理资源
  } finally {
    // 关闭行读取器
    rl.close();
    // 移除进程级 SIGINT 监听，避免残留
    process.off("SIGINT", onSigint);
  }

  // 结束语
  console.log("会话结束。");
}

// ESM 顶层 await：等 main() 执行完（实际是等 readline 循环结束）再退出进程
await main();
