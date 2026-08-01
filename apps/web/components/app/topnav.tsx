"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Bell,
  Bot,
  Building2,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronRight,
  Crosshair,
  FileText,
  Inbox,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Network,
  Play,
  Plug,
  Radar,
  Search,
  Settings,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useQuery } from "../../lib/queries";
import { signOut, switchOrg, useSession } from "../../lib/session";
import { LogoMark } from "../marks";

/**
 * The app's primary navigation. A top bar rather than a left rail: every group
 * carries its own sub-navigation, so the second level is one click away instead
 * of costing a permanent 236px column on every page.
 *
 * Below 1080px the four group triggers stop fitting beside the brand and the
 * tools, so they fold into a single menu rather than a strip that scrolls
 * sideways and clips its own first label.
 */

/** One icon spec for the whole bar. Mixed sizes and stroke weights were what
 *  made the set look assembled rather than designed. */
const ICON = { size: 17, strokeWidth: 1.8 } as const;

type SubNav = {
  href: string;
  label: string;
  desc: string;
  icon: React.ReactNode;
  /** Shows the live count of work waiting on a human. */
  counted?: boolean;
};

type NavGroup = {
  id: string;
  label: string;
  eyebrow: string;
  items: SubNav[];
};

// Grouped the way the product is used: what you look at, what you ask it, what
// it hands back to you, and how it is wired up.
const NAV: NavGroup[] = [
  {
    id: "overview",
    label: "Overview",
    eyebrow: "Where things stand",
    items: [
      {
        href: "/app",
        label: "Dashboard",
        desc: "Verdicts over time, exposure, and coverage",
        icon: <LayoutDashboard {...ICON} />,
      },
      {
        href: "/app/metrics",
        label: "Metrics",
        desc: "Mistake-to-repair, latency, coverage",
        icon: <ChartColumn {...ICON} />,
      },
    ],
  },
  {
    id: "map",
    label: "The map",
    eyebrow: "What is mapped",
    items: [
      {
        href: "/app/graph",
        label: "Graph",
        desc: "Explore every node and dependency",
        icon: <Network {...ICON} />,
      },
      {
        href: "/app/simulate",
        label: "Simulate",
        desc: "Ask the gate before you change anything",
        icon: <Play {...ICON} />,
      },
      {
        href: "/app/drift",
        label: "Drift",
        desc: "Where the map and the live systems disagree",
        icon: <Radar {...ICON} />,
      },
    ],
  },
  {
    id: "work",
    label: "The work",
    eyebrow: "What needs a human",
    items: [
      {
        href: "/app/queue",
        label: "Queue",
        desc: "Drafted rationale waiting on review",
        icon: <Inbox {...ICON} />,
        counted: true,
      },
      {
        href: "/app/decisions",
        label: "Decisions",
        desc: "Every verdict the gate has issued",
        icon: <ShieldCheck {...ICON} />,
      },
      {
        href: "/app/agents",
        label: "Agents",
        desc: "Historian runs and what they found",
        icon: <Bot {...ICON} />,
      },
      {
        href: "/app/investigate",
        label: "Investigate",
        desc: "What changed between known-good and broken",
        icon: <Crosshair {...ICON} />,
      },
      {
        href: "/app/documents",
        label: "Documents",
        desc: "Uploads the historians can search",
        icon: <FileText {...ICON} />,
      },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    eyebrow: "How this org is wired",
    items: [
      {
        href: "/app/settings/connectors",
        label: "Connectors",
        desc: "The systems Sadhak reads",
        icon: <Plug {...ICON} />,
      },
      {
        href: "/app/settings/organization",
        label: "Organization",
        desc: "Name, defaults, and gate modes",
        icon: <Building2 {...ICON} />,
      },
      {
        href: "/app/settings/members",
        label: "Members",
        desc: "Who can see and decide what",
        icon: <Users {...ICON} />,
      },
      {
        href: "/app/settings/api-keys",
        label: "API keys",
        desc: "Credentials for the gate and MCP",
        icon: <KeyRound {...ICON} />,
      },
      {
        href: "/app/settings/account",
        label: "Account",
        desc: "Your profile and sign-in",
        icon: <UserRound {...ICON} />,
      },
    ],
  },
];

/** "/app" is a prefix of every other route, so it only matches exactly. */
function matches(href: string, pathname: string): boolean {
  return href === "/app" ? pathname === "/app" : pathname.startsWith(href);
}

function initialsOf(name: string, max = 2): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, max)
    .join("")
    .toUpperCase();
}

/** One sub-navigation row. Shared by the desktop group menus and the mobile
 *  menu, so the two can never drift apart. */
