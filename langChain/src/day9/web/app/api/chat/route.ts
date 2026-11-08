/**
 * Day 9 · Route Handler（逐行注释版）
 *
 * POST /api/chat 接收 { threadId, message }，把 Agent 的流式文本增量
 * 通过 ReadableStream 直接写回响应体（纯文本，不是 SSE）。
 *
 * 为什么不用 SSE：
 *   前端只需要「一段连续增长的文本」，用 response.body.getReader() 边读边渲染即可；
 *   SSE 的 event:/data: 协议在这里只会增加解析成本。
 */
import { HumanMessage } from "@langchain/core/messages"; // 把用户输入包装成 LangChain 消息对象
import { extractText, getAgent } from "@/lib/agent"; // 懒加载 Agent + 从分片里抽正文

// LangChain 依赖 Node 的 net / stream 等能力，必须跑在 Node 运行时，不能用 Edge Runtime
export const runtime = "nodejs";

/** 参数校验失败时返回 400；页面会把 error 字段当普通文本显示 */
function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 }); // 返回 JSON + 400 状态码
}

export async function POST(request: Request): Promise<Response> {
  // request.json() 遇到非法 JSON 会抛异常，先兜住，避免直接 500
  let payload: unknown; // 先声明为 unknown：外部输入不可信，后面逐字段校验
  try {
    payload = await request.json(); // 读取并解析请求体
  } catch {
    return badRequest("请求体不是合法的 JSON。"); // 解析失败：400
  }

  // 请求体来自外部，不能信任类型：逐个字段做运行时校验
  const raw = payload as { threadId?: unknown; message?: unknown } | null; // 只做结构断言，字段仍是 unknown
  const threadId = raw?.threadId; // 取出 threadId（可能是任意类型）
  const message = raw?.message; // 取出 message（可能是任意类型）

  if (typeof threadId !== "string" || threadId.trim() === "") { // threadId 必须是非空字符串
    return badRequest("threadId 必须是非空字符串。"); // 校验失败：400
  }
  if (typeof message !== "string" || message.trim() === "") { // message 同理，不能是空白
    return badRequest("message 必须是非空字符串。"); // 校验失败：400
  }

  // ReadableStream 只能写入 Uint8Array，所以中文要先经过 TextEncoder 编码
  const encoder = new TextEncoder(); // 文本 -> UTF-8 字节
  const abortController = new AbortController(); // 本地中断控制器

  // 客户端断开（关标签页 / 取消 fetch）时 request.signal 会 abort，
  // 把它转发给本地 controller，让 agent.stream 停止，避免继续消耗模型调用。
  const abortOnDisconnect = (): void => abortController.abort(); // 包装成无参回调
  request.signal.addEventListener("abort", abortOnDisconnect); // 监听客户端断开事件

  let cancelled = false; // 标记「流已被取消」，防止后续继续 enqueue

  // start() 在 Response 返回给客户端之前就会执行，这里边生成边 enqueue，
  // 客户端拿到的是「已经吐出一部分」的响应，而不是等全部生成完再返回
  const body = new ReadableStream<Uint8Array>({
    async start(controller) { // controller 用来向流里写入数据和关闭流
      try {
        // 懒加载单例：第一次真正请求时才读 env、建模型；缺 env 的报错会走下面的 catch
        const agent = await getAgent(); // 拿到共享的 Agent 实例

        // streamMode: "messages" 每产出一项是 [消息分片, metadata] 元组；
        // configurable.thread_id 决定从 MemorySaver 里读哪一份历史
        const messageStream = await agent.stream(
          { messages: [new HumanMessage(message)] }, // 本轮新增的用户消息；历史由 checkpointer 自动补上
          {
            configurable: { thread_id: threadId }, // 会话主键：同 id 共享上下文
            streamMode: "messages", // 按消息分片输出，只关心正文增量
            signal: abortController.signal, // 中断信号：客户端断开时停止生成
          },
        );

        for await (const [chunk] of messageStream) { // 逐块消费上游流；这里只取分片，忽略 metadata
          // 客户端已断开时不再继续读取上游流
          if (cancelled || abortController.signal.aborted) break; // 提前退出循环

          // 只转发正文文本；工具调用、元数据等不显示在页面上
          const text = extractText(chunk); // 从 string / ContentBlock[] 中抽正文
          if (!text) continue; // 空分片（例如工具调用块）直接跳过

          try {
            controller.enqueue(encoder.encode(text)); // 把文本编码后写进响应流
          } catch {
            // 控制器已被关闭（客户端断开），停止读取
            cancelled = true; // 标记已取消
            break; // 退出循环
          }
        }
      } catch (error) {
        // 主动中断不算错误；其它异常把中文提示写进流，页面不会一直转圈
        if (!cancelled && !abortController.signal.aborted) { // 只有非主动中断才需要提示
          const reason = error instanceof Error ? error.message : String(error); // 兼容 Error 和非 Error
          try {
            controller.enqueue(encoder.encode(`\n\n[出错了] ${reason}`)); // 错误也走同一条流
          } catch {
            // 流已关闭，忽略
          }
        }
      } finally {
        // 无论成功、报错还是中断，都要解绑监听并关闭流，否则连接会一直挂着
        request.signal.removeEventListener("abort", abortOnDisconnect); // 移除监听，避免内存泄漏
        try {
          controller.close(); // 关闭流：浏览器端 reader.read() 会收到 done
        } catch {
          // 已关闭则忽略
        }
      }
    },
    // 浏览器取消读取（reader.cancel()）时触发：中断模型请求，释放资源
    cancel() {
      cancelled = true; // 标记取消
      abortController.abort(); // 中断上游 agent.stream
      request.signal.removeEventListener("abort", abortOnDisconnect); // 清理监听
    },
  });

  return new Response(body, {
    headers: {
      // 纯文本流；charset 保证中文不乱码
      "Content-Type": "text/plain; charset=utf-8",
      // 禁止浏览器或中间代理缓存，否则流式响应会被攒成一整块
      "Cache-Control": "no-cache",
    },
  });
}
