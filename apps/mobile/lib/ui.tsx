import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { T, VERDICT } from "./theme";

export function Card({
  title,
  action,
  children,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={s.card}>
      {title ? (
        <View style={s.cardHead}>
          {/* Shrinks rather than shoving `action` off the right edge. */}
          <Text style={s.cardTitle} numberOfLines={1}>
            {title}
          </Text>
          {action}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function Figure({ value, label }: { value: string | number; label: string }) {
  return (
    <View style={s.figure}>
      <Text
        style={s.figureValue}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
      >
        {value}
      </Text>
      <Text style={s.figureLabel}>{label.toUpperCase()}</Text>
    </View>
  );
}

export function VerdictChip({ verdict }: { verdict: keyof typeof VERDICT }) {
  const c = VERDICT[verdict];
  return (
    <View style={[s.chip, { backgroundColor: c.bg }]}>
      <View style={[s.chipDot, { backgroundColor: c.dot }]} />
      <Text style={[s.chipText, { color: c.fg }]}>{verdict}</Text>
    </View>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <View style={s.loading}>
      <ActivityIndicator color={T.thread} />
      <Text style={s.loadingText}>{label}</Text>
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <View style={s.empty}>
      <Text style={s.emptyText}>{text}</Text>
    </View>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <View style={s.error}>
      <Text style={s.errorText}>{message}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: T.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: T.lineSoft,
    padding: 18,
    marginBottom: 14,
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: T.lineSoft,
  },
  cardTitle: { fontSize: 16, fontWeight: "600", color: T.ink, flexShrink: 1 },
  /**
   * No minimum width. A `minWidth: 120` here fitted the two-up rows on
   * Overview and quietly overflowed the three-up row on Decisions: three
   * columns plus gaps plus card and screen padding wants ~450pt, and no phone
   * in portrait has it. Shrinking is the only behaviour that works at both
   * counts, so the constraint has to come off rather than be tuned.
   */
  figure: { flex: 1, minWidth: 0, flexShrink: 1 },
  figureValue: { fontSize: 26, fontWeight: "700", color: T.ink, letterSpacing: -0.5 },
  figureLabel: { fontSize: 9.5, letterSpacing: 1.2, color: T.inkFaint, marginTop: 3 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 99,
    // Never let a long row title squeeze the verdict into an ellipsis: the
    // verdict is the one thing on the row that must stay readable.
    flexShrink: 0,
  },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  chipText: { fontSize: 10, fontWeight: "600", letterSpacing: 0.5 },
  loading: { paddingVertical: 40, alignItems: "center", gap: 10 },
  loadingText: { fontSize: 11, letterSpacing: 1.4, color: T.inkFaint },
  empty: { paddingVertical: 28, alignItems: "center" },
  emptyText: { fontSize: 13, color: T.inkFaint, textAlign: "center", lineHeight: 20 },
  error: {
    backgroundColor: T.blockSoft,
    borderColor: T.block,
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    marginBottom: 14,
  },
  errorText: { color: T.blockInk, fontSize: 13 },
});
