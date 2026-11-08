"use client"; // 声明这是客户端组件：需要 useState / useEffect / fetch，不能在服务端渲染阶段跑

import { useEffect, useRef, useState } from "react"; // React 状态、引用、副作用 Hook

/** user / assistant 两种角色，决定气泡左右位置和配色 */
type Role = "user" | "assistant";

/** 页面里的单条消息；id 只用于 React 列表 key 和定位流式追加目标 */
type ChatMessage = {
  id: string; // 唯一标识，流式追加时靠它找到对应消息
  role: Role; // 谁说的：你 / 助手
  content: string; // 消息正文；助手消息会随着流式增量不断变长
};

export default function Page() { // App Router 的首页组件
  // threadId 是整个会话的主键：换一个 id，服务端就换一份历史
  const [threadId, setThreadId] = useState<string>(() => crypto.randomUUID()); // 惰性初始化：只在首次渲染时生成一次
  const [messages, setMessages] = useState<ChatMessage[]>([]); // 页面展示的消息列表
  const [input, setInput] = useState(""); // 输入框的受控值
  // pending 期间禁用输入框、发送按钮和新会话按钮，避免并发请求打乱消息顺序
  const [pending, setPending] = useState(false); // true 表示「正在等模型回答」
  // 用来把消息列表滚到底部
  const listRef = useRef<HTMLDivElement>(null); // 指向滚动容器的 DOM 引用

  // 每次消息更新后滚到底部
  useEffect(() => {
    const list = listRef.current; // 取当前 DOM；首次渲染时可能还是 null
    if (list) { // 容器已挂载才操作
      list.scrollTop = list.scrollHeight; // 把滚动位置设到内容最底部
    }
  }, [messages]); // 依赖 messages：只要新增或追加了内容就执行

  /** 把新收到的文本片段追加到指定助手消息，形成打字机效果 */
  function appendDelta(id: string, delta: string): void {
    setMessages((prev) =>
      prev.map((message) => // 遍历所有消息，只改 id 匹配的那一条
        message.id === id ? { ...message, content: message.content + delta } : message, // 命中：复制并拼接；未命中：原样返回
      ),
    );
  }

  /**
   * 发送流程：
   *   1. 先把用户消息和一条空的助手消息同步进列表（用户立刻看到反馈）；
   *   2. POST /api/chat，服务端返回纯文本流；
   *   3. 逐块读取响应体，把增量拼到那条助手消息上。
   */
  async function send(): Promise<void> {
    const question = input.trim(); // 去掉首尾空白
    if (!question || pending) return; // 空消息或上一次还没结束，直接忽略

    // 先占位，后续所有增量都写进这个 id，避免每次都去数组末尾找消息
    const assistantId = crypto.randomUUID(); // 提前生成助手消息 id
    setMessages((prev) => [
      ...prev, // 保留已有消息
      { id: crypto.randomUUID(), role: "user", content: question }, // 追加用户消息
      { id: assistantId, role: "assistant", content: "" }, // 追加空的助手消息作为占位
    ]);
    setInput(""); // 清空输入框
    setPending(true); // 进入「回答中」状态，禁用交互

    try {
      const response = await fetch("/api/chat", { // 请求 Route Handler
        method: "POST", // 用 POST 传消息体
        headers: { "Content-Type": "application/json" }, // 告诉服务端 body 是 JSON
        body: JSON.stringify({ threadId, message: question }), // 带上会话 id 和用户输入
      });

      // 400/500 时服务端返回 JSON，不是流；直接读全文当错误提示
      if (!response.ok) { // HTTP 状态码不在 2xx
        const errorText = await response.text(); // 读完整响应体
        appendDelta(assistantId, errorText || `请求失败（HTTP ${response.status}）。`); // 把错误显示在助手气泡里
        return; // 结束本次发送
      }

      if (!response.body) { // 极老浏览器可能没有流式响应体
        appendDelta(assistantId, "浏览器不支持流式读取（response.body 为空）。"); // 给用户提示
        return; // 结束本次发送
      }

      const reader = response.body.getReader(); // 拿到流的读取器
      const decoder = new TextDecoder(); // 字节 -> 字符串（UTF-8）

      // 循环 read() 拿到的 value 是字节块，不保证按完整字符切分，
      // 所以 decode 一定要带 { stream: true }，让解码器自己处理半个汉字的情况
      while (true) { // 一直读到流结束
        const { done, value } = await reader.read(); // done=true 表示流已关闭；value 是字节块
        if (done) break; // 流结束，退出循环

        const delta = decoder.decode(value, { stream: true }); // 解码这一块，并保留跨块状态
        if (delta) appendDelta(assistantId, delta); // 有文本就追加到助手消息
      }

      // 流结束后再 flush 一次，取出解码器里可能残留的尾巴
      const tail = decoder.decode(); // 不带参数调用 = 冲刷剩余字节
      if (tail) appendDelta(assistantId, tail); // 把尾巴也追加进去
    } catch (error) {
      // 网络错误、服务端断开等：把错误写进同一条助手消息里
      const reason = error instanceof Error ? error.message : String(error); // 统一成字符串
      appendDelta(assistantId, `请求失败：${reason}`); // 展示错误
    } finally {
      setPending(false); // 无论成功失败，都退出「回答中」状态
    }
  }

  /** 新会话：换 threadId（服务端随之换一份历史）并清空页面 */
  function newSession(): void {
    if (pending) return; // 正在回答时不允许切换，避免旧流写进新会话
    setThreadId(crypto.randomUUID()); // 生成全新会话 id
    setMessages([]); // 清空消息列表
    setInput(""); // 清空输入框
  }

  return (
    <main className="app">
      <header className="header">
        <div>
          <h1>Day 9 · Agent 聊天</h1>
          {/* 把 thread_id 显示出来，方便观察「同一 id 记得上下文、换 id 就忘」 */}
          <p className="thread">thread_id：{threadId}</p>
        </div>
        <button type="button" className="ghost" onClick={newSession} disabled={pending}>
          新会话
        </button>
      </header>

      <div className="messages" ref={listRef}>
        {/* 列表为空时给一句示例问题，顺便提示 Agent 有 get_current_time 工具 */}
        {messages.length === 0 ? (
          <p className="empty">输入问题开始聊天，例如「现在上海几点？」</p>
        ) : (
          messages.map((message) => (
            // key 用消息 id，React 才能正确复用节点、避免追加时错位
            <div key={message.id} className={`row ${message.role}`}>
              <div className="bubble">
                <span className="role">{message.role === "user" ? "你" : "助手"}</span>
                <p className="content">
                  {/* 助手消息刚创建时 content 为空，先显示占位文案，等第一块文本到达再替换 */}
                  {message.content || (message.role === "assistant" ? "正在思考…" : "")}
                </p>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 用 form 而不是裸 button：输入框里按回车也能触发 submit */}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault(); // 阻止浏览器默认的页面刷新
          void send(); // 触发异步发送；void 表示不等待返回的 Promise
        }}
      >
        <input
          value={input} // 受控输入：值来自 state
          onChange={(event) => setInput(event.target.value)} // 每次输入同步回 state
          placeholder="输入问题，回车发送"
          disabled={pending} // 回答中禁止继续输入
        />
        <button type="submit" disabled={pending || input.trim() === ""}>
          {pending ? "回答中…" : "发送"} {/* 用按钮文案反馈当前状态 */}
        </button>
      </form>
    </main>
  );
}
