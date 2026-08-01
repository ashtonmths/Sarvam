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
  //
  // It is also the *only* place /app is gated, and it has to stay that way.
  // There was a middleware doing the same redirect from `sadhak_session`, and
  // it made signing in impossible in production: the API issues that cookie
  // from api.sadhak.online with no Domain, so it is host-only there and is
  // never sent to sadhak.online, where middleware runs. A real session looked
  // exactly like no session, so every signin bounced straight back to
  // /signin?next=/app.
  //
  // Locally and in CI the two sit on localhost:3000 and localhost:3001 —
  // cookies ignore the port, so the check passed everywhere it was ever run
  // and failed only against the deployed hostnames.
  //
  // Asking for the cookie server-side means widening it to .sadhak.online,
  // which hands a live session token to every subdomain, n8n included. Not
  // worth it to skip one blank frame.
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
