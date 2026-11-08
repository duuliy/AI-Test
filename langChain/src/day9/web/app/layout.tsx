import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

// App Router 的根布局：所有页面都会套在这一层，这里只负责 html lang、body 和全局样式
export const metadata: Metadata = {
  title: "Day 9 · LangChain Agent 聊天",
  description: "Next.js Route Handler + LangChain Agent 流式对话",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
