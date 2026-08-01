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
          <Text style={s.cardTitle}>{title}</Text>
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
      <Text style={s.figureValue}>{value}</Text>
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
  cardTitle: { fontSize: 16, fontWeight: "600", color: T.ink },
  figure: { flex: 1, minWidth: 120 },
  figureValue: { fontSize: 26, fontWeight: "700", color: T.ink, letterSpacing: -0.5 },
  figureLabel: { fontSize: 9.5, letterSpacing: 1.2, color: T.inkFaint, marginTop: 3 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 99,
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
