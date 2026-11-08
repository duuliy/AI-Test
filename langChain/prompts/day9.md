# Day 9 提示词：接入前端（Next.js Route Handler）

> 用法：在项目根目录开启新会话，把本文件内容整段发给 AI。这是一个独立任务，不依赖其他 prompt 文件。

## 背景

你是一名资深 TypeScript 工程师，带我学习 LangChain.js v1。项目根目录就是当前工作目录，Day 1～8 已完成：Agent、工具、记忆、RAG、middleware。

今天把 Agent 接到前端：用 Next.js 的 Route Handler 包一层 Agent，把流式输出推到页面上，并保留会话记忆。

## 硬性约束：独立日代码

- 只新建 `src/day9/` 下的文件。
- **不要修改根 `package.json`、根 `tsconfig.json`、根 `.env`，也不要修改 `src/day1`～`src/day8` 的任何文件。**
- 在 `src/day9/web/` 下建一个**独立的 Next.js 应用**，拥有自己的 `package.json` 和 `tsconfig.json`。
- 不 import 根项目的任何源码；Agent、工具、env 读取全部复制到 `src/day9/web/lib/` 内。
- 根项目不新增 `day9` 脚本；运行方式在 `src/day9/web/` 目录内执行。

## 目标

一个可演示的聊天页面：

- 用户输入问题，页面逐字显示回答，不是等全部生成完再一次性出现
- 同一会话内能记住上下文
- 点“新会话”后上下文隔离
- Agent 至少能调用一个工具

## 开始前

先读：

1. `PLAN.md`
2. `src/day5/memory.ts` 中 `MemorySaver` 和 `thread_id` 的用法
3. `src/day4/agent.ts` 中 `createAgent` 和 `stream` 的用法
4. `node_modules/langchain` 中 `createAgent` 的类型定义
5. Next.js 当前稳定版 Route Handler 与 `ReadableStream` 的官方用法

API 不确定时以本地类型定义和官方文档为准。

## 任务

### 1. 独立 Next.js 应用

在 `src/day9/web/` 下创建：

- `package.json`：自己的 scripts 和依赖，不引用根项目
- `tsconfig.json`
- `next.config.ts`
- `app/layout.tsx`
- `app/page.tsx`
- `app/globals.css`
- `app/api/chat/route.ts`
- `lib/agent.ts`
- `lib/env.ts`
- `.env.local.example`

依赖至少：`next`、`react`、`react-dom`、`langchain`、`@langchain/core`、`@langchain/openai`、`@langchain/langgraph`、`zod`；开发依赖：`typescript`、`@types/node`、`@types/react`、`@types/react-dom`。

scripts：

```json
{
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "typecheck": "tsc --noEmit"
}
```

### 2. Agent 层

`lib/env.ts`：

- Next.js 会自动加载 `.env.local`，不要用 `process.loadEnvFile()`
- 读取 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`
- 缺失时抛出带中文说明的错误，错误信息要能显示到页面

`lib/agent.ts`：

- 用 `initChatModel` 创建模型，配置方式与项目现有 OpenAI 兼容接口一致
- 用 `createAgent` 创建 Agent，带 `MemorySaver` checkpointer
- 定义一个工具 `get_current_time`，参数 `{ timezone?: string }`，返回当前时间
- `systemPrompt`：中文、简洁、时间类问题必须调用工具、不编造
- 用**懒加载单例**：不要在模块加载时立刻创建 Agent，避免 `next build` 因缺少 env 失败
- 导出 `getAgent()` 和 `extractText(chunk)`，`extractText` 要兼容 `content` 为字符串或 ContentBlock 数组的情况

### 3. Route Handler

`app/api/chat/route.ts`：

- `export const runtime = "nodejs"`
- `POST` 接收 `{ threadId: string, message: string }`
- 校验两个字段都是非空字符串，否则返回 400 JSON
- 调用：

```ts
const stream = await agent.stream(
  { messages: [new HumanMessage(message)] },
  {
    configurable: { thread_id: threadId },
    streamMode: "messages",
  },
)
```

- 用 `ReadableStream` + `TextEncoder` 把文本增量写入响应
- 返回 `text/plain; charset=utf-8`，并设置 `Cache-Control: no-cache`
- 捕获异常时把中文错误写进流，不要让页面一直转圈
- 客户端断开时停止读取，避免继续消耗模型调用

### 4. 前端页面

`app/page.tsx`：

- 消息列表：用户消息和助手消息分别有样式
- 输入框 + 发送按钮，发送中禁用按钮
- 用 `fetch` 请求 `/api/chat`，读取 `response.body.getReader()`，用 `TextDecoder` 增量追加到当前助手消息
- `threadId` 用 `crypto.randomUUID()` 初始化和重置
- “新会话”按钮重置 `threadId` 和消息列表
- 错误时把错误文本显示在助手消息里
- 样式简洁即可，不要引 UI 框架

### 5. 环境变量示例

`src/day9/web/.env.local.example`：

```bash
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4
OPENAI_MODEL=glm-4.6
```

不要复制真实 key。

### 6. 运行说明

在汇报中给出：

```bash
cd src/day9/web
npm install
cp .env.local.example .env.local
npm run dev
```

## 约束

- 不修改根项目任何文件
- 不使用 Express、不使用 SSE；Route Handler 直接返回纯文本流
- 不做 RAG、不做 middleware
- 所有 import 都指向 `src/day9/web/lib/` 或 npm 包
- TypeScript strict，注释用中文

## 验收

在 `src/day9/web/` 内执行：

```bash
npm run typecheck
npm run build
```

通过标准：

- 类型检查和构建都通过，缺少 `.env.local` 时也不会在 build 阶段崩溃
- `npm run dev` 后页面能打开
- 发一条消息，回答逐步出现
- 同一 `threadId` 追问能记住上一轮
- 点“新会话”后追问不知道上一轮
- 请求时间类问题时能看到 Agent 调用 `get_current_time`

## 汇报

完成后告诉我：

1. 新增了哪些文件
2. 如何启动和访问页面
3. 流式响应的数据形状是什么
4. 会话记忆是怎么和 `threadId` 关联的
5. `next build` 是否通过，遇到过什么坑
