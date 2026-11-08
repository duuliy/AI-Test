# Day 2 提示词：状态设计与 Reducer

> 用法：在项目根目录开启新会话，把本文件内容整段发给 AI。这是一个独立任务，不依赖其他 prompt 文件。

## 背景

你是一名资深 TypeScript 工程师，带我学习 LangGraph.js v1。项目根目录就是当前工作目录，Day 1 已完成：工程骨架、`StateSchema`、三节点直线图、`updates` 流。

今天只学状态本身：同一个字段被多个节点写入时，到底是覆盖还是合并。

## 硬性约束：独立日代码

- 只新建 `src/day2/` 下的文件
- 允许在根 `package.json` 的 `scripts` 中新增 `day2`，允许新增依赖；不得升级、降级或删除已有依赖，不得改动其他脚本
- 不 import `src/shared`、`src/day1`；env 读取和模型初始化复制到 `src/day2/` 内
- 不修改其他 day 的任何文件，不改根 `tsconfig.json` 和 `PLAN.md`

## 目标

写一张带并行分支的图，清楚演示四件事：

1. 普通字段被后写覆盖
2. `ReducedValue` 按自定义规则合并
3. `MessagesValue` 自动合并消息数组（与普通数组字段对比）
4. `configurable` 传参与 `updateState` 手动改状态

## 开始前

先读：

1. `PLAN.md`
2. `src/day1/graph.ts` 中 `StateSchema` 和 `ReducedValue` 的写法
3. `node_modules/@langchain/langgraph/dist/state/schema.d.ts` 的 `StateSchema` 文档注释
4. `node_modules/@langchain/langgraph/dist/state/prebuilt/messages.d.ts` 中 `MessagesValue`
5. `node_modules/@langchain/langgraph/dist/graph/messages_reducer.d.ts` 中 `Messages` 输入类型
6. `node_modules/@langchain/langgraph/dist/pregel/types.d.ts` 中 `getState`、`updateState`
7. `node_modules/@langchain/langgraph/dist/web.d.ts` 中 `MemorySaver`（今天只借用它跑 `updateState`，不做线程隔离）

API 不确定时以本地类型定义为准。

## 任务

### 1. 配置

新建 `src/day2/model.ts`，内容和 Day 1 的 `model.ts` 一致（独立复制，不 import）。

### 2. 状态定义

新建 `src/day2/state.ts`，用 `new StateSchema({...})` 定义：

- `userId: z.string().default("anonymous")`
- `messages: MessagesValue`
- `plainMessages: z.array(z.string()).default([])`（用于对照，普通字段是覆盖）
- `steps`：`ReducedValue`，输入字符串，累积成数组
- `findings`：`ReducedValue`，输入字符串，累积成**去重**数组
- `score`：`ReducedValue`，输入数字，合并规则取最大值

注释写清：哪些是 last value、哪些是 reducer、输入类型和存储类型分别是什么。

### 3. 并行分支演示

新建 `src/day2/reducers.ts`：

- 图结构：`START` 分别连到 `left` 和 `right`（两条 `addEdge`），两个分支都连到 `join`（用数组起点写法 `addEdge(["left", "right"], "join")`，以本地类型定义为准）
- `left` 和 `right` 都返回：
  - 一条 `HumanMessage` / `AIMessage`（用 `new HumanMessage(...)` 等构造，内容固定，不调模型）
  - 相同的 `plainMessages` 字符串
  - 不同的 `findings`
  - 不同的 `steps`
  - 不同的 `score`
- `join` 返回 `{ steps: "join" }`
- 并行分支用两条 `addEdge(START, "left")` / `addEdge(START, "right")` 形成扇出，`join` 用数组起点形成扇入
- `invoke` 后打印全部状态字段

期望：

- `steps` 包含两个分支和 join 的条目
- `findings` 去重后保留两条
- `score` 是分支里的较大值，不是最后一个分支的值
- `plainMessages` 只剩最后写入的那一条，能直观看出覆盖
- `messages` 保留两条消息

### 4. configurable 传参

在同一张图或单独入口节点里演示：

- `invoke(input, { configurable: { userId: "user-42" } })`
- 节点第二个参数是 runtime，从 `runtime.configurable` 读 `userId`，返回 `{ userId }`
- 不给 `configurable` 时回落到默认值
- 打印两种情况的 `userId`

### 5. `updateState`

新建 `src/day2/update-state.ts`：

- `const checkpointer = new MemorySaver()`
- `compile({ checkpointer })`
- `invoke(..., { configurable: { thread_id: "day2" } })`
- 调用 `graph.updateState({ configurable: { thread_id: "day2" } }, { score: 99, steps: "manual" }, "left")`
- 再 `getState` 打印，确认 `score` 被改成 99
- 注释说明：checkpointer 的细节、持久化和线程隔离是 Day 4 的内容，今天只借用

### 6. 脚本

在 `package.json` 增加：

```json
"day2": "tsx src/day2/reducers.ts",
"day2:update": "tsx src/day2/update-state.ts"
```

只新增这两条，不要改其他脚本。

## 约束

- 不做条件边、循环、工具调用、中断、子图
- 不引入 embedding 或 RAG
- 不修改 Day 1 的文件
- TypeScript strict，相对导入写 `.js` 后缀
- 注释用中文

## 验收

```bash
npm run typecheck
npm run day2
npm run day2:update
```

通过标准：

- `steps` 是累加结果，`findings` 去重生效，`score` 取最大值
- `messages` 与 `plainMessages` 的差异能直接从输出看出来
- 并行分支都执行了，`join` 只执行一次
- `configurable` 的 `userId` 生效，缺省时有回落
- `updateState` 后 `getState` 的 `score` 变成 99
- 代码中没有 import 其他 day 目录或 `src/shared`

## 汇报

完成后告诉我：

1. 新增了哪些文件
2. 状态里每个字段用的是普通 schema 还是 reducer，为什么
3. `messages` 和 `plainMessages` 的输出差异
4. 并行分支写入同一字段时的实际合并结果
5. `updateState` 前后的 `score`
6. 用一句话说清 reducer 解决什么问题
