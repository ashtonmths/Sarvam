"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { API_URL } from "../../lib/env";

/**
 * The human-clickable half of unsubscribing.
 *
 * The RFC 8058 one-click POST already works without this page — a mail client
 * hits the API directly and never opens a browser. This exists for the person
 * who clicks the link in the message body, and it does the unsubscribe
 * immediately rather than asking them to confirm. Making somebody click twice
 * to stop email they did not want is a dark pattern with a friendly face.
 *
 * Resubscribing is offered afterwards, because the only reason to land here by
 * accident is a misclick, and undoing it should not require finding the email
 * again.
 */
function UnsubscribeInner() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<"working" | "done" | "back" | "bad">("working");
  const [category, setCategory] = useState("");

  useEffect(() => {
    if (!token) {
      setState("bad");
      return;
    }
    fetch(`${API_URL}/api/comms/unsubscribe?token=${encodeURIComponent(token)}`, {
      method: "POST",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("bad token");
        const body = (await response.json()) as { category?: string };
        setCategory(body.category ?? "");
        setState("done");
      })
      .catch(() => setState("bad"));
  }, [token]);

  async function resubscribe() {
    await fetch(`${API_URL}/api/comms/resubscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => undefined);
    setState("back");
  }

  return (
    <main className="container" style={{ padding: "96px 0", maxWidth: 560 }}>
      {state === "working" && <p className="dim">One moment…</p>}

      {state === "bad" && (
        <>
          <h1 className="legal__title">That link is not valid</h1>
          <p className="legal__summary">
            It may have been mangled by a mail client. Email preferences also live in your
            account settings, and changing them there always works.
          </p>
          <Link className="btn btn--ink" href="/app/settings/account">
            Open settings
          </Link>
        </>
      )}

      {state === "done" && (
        <>
          <h1 className="legal__title">Done — you are unsubscribed</h1>
          <p className="legal__summary">
            No more {category === "digest" ? "weekly digests" : "product emails"} from us.
            This took effect immediately, not &ldquo;within 10 business days&rdquo;.
          </p>
          <p className="legal__summary" style={{ fontSize: "0.92rem" }}>
            Account email — password resets, invitations, anything you need to get back in
            — still arrives. Suppressing that would lock you out of your own account,
            which is not what unsubscribe means.
          </p>
          <button type="button" className="btn btn--ghost" onClick={resubscribe}>
            Actually, put me back on
          </button>
        </>
      )}

      {state === "back" && (
        <>
          <h1 className="legal__title">You are back on the list</h1>
          <p className="legal__summary">No hard feelings either way.</p>
          <Link className="btn btn--ink" href="/app">
            Open the app
          </Link>
        </>
      )}
    </main>
  );
}

export default function UnsubscribePage() {
  return (
    <Suspense fallback={null}>
      <UnsubscribeInner />
    </Suspense>
  );
}
