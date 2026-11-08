# Day 2 提示词：结构化输出

> 用法：在项目根目录开启新会话，把本文件内容整段发给 AI。这是一个独立任务，不依赖其他 prompt 文件。

## 背景

你是一名资深 TypeScript 工程师，带我学习 LangChain.js v1。项目根目录就是当前工作目录，已有：

- `package.json`：`langchain`、`@langchain/core`、`@langchain/openai`、`zod`、`tsx`
- `tsconfig.json`：strict + NodeNext，相对导入必须带 `.js` 后缀
- `src/day1/chat.ts`：Day 1 的流式多轮对话，已完成
- `.env`：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`

Day 1 已掌握 `initChatModel`、消息类型和 `stream()`。今天只学结构化输出，不要引入 Agent、工具或记忆。

## 目标

让模型稳定返回符合 Zod schema 的对象，理解 `withStructuredOutput` 的工作方式、失败场景和重试策略。

## 开始前

先读：

1. `PLAN.md`
2. `src/day1/chat.ts`（重点看 `loadDotEnv`、`readConfig`、`describeError` 的写法）
3. `node_modules/langchain` 与 `node_modules/@langchain/core` 中 `withStructuredOutput` 相关的类型定义

API 不确定时以本地类型定义和官方文档为准，不要凭记忆写。

## 任务

### 1. 公共模型初始化

新建 `src/shared/model.ts`：

- `loadEnv()`：调用 `process.loadEnvFile()`，`.env` 不存在时忽略
- `createModel()`：校验 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`，缺失时输出中文提示并退出；调用 `initChatModel(modelName, { modelProvider: "openai", apiKey, configuration: { baseURL }, temperature: 0 })`
- `describeError(error)`：沿用 Day 1 的错误翻译思路

不要改动 `src/day1` 下的文件。如果 `src/shared/model.ts` 已存在，直接复用。

### 2. 两个 Zod schema

新建 `src/day2/structured.ts`，定义：

**A. 意图路由 `IntentSchema`**

- `intent`：`z.enum(["weather", "calculator", "knowledge_search", "chitchat"])`
- `confidence`：0～1 的数字
- `reason`：一句简短理由
- 每个字段加 `.describe()`，用自然语言说明含义

**B. 会议信息抽取 `MeetingSchema`**

- `title`、`startTime`、`location`：可能缺失，用 `.nullable()`，不要用 `.optional()`
- `attendees`：字符串数组，未提及时返回空数组
- `durationMinutes`：正整数或 `null`
- 注释里说明 `.nullable()` 与 `.optional()` 的区别

### 3. 调用结构化输出

- 分别用 `model.withStructuredOutput(schema, { name: "..." })` 创建两个 runner
- 每个 runner 用 `SystemMessage` + `HumanMessage` 调用
- 打印：原始输入、解析后的对象、关键字段的 `typeof` 检查

至少覆盖四组输入：

- 意图明确的一句
- 意图模糊、置信度应偏低的一句
- 会议信息完整的一句
- 会议信息缺失较多的一句（验证 `null` 和空数组）

### 4. 失败处理

- 返回 `null` 或抛错时打印中文提示，不要静默失败
- 最多重试 1 次，并注释说明结构化输出为什么会失败
- 如果当前 provider 不支持默认的 JSON Schema 模式（常见 HTTP 400），先查当前版本 `withStructuredOutput` 支持的 `method` 选项，再改用 function calling 方式，并注释原因。不要为了绕过报错而删掉 schema。

### 5. 脚本

在 `package.json` 增加：

```json
"day2": "tsx src/day2/structured.ts"
```

## 约束

- TypeScript strict，不用 `any` 绕过类型
- NodeNext：相对导入写 `.js` 后缀
- 不引入新的重型依赖，Zod 已安装
- 不实现 Day 3 及以后的内容
- 注释用中文，只解释“为什么”，不复述代码

## 验收

依次执行：

```bash
npm run typecheck
npm run day2
```

通过标准：

- 类型检查无错误
- 四组输入都能打印结构化结果
- 缺失字段是 `null` 或空数组，不是 `undefined`，也不是字符串 `"null"`
- 失败路径有可读的中文提示

## 汇报

完成后告诉我：

1. 新增/修改了哪些文件
2. `npm run day2` 的实际输出摘要
3. `withStructuredOutput` 在当前 provider 上用的是哪种模式，为什么
4. 遇到的坑和处理方式
