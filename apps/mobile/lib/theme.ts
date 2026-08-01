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

export function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
