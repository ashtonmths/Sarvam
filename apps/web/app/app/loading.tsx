import { LogoMark } from "../../components/marks";

/**
 * The route-level loading state. Skeletons in the shape of the page that is
 * coming, plus the mark drawing its own thread — the previous version was
 * static grey boxes at fixed opacity, which reads as a broken page rather than
 * a busy one.
 */
export default function AppLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading">
      <div className="loader">
        <LogoMark size={34} className="loader__mark" />
        <span className="loader__label">Loading</span>
      </div>

      <div style={{ display: "grid", gap: 18 }} aria-hidden="true">
        <div className="skel" style={{ height: 88 }} />
        <div className="panel-grid panel-grid--4">
          <div className="skel" style={{ height: 110 }} />
          <div className="skel" style={{ height: 110 }} />
          <div className="skel" style={{ height: 110 }} />
          <div className="skel" style={{ height: 110 }} />
        </div>
        <div className="skel" style={{ height: 260 }} />
      </div>
    </div>
  );
}
