"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CORRECTIONS, EDGES, RATIONALE } from "../../lib/mock/data";
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

type NavItem = {
  href: string;
  label: string;
  icon: React.ReactNode;
  badged?: boolean;
};

// Two groups that mirror how the product is used: the map you look at, and
// the work the gate generates for you.
const MAP: NavItem[] = [
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
];

const OPERATE: NavItem[] = [
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
];

const SETTINGS: NavItem = {
  href: "/app/settings",
  label: "Settings",
  icon: (
    <I d="M12 9 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0 M12 2.8 L13.2 5.6 L16.2 5 L16 8 L18.8 9.4 L17 12 L18.8 14.6 L16 16 L16.2 19 L13.2 18.4 L12 21.2 L10.8 18.4 L7.8 19 L8 16 L5.2 14.6 L7 12 L5.2 9.4 L8 8 L7.8 5 L10.8 5.6 Z" />
  ),
};

const RAIL_PREF = "sadhak.rail";

function RailLink({
  item,
  current,
  badge,
}: {
  item: NavItem;
  current: boolean;
  badge?: number;
}) {
  return (
    <Link
      href={item.href}
      className="rail__item"
      aria-current={current ? "page" : undefined}
      title={item.label}
      data-testid={`rail-${item.label.toLowerCase()}`}
    >
      {item.icon}
      <span className="rail__text">{item.label}</span>
      {item.badged && badge != null && badge > 0 && (
        <span className="rail__badge">{badge}</span>
      )}
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { ready, user, org, orgs } = useSession();
  const [orgMenu, setOrgMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const orgRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const router = useRouter();

  // Queue counts still come from the mock: Historian (plan 10) and Reviewer
  // (plan 11) are what populate them for real.
  const queueCount =
    RATIONALE.filter((r) => r.state === "drafted").length + CORRECTIONS.length;

  // Coverage is the product's honest number: only human-confirmed rationale
  // counts, which is exactly what the marketing site promises ("0 guesses").
  const confirmed = RATIONALE.filter((r) => r.state === "confirmed").length;
  const coveragePct = Math.round((confirmed / EDGES.length) * 100);

  useEffect(() => {
    setCollapsed(localStorage.getItem(RAIL_PREF) === "min");
  }, []);

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

  const isCurrent = (href: string) =>
    href === "/app" ? pathname === "/app" : pathname.startsWith(href);

  const toggleRail = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(RAIL_PREF, next ? "min" : "full");
  };

  return (
    <div className="shell">
      <aside className={`shell__rail${collapsed ? " shell__rail--min" : ""}`}>
        <div className="rail__head">
          <Link href="/app" className="logo" aria-label="Sadhak overview">
            <LogoMark />
            <span className="rail__text">sadhak</span>
          </Link>
          <button
            type="button"
            className="rail__toggle"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            onClick={toggleRail}
          >
            <svg width={15} height={15} viewBox="0 0 24 24" aria-hidden="true" {...glyph}>
              <path d="M4 4.5 H20 V19.5 H4 Z M9.5 4.5 V19.5" />
            </svg>
          </button>
        </div>

        <div ref={orgRef} className="rail__org-wrap">
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
          <span className="rail__label">The map</span>
          {MAP.map((item) => (
            <RailLink key={item.href} item={item} current={isCurrent(item.href)} />
          ))}
          <span className="rail__label">The work</span>
          {OPERATE.map((item) => (
            <RailLink
              key={item.href}
              item={item}
              current={isCurrent(item.href)}
              badge={queueCount}
            />
          ))}
        </nav>

        <Link href="/app/agents" className="rail__card" data-testid="shell-coverage-card">
          <span className="rail__card-eyebrow">
            <span>Coverage</span>
            <span>
              {confirmed}/{EDGES.length}
            </span>
          </span>
          <span className="rail__card-meter" aria-hidden="true">
            <i style={{ width: `${coveragePct}%` }} />
          </span>
          <span className="rail__card-note">
            {coveragePct}% of edges have confirmed rationale. Run the historians on the
            rest.
          </span>
        </Link>
        <Link
          href="/app/agents"
          className="rail__spark"
          title={`Coverage ${coveragePct}% — run the historians`}
          aria-label={`Coverage ${coveragePct} percent. Open agents.`}
        >
          <svg width={16} height={16} viewBox="0 0 24 24" aria-hidden="true" {...glyph}>
            <path d="M12 3 L13.8 10.2 L21 12 L13.8 13.8 L12 21 L10.2 13.8 L3 12 L10.2 10.2 Z" />
          </svg>
        </Link>

        <div className="rail__foot">
          <RailLink item={SETTINGS} current={isCurrent(SETTINGS.href)} />
          <div className="rail__user">
            <span className="rail__avatar" aria-hidden="true" title={user.name}>
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
        </div>
      </aside>

      <main className="shell__main">{children}</main>
    </div>
  );
}
