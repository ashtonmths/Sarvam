"use client";

import { PageHead } from "../../../components/app/ui";

/**
 * No secondary navigation. The top bar's Settings menu already lists every
 * pane, and a second row of tabs under it was the last thing making this
 * section look unlike the rest of the app.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHead
        title="Settings"
        sub="Five panes and no sixth — no billing pane exists, and every gate in the app is a role capability, never a subscription state."
      />
      <div className="settings__pane">{children}</div>
    </>
  );
}
