import Link from "next/link";
import { LogoMark } from "../components/marks";

export default function NotFound() {
  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        textAlign: "center",
      }}
    >
      <div>
        <Link
          href="/"
          className="logo"
          aria-label="Sadhak home"
          style={{
            justifyContent: "center",
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <LogoMark />
          sadhak
        </Link>
        <h1 style={{ fontSize: 42, margin: "22px 0 10px" }}>
          Nothing depends on this page.
        </h1>
        <p style={{ color: "var(--ink-soft)", maxWidth: "44ch", margin: "0 auto" }}>
          We traced every edge — this URL has no dependents, no rationale, and no reason
          to exist. Safe to navigate away.
        </p>
        <div
          style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 26 }}
        >
          <Link href="/" className="btn btn--ghost btn--small">
            Marketing site
          </Link>
          <Link href="/app" className="btn btn--ink btn--small">
            Open the app
          </Link>
        </div>
      </div>
    </div>
  );
}
