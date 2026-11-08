# Day 7 提示词：综合项目（带审批的研究助手）

> 用法：在项目根目录开启新会话，把本文件内容整段发给 AI。这是一个独立任务，不依赖其他 prompt 文件。

## 背景

你是一名资深 TypeScript 工程师，带我学习 LangGraph.js v1。项目根目录就是当前工作目录，Day 1～6 已完成：状态图、reducer、条件边、持久化、中断审批与流式、子图与多 Agent。

今天把六天的能力串成一个独立项目：一个带人工审批的研究助手。重点是**流程编排**，不是 RAG 效果。

## 硬性约束：独立子项目

- 项目放在 `src/final-project/`，与 `src/day1`～`src/day6` 同级
- 子项目自带 `package.json`、`tsconfig.json`、`.env.example`、`README.md`（只写运行方式，不写学习笔记）
- 可以独立 `npm install`、`npm run typecheck`、`npm run start`
- 不 import 任何 day 目录或 `src/shared`；需要的 env、模型、检索、工具全部在子项目内重新实现
- 不改根 `package.json`、根 `tsconfig.json`、`PLAN.md`
- SQLite 文件放子项目内，并加进子项目 `.gitignore`

## 目标

实现一条完整可演示的流程：

```text
START → plan → (Send 并行 research 子图) → draft
      → review(条件边) ──需修改──→ draft
                        └─通过──→ approval(interrupt) → finalize → END
```

能力清单：

1. 结构化拆分研究问题
2. 并行检索子图，结果去重并带来源
3. 自检覆盖度，不达标回流改稿
4. `interrupt` 人工审批，拒绝带反馈回 `draft`
5. `SqliteSaver` 持久化，中断后重启进程仍能继续
6. `custom` 流式打印节点进度

## 开始前

先读（只读，不复制）：

1. `PLAN.md`
2. `src/day3/react-graph.ts`：手写循环与工具协议
3. `src/day4/sqlite.ts`：SQLite checkpointer 用法
4. `src/day5/approval.ts`：`interrupt` 与 `Command({ resume })`
5. `src/day6/send.ts`：`Send` 并行
6. `src/day6/subgraph.ts`：子图挂载

理解做法后，在 `src/final-project/` 内重新实现，不要整文件拷贝。

## 任务

### 1. 子项目骨架

- `package.json`：`@langchain/langgraph`、`@langchain/core`、`@langchain/openai`、SQLite checkpointer、`zod`；dev 依赖 `tsx`、`typescript`、`@types/node`
- scripts：`start`、`typecheck`
- `tsconfig.json`：strict + NodeNext
- `.env.example`：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`
- `.gitignore`：`node_modules`、`.env`、`*.db`

### 2. 本地知识库

- `src/final-project/docs/` 下三篇 Markdown，自选主题，但必须能回答示例问题
- 检索实现：按关键词命中数打分，返回 Top 3
- 不引入 embedding，不接外部向量库
- 每条结果保留 `source` 和 `chunkIndex`（可以是段落序号），用于引用

### 3. 状态

用 `new StateSchema({...})` 定义：

- `question: z.string()`
- `queries: z.array(z.string()).default([])`
- `findings`：`ReducedValue` 累积并去重
- `draft: z.string().default("")`
- `reviewPassed: z.boolean().default(false)`
- `missing: z.array(z.string()).default([])`
- `revisions: z.number().default(0)`
- `approved: z.boolean().default(false)`
- `feedback: z.string().default("")`
- `finalAnswer: z.string().default("")`
- `steps`：`ReducedValue` 累积

### 4. 节点

- `plan`：
  - 用 `withStructuredOutput` 把 `question` 拆成 2～3 个检索子问题
  - 返回 `{ queries, steps: "plan" }`
- `research`（子图）：
  - 输入单个 `query`，检索、压缩、返回带来源的片段
  - 用 `Send` 并行分发所有 `queries`
  - 结果写进 `findings`
- `draft`：
  - 基于 `findings` 和上一轮 `feedback` 生成草稿
  - 每个结论后标 `[来源: 文件名#段落]`
  - `revisions + 1`
- `review`：
  - 用 `withStructuredOutput` 自检：`passed: boolean`、`missing: string[]`
  - 不通过就回 `draft`，`revisions` 达到 2 时强制通过，避免死循环
- `approval`：
  - `interrupt({ type: "approval_request", draft, missing })`
  - `responseSchema` 约束 `{ decision: "approve" | "reject", feedback?: string }`
  - 返回 `{ approved, feedback }`
- `finalize`：
  - 输出最终稿，保留引用
  - 没有依据的结论明确写“知识库中未找到相关依据”，不要编造

### 5. 图与路由

- `START → plan`
- `plan` 用条件边返回 `Send` 数组，分发到 `research`
- `research → draft`
- `draft → review`
- `review` 条件边：通过 → `approval`，不通过 → `draft`
- `approval` 条件边：`approve` → `finalize`，`reject` → `draft`
- `finalize → END`
- `compile({ checkpointer: SqliteSaver })`
- 加 `recursionLimit` 兜底

### 6. CLI

- `npm run start -- --thread=demo`：从头开始一轮
- `npm run start -- --thread=demo --resume=approve`：恢复审批
- `npm run start -- --thread=demo --resume=reject --feedback="补充一个例子"`：拒绝并改稿
- 中断时打印中断内容、当前草稿和下一步命令提示，然后正常退出
- 运行中用 `custom` 流打印 `[节点] 进度`，最终稿单独输出
- 同一 `thread_id` 的行为要前后一致；换 `thread_id` 就是全新会话

### 7. README

只写：

- 安装与运行命令
- 三条演示路径
- 目录结构

不要写学习笔记或实现原理长文。

## 约束

- 不做 Web 前端，CLI 足够
- 不做 embedding、不做真实检索 API
- 不真正发布或写入外部系统
- 不把 key 写进代码或 README
- 不复制 day 目录的源码，理解后重写
- TypeScript strict，相对导入写 `.js` 后缀
- 注释用中文

## 验收

```bash
cd src/final-project
npm install
npm run typecheck
npm run start -- --thread=demo
npm run start -- --thread=demo --resume=approve
npm run start -- --thread=demo --resume=reject --feedback="补充一个具体例子"
```

通过标准：

- 独立安装和 `typecheck` 通过
- 一次完整运行能看到：拆分问题 → 并行检索 → 草稿 → 自检 → 审批中断
- 拒绝后草稿确实体现反馈，再次审批通过
- 中断后退出进程，再执行 `--resume` 能继续，不需要重跑前面的步骤
- 有依据的结论带 `[来源: 文件名#段落]`
- 知识库外的问题不编造
- 代码中没有 import 任何 day 目录或 `src/shared`

## 汇报

完成后告诉我：

1. 子项目文件清单和目录结构
2. 完整状态字段和图的节点/边
3. 一次完整运行的节点序列和并行检索耗时
4. 中断对象结构，以及 `--resume` 前后的行为
5. 中断后重启进程的验证结果
6. 拒绝改稿那一轮，草稿实际改了什么
7. 这个项目里哪些能力来自哪一天
