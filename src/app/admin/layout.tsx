import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getWebSessionFromCookies } from "@/lib/web-auth";
import AdminNav from "./admin-nav";

export const metadata: Metadata = {
  title: "Admin · Come With Me",
  robots: { index: false, follow: false },
};

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getWebSessionFromCookies();
  if (!session) {
    redirect("/login?redirect=/admin");
  }

  return (
    <div className="admin-root min-h-screen lg:grid lg:grid-cols-[208px_minmax(0,1fr)]">
      <AdminNav />
      <div className="min-w-0">
        <main className="mx-auto max-w-[1360px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
          {children}
        </main>
      </div>
    </div>
  );
}
