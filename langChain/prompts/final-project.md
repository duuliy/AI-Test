# 综合项目提示词：个人知识库助手

> 用法：在项目根目录开启新会话，把本文件内容整段发给 AI。这是一个独立项目任务，不依赖其他 prompt 文件。

## 背景

你是一名资深 TypeScript 工程师，带我把 Day 1～10 学到的能力串成一个能演示的小项目。

项目根目录就是当前工作目录，已有 `src/day1`～`src/day10`，但**本项目与它们完全无关**：

- 不 import 任何 day 目录或 `src/shared`
- 不修改任何 day 目录
- 不修改根 `package.json`、根 `tsconfig.json`、根 `.env`
- 项目放在 `src/final-project/`，与 `src/day1`～`src/day10` 同级

## 项目目标

做一个极简的「个人知识库问答 Web 应用」：

- 基于本地 3 篇文档回答，回答带来源引用
- 页面流式显示回答，不是等全部生成完
- 同一会话记住上下文，新会话隔离
- 能调用时间、计算器、知识库检索三类工具
- 请求前先做一次结构化路由，决定是否需要查知识库

界面只做聊天页，不做登录、数据库、上传、管理后台。

## 能力映射

| Day | 在项目里用在哪 |
|---|---|
| Day 1 | 模型初始化、消息类型、流式输出 |
| Day 2 | `withStructuredOutput` 做问题路由 |
| Day 3 | `tool()` + Zod 定义三个工具 |
| Day 4 | `createAgent`、`systemPrompt`、`stream` |
| Day 5 | `MemorySaver` + `thread_id` 会话记忆 |
| Day 6 | 文档加载、切分、embedding、内存向量库 |
| Day 7 | 检索封装成工具，回答带来源 |
| Day 8 | retry、自定义 `wrapToolCall` 错误处理、summarization |
| Day 9 | Next.js Route Handler + 流式页面 |
| Day 10 | LangSmith 环境变量追踪 |

为了让项目保持简单，明确不做：

- 不做 human-in-the-loop（需要额外的审批 UI 和 `Command` 恢复流程）
- 不做自定义 `StateGraph` 和多 Agent
- 不做持久化向量库、数据库、文件上传
- 不为了“用到某个 API”而增加无意义步骤

## 技术栈

- Node 20+、TypeScript strict
- Next.js（App Router）+ React
- `langchain`、`@langchain/core`、`@langchain/openai`、`@langchain/langgraph`、`@langchain/classic`、`@langchain/textsplitters`、`zod`
- 模型走 OpenAI 兼容接口
- 独立的 `src/final-project/package.json`，不引用根项目依赖

## 目录结构

```text
src/final-project/
├── package.json
├── tsconfig.json
├── next.config.ts
├── .env.local.example
├── app/
│   ├── layout.tsx
│   ├── page.tsx
│   ├── globals.css
│   └── api/chat/route.ts
├── lib/
│   ├── env.ts
│   ├── model.ts
│   ├── embeddings.ts
│   ├── docs.ts
│   ├── rag.ts
│   ├── router.ts
│   ├── tools.ts
│   ├── middleware.ts
│   ├── agent.ts
│   └── text.ts
└── docs/
    ├── langchain.md
    ├── rag.md
    └── agent.md
```

## 任务

### 1. 独立 Next.js 应用

在 `src/final-project/` 内创建独立应用：

- `package.json` 依赖：`next`、`react`、`react-dom`、`langchain`、`@langchain/core`、`@langchain/openai`、`@langchain/langgraph`、`@langchain/classic`、`@langchain/textsplitters`、`zod`
- 开发依赖：`typescript`、`@types/node`、`@types/react`、`@types/react-dom`、`tsx`
- scripts：

```json
{
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "typecheck": "tsc --noEmit"
}
```

- `tsconfig.json` 开启 strict
- 不要改动根 `package.json`，不要复用 `src/day9/web` 的文件

### 2. 环境变量

`.env.local.example`：

