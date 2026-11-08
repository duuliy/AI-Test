# Day 8 提示词：Middleware

> 用法：在项目根目录开启新会话，把本文件内容整段发给 AI。这是一个独立任务，不依赖其他 prompt 文件。

## 背景

你是一名资深 TypeScript 工程师，带我学习 LangChain.js v1。项目根目录就是当前工作目录，Day 1～7 已完成：Agent、工具、记忆、RAG。

今天学 middleware，重点覆盖：

- 内置 `summarizationMiddleware`
- 内置 `toolRetryMiddleware`
- 内置 `humanInTheLoopMiddleware`
- 自定义 `createMiddleware({ wrapToolCall })` 处理工具异常

今天不做前端、不做 RAG。

## 硬性约束：独立日代码

- 只新建 `src/day8/` 下的文件。
- 允许在根 `package.json` 的 `scripts` 中新增 `day8`，允许新增依赖；不得升级、降级或删除已有依赖，不得改动其他脚本。
- 不 import `src/shared`、`src/day1`～`src/day7`；需要的 env 读取、模型初始化、工具定义全部复制到 `src/day8/` 内。
- 不修改其他 day 的任何文件，不改根 `tsconfig.json`。

## 目标

用一个 Agent 同时演示四种能力，并能从日志里清楚看到每种 middleware 生效：

1. 对话变长后自动摘要
2. 工具失败自动重试
3. 危险工具执行前暂停，等待人工批准
4. 工具抛异常时被自定义 middleware 转成可读错误，进程不崩

## 开始前

先读：

1. `PLAN.md`
2. `src/day5/memory.ts` 中 checkpointer 的用法
3. `src/day4/agent.ts` 中 `createAgent` 的用法
4. `node_modules/langchain/dist/agents/middleware/` 下 `summarization.d.ts`、`toolRetry.d.ts`、`hitl.d.ts`、`middleware.d.ts`
5. `node_modules/@langchain/langgraph` 中 `Command` 的类型定义

API 不确定时以本地类型定义和官方示例为准，不要猜配置字段。

## 任务

### 1. 独立配置与工具

新建 `src/day8/model.ts`：

- env 读取
- `createChatModel()`，`temperature: 0.2`
- `describeError()`

新建 `src/day8/tools.ts`，用 `tool()` 定义 4 个工具：

**A. `flaky_search`**

- 参数：`{ query: string }`
- 用模块级计数器模拟不稳定：前 2 次调用抛 `Error("临时网络错误")`，第 3 次返回 `"搜索结果：..."` 
- 用于验证 `toolRetryMiddleware`

**B. `delete_note`**

- 参数：`{ noteId: string }`
- 不真正删除文件，只返回 `"已删除笔记 noteId"` 
- 用于验证 `humanInTheLoopMiddleware`

**C. `broken_weather`**

- 参数：`{ city: string }`
- 永远抛 `Error("天气服务不可用")` 
- 用于验证自定义 `wrapToolCall` 错误处理

**D. `get_current_time`**

- 参数：`{ timezone?: string }`
- 返回当前时间，作为安全工具的对照

每个工具写清 `description` 和 Zod schema。

### 2. 自定义 middleware

新建 `src/day8/tool-error-middleware.ts`：

- 用 `createMiddleware({ name: "tool-error-middleware", wrapToolCall })`
- `wrapToolCall` 中 `try/catch` 调用 `handler(request)`
- 捕获异常后返回 `ToolMessage`，内容包含：
  - 工具名
  - 错误信息
  - 一句“请告知用户该工具暂时不可用”
- `tool_call_id` 必须是 `request.toolCall.id`
- 不要吞掉所有错误后静默成功，必须让模型看到错误文案

### 3. 组装 Agent

新建 `src/day8/middleware.ts`：

- `const checkpointer = new MemorySaver()`
- `createAgent({ model, tools, systemPrompt, middleware, checkpointer })`
- middleware 数组按下面顺序起步：

```ts
[
  toolRetryMiddleware({
    maxRetries: 2,
    initialDelayMs: 300,
    backoffFactor: 1,
    tools: ["flaky_search"],
  }),
  toolErrorMiddleware,
  humanInTheLoopMiddleware({
    interruptOn: {
      delete_note: {
        allowedDecisions: ["approve", "reject"],
        description: "删除笔记需要人工确认",
      },
    },
  }),
  summarizationMiddleware({
    model,
    trigger: { messages: 8 },
    keep: { messages: 4 },
  }),
]
```

- 注释说明 middleware 顺序可能影响包裹关系；如果实际运行发现 `flaky_search` 没被重试，调整顺序并说明原因
- `systemPrompt`：中文、简洁、优先用工具、工具报错时如实告知

### 4. 分场景演示

在 `src/day8/middleware.ts` 中按顺序打印分节标题：

**A. 重试**

- 同一 `thread_id` 提问：`帮我搜索 flaky 数据`
- 日志应出现 3 次调用尝试（2 次失败 + 1 次成功）
- 打印最终回答

**B. Human-in-the-loop**

- 提问：`删除 note-1`
- 检查 `result.__interrupt__`
- 如果有中断：
  - 打印 `actionRequests` 和 `reviewConfigs`
  - 用 `new Command({ resume: { decisions: [{ type: "approve" }] } })` 恢复
  - 打印恢复后的最终回答
- 再加一次 `reject` 演示：重新用一个新 `thread_id`，中断后用 `{ type: "reject", message: "演示模式禁止删除" }` 恢复
- 类型使用 `Interrupt<HITLRequest>`、`HITLResponse`，以实际导出为准

**C. 自定义错误处理**

- 提问：`北京天气怎么样？`
- Agent 调用 `broken_weather` 后应拿到错误 `ToolMessage`
- 最终回答应包含“天气服务不可用”，进程不崩

**D. 摘要**

- 同一 `thread_id` 连续发 6～8 条短消息，例如依次询问时间、再让 Agent 复述前一条
- 打印每轮后 state 里的消息数量
- 观察 summarization 触发后数量下降，并说明被摘要掉的内容如何保留为摘要消息
- 如果当前版本不方便读 state，就打印摘要 middleware 的日志或最终消息列表，不要自造 API

### 5. 脚本

在 `package.json` 增加：

```json
"day8": "tsx src/day8/middleware.ts"
```

只新增这一条，不要改其他脚本。

## 约束

- 不真正删除任何文件
- 不接真实天气/搜索 API
- 不做 RAG、不做前端
- 不 import 其他 day 目录
- TypeScript strict，相对导入写 `.js` 后缀
- 注释用中文

## 验收

```bash
npm run typecheck
npm run day8
```

通过标准：

- 重试场景能看到 3 次尝试，最终成功
- HITL 场景能看到暂停、审批请求、恢复执行；approve 和 reject 都有输出
- `broken_weather` 的错误被转成可读文本，进程正常退出
- 摘要场景能看到消息数量下降或摘要日志
- 代码中没有 import 其他 day 目录或 `src/shared`

## 汇报

完成后告诉我：

1. 新增/修改了哪些文件
2. middleware 数组的最终顺序，以及为什么这样排
3. HITL 中断对象里实际有哪些字段
4. `Command({ resume })` 的恢复结果
5. 摘要前后 state 的消息数量变化
6. 自定义 `wrapToolCall` 返回的 `ToolMessage` 长什么样
