/**
 * 根布局 —— 所有页面共享的最外层外壳
 *
 * 职责：
 *   1. 引入全局样式（globals.css）
 *   2. 设置 html lang="zh-CN"，让浏览器正确识别语言、辅助工具正常工作
 *   3. 注入 Next.js metadata（title / description）
 *
 * 不需要再加任何业务逻辑：这个文件就是壳，所有状态和交互都在 page.tsx 里。
 */
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "个人知识库助手",
  description: "基于本地文档的流式问答 Demo（LangChain + Next.js）",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
