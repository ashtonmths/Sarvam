"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useSession } from "../../lib/session";
import { TopNav } from "./topnav";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { ready, user } = useSession();
  const pathname = usePathname();
  const router = useRouter();

  // The API is the security boundary; this only keeps the shell from flashing.
  useEffect(() => {
    if (ready && !user) router.replace(`/signin?next=${encodeURIComponent(pathname)}`);
  }, [ready, user, pathname, router]);

  if (!ready || !user) return null;

  return (
    <div className="shell">
      <TopNav />
      <main className="shell__main">{children}</main>
    </div>
  );
}
