# LangChain.js 两周学习大纲

> 这份文件只记录每天的学习目标、知识点和验收标准。具体执行指令在对应的 dayN 提示词文件里。

## 技术栈

- Node 20+、TypeScript strict、`tsx`
- `langchain`、`@langchain/core`、`@langchain/langgraph`、`@langchain/openai`、`zod`
- 模型走 OpenAI 兼容接口
- 每天 1 小时：10 分钟看文档，20-30 分钟写代码，10 分钟记笔记

## 总览

| Day | 主题 | 核心产出 |
|---|---|---|
| Day 1 | 环境与流式对话 | CLI 流式多轮对话 |
| Day 2 | 结构化输出 | 稳定的 Zod JSON 输出 |
| Day 3 | Tool Calling | 3 个工具 + 手动调用循环 |
| Day 4 | createAgent | 能自主选工具的 Agent |
| Day 5 | 会话记忆 | checkpointer + thread_id |
| Day 6 | RAG 入库 | 文档切分、embedding、内存向量库 |
| Day 7 | RAG Agent | 检索工具化，回答带引用 |
| Day 8 | Middleware | 摘要、重试、HITL、错误处理 |
| Day 9 | 接入前端 | Next.js 流式聊天页 |
| Day 10 | 追踪与 StateGraph | LangSmith 链路 + 最小状态图 |
| 综合项目 | 个人知识库助手 | 独立 RAG Web 应用 |

---

## 第一周：把 Agent 跑起来

### Day 1：环境搭建与流式对话

**目标**

从零搭出 TypeScript 项目，用 LangChain 调通模型，完成命令行流式多轮对话。

**知识点**

- `initChatModel` 接入任意 OpenAI 兼容服务
- `SystemMessage` / `HumanMessage` / `AIMessage`，上下文就是一个消息数组
- `stream()` 返回 `AIMessageChunk`，需要自行拼接
- 模型无状态，每轮都要重发历史
- 失败或中断的轮次不能写入历史

**产出**

- `package.json`、`tsconfig.json`、`.env.example`
- `src/day1/chat.ts`：流式多轮 CLI
- 可选 `src/day1/server.ts`：Express + SSE

**验收**

- `npm run typecheck` 通过
- `npm run day1` 连续两轮，第二轮能复述第一轮内容
- 假 key 能显示中文 401 提示

**提示词**：[day1.md](./day1.md)

---

### Day 2：结构化输出

**目标**

让模型稳定返回符合 Zod schema 的对象，而不是靠正则解析自然语言。

**知识点**

- `withStructuredOutput` 与 Zod schema
- `.describe()` 如何影响模型
- `.nullable()` 与 `.optional()` 的区别
- 结构化输出失败的原因与重试
- provider 不支持 JSON Schema 时改用 function calling

**产出**

- `src/day2/structured.ts`
- 意图路由 schema + 会议信息抽取 schema
- 正常输入、模糊输入、缺失字段、失败路径的演示

**验收**

- `npm run typecheck` 通过
- `npm run day2` 输出合法对象
- 缺失字段是 `null` 或空数组，不是字符串 `"null"`

**提示词**：[day2-structured-output.md](./day2-structured-output.md)

---

### Day 3：Tool Calling

**目标**

理解工具调用不是模型直接执行，而是模型返回 `tool_calls`，由本地代码执行后回填结果。

**知识点**

- `tool()` + Zod 定义工具参数
- `description` 决定模型如何选择工具
- `bindTools` 与 `AIMessage.tool_calls`
- `ToolMessage` 必须带 `tool_call_id`
- 未知工具、工具异常、死循环保护

**产出**

- `src/day3/tools.ts`：时间、计算器、知识检索三个工具
- `src/day3/run-tools.ts`：手写完整工具循环，最多 5 轮

**验收**

- 单工具、多工具问题都能正确调用
- 工具报错时循环继续，进程不崩
- 代码中没有 `eval` / `new Function`

**提示词**：[day3-tool-calling.md](./day3-tool-calling.md)

---

### Day 4：createAgent

**目标**

用 `createAgent` 替换 Day 3 的手动循环，理解框架替你封装了什么。

**知识点**

- `createAgent({ model, tools, systemPrompt })`
- `systemPrompt` 如何约束工具使用和回答风格
- `responseFormat` 让最终答复结构化
- `streamMode: "messages"` 与 `"updates"` 的差异
- 不使用 `AgentExecutor` 等旧 API

**产出**

- `src/day4/agent.ts`
- 基础 Agent、带 `responseFormat` 的 Agent、两种流式模式演示
- 支持命令行参数传入问题

**验收**

- Agent 自主选中正确工具
- 流式文本逐步出现
- 结构化结果字段完整

**提示词**：[day4-create-agent.md](./day4-create-agent.md)

---

### Day 5：会话记忆

**目标**

用 checkpointer 管理多轮上下文，理解 `thread_id` 是会话主键。

**知识点**

- `MemorySaver` 与 checkpointer
- `invoke(..., { configurable: { thread_id } })`
- 同线程记忆、跨线程隔离
- `MemorySaver` 只存在进程内存，重启丢失
- 对比 Day 1 的 `Map<sessionId, messages>`

**产出**

- `src/day5/memory.ts`
- 四轮演示：A 记住、B 不知道、A 仍记得

**验收**

- 同一 `thread_id` 能答出前文
- 不同 `thread_id` 互相隔离
- 能说清 checkpointer 和消息历史的关系

**提示词**：[day5-memory.md](./day5-memory.md)

---

## 第二周：RAG、Middleware、前端

### Day 6：RAG 入库与检索

**目标**

