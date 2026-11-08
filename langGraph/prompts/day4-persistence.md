# Day 4 提示词：持久化、线程与时间旅行

> 用法：在项目根目录开启新会话，把本文件内容整段发给 AI。这是一个独立任务，不依赖其他 prompt 文件。

## 背景

你是一名资深 TypeScript 工程师，带我学习 LangGraph.js v1。项目根目录就是当前工作目录，Day 1～3 已完成：状态图、reducer、条件边、手写 ReAct 循环。

今天学 checkpointer：状态存在哪、线程怎么隔离、历史快照怎么回放、怎么从某个断点分支重跑。

## 硬性约束：独立日代码

- 只新建 `src/day4/` 下的文件
- 允许在根 `package.json` 的 `scripts` 中新增 `day4`、`day4:sqlite`、`day4:time-travel`，允许新增依赖；不得升级、降级或删除已有依赖，不得改动其他脚本
- 不 import `src/shared`、`src/day1`～`src/day3`；env 读取和模型初始化复制到 `src/day4/` 内
- 不修改其他 day 的任何文件，不改根 `tsconfig.json` 和 `PLAN.md`
- SQLite 文件放在 `src/day4/` 内；如果根 `.gitignore` 已存在，只允许追加一行 `src/day4/*.db`，不得改动已有行

## 目标

1. 理解 checkpointer 保存的是“每个超步的完整状态快照”，不是模型记忆
2. `MemorySaver` 与 `SqliteSaver` 的差别，以及重启后的行为
3. `thread_id` 隔离、`getState`、`getStateHistory`
4. 时间旅行：从历史 checkpoint 恢复、`updateState` 分叉、旧分支不受影响

## 开始前

先读：

1. `PLAN.md`
2. `src/day3/react-graph.ts` 中 `compile` 和 `invoke` 的用法
3. `node_modules/@langchain/langgraph/dist/web.d.ts` 中 `MemorySaver`
4. `node_modules/@langchain/langgraph-checkpoint/dist/*.d.ts` 中 `BaseCheckpointSaver`、`Checkpoint`、`CheckpointTuple`
5. `node_modules/@langchain/langgraph/dist/pregel/types.d.ts` 中 `getState`、`getStateHistory`、`updateState` 的签名和 `StateSnapshot` 字段
6. `node_modules/@langchain/langgraph/dist/graph/graph.d.ts` 中 `compile({ checkpointer })`

LangGraph 的 SQLite checkpointer 需要新装包，安装前先确认当前版本的包名和导出名，不要凭记忆写。API 不确定时以本地类型定义为准。

## 任务

### 1. 依赖与配置

- 新增 SQLite checkpointer 依赖（以官方当前包名为准）
- 新建 `src/day4/model.ts`，内容同 Day 1 的 `model.ts`（独立复制）

### 2. 可复用的对话图

新建 `src/day4/chat-graph.ts`：

- 状态：`messages: MessagesValue`
- 节点 `chat`：调用模型，把 `AIMessage` 追加进 `messages`
- 图：`START → chat → END`
- 导出工厂函数 `createChatGraph(checkpointer)`，内部 `compile({ checkpointer })`

### 3. `MemorySaver` 线程隔离

新建 `src/day4/memory.ts`：

- 同一个图实例、同一个 `MemorySaver`
- 线程 A：`我叫小明` → `我叫什么？`
- 线程 B：`我叫什么？`
- 线程 A 再来一轮：`我叫什么？`
- 每轮打印 `thread_id`、回答、以及 `getState` 里的消息条数

期望：A 记得、B 不知道、A 仍记得。

### 4. `SqliteSaver` 跨进程持久化

新建 `src/day4/sqlite.ts`：

- 用 SQLite checkpointer 连接 `src/day4/checkpoints.db`
- 支持命令行参数 `--phase=write|ask`，默认 `write`
- `write`：在线程 `persist-demo` 里告诉它名字，打印回答后结束进程
- `ask`：用**新进程**、同一个 `thread_id` 问“我叫什么？”
- 验证：`ask` 能答出 `write` 阶段的名字
- 打印数据库文件路径，提醒它可以删除重建

### 5. 时间旅行

新建 `src/day4/time-travel.ts`：

- 状态：`topic: z.string()`、`draft: z.string().default("")`、`steps`（`ReducedValue` 累积）
- 四个线性节点：`plan → draft → check → final`
- `plan` 返回选题和步骤；`draft` 返回一版草稿；`check` 只记录步骤；`final` 输出终稿
- 用 `MemorySaver` 编译，`thread_id: "time-travel"`
- 跑完一次后：
  - 用 `getStateHistory` 打印每个 checkpoint 的 `config`、`next`、`values.steps`
  - 选一个位于 `draft` 之后的 checkpoint，用 `updateState` 把 `draft` 改成“改过的草稿”，`asNode` 传 `"draft"`
  - 用 `updateState` 返回的新 config 继续执行，打印新终稿
  - 再次 `getStateHistory`，确认旧分支的历史仍然存在
- 注释说明 checkpoint 的分支语义；如果当前版本 `updateState` 的行为与这里描述不一致，以类型定义和实际输出为准，并在汇报里说明

### 6. 脚本

在 `package.json` 增加：

```json
"day4": "tsx src/day4/memory.ts",
"day4:sqlite": "tsx src/day4/sqlite.ts",
"day4:time-travel": "tsx src/day4/time-travel.ts"
```

## 约束

- 不做中断与人工审批（Day 5）
- 不做子图、多 Agent（Day 6）
- 不接真实数据库服务，只用本地 SQLite 文件
- 不修改 Day 1～3 的文件
- TypeScript strict，相对导入写 `.js` 后缀
- 注释用中文

## 验收

```bash
npm run typecheck
npm run day4
npm run day4:sqlite -- --phase=write
npm run day4:sqlite -- --phase=ask
npm run day4:time-travel
```

通过标准：

- 线程 A/B 的行为符合预期，消息条数能看出历史累积
- `ask` 在新进程里仍能答出名字
- `getStateHistory` 能列出至少三个 checkpoint
- `updateState` 后能从新分支跑出不同终稿，旧分支仍可查
- 能说清 `MemorySaver` 重启丢失的原因

## 汇报

完成后告诉我：

1. 新增了哪些文件，装了哪个 checkpointer 包
2. `thread_id` 隔离的实际输出
3. `write` / `ask` 两次进程的结果，数据库文件大小
4. `getStateHistory` 打印出的 checkpoint 数量和 `next` 字段
5. `updateState` 前后两条分支的终稿差异
6. 用一句话说明 checkpointer 保存的是什么
