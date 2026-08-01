/**
 * Inline vector marks. No icon library: every glyph the site needs is a few
 * strokes, and keeping them inline means no network fetch and full control
 * of stroke weight against the type.
 */

/**
 * The labyrinth mark, drawn rather than fetched.
 *
 * It was a 192px PNG, which meant no network-free render, no currentColor, and
 * nothing to animate. As vector it inherits the surrounding text colour, stays
 * sharp at any size, and the spiral can be stroke-drawn — which is what the
 * loading state uses.
 *
 * The form is the product's own metaphor: a square labyrinth you can only
 * cross by following one continuous thread.
 */
export function LogoMark({
  size = 26,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      fill="none"
    >
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="currentColor" />
      <path
        d="M16 25.5V22M16 22a6 6 0 1 0-6-6v0a6 6 0 0 0 6 6ZM16 6.5a9.5 9.5 0 0 1 9.5 9.5M16 18.5A2.5 2.5 0 1 1 18.5 16"
        stroke="var(--paper, #ebe9e2)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type GlyphProps = { size?: number };

const stroke = {
  fill: "none",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** n8n: three linked workflow nodes. */
export function GlyphFlow({ size = 22 }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      stroke="#c05a2e"
      {...stroke}
    >
      <circle cx="5" cy="12" r="2.6" />
      <circle cx="19" cy="6" r="2.6" />
      <circle cx="19" cy="18" r="2.6" />
      <path d="M7.4 11 L16.6 6.8 M7.4 13 L16.6 17.2" />
    </svg>
  );
}

/** Airtable: stacked grid. */
export function GlyphGrid({ size = 22 }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      stroke="#3a7bd0"
      {...stroke}
    >
      <rect x="4" y="5" width="16" height="14" rx="2.5" />
      <path d="M4 11 H20 M12 11 V19" />
    </svg>
  );
}

/** Postgres: database cylinder. */
export function GlyphDb({ size = 22 }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      stroke="#2f7a4d"
      {...stroke}
    >
      <ellipse cx="12" cy="6" rx="7" ry="2.8" />
      <path d="M5 6 V18 C5 19.6 8.1 20.8 12 20.8 C15.9 20.8 19 19.6 19 18 V6" />
      <path d="M5 12 C5 13.6 8.1 14.8 12 14.8 C15.9 14.8 19 13.6 19 12" />
    </svg>
  );
}

/** Slack: speech bubble. */
export function GlyphChat({ size = 22 }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      stroke="#8352c5"
      {...stroke}
    >
      <path d="M4 7.5 C4 6.1 5.1 5 6.5 5 H17.5 C18.9 5 20 6.1 20 7.5 V14.5 C20 15.9 18.9 17 17.5 17 H9 L5.2 20 C4.7 20.4 4 20 4 19.4 Z" />
      <path d="M8 9.5 H16 M8 12.5 H13" />
    </svg>
  );
}

/** GitHub: branch. */
export function GlyphBranch({ size = 22 }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      stroke="#57606a"
      {...stroke}
    >
      <circle cx="6" cy="5.5" r="2.4" />
      <circle cx="6" cy="18.5" r="2.4" />
      <circle cx="18" cy="8" r="2.4" />
      <path d="M6 8 V16 M18 10.5 C18 14 14 14.5 8.6 17.4" />
    </svg>
  );
}

/** MCP / agent: terminal cursor. */
export function GlyphAgent({ size = 22 }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      stroke="#4053c8"
      {...stroke}
    >
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="M7.5 10 L10.5 12.5 L7.5 15 M12.5 15.5 H16.5" />
    </svg>
  );
}
