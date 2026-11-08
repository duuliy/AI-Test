# Day 3 提示词：Tool Calling

> 用法：在项目根目录开启新会话，把本文件内容整段发给 AI。这是一个独立任务，不依赖其他 prompt 文件。

## 背景

你是一名资深 TypeScript 工程师，带我学习 LangChain.js v1。项目根目录就是当前工作目录，已有：

- `package.json`：`langchain`、`@langchain/core`、`@langchain/openai`、`zod`、`tsx`
- `tsconfig.json`：strict + NodeNext，相对导入必须带 `.js` 后缀
- `src/day1/chat.ts`：Day 1 的流式多轮对话
- `src/day2/structured.ts`：Day 2 的结构化输出
- `.env`：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`

今天只学“定义工具 + 手动 tool calling 循环”，不要用 `createAgent`，那是 Day 4 的内容。

## 目标

用 `tool()` 和 Zod 定义 3 个工具，手动完成完整循环：

模型发起 `tool_calls` → 本地执行工具 → 回填 `ToolMessage` → 再调用模型 → 得到最终回答。

理解这个循环之后，才能看清 `createAgent` 到底替你做了什么。

## 开始前

先读：

1. `PLAN.md`
2. `src/day1/chat.ts`（复用 env 读取和错误处理思路）
3. `src/day2/structured.ts`
4. `node_modules/@langchain/core/tools` 中 `tool()`、`DynamicStructuredTool` 的类型定义
5. `node_modules/@langchain/core/messages` 中 `AIMessage`、`ToolMessage`、`ToolCall` 的类型定义

API 不确定时以本地类型定义和官方文档为准。

## 任务

### 1. 定义工具

新建 `src/day3/tools.ts`，用 `@langchain/core/tools` 的 `tool()` 定义三个工具：

**A. `get_current_time`**

- 参数：`{ timezone?: string }`，默认 `Asia/Shanghai`
- 用 `Intl.DateTimeFormat` 返回该时区的本地时间和 ISO 时间
- 非法时区返回错误字符串，不要抛异常

**B. `calculate`**

- 参数：`{ a: number, b: number, op: "+" | "-" | "*" | "/" }`
- 禁止使用 `eval` 或 `new Function`
- 除零返回错误字符串

**C. `search_knowledge`**

- 参数：`{ query: string }`
- 内置 5 条 LangChain 学习笔记（title + content），不要接真实搜索 API
- 大小写不敏感的关键词匹配，返回最相关的 3 条
- 没有命中时明确返回“未找到”，不要编造

每个工具都要：

- 写清 `description`，模型靠它决定选哪个工具
- 用 Zod schema 约束参数
- 返回字符串，方便直接放进 `ToolMessage`

最后导出 `tools` 数组，以及按名称查找工具的函数。

### 2. 手动 tool calling 循环

新建 `src/day3/run-tools.ts`：

- `const modelWithTools = model.bindTools(tools)`
- `messages` 从 `SystemMessage` + `HumanMessage` 开始
- 最多循环 5 轮：
  - `invoke` 得到 `AIMessage`，push 进 `messages`
  - 没有 `tool_calls` 就结束循环
  - 有 `tool_calls` 就逐个执行：
    - 按 `name` 找工具
    - 未知工具：回填一条错误 `ToolMessage`，不要让进程崩溃
    - 工具抛错：捕获后回填错误 `ToolMessage`
    - `ToolMessage` 必须带对应的 `tool_call_id`
  - 继续下一轮
- 每步打印 `[round]`、`[tool call]`、`[tool result]`
- 最后打印最终回答
- 超过 5 轮时打印警告并停止，避免死循环

### 3. 演示

默认运行 4 个问题：

1. 单工具：`现在上海几点？`
2. 单工具：`帮我算 37 * 19`
3. 单工具：`checkpointer 是什么？`
4. 多工具：`现在北京时间几点？再帮我算 128 / 4`

支持自定义问题：

```bash
npm run day3 -- "现在东京几点？"
```

### 4. 脚本

在 `package.json` 增加：

```json
"day3": "tsx src/day3/run-tools.ts"
```

## 约束

- 优先复用 `src/shared/model.ts`；不存在就按 Day 2 的约定创建
- 不要调用 `createAgent`
- 不要接真实天气、搜索 API
- 不加记忆、不加 RAG
- TypeScript strict，相对导入写 `.js` 后缀
- 注释用中文

## 验收

依次执行：

```bash
npm run typecheck
npm run day3
```

通过标准：

- 模型能选中正确工具
- 多工具问题至少产生 2 次 `tool_call`
- 工具报错时循环继续，最终仍有回答
- 每条 `ToolMessage` 的 `tool_call_id` 与 `tool_calls` 对应
- 代码中没有 `eval` / `new Function`

## 汇报

完成后告诉我：

1. 新增/修改了哪些文件
2. `npm run day3` 的实际工具调用轨迹
3. `AIMessage.tool_calls` 里实际有哪些字段
4. 工具报错时你是怎么回填的
5. 这个手动循环和 `createAgent` 的预期差异
