"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = { label: string; href: string };

const NAV_ITEMS: NavItem[] = [
  { label: "Transactions", href: "/" },
  { label: "Import", href: "/import" },
  { label: "Accounts", href: "/accounts" },
  { label: "Categories", href: "/categories" },
  { label: "Rules", href: "/rules" },
  { label: "Reports", href: "/reports" },
  { label: "Settings", href: "/settings" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-56 shrink-0 flex-col gap-6 border-r border-zinc-200 bg-white px-3 py-6 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="px-3">
        <span className="text-2xl font-bold tracking-tight">
          My Budget
        </span>
      </div>
      <nav className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={[
                "rounded-md px-3 py-2 text-base font-medium transition-colors",
                active
                  ? "bg-blue-600 text-white"
                  : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
              ].join(" ")}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
