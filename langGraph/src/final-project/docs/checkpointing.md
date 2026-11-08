# LangGraph 检查点与持久化

## 什么是检查点

LangGraph 的 checkpointer 会在图执行的每一步之后，把完整状态写入一个 checkpoint。每个 checkpoint 都带 checkpoint_id 和父节点指针，因此同一条线程的历史可以被还原。

线程由 config 里的 thread_id 标识。同一个 thread_id 的多次 invoke 会共享同一段历史；换一个 thread_id 就是一段全新的会话。

## SqliteSaver 的落盘方式

SqliteSaver 把 checkpoint 写到本地 SQLite 文件，进程退出后数据仍然存在。重启进程后，只要使用同一个数据库文件和同一个 thread_id，图就能从最后一个 checkpoint 继续执行。

因为 checkpointer 保存了每一步的状态，interrupt 中断后的断点也保存在磁盘上，所以人工审批可以跨进程完成。

## getState 与时间旅行

graph.getState(config) 返回当前线程的最新快照，包括 values、next 和 tasks。tasks 里的 interrupts 字段能看出图停在哪个节点、等待什么恢复值。

拿到历史 checkpoint_id 之后，还可以从旧 checkpoint 重新执行，这就是时间旅行：修改历史分支而不会覆盖原有轨迹。
