"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cx } from "./ui";

const ITEMS = [
  { href: "/admin", label: "Posts", match: (path: string) => isPostsPath(path) },
  {
    href: "/admin/users",
    label: "Users",
    match: (path: string) => path.startsWith("/admin/users"),
  },
  {
    href: "/admin/analytics",
    label: "Analytics",
    match: (path: string) => path.startsWith("/admin/analytics"),
  },
];

function isPostsPath(path: string) {
  if (path === "/admin") return true;
  return (
    path.startsWith("/admin/") &&
    !path.startsWith("/admin/users") &&
    !path.startsWith("/admin/analytics")
  );
}

export default function AdminNav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface lg:h-screen lg:border-r lg:border-b-0">
      <div className="flex items-center gap-6 px-4 sm:px-6 lg:flex-col lg:items-stretch lg:gap-0 lg:px-3 lg:py-5">
        <Link
          href="/admin"
          className="flex shrink-0 items-baseline gap-1.5 py-3 lg:px-2 lg:pt-0 lg:pb-6"
        >
          <span className="text-sm font-semibold tracking-tight text-ink">
            Come With Me
          </span>
          <span className="text-xs text-ink-3">Admin</span>
        </Link>
        <nav aria-label="Admin" className="min-w-0 overflow-x-auto">
          <ul className="flex gap-1 lg:flex-col">
            {ITEMS.map((item) => {
              const active = item.match(pathname);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "relative block rounded-md px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors",
                      active
                        ? "bg-subtle text-ink"
                        : "text-ink-3 hover:bg-subtle hover:text-ink",
                    )}
                  >
                    {active && (
                      <span
                        aria-hidden
                        className="absolute inset-y-1.5 -left-3 hidden w-0.5 rounded-full bg-accent lg:block"
                      />
                    )}
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </header>
  );
}
