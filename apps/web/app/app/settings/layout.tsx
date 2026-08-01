"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PageHead } from "../../../components/app/ui";

const PANES = [
  { href: "/app/settings/connectors", label: "Connectors" },
  { href: "/app/settings/members", label: "Members" },
  { href: "/app/settings/api-keys", label: "API keys" },
  { href: "/app/settings/account", label: "Account" },
  { href: "/app/settings/organization", label: "Organization" },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <>
      <PageHead
        title="Settings"
        sub="Five panes and no sixth — no billing pane exists, and every gate in the app is a role capability, never a subscription state."
      />
      <div className="settings">
        <nav className="settings__nav" aria-label="Settings">
          {PANES.map((p) => (
            <Link
              key={p.href}
              href={p.href}
              aria-current={pathname === p.href ? "page" : undefined}
              data-testid={`settings-nav-${p.label.toLowerCase().replace(" ", "-")}`}
            >
              {p.label}
            </Link>
          ))}
        </nav>
        <div>{children}</div>
      </div>
    </>
  );
}
