import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type DecisionRow, type Page, type VerdictName, api } from "../../lib/api";
import { T, timeAgo } from "../../lib/theme";
import { Card, Empty, ErrorNote, Figure, Loading, VerdictChip } from "../../lib/ui";

/** Every verdict the gate issued, with a filter. Read-only. */

const FILTERS: (VerdictName | "ALL")[] = ["ALL", "BLOCK", "WARN", "APPROVE"];

export default function Decisions() {
  const insets = useSafeAreaInsets();
  const [rows, setRows] = useState<DecisionRow[]>([]);
  const [filter, setFilter] = useState<VerdictName | "ALL">("ALL");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await api.get<Page<DecisionRow>>("/api/gate/decisions?limit=50");
      setRows(page.items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load decisions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const shown = useMemo(
    () => (filter === "ALL" ? rows : rows.filter((r) => r.verdict === filter)),
    [rows, filter],
  );

  const counts = useMemo(
    () => ({
      APPROVE: rows.filter((r) => r.verdict === "APPROVE").length,
      WARN: rows.filter((r) => r.verdict === "WARN").length,
      BLOCK: rows.filter((r) => r.verdict === "BLOCK").length,
    }),
    [rows],
  );

  return (
    <ScrollView
      style={s.root}
      contentContainerStyle={[s.content, { paddingTop: insets.top + 16 }]}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.thread} />
      }
    >
      <Text style={s.title}>Decisions</Text>
      <Text style={s.sub}>The last 50 verdicts, newest first</Text>

      {error ? <ErrorNote message={error} /> : null}

      <Card title="Verdict mix">
        <View style={s.figures}>
          <Figure value={counts.APPROVE} label="Approved" />
          <Figure value={counts.WARN} label="Warned" />
          <Figure value={counts.BLOCK} label="Blocked" />
        </View>
      </Card>

      <View style={s.filters}>
        {FILTERS.map((f) => (
          <Pressable
            key={f}
            onPress={() => setFilter(f)}
            style={[s.filter, filter === f && s.filterOn]}
            accessibilityRole="button"
          >
            <Text style={[s.filterText, filter === f && s.filterTextOn]}>{f}</Text>
          </Pressable>
        ))}
      </View>

      {loading ? <Loading /> : null}

      {!loading && (
        <Card>
          {shown.length === 0 ? (
            <Empty text={rows.length === 0 ? "No decisions yet." : `No ${filter} verdicts.`} />
          ) : (
            shown.map((d, i) => (
              <View key={d.id} style={[s.row, i === 0 && s.rowFirst]}>
                <View style={s.rowBody}>
                  <Text style={s.rowTitle} numberOfLines={1}>
                    {d.change.operation ?? "change"}{" "}
                    {String(d.change.externalId ?? "")
                      .split("/")
                      .filter(Boolean)
                      .pop() ?? ""}
                  </Text>
                  <Text style={s.rowMeta}>
                    {d.mode} · {d.computedInMs}ms · {timeAgo(d.createdAt)}
                    {d.dryRun ? " · dry run" : ""}
                  </Text>
                </View>
                <VerdictChip verdict={d.verdict} />
              </View>
            ))
          )}
        </Card>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.paper },
  content: { padding: 16, paddingBottom: 32 },
  title: { fontSize: 25, fontWeight: "700", color: T.ink, letterSpacing: -0.5 },
  sub: { fontSize: 12.5, color: T.inkFaint, marginTop: 4, marginBottom: 18 },
  figures: { flexDirection: "row", gap: 12 },
  filters: { flexDirection: "row", gap: 6, marginBottom: 14, flexWrap: "wrap" },
  filter: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 99,
    backgroundColor: T.panel,
    borderWidth: 1,
    borderColor: T.lineSoft,
  },
  filterOn: { backgroundColor: T.ink, borderColor: T.ink },
  filterText: { fontSize: 12, fontWeight: "600", color: T.inkFaint },
  filterTextOn: { color: T.paper },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 11,
    borderTopWidth: 1,
    borderTopColor: T.lineSoft,
  },
  rowFirst: { borderTopWidth: 0 },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 13.5, fontWeight: "600", color: T.ink },
  rowMeta: { fontSize: 11.5, color: T.inkFaint, marginTop: 2 },
});
