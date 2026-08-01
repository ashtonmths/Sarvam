"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CORRECTIONS, RATIONALE } from "../../lib/mock/data";
import { signOut, switchOrg, useSession } from "../../lib/session";
import { LogoMark } from "../marks";

const glyph = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function I({ d, extra }: { d: string; extra?: React.ReactNode }) {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" aria-hidden="true" {...glyph}>
      <path d={d} />
      {extra}
    </svg>
  );
}

const NAV = [
  {
    href: "/app",
    label: "Overview",
    icon: (
      <I d="M4 13 L10 13 L10 4 L4 4 Z M4 20 L10 20 L10 17 L4 17 Z M14 20 L20 20 L20 11 L14 11 Z M14 7 L20 7 L20 4 L14 4 Z" />
    ),
  },
  {
    href: "/app/graph",
    label: "Graph",
    icon: (
      <I d="M6 6 m-2.4 0 a2.4 2.4 0 1 0 4.8 0 a2.4 2.4 0 1 0 -4.8 0 M18 9 m-2.4 0 a2.4 2.4 0 1 0 4.8 0 a2.4 2.4 0 1 0 -4.8 0 M10 18 m-2.4 0 a2.4 2.4 0 1 0 4.8 0 a2.4 2.4 0 1 0 -4.8 0 M8.2 7.4 L15.7 8.6 M9 15.8 L7 8.3 M11.9 16.5 L16.5 11" />
    ),
  },
  { href: "/app/simulate", label: "Simulate", icon: <I d="M5 4 L19 12 L5 20 Z" /> },
  {
    href: "/app/queue",
    label: "Queue",
    icon: <I d="M4 6 H20 M4 12 H20 M4 18 H13" />,
    badged: true,
  },
  {
    href: "/app/agents",
    label: "Agents",
    icon: <I d="M3.5 5 H20.5 V19 H3.5 Z M7.5 10 L10.5 12.5 L7.5 15 M12.5 15.5 H16.5" />,
  },
  {
    href: "/app/decisions",
    label: "Decisions",
    icon: (
      <I d="M12 3 L20 7 V12 C20 17 16.5 20 12 21.5 C7.5 20 4 17 4 12 V7 Z M8.8 12 L11 14.2 L15.4 9.8" />
    ),
  },
  {
    href: "/app/metrics",
    label: "Metrics",
    icon: <I d="M4 20 L4 14 M9.3 20 L9.3 9 M14.6 20 L14.6 12 M20 20 L20 5" />,
  },
  {
    href: "/app/settings",
    label: "Settings",
    icon: (
      <I d="M12 9 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0 M12 2.8 L13.2 5.6 L16.2 5 L16 8 L18.8 9.4 L17 12 L18.8 14.6 L16 16 L16.2 19 L13.2 18.4 L12 21.2 L10.8 18.4 L7.8 19 L8 16 L5.2 14.6 L7 12 L5.2 9.4 L8 8 L7.8 5 L10.8 5.6 Z" />
    ),
  },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { ready, user, org, orgs } = useSession();
  const [orgMenu, setOrgMenu] = useState(false);
  const orgRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const router = useRouter();

  // Queue counts still come from the mock: Historian (plan 10) and Reviewer
  // (plan 11) are what populate them for real.
  const queueCount =
    RATIONALE.filter((r) => r.state === "drafted").length + CORRECTIONS.length;

  // The API is the security boundary; this only keeps the shell from flashing.
  useEffect(() => {
    if (ready && !user) router.replace(`/signin?next=${encodeURIComponent(pathname)}`);
  }, [ready, user, pathname, router]);

  useEffect(() => {
    if (!orgMenu) return;
    const close = (e: MouseEvent) => {
      if (!orgRef.current?.contains(e.target as Node)) setOrgMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [orgMenu]);

  if (!ready || !user) return null;

  const initials = user.name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="shell">
      <aside className="shell__rail">
        <Link href="/app" className="logo" aria-label="Sadhak overview">
          <LogoMark />
          sadhak
        </Link>

        <div ref={orgRef} style={{ position: "relative" }}>
          <button
            type="button"
            className="rail__org"
            aria-haspopup="menu"
            aria-expanded={orgMenu}
            onClick={() => setOrgMenu((v) => !v)}
            data-testid="shell-org-switcher"
          >
            {org?.name ?? "No organization"}
            <span className="rail__org-caret">{orgMenu ? "▴" : "▾"}</span>
          </button>
          {orgMenu && (
            <div className="rail__org-menu" role="menu">
              {orgs.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="menuitem"
                  onClick={async () => {
                    setOrgMenu(false);
                    await switchOrg(o.id);
                    router.refresh();
                  }}
                >
                  {o.name}
                  {o.id === org?.id && <span className="mono dim">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <nav className="rail__nav" aria-label="App">
          {NAV.map((item) => {
            const current =
              item.href === "/app" ? pathname === "/app" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className="rail__item"
                aria-current={current ? "page" : undefined}
                data-testid={`rail-${item.label.toLowerCase()}`}
              >
                {item.icon}
                {item.label}
                {item.badged && queueCount > 0 && (
                  <span className="rail__badge">{queueCount}</span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="rail__user">
          <span className="rail__avatar" aria-hidden="true">
            {initials}
          </span>
          <span className="rail__user-meta">
            <strong>{user.name}</strong>
            <span>{org?.role ?? user.role}</span>
          </span>
          <button
            type="button"
            className="rail__signout"
            data-testid="shell-signout"
            onClick={async () => {
              await signOut();
              router.push("/");
              router.refresh();
            }}
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="shell__main">{children}</main>
    </div>
  );
}
