import { ChangeCard, VerdictCard } from "./product-cards";

/**
 * The hero tableau: a change on the left, Ariadne in the middle, the verdict
 * on the right, joined by dashed edges that draw themselves on load. Below
 * 920px the edges hide and the cards stack.
 */
export function HeroGraph() {
  return (
    <div className="graph">
      <svg
        className="graph__edges"
        viewBox="0 0 1000 300"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          className="graph__edge graph__edge--draw"
          vectorEffect="non-scaling-stroke"
          d="M 330 150 C 380 150 390 138 445 140"
        />
        <path
          className="graph__edge graph__edge--draw"
          vectorEffect="non-scaling-stroke"
          d="M 555 140 C 600 138 605 150 648 150"
          style={{ animationDelay: "0.85s" }}
        />
      </svg>

      <div className="graph__row">
        <ChangeCard />
        <div className="graph__node">
          <span className="graph__node-dot" />
          ariadne
        </div>
        <VerdictCard />
      </div>
    </div>
  );
}

/** Faint blueprint lines in the hero frame, echoing wiring under the surface. */
export function HeroBackdrop() {
  return (
    <svg
      className="hero__grid"
      viewBox="0 0 1200 760"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeDasharray="4 7"
        vectorEffect="non-scaling-stroke"
      >
        <path d="M 240 0 V 180 Q 240 210 210 210 H 0" vectorEffect="non-scaling-stroke" />
        <path d="M 960 0 V 150 Q 960 180 990 180 H 1200" vectorEffect="non-scaling-stroke" />
        <path d="M 130 760 V 560 Q 130 530 160 530 H 240" vectorEffect="non-scaling-stroke" />
        <path d="M 1070 760 V 540 Q 1070 510 1040 510 H 960" vectorEffect="non-scaling-stroke" />
      </g>
    </svg>
  );
}

/** The thread motif inside dark panels, drawn in the accent color. */
export function ThreadLines({ className }: { className: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 1200 400"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        d="M -20 320 C 200 300 260 120 500 140 C 720 158 760 300 1220 240"
        fill="none"
        stroke="var(--thread)"
        strokeWidth="1.4"
        strokeDasharray="5 7"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d="M -20 380 C 260 360 340 200 600 220 C 840 238 900 360 1220 320"
        fill="none"
        stroke="var(--thread)"
        strokeWidth="1"
        strokeDasharray="3 8"
        opacity="0.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
