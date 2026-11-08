"use client";

/**
 * 个人知识库助手 —— 单页聊天界面
 *
 * 客户端组件（"use client"）：
 *   Route Handler 跑在 Node Runtime（服务端）；
 *   这个组件跑在浏览器里，负责渲染消息列表、发送 fetch、逐块 append 文本。
 *   Thread_id 是前端生成的 UUID，每次请求原样带给 Route Handler，
 *   服务端 MemorySaver 按它分桶存历史。
 *
 * 流式处理：
 *   fetch 返回 Response 后，通过 response.body.getReader() 得到 ReadableStreamReader。
 *   reader.read() 返回 { done, value }，value 是 Uint8Array，
 *   用 TextDecoder({ stream: true }) 解码 —— stream 模式能正确处理
 *   跨块切开的多字节字符（比如中文 "你好" 被切成两截到两个 chunk 里）。
 */
import { useEffect, useRef, useState } from "react";

type Role = "user" | "assistant";
type RouteLabel = "knowledge" | "time" | "general";

/** 路由标签的中文显示映射：页面气泡里显示"知识库"而不是 "knowledge" */
const ROUTE_LABELS: Record<RouteLabel, string> = {
  knowledge: "知识库",
  time: "时间",
  general: "通用",
};

/** TypeScript 类型守卫：检查响应头里拿到的字符串是不是 RouteLabel 之一 */
function isRouteLabel(value: string | null): value is RouteLabel {
  return value === "knowledge" || value === "time" || value === "general";
}

/** ChatMessage 结构：role 区分消息方向，route 只有助手消息才有 */
type ChatMessage = {
  id: string;
  role: Role;
  content: string;
  route?: RouteLabel;
};

export default function Page() {
  // --- 会话状态 ---
  // threadId: 从空 state 初始化时生成一个 UUID，相当于"当前会话的主键"
  // messages: 消息列表，驱动气泡渲染
  // input: 输入框受控值
  // pending: 是否正在等待助手回复（禁用发送按钮）
  const [threadId, setThreadId] = useState<string>(() => crypto.randomUUID());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // --- 自动滚动到底 ---
  // messages 每次更新都触发 re-render，useEffect 在 DOM 更新后把 scrollTop 设成 scrollHeight
  // 这样新消息一出现就滚到最底部，用户不会被"滚回中间"打扰
  useEffect(() => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages]);

  /** 把收到的文本片段追加到指定助手消息。
   *  用函数式 setMessages 保证 React 正确批处理多次 appendDelta 调用 */
  function appendDelta(id: string, delta: string): void {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === id ? { ...message, content: message.content + delta } : message,
      ),
    );
  }

  /** 给助手消息打上路由标签 —— 响应头 X-Route 在 fetch 成功时就拿到，立刻设置 */
  function setRoute(id: string, route: RouteLabel): void {
    setMessages((prev) =>
      prev.map((message) => (message.id === id ? { ...message, route } : message)),
    );
  }

  /**
   * 发送消息 —— 整条 fetch 链路在一个 async 函数里串起来。
   * 执行顺序：
   *   1. 校验输入（非空 / 非 pending）
   *   2. 先把"用户消息 + 空助手消息"两条都 append 到 messages，
   *      空助手消息作为流式 appendDelta 的挂载点，避免"用户发了但页面没反应"
   *   3. fetch POST /api/chat
   *   4. 根据 response.ok 分两条路：
   *      - !ok（400）：直接 response.text() + JSON.parse，把 error 字段写进气泡
   *      - ok：读 X-Route 响应头 → 显示路由标签 → response.body.getReader() → while 循环读流
   *   5. finally 里 setPending(false)，保证任何异常都不会让按钮一直禁用
   */
  async function send(): Promise<void> {
    const question = input.trim();
    if (!question || pending) return;

    const assistantId = crypto.randomUUID();

    // 乐观更新：先把两条消息都放进 list，再发请求。
    // 助手消息 content 暂时为空串，流式文本到达时逐块 appendDelta 进去。
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", content: question },
      { id: assistantId, role: "assistant", content: "" },
    ]);
    setInput("");
    setPending(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId, message: question }),
      });

      // 400 等错误返回 JSON（不是流），直接读全文把提示写进助手气泡
      if (!response.ok) {
        const raw = await response.text();
        let reason = raw || `请求失败（HTTP ${response.status}）。`;
        try {
          const parsed = JSON.parse(raw) as { error?: unknown };
          if (typeof parsed.error === "string") reason = parsed.error;
        } catch {
          // 不是 JSON 就按原文显示
        }
        appendDelta(assistantId, reason);
        return;
      }

      // 路由标签在响应头里，fetch 收到响应头后（流开始之前）立刻就能读
      const routeHeader = response.headers.get("X-Route");
      if (isRouteLabel(routeHeader)) {
        setRoute(assistantId, routeHeader);
      }

      // 老浏览器可能没有 response.body（不支持流式读取）
      if (!response.body) {
        appendDelta(assistantId, "浏览器不支持流式读取（response.body 为空）。");
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      // TextDecoder 必须带 { stream: true } ——
      // 否则跨块切开的多字节字符（比如 UTF-8 的 3 字节中文）会在 boundary 处乱码。
      // 最后一次 decode() 不带 stream: true，把解码器里残留的尾巴 flush 出来
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const delta = decoder.decode(value, { stream: true });
        if (delta) appendDelta(assistantId, delta);
      }

      const tail = decoder.decode();
      if (tail) appendDelta(assistantId, tail);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      appendDelta(assistantId, `请求失败：${reason}`);
    } finally {
      setPending(false);
    }
  }

  /** 新会话：换一个 threadId = 换一份 MemorySaver 历史，同时清空页面上的气泡列表 */
  function newSession(): void {
    if (pending) return;
    setThreadId(crypto.randomUUID());
    setMessages([]);
    setInput("");
  }

  return (
    <main className="app">
      <header className="header">
        <div>
          <h1>个人知识库助手</h1>
          {/* 显示 thread_id 方便调试：可以手动复制相同 id 打开两个标签页验证会话隔离 */}
          <p className="thread">thread_id：{threadId}</p>
        </div>
        <button type="button" className="ghost" onClick={newSession} disabled={pending}>
          新会话
        </button>
      </header>

      <div className="messages" ref={listRef}>
        {messages.length === 0 ? (
          // 空状态提示：给三个不同路由的示例问题，用户一眼知道能问什么
          <p className="empty">
            试试提问：「RAG 的完整流程是什么？」「现在纽约几点？」「37 * 19 等于多少？」
          </p>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={`row ${message.role}`}>
              <div className="bubble">
                <div className="meta">
                  <span className="role">{message.role === "user" ? "你" : "助手"}</span>
                  {/* 只有助手消息才有 route，三元表达式精确控制是否渲染 */}
                  {message.route ? (
                    <span className={`badge ${message.route}`}>{ROUTE_LABELS[message.route]}</span>
                  ) : null}
                </div>
                {/* content 为空且是助手消息时显示"正在思考..."占位，避免气泡看起来像坏掉了 */}
                <p className="content">
                  {message.content || (message.role === "assistant" ? "正在思考…" : "")}
                </p>
              </div>
            </div>
          ))
        )}
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="输入问题，回车发送"
          disabled={pending}
        />
        {/* 发送按钮在 pending 时禁用，input 空时也禁用 —— 双重防护 */}
        <button type="submit" disabled={pending || input.trim() === ""}>
          {pending ? "回答中…" : "发送"}
        </button>
      </form>
    </main>
  );
}
