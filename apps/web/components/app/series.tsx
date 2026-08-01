"use client";

import type { SeriesPoint } from "../../lib/api";

/**
 * A 30-day trend, drawn as stacked daily bars.
 *
 * Bars rather than a line, deliberately. These are daily *counts* — three
 * blocks on Tuesday, none on Wednesday — and a line drawn through them
 * interpolates values that never existed, implying activity on days when
 * nothing happened. A gap in a bar chart reads as "nothing that day", which is
 * the truth.
 *
 * Hand-drawn SVG rather than a charting library, for the same reason `useQuery`
 * is forty lines rather than TanStack: the surface needed is one chart shape,
 * and a dependency that ships an axis engine, a tooltip system and a locale
 * bundle is not a saving on a page with two charts.
 */

const WIDTH = 640;
const HEIGHT = 90;
const GAP = 2;

export interface SeriesBand {
  label: string;
  points: SeriesPoint[];
  color: string;
}

export function StackedSeries({
  bands,
  emptyLabel,
}: {
  bands: SeriesBand[];
  emptyLabel: string;
}) {
  // Every band shares an x axis, so the day list comes from the longest one.
  const days = bands.reduce<string[]>(
    (longest, band) =>
      band.points.length > longest.length ? band.points.map((p) => p.day) : longest,
    [],
  );

  if (days.length === 0) {
    return (
      <p className="dim" style={{ fontSize: 13 }}>
        {emptyLabel}
      </p>
    );
  }

  const totals = days.map((day) =>
    bands.reduce(
      (sum, band) => sum + (band.points.find((p) => p.day === day)?.value ?? 0),
      0,
    ),
  );
  const peak = Math.max(1, ...totals);
  const slot = WIDTH / days.length;
  const barWidth = Math.max(1, slot - GAP);

  const grandTotal = totals.reduce((sum, n) => sum + n, 0);

  return (
    <figure className="series">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${bands.map((b) => b.label).join(", ")} per day over ${days.length} days. ${grandTotal} in total.`}
        preserveAspectRatio="none"
      >
        <title>{bands.map((b) => b.label).join(" · ")}</title>
        {days.map((day, index) => {
          let offset = 0;
          return (
            <g key={day}>
              {bands.map((band) => {
                const value = band.points.find((p) => p.day === day)?.value ?? 0;
                if (value === 0) return null;
                const height = (value / peak) * (HEIGHT - 4);
                const y = HEIGHT - offset - height;
                offset += height;
                return (
                  <rect
                    key={band.label}
                    x={index * slot}
                    y={y}
                    width={barWidth}
                    height={height}
                    fill={band.color}
                  >
                    {/* Native tooltip: no hover state to manage, and it works
                        on keyboard focus and in a screen reader. */}
                    <title>{`${day} · ${band.label}: ${value}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
      </svg>

      <figcaption className="series__legend">
        {bands.map((band) => (
          <span key={band.label}>
            <i style={{ background: band.color }} aria-hidden="true" />
            {band.label}
          </span>
        ))}
        <span className="series__range">
          {days[0]} → {days.at(-1)}
        </span>
      </figcaption>
    </figure>
  );
}
