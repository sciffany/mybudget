import type { Metadata } from "next";
import { Plus_Jakarta_Sans, Geist_Mono } from "next/font/google";
import "./globals.css";
import Sidebar from "./_components/Sidebar";

const sans = Plus_Jakarta_Sans({
  variable: "--font-app-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "My Budget",
  description: "Local-first budgeting that runs entirely in your browser.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <div className="flex min-h-screen flex-col bg-zinc-50 text-zinc-900 md:flex-row dark:bg-zinc-950 dark:text-zinc-100">
          <Sidebar />
          <div className="min-w-0 flex-1 overflow-x-auto">{children}</div>
        </div>
      </body>
    </html>
  );
}
