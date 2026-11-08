# interrupt 人工审批与断点恢复

## interrupt 如何暂停图

interrupt(value) 在节点内部暂停执行，并把 value 作为中断内容暴露给调用方。它本质上抛出一个特殊异常，所以不要在 interrupt 外层用普通 try/catch 吞掉异常。

中断必须依赖 checkpointer：断点状态要落盘，恢复时才能找到被暂停的那个任务。

## 用 Command 恢复

恢复的方式是 invoke 或 stream 一个 Command 对象，并把 resume 值放在里面，同时保持同一个 thread_id。LangGraph 会把 resume 值作为 interrupt 的返回值交还给原来的节点。

如果恢复值和约定格式不一致，应该在节点里用 zod 校验，给出明确错误，而不是把脏数据写进状态。

## 审批拒绝后的回流

人工审批通常返回 approve 或 reject。approve 进入发布节点；reject 时带上 feedback，条件边把流程送回改稿节点。

为了避免死循环，可以限制改稿次数：达到上限后强制通过，并在最终稿里保留未覆盖的检查项，提醒人工复核。

## 跨进程恢复

由于 SqliteSaver 把中断断点写入本地文件，第一次运行在 approval 节点中断后可以直接退出进程。重新执行时使用 --resume，图会从 approval 继续，而不是重跑 plan 和 research。
