# Day 1 提示词：环境搭建与流式多轮对话

> 用法：在项目根目录开启新会话，把本文件内容整段发给 AI。这是一个独立任务。
> 说明：Day 1 的原始指令来自 Trae 会话的 long-text 提示词，当时没有落到 `prompts/` 目录；本文件是事后按实际实现补录的版本，内容与已完成代码一致。

## 背景

你是一名资深 TypeScript 工程师，带我学习 LangChain.js v1（不是 Python 版）。项目根目录就是当前工作目录，当前可能是空目录或只有空骨架。

技术约定：

- Node 20+、TypeScript strict 模式、用 `tsx` 直接运行 TS
- 模型走 OpenAI 兼容接口，配置放在 `.env`：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`
- 使用 LangChain v1 新 API，不使用 `AgentExecutor` 等旧写法
- 我熟悉 TypeScript / Node.js，不需要解释 JS 基础概念

## 目标

从零搭出项目骨架，并用 LangChain 调通模型：命令行流式多轮对话。

掌握三件事：

1. `initChatModel` 如何接入任意 OpenAI 兼容服务
2. 三种消息类型（`SystemMessage` / `HumanMessage` / `AIMessage`）与“上下文就是数组”的含义
3. `stream()` 返回的 `AIMessageChunk` 是增量，需要自行拼接

## 开始前

1. 先 `ls` 查看当前目录，**不要覆盖已有文件**
2. 检查 Node 版本是否 >= 20；不是则提示切换，不要擅自改系统环境
3. 不要提前实现 Day 2 及以后的功能

## 任务

### 1. 工程文件

创建 / 补齐：

- `package.json`：依赖 `langchain`、`@langchain/core`、`@langchain/openai`、`zod`；dev 依赖 `tsx`、`typescript`、`@types/node`
- `tsconfig.json`：`strict`、`module` / `moduleResolution` 用 NodeNext，`target` ES2022
- `.env.example`：三个变量留占位值
- `.gitignore`：忽略 `node_modules`、`.env`、`dist`
- `scripts`：`day1` → `tsx src/day1/chat.ts`，`typecheck` → `tsc --noEmit`

不要提交真实 key。

### 2. `src/day1/chat.ts`

实现命令行流式多轮对话：

- `loadDotEnv()`：用 `process.loadEnvFile()`，`.env` 不存在时忽略（ENOENT），其他错误抛出
- `readConfig()`：校验三个环境变量，缺失时一次性列出全部缺失项、中文提示、`exit(1)`
- `extractText(chunk)`：兼容 `chunk.content` 为 string 或 ContentBlock[]，只取 `type === "text"` 的块
- `describeError(error)`：把状态码与网络错误翻译成中文，至少覆盖 401/403、404、429、5xx、DNS、连接拒绝、TLS、超时
- `main()`：
  - `initChatModel(modelName, { modelProvider: "openai", apiKey, configuration: { baseURL } })`
  - 历史数组 `messages` 以 `SystemMessage` 开头
  - readline 逐行读输入；`exit` 退出；空行跳过
  - 每轮发 `[...messages, new HumanMessage(line)]`，`stream()` 逐块打印并拼接
  - **成功后才 push `HumanMessage` + `AIMessage(reply)`**，失败/中断不写历史
  - Ctrl+C：生成中 `abort()` 当前请求，空闲时直接退出
  - `AbortSignal.any` 合并“用户中断”和 60s 超时

### 3. 验证

- `npm run typecheck` 通过
- 用真实 `.env` 跑 `npm run day1`，连续两轮：第二轮能复述第一轮内容
- 用假 key 验证 401 的中文提示

### 4. 可选扩展：Express + SSE

Day 1 完成后，可额外加一个 `src/day1/server.ts` 作为 HTTP 版，逻辑保持不变：

- `POST /chat/stream`：`{ sessionId, message }` → `text/event-stream`，事件为 `{"delta"}` / `{"done":true}` / `{"error"}`
- 历史存 `Map<sessionId, BaseMessage[]>`
- 断连监听必须用 `res.on("close")` 而不是 `req.on("close")`（Node 16+ 中 req 的 close 在请求体读完就触发）

## 讲解要求

每完成一段代码，用中文说明“为什么这么写”，重点讲：

- 为什么模型无状态、每轮要重发全部历史
- `AIMessageChunk` 与完整 `AIMessage` 的区别，直接 push chunk 会破坏什么
- 为什么失败/中断的轮次不能进历史

最后给 3 道自测题。
