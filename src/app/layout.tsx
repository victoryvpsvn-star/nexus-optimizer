import type { Metadata } from "next";
import { Be_Vietnam_Pro, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const display = Be_Vietnam_Pro({
  variable: "--font-display",
  subsets: ["vietnamese", "latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const mono = JetBrains_Mono({
  variable: "--font-mono-jb",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NEXUS OPTIMIZER — Bộ công cụ hệ thống đa năng",
  description:
    "Giám sát CPU/RAM/Disk realtime, dọn dẹp bộ nhớ, Gaming Mode, tinh chỉnh hệ thống, script nâng cao, sao lưu 30GB — tất cả trong một dashboard sakura.",
  icons: {
    icon: "/img/logo-sakura.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi" className="dark" data-theme="sakura" suppressHydrationWarning>
      <body
        className={`${display.variable} ${mono.variable} antialiased font-sans`}
      >
        {children}
        <Toaster position="top-right" richColors theme="light" closeButton />
      </body>
    </html>
  );
}
