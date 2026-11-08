# LangChain.js 两周学习计划

> 来源：Trae 会话「langchain学习计划」。Day 1 的实现见 [src/day1/chat.ts](src/day1/chat.ts)。

## 技术栈

- Node 20+、TypeScript（strict）
- `langchain`、`@langchain/core`、`@langchain/langgraph`、`zod`
- 模型走 OpenAI 兼容接口（`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`）
- 使用 LangChain v1 新 API，不使用 `AgentExecutor`、`initializeAgentExecutorWithOptions` 等旧写法

## 第 1 周：把 Agent 跑起来

- Day 1：环境搭建，用 `initChatModel` 调通模型，熟悉消息类型和流式输出。
- Day 2：结构化输出，用 `zod` schema 配合 `withStructuredOutput`。
- Day 3：用 `tool()` 加 `zod` 定义工具，理解 tool calling。
- Day 4：用 `createAgent` 搭 Agent，学会 `systemPrompt`、`responseFormat` 和 `stream`。
- Day 5：记忆，用 checkpointer 加 `thread_id` 实现多轮对话。
- 周末项目：一个能调用 2～3 个工具的命令行助手。

## 第 2 周：RAG、Middleware、接入前端

- Day 1～2：RAG。包括文档加载、切分、embedding、内存向量库，再把检索结果封装成工具给 Agent 用。
- Day 3：Middleware。包括内置的 summarization、retry、human-in-the-loop，再自己写一个 `wrapToolCall` 处理工具报错。
- Day 4：接入前端。用 Next.js 的 Route Handler 包一层 Agent，把流式输出推到页面上。
- Day 5：LangSmith 追踪和调试，顺带了解 LangGraph 的 `StateGraph`。
- 周末项目：一个基于自己文档的问答 Web 应用，带流式输出和会话记忆。

## 当前进度

- Day 1 已完成：项目骨架、流式多轮对话、错误处理、类型检查。
- `@langchain/langgraph` 属于后续阶段，Day 1 暂未安装。
