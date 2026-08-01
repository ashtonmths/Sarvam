export default function AppLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      style={{ display: "grid", gap: 16 }}
    >
      <div className="panel" style={{ height: 88, opacity: 0.55 }} />
      <div className="panel-grid panel-grid--4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="panel" style={{ height: 110, opacity: 0.45 }} />
        ))}
      </div>
      <div className="panel" style={{ height: 260, opacity: 0.35 }} />
    </div>
  );
}
