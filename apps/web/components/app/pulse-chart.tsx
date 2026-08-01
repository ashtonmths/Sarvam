"use client";

/**
 * The overview's headline chart: one stem per bucket, a dot at its value, and
 * a tooltip on whichever bucket is selected. Deliberately not a charting
 * library — seven to thirty points on one axis is a flexbox, and pulling in a
 * renderer for it would cost more than the whole page weighs.
 */

export interface PulsePoint {
  /** Stable key — the bucket's first ISO day. */
  key: string;
  /** What sits in the circle under the stem. */
  label: string;
  /** Spoken/hover form: the full date or range. */
  full: string;
  value: number;
}

/** Stems never touch the card's ceiling: the tooltip needs the headroom. */
const FLOOR = 10;
const CEILING = 72;

export function PulseChart({
  points,
  active,
  onPick,
  unit,
}: {
  points: PulsePoint[];
  active: number;
  onPick: (index: number) => void;
  unit: string;
}) {
  const max = Math.max(...points.map((p) => p.value), 0);

  return (
    <div className="pulse" data-testid="overview-pulse">
      {points.map((point, i) => {
        const height = max > 0 ? FLOOR + (point.value / max) * (CEILING - FLOOR) : FLOOR;
        const on = i === active;
        return (
          <button
            type="button"
            key={point.key}
            className="pulse__col"
            data-on={on || undefined}
            onClick={() => onPick(i)}
            onFocus={() => onPick(i)}
            aria-label={`${point.full}: ${point.value} ${unit}`}
            aria-pressed={on}
          >
            <span className="pulse__plot">
              <span className="pulse__stem" style={{ height: `${height}%` }}>
                <span className="pulse__dot" aria-hidden />
                {on && (
                  <span className="pulse__tip" aria-hidden>
                    {point.value.toLocaleString()} {unit}
                  </span>
                )}
              </span>
            </span>
            <span className="pulse__label" aria-hidden>
              {point.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
