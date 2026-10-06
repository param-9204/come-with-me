import type { Metadata } from "next";

import AdminNav from "./admin-nav";

export const metadata: Metadata = {
  title: "Admin · Come With Me",
  robots: { index: false, follow: false },
};

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
