"use client";

/**
 * Last-resort boundary: replaces the root layout, so it must be
 * self-contained — inline styles only, no token file guaranteed.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          background: "#ebe9e2",
          color: "#17191e",
          fontFamily: "'Helvetica Neue', sans-serif",
          textAlign: "center",
          padding: 24,
        }}
      >
        <div>
          <h1 style={{ fontSize: 34, marginBottom: 10 }}>
            Sadhak hit an unhandled error.
          </h1>
          <p style={{ color: "#575c66", maxWidth: "46ch", margin: "0 auto 22px" }}>
            The deterministic engine is unaffected — this is the shell, not the gate.
            {error.digest ? ` Reference: ${error.digest}` : ""}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              background: "#17191e",
              color: "#f6f4ee",
              border: 0,
              borderRadius: 12,
              padding: "12px 24px",
              fontSize: 15,
              cursor: "pointer",
            }}
          >
            Reload the shell
          </button>
        </div>
      </body>
    </html>
  );
}
