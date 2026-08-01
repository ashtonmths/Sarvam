"use client";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="empty" style={{ marginTop: 40 }}>
      <strong>Something broke on our side</strong>
      <p>The rest of the app is unaffected — the deterministic surfaces keep working.</p>
      {error.digest && <p className="mono dim">ref {error.digest}</p>}
      <p style={{ marginTop: 12 }}>
        <button type="button" className="btn btn--ink btn--small" onClick={reset}>
          Try again
        </button>
      </p>
    </div>
  );
}