```bash
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4
OPENAI_MODEL=glm-4.6
OPENAI_EMBEDDING_MODEL=embedding-3

# 可选：embedding 接口不可用时改成本地哈希
USE_LOCAL_EMBEDDINGS=0

# 可选：LangSmith 追踪
LANGSMITH_TRACING=false
LANGSMITH_API_KEY=
LANGSMITH_PROJECT=kb-assistant
```

`lib/env.ts`：

- Next.js 自动加载 `.env.local`，不要调用 `process.loadEnvFile()`
- 校验必填变量，缺失时抛出中文错误
- 不要打印完整 key

### 3. 本地知识库

`docs/` 下自己写 3 篇 500～800 字的 Markdown：

- `langchain.md`：模型、消息、工具、Agent 的基础概念
- `rag.md`：加载、切分、embedding、检索、引用的流程
- `agent.md`：`createAgent`、middleware、checkpointer 的作用

不要复制外部文章。

`lib/docs.ts`：

- 用 `node:fs/promises` 读取 `docs/*.md`
- 每篇转成 `Document`，metadata 含 `source`、`title`

`lib/embeddings.ts`：

- 用 `OpenAIEmbeddings`，模型读 `OPENAI_EMBEDDING_MODEL`
- 如果 `USE_LOCAL_EMBEDDINGS=1`，改用本地哈希 embedding（`node:crypto`，固定维度、归一化）
- 启动日志标明当前用的是真实还是本地 embedding
- 不要静默 fallback

`lib/rag.ts`：

- 用 `RecursiveCharacterTextSplitter`，`chunkSize: 400`、`chunkOverlap: 80`
- 每个 chunk metadata 增加 `chunkIndex`
- `MemoryVectorStore.fromDocuments(...)`
- 导出 `getVectorStore()`，模块级懒加载单例，避免每次请求重建
- 导出 `searchDocs(query, k = 4)`，返回 `{ content, source, chunkIndex, score }[]`

### 4. 结构化路由（Day 2）

`lib/router.ts`：

- 用 `withStructuredOutput` 定义：

```ts
z.object({
  route: z.enum(["knowledge", "time", "general"]),
  reason: z.string(),
})
```

- 输入最近一条用户消息
- 规则：
  - 问文档、概念、流程 → `knowledge`
  - 问当前时间、日期、时区 → `time`
  - 闲聊、其他 → `general`
- 路由结果只用于选择工具集合和提示词，不要用来改写用户问题
- 结构化输出失败时回退到 `knowledge`，并在服务端日志里写明原因，不要中断请求

### 5. 工具（Day 3 / Day 7）

`lib/tools.ts`：

- `search_knowledge_base({ query })`：
  - 调用 `searchDocs(query, 4)`
  - 返回格式化文本，每条包含 `[来源: source#chunkIndex]`、分数、正文
  - 无结果返回 `知识库中没有找到相关内容。`
- `get_current_time({ timezone? })`：默认 `Asia/Shanghai`，非法时区返回错误字符串
- `calculate({ a, b, op })`：`+ - * /`，禁止 `eval`，除零返回错误字符串

每个工具写清 `description` 和 Zod schema。

### 6. Middleware（Day 8）

`lib/middleware.ts`：

- `toolRetryMiddleware({ maxRetries: 2, initialDelayMs: 300 })`：所有工具生效
- 自定义 `createMiddleware({ name: "tool-error-handler", wrapToolCall })`：
  - `try/catch` 包住 `handler(request)`
  - 失败时返回 `ToolMessage`，内容含工具名和错误信息，并提示“请告知用户该工具暂时不可用”
  - `tool_call_id` 用 `request.toolCall.id`
- `summarizationMiddleware({ model, trigger: { messages: 20 }, keep: { messages: 6 } })`
- 不制造“必然失败”的假工具；错误处理只在真实异常时生效

### 7. Agent（Day 4 / Day 5）

`lib/agent.ts`：

- `const checkpointer = new MemorySaver()`
- 按路由缓存 Agent：