function SubNavItem({
  item,
  pathname,
  queueCount,
  groupId,
}: {
  item: SubNav;
  pathname: string;
  queueCount: number;
  groupId: string;
}) {
  return (
    <DropdownMenu.Item asChild>
      <Link
        href={item.href}
        className="navmenu__item"
        data-active={matches(item.href, pathname) || undefined}
        data-testid={`nav-${groupId}-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <span className="navmenu__icon">{item.icon}</span>
        <span className="navmenu__body">
          <strong>
            {item.label}
            {item.counted && queueCount > 0 && (
              <span className="topnav__pip">{queueCount}</span>
            )}
          </strong>
          <span>{item.desc}</span>
        </span>
        <ChevronRight size={15} strokeWidth={1.8} className="navmenu__go" aria-hidden />
      </Link>
    </DropdownMenu.Item>
  );
}

function NavGroupMenu({
  group,
  pathname,
  queueCount,
}: {
  group: NavGroup;
  pathname: string;
  queueCount: number;
}) {
  const active = group.items.some((i) => matches(i.href, pathname));
  const groupCount = group.items.some((i) => i.counted) ? queueCount : 0;

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="topnav__link"
          data-active={active || undefined}
          data-testid={`nav-${group.id}`}
        >
          {group.label}
          {groupCount > 0 && <span className="topnav__pip">{groupCount}</span>}
          <ChevronDown
            size={13}
            strokeWidth={2.2}
            className="topnav__caret"
            aria-hidden
          />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="navmenu"
          align="start"
          sideOffset={10}
          collisionPadding={16}
        >
          <span className="navmenu__eyebrow">{group.eyebrow}</span>
          {group.items.map((item) => (
            <SubNavItem
              key={item.href}
              item={item}
              pathname={pathname}
              queueCount={queueCount}
              groupId={group.id}
            />
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Every group and every sub-item in one sheet, for widths that cannot hold the
 *  four triggers side by side. */
function MobileMenu({ pathname, queueCount }: { pathname: string; queueCount: number }) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="topnav__burger"
          aria-label="Open navigation"
          data-testid="nav-mobile"
        >
          <Menu size={18} strokeWidth={1.9} aria-hidden />
          {queueCount > 0 && <span className="topnav__dot" aria-hidden />}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="navmenu navmenu--sheet"
          align="start"
          sideOffset={10}
          collisionPadding={12}
        >
          {NAV.map((group) => (
            <div className="navmenu__group" key={group.id}>
              <span className="navmenu__eyebrow">{group.label}</span>
              {group.items.map((item) => (
                <SubNavItem
                  key={item.href}
                  item={item}
                  pathname={pathname}
                  queueCount={queueCount}
                  groupId={`m-${group.id}`}
                />
              ))}
            </div>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function TopNav() {
  const { user, org, orgs } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [q, setQ] = useState("");

  // Live count of what is actually waiting on a human.
  const drafts = useQuery<{ items: unknown[] }>(
    org ? "/api/rationale?state=drafted" : null,
    [org?.id],
  );
  const queueCount = drafts.data?.items.length ?? 0;

  if (!user) return null;

  return (
    <header className="topnav">
      <div className="topnav__inner">
        <MobileMenu pathname={pathname} queueCount={queueCount} />

        <Link href="/app" className="topnav__brand" aria-label="Sadhak overview">
          <LogoMark size={28} />
          <span>साधक</span>
        </Link>

        <nav className="topnav__nav" aria-label="Primary">
          {NAV.map((group) => (
            <NavGroupMenu
              key={group.id}
              group={group}
              pathname={pathname}
              queueCount={queueCount}
            />
          ))}
        </nav>

        <div className="topnav__tools">
          <search>
            <form
              className="topnav__search"
              onSubmit={(e) => {
                e.preventDefault();
                router.push(q ? `/app/graph?q=${encodeURIComponent(q)}` : "/app/graph");
              }}
            >
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search the graph…"
                aria-label="Search the graph"
                data-testid="topbar-search"
              />
              <button type="submit" className="topnav__search-go" aria-label="Search">
                <Search size={15} strokeWidth={2} aria-hidden />
              </button>
            </form>
          </search>

          {/* The org's own initials, not a generic building glyph — it says
              which org you are in without needing a label beside it. */}
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="topnav__org"
                aria-label={`Organization: ${org?.name ?? "none"}. Switch organization.`}
                data-testid="shell-org-switcher"
              >
                {org ? initialsOf(org.name) : "—"}
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="dropdown"
                align="end"
                sideOffset={8}
                collisionPadding={12}
              >
                <div className="dropdown__id">
                  <strong>{org?.name ?? "No organization"}</strong>
                  <span>Switch organization</span>
                </div>
                <DropdownMenu.Separator className="dropdown__sep" />
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
                    {o.id === org?.id && <Check size={14} strokeWidth={2} aria-hidden />}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>

          <Link
            href="/app/queue"
            className="topnav__icon"
            aria-label={
              queueCount > 0
                ? `Queue, ${queueCount} waiting on review`
                : "Queue, nothing waiting"
            }
          >
            <Bell size={17} strokeWidth={1.8} aria-hidden />
            {queueCount > 0 && <span className="topnav__dot" aria-hidden />}
          </Link>

          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="topnav__avatar"
                data-testid="shell-user-menu"
              >
                {initialsOf(user.name)}
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="dropdown"
                align="end"
                sideOffset={8}
                collisionPadding={12}
              >
                <div className="dropdown__id">
                  <strong>{user.name}</strong>
                  <span>{user.email}</span>
                </div>
                <DropdownMenu.Separator className="dropdown__sep" />
                <DropdownMenu.Item
                  className="dropdown__item"
                  onSelect={() => router.push("/app/settings")}
                >
                  Settings
                  <Settings size={15} strokeWidth={1.8} aria-hidden />
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="dropdown__sep" />
                <DropdownMenu.Item
                  className="dropdown__item dropdown__item--danger"
                  data-testid="shell-signout"
                  onSelect={async () => {
                    await signOut();
                    router.push("/");
                    router.refresh();
                  }}
                >
                  Sign out
                  <LogOut size={15} strokeWidth={1.8} aria-hidden />
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>
    </header>
  );
}