把本地文档变成可检索的 chunk，理解 RAG 的前半段。

**知识点**

- 文档加载与 metadata
- `RecursiveCharacterTextSplitter` 的 `chunkSize` / `chunkOverlap`
- `OpenAIEmbeddings`
- `MemoryVectorStore`
- `similaritySearchWithScore`
- embedding 不可用时的本地哈希兜底

**产出**

- `src/day6/docs/` 三篇本地 Markdown
- `src/day6/ingest.ts`：加载、切分、建库
- `src/day6/rag.ts`：命令行检索，打印 Top 3 和分数

**验收**

- 打印 chunk 数量和 Top 3 结果
- 相关问题命中的内容确实相关
- 无关问题分数明显更低

**提示词**：[day6.md](./day6.md)

---

### Day 7：RAG Agent

**目标**

把检索封装成工具，让 Agent 自己决定何时查知识库，并在回答里带来源。

**知识点**

- Retriever Tool 的参数和返回值设计
- 检索结果格式化
- 引用格式 `[来源: 文件名#chunkIndex]`
- 没有依据时明确说不知道
- 模块级缓存，避免重复 embed

**产出**

- `src/day7/` 独立副本：docs、model、ingest
- `src/day7/retriever-tool.ts`
- `src/day7/rag-agent.ts`
- 3 个可回答问题 + 1 个知识库外问题

**验收**

- 可回答问题带引用
- 知识库外问题不编造
- 工具日志能看到命中的 chunk 和分数

**提示词**：[day7.md](./day7.md)

---

### Day 8：Middleware

**目标**

用 middleware 给 Agent 加可靠性能力，而不是把逻辑堆进 prompt。

**知识点**

- `summarizationMiddleware`：长对话自动摘要
- `toolRetryMiddleware`：工具失败自动重试
- `humanInTheLoopMiddleware`：危险操作前暂停审批
- `createMiddleware({ wrapToolCall })`：自定义工具错误处理
- middleware 顺序对包裹关系的影响

**产出**

- `src/day8/model.ts`、`tools.ts`
- `src/day8/tool-error-middleware.ts`
- `src/day8/middleware.ts`：重试、HITL approve/reject、错误处理、摘要四段演示

**验收**

- 重试场景能看到 3 次尝试
- HITL 能暂停并恢复
- 工具异常转成可读文本，进程不崩
- 摘要前后消息数量有变化

**提示词**：[day8.md](./day8.md)

---

### Day 9：接入前端

**目标**

用 Next.js Route Handler 包一层 Agent，把流式输出推到页面，并保留会话记忆。

**知识点**

- Next.js App Router 与 Route Handler
- `ReadableStream` + `TextEncoder` 返回纯文本流
- 前端 `response.body.getReader()` + `TextDecoder`
- `threadId` 与 `MemorySaver`
- 懒加载单例，避免 build 阶段读取 env

**产出**

- `src/day9/web/` 独立 Next.js 应用
- `app/api/chat/route.ts`
- `app/page.tsx`：消息列表、流式追加、新会话
- `.env.local.example`

**验收**

- `npm run typecheck`、`npm run build` 通过
- 回答逐步出现
- 同线程记住上下文，新会话隔离
- 时间问题能触发工具

**提示词**：[day9.md](./day9.md)

---

### Day 10：LangSmith 与 StateGraph

**目标**

能看见一次 Agent 调用的完整链路，并理解 LangGraph 最小状态图。

**知识点**

- LangSmith tracing 环境变量
- Agent run 中的模型调用、工具调用、耗时
- `StateSchema`、`ReducedValue`
- `StateGraph` 的节点、边、状态更新
- `StateGraph` 与 `createAgent` 的关系

**产出**

- `src/day10/trace.ts`：带工具的 Agent + LangSmith
- `src/day10/graph.ts`：`classify → answer → review` 三节点状态图
- 无 LangSmith key 时正常跳过

**验收**

- `npm run day10` 正常运行
- 配置 key 后 LangSmith 能看到 run
- `npm run day10:graph` 打印分类、回答和累积的 `steps`

**提示词**：[day10.md](./day10.md)

---

## 综合项目：个人知识库助手

**目标**

把 Day 1～10 串成一个独立、可演示的小项目，不再依赖任何 day 目录代码。

**项目位置**

`src/final-project/`，与 `src/day1`～`src/day10` 同级。

**功能**

- 本地文档入库：加载、切分、embedding、内存向量库
- 结构化路由：`knowledge` / `time` / `general`
- 三类工具：知识库检索、当前时间、计算器
- Agent + `MemorySaver` 多轮记忆
- retry、自定义工具错误处理、summarization
- Next.js 流式聊天页面 + 新会话
- 可选 LangSmith 追踪

**验收**

- 独立安装、`typecheck`、`build` 通过
- 知识库问题带来源引用
- 时间、计算问题调用对应工具
- 同会话记忆、新会话隔离
- 回答流式显示

**提示词**：[final-project.md](./final-project.md)

---

## 检查点

每完成一天，问自己三个问题：

1. 今天新增的 API，能不能用一句话说清它解决什么问题？
2. 代码跑失败时，报错属于配置、模型、工具还是状态管理？
3. 如果换一个模型 provider，哪些地方需要改？

两周结束后应能独立完成：

- 给 Agent 加一个新工具
- 给 RAG 换一套文档并调整切分参数
- 给前端加一个会话列表
- 用 LangSmith 定位一次工具调用失败

## 暂不深入

- LangGraph 自定义图、子图、多 Agent 协作
- 持久化 checkpointer（SQLite / Postgres）
- 生产级向量数据库与检索重排
- 鉴权、配额、流式取消的完整生产实现

