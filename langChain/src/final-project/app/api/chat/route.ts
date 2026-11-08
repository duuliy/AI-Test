/**
 * POST /api/chat —— 流式问答入口
 *
 * 请求体：{ threadId: string, message: string }
 * 响应体：纯文本流（text/plain），模型每生成一小段就立刻写回客户端。
 *        同时在响应头 X-Route 里返回路由结果（knowledge / time / general），
 *        前端拿到后可以给助手消息打上"知识库问答"等小标签。
 *
 * 为什么用裸文本流而不是 SSE：
 *   前端只需要"一段连续增长的文本"，用 fetch + response.body.getReader()
 *   边读边 append 到气泡里即可。SSE 的 event:/data: 协议在这里只会增加解析成本，
 *   而且 Next.js Route Handler 对 SSE 的 TypeScript 类型支持也比较别扭。
 *
 * 运行时选择 nodejs：
 *   LangChain 依赖 Node 的 net / stream 等内置模块，
 *   Edge Runtime（V8 Isolate）里跑不了，必须显式指定。
 */
import { HumanMessage } from "@langchain/core/messages";
import { getAgent } from "@/lib/agent";
import { describeError } from "@/lib/model";
import { routeQuestion } from "@/lib/router";
import { extractText } from "@/lib/text";

export const runtime = "nodejs";

/** 参数校验失败时返回 400 + JSON；前端会把 error 字段当普通文本显示在气泡里 */
function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

export async function POST(request: Request): Promise<Response> {
  // request.json() 遇到非法 JSON 会抛异常，先兜住，避免直接 500
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("请求体不是合法的 JSON。");
  }

  // 请求体来自外部，不能信任类型：逐字段做运行时校验，和 route handler 同模式
  const raw = payload as { threadId?: unknown; message?: unknown } | null;
  const threadId = raw?.threadId;
  const message = raw?.message;

  if (typeof threadId !== "string" || threadId.trim() === "") {
    return badRequest("threadId 必须是非空字符串。");
  }
  if (typeof message !== "string" || message.trim() === "") {
    return badRequest("message 必须是非空字符串。");
  }

  // 先路由，再流式生成。
  // 路由本身是一次模型调用，但它开销很小（只输出 route + reason 两个短字段），
  // 换来的收益是：knowledge 路由才加载知识库工具，time/general 跳过
  // —— 避免不必要的 embedding + 向量库查询。
  const decision = await routeQuestion(message);

  // ReadableStream 只能写入 Uint8Array，中文要先经过 TextEncoder 编码
  const encoder = new TextEncoder();

  // 本地中断控制器：request.signal 是客户端断开（关页面 / 取消 fetch）时自动 abort 的，
  // 我们把它转发给本地 controller，让 agent.stream() 也能及时停止
  const abortController = new AbortController();

  const abortOnDisconnect = (): void => abortController.abort();
  request.signal.addEventListener("abort", abortOnDisconnect);

  // cancelled 和 abortController.signal.aborted 是两个独立判断：
  // cancelled = true 表示流已被显式取消（cancel() 回调被调用）；
  // signal.aborted 表示客户端已断开；
  // 两者语义略有重叠，但都要检查才能覆盖所有边界
  let cancelled = false;

  // start() 是在 Response 返回给客户端之前就会执行的闭包。
  // 边生成边 enqueue，客户端拿到的是"已经吐出一部分"的响应，
  // 而不是等全部生成完再返回 —— 这就是流式的关键
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const agent = await getAgent(decision.route);

        // streamMode: "messages" —— 按消息分片输出，每项是 [chunk, metadata] 元组；
        //   这里解构时只取 chunk（第一个元素），忽略 metadata（第二个元素）。
        // configurable.thread_id —— 告诉 MemorySaver "这条消息属于哪个会话"，
        //   框架会自动把该 thread_id 下的历史读出来，追加新消息后再存回去。
        // signal —— 转发给 LangGraph 的中断信号，客户端断开时停止生成。
        const messageStream = await agent.stream(
          { messages: [new HumanMessage(message)] },
          {
            configurable: { thread_id: threadId },
            streamMode: "messages",
            signal: abortController.signal,
          },
        );

        for await (const [chunk] of messageStream) {
          if (cancelled || abortController.signal.aborted) break;

          // 只转发正文文本；工具调用块、reasoning 块、tool_result 块都跳过
          const text = extractText(chunk);
          if (!text) continue;

          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // controller.enqueue 在流已关闭时会抛 TypeError
            // —— 这通常是客户端断开导致的，标记 cancelled 后 break
            cancelled = true;
            break;
          }
        }
      } catch (error) {
        // 主动中断不算错误；只有非主动中断才写提示给用户
        if (!cancelled && !abortController.signal.aborted) {
          try {
            // describeError 把 SDK/网络错误翻译成中文，直接拼进给用户的提示
            controller.enqueue(encoder.encode(`\n\n[出错了] ${describeError(error)}`));
          } catch {
            // 流已关闭，忽略
          }
        }
      } finally {
        // 无论成功、报错还是中断，都要解绑监听并关闭流，否则连接会一直挂着
        request.signal.removeEventListener("abort", abortOnDisconnect);
        try {
          controller.close();
        } catch {
          // 已关闭则忽略
        }
      }
    },
    // 浏览器取消读取（reader.cancel()）时触发：中断模型请求，释放资源
    cancel() {
      cancelled = true;
      abortController.abort();
      request.signal.removeEventListener("abort", abortOnDisconnect);
    },
  });

  // Content-Type 用 text/plain 而不是 text/event-stream：
  // 后者要求 event:/data: 协议格式，text/plain 就是纯原始字节
  // Cache-Control: no-cache 禁止浏览器或中间代理缓存 —— 否则流式响应可能被攒成一整块才吐出来
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Route": decision.route,
    },
  });
}
