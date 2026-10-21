"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

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
  const router = useRouter();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    } catch {
      window.location.href = "/login";
    }
  };

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface lg:h-screen lg:border-r lg:border-b-0 lg:flex lg:flex-col lg:justify-between">
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

            {/* Link back to Main Intelligence Scraper */}
            <li className="lg:mt-4 lg:pt-3 lg:border-t lg:border-line">
              <Link
                href="/"
                className="relative flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap text-ink-3 hover:bg-subtle hover:text-ink transition-colors"
              >
                <svg
                  className="w-3.5 h-3.5 opacity-70"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
                <span>Scraper Studio</span>
              </Link>
            </li>
          </ul>
        </nav>
      </div>

      {/* Footer with user info & logout */}
      <div className="hidden lg:block p-3 border-t border-line bg-surface/50">
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
            <span className="text-xs font-medium text-ink truncate">Admin Active</span>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            disabled={isLoggingOut}
            title="Sign out of Admin"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-bad hover:bg-bad-soft transition-colors cursor-pointer"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.75}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
              />
            </svg>
            <span>{isLoggingOut ? "..." : "Sign Out"}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
