# Day 5 提示词：会话记忆

> 用法：在项目根目录开启新会话，把本文件内容整段发给 AI。这是一个独立任务，不依赖其他 prompt 文件。

## 背景

你是一名资深 TypeScript 工程师，带我学习 LangChain.js v1。项目根目录就是当前工作目录，已有：

- `package.json`：`langchain`、`@langchain/core`、`@langchain/openai`、`zod`、`tsx`
- `tsconfig.json`：strict + NodeNext，相对导入必须带 `.js` 后缀
- Day 1～4：流式对话、结构化输出、手动工具循环、`createAgent`
- `.env`：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`

Day 1 用 `Map<sessionId, messages>` 做过进程内多轮对话。今天用 LangChain 的 checkpointer 把这套逻辑交给框架管理。

## 目标

用 `checkpointer` + `thread_id` 实现多轮记忆，并验证：

- 同一个 `thread_id` 能记住前文
- 不同 `thread_id` 之间互相隔离
- `MemorySaver` 只存在进程内存，重启即丢

## 开始前

先读：

1. `PLAN.md`
2. `src/day1/chat.ts` 和 `src/day1/server.ts` 中会话历史的实现
3. `src/day4/agent.ts`
4. `node_modules/langchain` 中 `createAgent` 对 `checkpointer` 的类型定义
5. `node_modules/@langchain/langgraph` 中 `MemorySaver`、`BaseCheckpointSaver` 的类型定义

API 不确定时以本地类型定义和官方文档为准。

## 任务

### 1. 安装依赖

如果 `@langchain/langgraph` 还不在 `package.json` 中：

```bash
npm i @langchain/langgraph
```

已安装就跳过。

### 2. 创建带记忆的 Agent

新建 `src/day5/memory.ts`：

- `import { MemorySaver } from "@langchain/langgraph"`
- `const checkpointer = new MemorySaver()`
- `createAgent({ model, tools, systemPrompt, checkpointer })`
- 调用时传线程配置：

```ts
await agent.invoke(
  { messages: [new HumanMessage(text)] },
  { configurable: { thread_id } },
)
```

- 工具复用 Day 3 的 `tools`；如果不存在，用 Day 4 的最小工具集
- `systemPrompt` 要求中文、简洁、优先使用工具、不编造

### 3. 演示脚本

按顺序执行并打印每轮结果：

1. thread `user-a`：`我叫小明，请记住。`
2. thread `user-a`：`我叫什么？`
3. thread `user-b`：`我叫什么？`
4. thread `user-a`：`再说一次，我叫什么？`

预期：

- 第 2 轮答出“小明”
- 第 3 轮不知道
- 第 4 轮仍记得

每轮额外打印当前线程的消息数量。优先使用当前版本提供的方式（例如 `agent.getState(...)`）；类型不支持就跳过，不要自造 API。

### 4. 注释说明

在关键位置注释：

- checkpointer 保存的是完整消息历史，不是“模型记住了”
- `thread_id` 就是会话主键
- `MemorySaver` 是进程内存储，重启丢失；生产环境应换持久化 checkpointer
- 对比 Day 1 的 `Map<sessionId, messages>`，说明框架替你做了什么

### 5. 脚本

在 `package.json` 增加：

```json
"day5": "tsx src/day5/memory.ts"
```

## 约束

- 只做短期记忆，不要接 SQLite、Postgres、Redis
- 不做消息摘要、裁剪、长期记忆
- 不做多 Agent、不做 RAG
- 不修改 Day 1～4 的文件
- TypeScript strict，相对导入写 `.js` 后缀
- 注释用中文

## 验收

依次执行：

```bash
npm run typecheck
npm run day5
```

通过标准：

- `user-a` 的第二轮能答出名字
- `user-b` 不知道名字
- `user-a` 回到自己的线程后仍记得
- 能说清 `thread_id`、checkpointer 和消息历史三者的关系
- 没有引入持久化依赖

## 汇报

完成后告诉我：

1. 新增/修改了哪些文件
2. `npm run day5` 四轮的实际输出
3. checkpointer 是在哪一步写入历史的
4. 不同 `thread_id` 的隔离是怎么实现的
5. 如果进程重启，这个示例会发生什么
