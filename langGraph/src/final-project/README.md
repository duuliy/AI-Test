# 带人工审批的研究助手

基于本地知识库的研究助手：拆分问题 → 并行检索 → 生成草稿 → 自检 → 人工审批 → 输出最终稿。

## 安装

```bash
cd src/final-project
npm install
cp .env.example .env   # 填入 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
```

未配置模型时，plan / draft / review 会自动使用本地规则兜底，流程仍可完整演示。

## 运行

```bash
npm run typecheck
npm run start -- --thread=demo
```

可选参数：

- `--thread=<id>`：会话线程，默认 `demo`；换 id 就是全新会话
- `--question="..."`：首次运行的起始问题
- `--resume=approve|reject`：恢复审批
- `--feedback="..."`：仅用于 `--resume=reject`

## 三条演示路径

### 1. 审批通过

```bash
npm run start -- --thread=demo
npm run start -- --thread=demo --resume=approve
```

### 2. 拒绝后改稿，再次通过

```bash
npm run start -- --thread=demo-reject
npm run start -- --thread=demo-reject --resume=reject --feedback="补充一个具体例子"
npm run start -- --thread=demo-reject --resume=approve
```

### 3. 中断后重启进程

```bash
npm run start -- --thread=demo-restart
# 进程结束（中断信息已写入 checkpoints.db）
npm run start -- --thread=demo-restart --resume=approve
```

## 目录结构

```text
src/final-project/
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── checkpoints.db        # 运行后生成，可随时删除
├── docs/                 # 本地知识库
│   ├── checkpointing.md
│   ├── interrupt-approval.md
│   └── parallel-send.md
└── src/
    ├── main.ts           # CLI 与中断处理
    ├── graph.ts          # 主图与节点
    ├── research-subgraph.ts
    ├── state.ts          # 状态与 reducer
    ├── retrieval.ts      # 关键词检索
    └── config.ts         # 环境与模型
```
