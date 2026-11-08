# Day 5 提示词：中断、人工审批与流式

> 用法：在项目根目录开启新会话，把本文件内容整段发给 AI。这是一个独立任务，不依赖其他 prompt 文件。

## 背景

你是一名资深 TypeScript 工程师，带我学习 LangGraph.js v1。项目根目录就是当前工作目录，Day 1～4 已完成：状态图、条件边、工具循环、checkpointer 与时间旅行。

今天学图的“暂停与恢复”，以及把执行过程流式推给调用方。这是自写图相对于 `createAgent` 最明显的优势之一。

## 硬性约束：独立日代码

- 只新建 `src/day5/` 下的文件
- 允许在根 `package.json` 的 `scripts` 中新增 `day5`、`day5:stream`，允许新增依赖；不得升级、降级或删除已有依赖，不得改动其他脚本
- 不 import `src/shared`、`src/day1`～`src/day4`；env 读取和模型初始化复制到 `src/day5/` 内
- 不修改其他 day 的任何文件，不改根 `tsconfig.json` 和 `PLAN.md`

## 目标

1. 用 `interrupt()` 在节点内暂停，并把待审批内容暴露给调用方
2. 用 `Command({ resume })` 在**同一个** `thread_id` 上恢复
3. 演示通过、拒绝、修改后再审三条路径
4. 用 `streamMode` 的 `custom`、`updates`、`messages` 分别输出进度、节点更新和逐字文本
5. 用 `AbortSignal` 取消一次运行

## 开始前

先读：

1. `PLAN.md`
2. `src/day4/memory.ts` 与 `src/day4/time-travel.ts` 中 checkpointer 和 `getState` 的用法
3. `node_modules/@langchain/langgraph/dist/interrupt.d.ts` 中 `interrupt` 的参数、`responseSchema` 和异常说明
4. `node_modules/@langchain/langgraph/dist/constants.d.ts` 中 `Command` 的 `resume` / `goto` / `update`
5. `node_modules/@langchain/langgraph/dist/pregel/runnable_types.d.ts` 中 `Runtime` 的 `writer`、`signal`
6. `node_modules/@langchain/langgraph/dist/writer.d.ts` 中 `writer()`
7. `node_modules/@langchain/langgraph/dist/pregel/types.d.ts` 中 `StreamMode` 的取值

注意：`interrupt` 内部靠抛异常实现暂停，不要用 `try/catch` 把它吞掉。

## 任务

### 1. 配置

新建 `src/day5/model.ts`，内容同 Day 1 的 `model.ts`（独立复制）。

### 2. 审批流程图

新建 `src/day5/approval.ts`：

状态：

- `task: z.string()`
- `draft: z.string().default("")`
- `decision: z.enum(["pending", "approve", "reject"]).default("pending")`
- `feedback: z.string().default("")`
- `published: z.string().default("")`
- `revisions: z.number().default(0)`

节点：

- `draftNode`：把 `task` 和上一轮 `feedback` 一起交给模型，生成新草稿，返回 `{ draft, decision: "pending", revisions + 1 }`
- `reviewNode`：
  - 调用 `interrupt({ type: "approval_request", draft, task })`
  - 用 `responseSchema` 约束恢复值：`{ decision: "approve" | "reject", feedback?: string }`
  - 恢复后返回 `{ decision, feedback }`
- `publishNode`：返回 `{ published: "已发布：..." }`
- `reviseNode`：只记录步骤，回到 `draft`

图：

- `START → draft`
- `draft → review`
- `review` 用条件边：`approve → publish`，`reject → revise`
- `revise → draft`，`publish → END`
- 用 `MemorySaver` 编译

### 3. 三条审批路径

在 `approval.ts` 里按顺序演示：

**A. 通过**

- 新 `thread_id`：`approval-approve`
- 首次 `invoke` 后打印 `result.__interrupt__`（实际字段以类型定义为准，重点看中断值和 schema）
- 用 `new Command({ resume: { decision: "approve" } })` 恢复
- 打印最终 `published`

**B. 拒绝并改稿**

- 新 `thread_id`：`approval-reject`
- 首次 `invoke` 后，用 `{ decision: "reject", feedback: "太泛了，补一个具体例子" }` 恢复
- 图应回到 `draft` 并再次中断
- 第二次用 `{ decision: "approve" }` 恢复，打印最终稿
- 确认第二次草稿里体现了反馈

**C. 错误用法对照（只打印说明，不必跑完整流程）**

- 中断后用同一个 `thread_id` 直接发送新 `HumanMessage`，说明为什么会被当成从断点继续
- 正确做法是换 `thread_id` 或先 `Command` 恢复

### 4. 流式与取消

新建 `src/day5/stream.ts`：

- 复用审批图或写一张更小的图，节点里通过 runtime 的 `writer` 发送进度事件，例如 `{ node: "draft", progress: 0.5 }`
- 分别演示：
  - `streamMode: "custom"`：只打印自定义事件
  - `streamMode: ["updates", "custom"]`：同时打印节点更新和自定义事件（数组写法以类型定义为准）
  - `streamMode: "messages"`：逐段打印模型文本
- 取消演示：
  - `AbortController` 在 300ms 后 `abort()`
  - 把 `signal` 传给 `invoke` 或 `stream`
  - 捕获取消错误，打印“已取消”，正常退出，不抛未处理异常

### 5. 脚本

在 `package.json` 增加：

```json
"day5": "tsx src/day5/approval.ts",
"day5:stream": "tsx src/day5/stream.ts"
```

## 约束

- 不真正发布、删除或写入任何外部系统
- 不使用 middleware 的 HITL，今天只学图内 `interrupt`
- 不做子图、多 Agent
- 不修改 Day 1～4 的文件
- TypeScript strict，相对导入写 `.js` 后缀
- 注释用中文

## 验收

```bash
npm run typecheck
npm run day5
npm run day5:stream
```

通过标准：

- 通过的线程最终有 `published`
- 拒绝的线程先回到 `draft`，第二次审批通过后才有 `published`
- 打印出的中断对象能看出审批值；恢复值经过 schema 校验
- 中断后发新消息的错误用法能说清楚原因
- `custom` 流能看到进度事件，`messages` 流是逐字输出
- 取消后进程正常退出，没有未处理异常
- 代码中没有 import 其他 day 目录或 `src/shared`

## 汇报

完成后告诉我：

1. 新增了哪些文件
2. 审批图的节点、边和状态字段
3. `result.__interrupt__` 的实际结构
4. 三条路径各自的最终输出
5. 三种 `streamMode` 的输出差异
6. 取消时捕获到的错误类型
7. 用一句话说明为什么 `interrupt` 依赖 checkpointer
