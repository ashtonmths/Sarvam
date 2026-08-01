"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { LogOut, PanelLeft, Play, Search, Settings } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { signOut, useSession } from "../../lib/session";

export function Topbar({
  railCollapsed,
  onToggleRail,
}: {
  railCollapsed: boolean;
  onToggleRail: () => void;
}) {
  const { user } = useSession();
  const router = useRouter();
  const [q, setQ] = useState("");

  if (!user) return null;

  const initials = user.name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <header className="topbar">
      <div className="topbar__lead">
        <button
          type="button"
          className="rail__toggle topbar__toggle"
          aria-label={railCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!railCollapsed}
          onClick={onToggleRail}
        >
          <PanelLeft size={15} strokeWidth={1.6} aria-hidden="true" />
        </button>
        <search>
          <form
            className="topbar__search"
            onSubmit={(e) => {
              e.preventDefault();
              router.push(q ? `/app/graph?q=${encodeURIComponent(q)}` : "/app/graph");
            }}
          >
            <Search size={15} strokeWidth={1.7} aria-hidden="true" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search the graph…"
              aria-label="Search the graph"
              data-testid="topbar-search"
            />
          </form>
        </search>
      </div>

      <div className="topbar__actions">
        <Link href="/app/simulate" className="btn btn--ghost btn--small">
          <Play size={14} strokeWidth={1.7} aria-hidden="true" />
          Simulate a change
        </Link>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="topbar__avatar"
              data-testid="shell-user-menu"
            >
              {initials}
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
                <Settings size={14} strokeWidth={1.7} aria-hidden="true" />
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
                <LogOut size={14} strokeWidth={1.7} aria-hidden="true" />
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
}