```ts
const toolsByRoute = {
  knowledge: [searchKnowledgeBase, getCurrentTime, calculate],
  time: [getCurrentTime, calculate],
  general: [getCurrentTime, calculate],
}
```

- `createAgent({ model, tools, systemPrompt, checkpointer, middleware })`
- `systemPrompt` 要求：
  - 中文、简洁
  - `knowledge` 路由时只依据检索结果回答，并标注 `[来源: 文件名#chunkIndex]`
  - 检索不足时明确说“根据现有知识库无法回答”，不补充常识
  - 时间、计算类问题必须先调用工具
- 导出 `getAgent(route)`
- 用模块级缓存避免每次请求重新创建 Agent

### 8. Route Handler（Day 9）

`app/api/chat/route.ts`：

- `export const runtime = "nodejs"`
- POST 接收 `{ threadId: string, message: string }`
- 校验字段，非法返回 400 JSON
- 先调用 router 得到 `route`
- 再调用：

```ts
const stream = await agent.stream(
  { messages: [new HumanMessage(message)] },
  {
    configurable: { thread_id: threadId },
    streamMode: "messages",
  },
)
```

- 用 `ReadableStream` + `TextEncoder` 增量输出纯文本
- 响应头带上 `X-Route`，值为路由结果，前端据此显示小标签
- 设置 `Content-Type: text/plain; charset=utf-8`、`Cache-Control: no-cache`
- 异常时把中文错误写入流，不要让页面一直等待
- 客户端断开时停止读取

`lib/text.ts`：

- `extractText(chunk)` 兼容 `content` 为字符串和 ContentBlock 数组

### 9. 页面（Day 9）

`app/page.tsx`：

- 消息列表、输入框、发送按钮
- 发送中禁用按钮
- `fetch` 请求 `/api/chat`，用 `response.body.getReader()` + `TextDecoder` 增量追加
- 读取 `X-Route`，在助手消息旁显示“知识库 / 时间 / 通用”
- `threadId` 用 `crypto.randomUUID()` 初始化
- “新会话”按钮重置 `threadId` 和消息列表
- 错误显示在助手消息里
- 不引 UI 框架，`globals.css` 保持简洁

### 10. LangSmith（Day 10）

- 只依赖环境变量，代码里不手动创建 tracer
- `.env.local` 配好后自动追踪
- 未配置时项目正常运行，不报错、不打印 key

## 约束

- 所有代码都在 `src/final-project/` 内
- 不 import `src/day*` 或 `src/shared`
- 不修改根项目文件
- 不实现登录、上传、数据库、HITL
- 不把真实 key 写进代码或 `.env.local.example`
- TypeScript strict，注释用中文

## 验收

在 `src/final-project/` 内执行：

```bash
npm install
npm run typecheck
npm run build
```

然后：

```bash
cp .env.local.example .env.local
# 填入真实 key
npm run dev
```

手动验证：

1. `RAG 的完整流程是什么？` → 路由为 `knowledge`，回答带 `[来源: rag.md#...]`
2. `现在纽约几点？` → 路由为 `time`，调用了时间工具
3. `37 * 19 等于多少？` → 调用了计算器
4. `LangChain 支持哪些向量数据库？` → 知识库无依据时明确说不知道，不编造
5. 同一会话先发“我叫小明”，再问“我叫什么？” → 能记住
6. 点“新会话”后再问 → 不知道上一轮
7. 回答是逐段出现的，不是最后一次性出现
8. 页面能看到路由标签

代码检查：

- `grep -r "from \"\.\./day\|from \"\.\./shared\|src/day" src/final-project` 无结果
- 根 `package.json`、根 `tsconfig.json`、所有 day 目录未变

## 汇报

完成后告诉我：

1. 新建了哪些文件
2. `npm run build` 是否通过
3. 三个路由分别选了什么工具，为什么
4. 一次知识库问答的完整链路：路由 → 检索 → Agent → 流式输出
5. 会话记忆是怎么和 `threadId` 关联的
6. LangSmith 是否启用，看到了哪些 run
7. 哪些 Day 的能力没有用上，为什么
