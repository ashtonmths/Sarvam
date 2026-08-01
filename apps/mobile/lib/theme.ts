import { Platform, type ViewStyle } from "react-native";

/** The web app's tokens, transcribed. One palette across both clients. */
export const T = {
  paper: "#ebe9e2",
  panel: "#f6f4ee",
  card: "#fdfcfa",
  ink: "#17191e",
  inkSoft: "#575c66",
  inkFaint: "#636872",
  line: "#d9d6cc",
  lineSoft: "#e4e1d8",
  thread: "#4053c8",
  threadSoft: "#dfe3f7",
  block: "#bf3a1f",
  blockSoft: "#f8e5e0",
  blockInk: "#a5301a",
  warn: "#a87710",
  warnSoft: "#f6ecd6",
  warnInk: "#7d5708",
  approve: "#2f7a4d",
  approveSoft: "#e2efe6",
  approveInk: "#26643f",
} as const;

export const VERDICT = {
  APPROVE: { fg: T.approveInk, bg: T.approveSoft, dot: T.approve },
  WARN: { fg: T.warnInk, bg: T.warnSoft, dot: T.warn },
  BLOCK: { fg: T.blockInk, bg: T.blockSoft, dot: T.block },
} as const;

/** Corner radii, matching `--radius-*` on the web. */
export const R = { lg: 26, md: 16, sm: 10, pill: 999 } as const;

/**
 * Vertical clearance under a scroll view.
 *
 * The bar floats now, so it no longer displaces content the way a docked bar
 * did — the last card would sit underneath it. Every scrolling screen pays
 * this at the bottom of its content, on top of whatever safe-area inset the
 * device reports.
 */
export const TAB_CLEARANCE = 104;

/**
 * `--shadow-card` and `--shadow-chip` don't translate: iOS takes one shadow
 * with a colour and a radius, Android takes an elevation and draws its own.
 * These are the two-platform spelling of the same intent.
 */
type Shadow = Pick<
  ViewStyle,
  "shadowColor" | "shadowOffset" | "shadowOpacity" | "shadowRadius" | "elevation"
>;

const shadow = (opacity: number, radius: number, offsetY: number, elevation: number) =>
  Platform.select<Shadow>({
    ios: {
      shadowColor: T.ink,
      shadowOffset: { width: 0, height: offsetY },
      shadowOpacity: opacity,
      shadowRadius: radius,
    },
    android: { elevation },
    default: {},
  }) as Shadow;

export const SHADOW = {
  card: shadow(0.06, 16, 6, 1),
  /** The floating bar, which has to read as lifted off the page. */
  bar: shadow(0.14, 22, 10, 12),
  sheet: shadow(0.18, 20, -6, 16),
} as const;

export function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
