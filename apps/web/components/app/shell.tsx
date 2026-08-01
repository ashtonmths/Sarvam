"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  BarChart3,
  Check,
  ChevronsUpDown,
  Inbox,
  LayoutDashboard,
  Play,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Waypoints,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Coverage } from "../../lib/api";
import { useQuery } from "../../lib/queries";
import { switchOrg, useSession } from "../../lib/session";
import { LogoMark } from "../marks";
import { Topbar } from "./topbar";

type NavItem = {
  href: string;
  label: string;
  icon: React.ReactNode;
  badged?: boolean;
};

const ICON = { size: 17, strokeWidth: 1.6 } as const;

// Two groups that mirror how the product is used: the map you look at, and
// the work the gate generates for you.
const MAP: NavItem[] = [
  { href: "/app", label: "Overview", icon: <LayoutDashboard {...ICON} /> },
  { href: "/app/graph", label: "Graph", icon: <Waypoints {...ICON} /> },
  { href: "/app/simulate", label: "Simulate", icon: <Play {...ICON} /> },
];

const OPERATE: NavItem[] = [
  { href: "/app/queue", label: "Queue", icon: <Inbox {...ICON} />, badged: true },
  { href: "/app/agents", label: "Agents", icon: <SquareTerminal {...ICON} /> },
  { href: "/app/decisions", label: "Decisions", icon: <ShieldCheck {...ICON} /> },
  { href: "/app/metrics", label: "Metrics", icon: <BarChart3 {...ICON} /> },
];

const SETTINGS: NavItem = {
  href: "/app/settings",
  label: "Settings",
  icon: <Settings {...ICON} />,
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
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  // Live count of what is actually waiting on a human.
  const drafts = useQuery<{ items: unknown[] }>(
    org ? "/api/rationale?state=drafted" : null,
    [org?.id],
  );
  const queueCount = drafts.data?.items.length ?? 0;

  // Coverage is the product's honest number: only human-confirmed rationale
  // counts, which is exactly what the marketing site promises ("0 guesses").
  const coverage = useQuery<Coverage>(org ? "/api/metrics/coverage" : null, [org?.id]);
  const confirmed = coverage.data?.coverageConfirmed ?? 0;
  const totalEdges = coverage.data?.totalEdges ?? 0;
  const coveragePct = totalEdges > 0 ? Math.round((confirmed / totalEdges) * 100) : 0;

  useEffect(() => {
    setCollapsed(localStorage.getItem(RAIL_PREF) === "min");
  }, []);

  // The API is the security boundary; this only keeps the shell from flashing.
  useEffect(() => {
    if (ready && !user) router.replace(`/signin?next=${encodeURIComponent(pathname)}`);
  }, [ready, user, pathname, router]);

  if (!ready || !user) return null;

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
        </div>

        <div className="rail__org-wrap">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="rail__org"
                data-testid="shell-org-switcher"
              >
                <span className="rail__org-name">{org?.name ?? "No organization"}</span>
                <ChevronsUpDown
                  size={14}
                  strokeWidth={1.6}
                  className="rail__org-caret"
                  aria-hidden="true"
                />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="dropdown"
                align="start"
                sideOffset={6}
                collisionPadding={12}
              >
                {orgs.map((o) => (
                  <DropdownMenu.Item
                    key={o.id}
                    className="dropdown__item"
                    onSelect={async () => {
                      await switchOrg(o.id);
                      router.refresh();
                    }}
                  >
                    {o.name}
                    {o.id === org?.id && (
                      <Check size={14} strokeWidth={1.8} aria-hidden="true" />
                    )}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
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
              {confirmed}/{totalEdges}
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
          <Sparkles size={16} strokeWidth={1.6} aria-hidden="true" />
        </Link>

        <div className="rail__foot">
          <RailLink item={SETTINGS} current={isCurrent(SETTINGS.href)} />
        </div>
      </aside>

      <div className="shell__col">
        <Topbar railCollapsed={collapsed} onToggleRail={toggleRail} />
        <main className="shell__main">{children}</main>
      </div>
    </div>
  );
}
