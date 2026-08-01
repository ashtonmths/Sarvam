import { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  api,
  type Coverage,
  type DecisionRow,
  type DriftSummary,
  type GraphStats,
  type Page,
} from "../../lib/api";
import { useSession } from "../../lib/session";
import { T, timeAgo } from "../../lib/theme";
import { Card, Empty, ErrorNote, Figure, Loading, VerdictChip } from "../../lib/ui";

/**
 * The analytical view. Read-only by design: the numbers the gate produces, and
 * nothing that changes them. Every control that mutates state stays on the web
 * app, which is the split the product wants.
 */

interface Data {
  stats: GraphStats | null;
  coverage: Coverage | null;
  drift: DriftSummary | null;
  decisions: DecisionRow[];
}

const EMPTY: Data = { stats: null, coverage: null, drift: null, decisions: [] };

export default function Overview() {
  const { user, org } = useSession();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<Data>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // allSettled: one dead endpoint should cost its own card, not the screen.
    const [stats, coverage, drift, decisions] = await Promise.allSettled([
      api.get<GraphStats>("/api/graph/stats"),
      api.get<Coverage>("/api/metrics/coverage"),
      api.get<DriftSummary>("/api/drift/summary"),
      api.get<Page<DecisionRow>>("/api/gate/decisions?limit=5"),
    ]);

    setData({
      stats: stats.status === "fulfilled" ? stats.value : null,
      coverage: coverage.status === "fulfilled" ? coverage.value : null,
      drift: drift.status === "fulfilled" ? drift.value : null,
      decisions: decisions.status === "fulfilled" ? decisions.value.items : [],
    });

    const allFailed = [stats, coverage, drift, decisions].every(
      (r) => r.status === "rejected",
    );
    setError(
      allFailed && stats.status === "rejected"
        ? ((stats.reason as Error)?.message ?? "Could not reach the API")
        : null,
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const { stats, coverage, drift, decisions } = data;
  const covered =
    coverage && coverage.totalEdges > 0
      ? Math.round((coverage.coverageConfirmed / coverage.totalEdges) * 100)
      : 0;

  return (
    <ScrollView
      style={s.root}
      contentContainerStyle={[s.content, { paddingTop: insets.top + 16 }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={T.thread}
        />
      }
    >
      <Text style={s.hello}>{org?.name ?? "Overview"}</Text>
      <Text style={s.sub}>
        Signed in as {user?.name ?? user?.email ?? "you"} · pull to refresh
      </Text>

      {error ? <ErrorNote message={error} /> : null}
      {loading ? <Loading /> : null}

      {!loading && (
        <>
          <Card title="The map">
            <View style={s.figures}>
              <Figure value={stats?.nodes.total ?? 0} label="Nodes mapped" />
              <Figure value={stats?.edges.total ?? 0} label="Dependencies" />
            </View>
            <View style={[s.figures, s.figuresGap]}>
              <Figure value={stats?.nodes.byState.stale ?? 0} label="Stale" />
              <Figure value={stats?.unresolvedRefs ?? 0} label="Unresolved refs" />
            </View>
          </Card>

          <Card title="Rationale coverage">
            <View style={s.coverRow}>
              <Text style={s.coverPct}>{covered}%</Text>
              <Text style={s.coverNote}>
                {coverage?.coverageConfirmed ?? 0}/{coverage?.totalEdges ?? 0} edges
                confirmed
              </Text>
            </View>
            <View style={s.meter}>
              <View style={[s.meterFill, { width: `${covered}%` }]} />
            </View>
          </Card>

          <Card title="Drift">
            {drift && drift.open > 0 ? (
              <>
                <Text style={s.driftBig}>
                  {drift.open} finding{drift.open === 1 ? "" : "s"} open
                </Text>
                <Text style={s.driftNote}>
                  The live systems and the map disagree
                  {drift.lastCheckedAt
                    ? ` · checked ${timeAgo(drift.lastCheckedAt)}`
                    : ""}
                </Text>
              </>
            ) : (
              <Empty
                text={
                  drift?.lastCheckedAt
                    ? `Nothing in dispute — checked ${timeAgo(drift.lastCheckedAt)}`
                    : "Nothing in dispute"
                }
              />
            )}
          </Card>

          <Card title="Recent decisions">
            {decisions.length === 0 ? (
              <Empty text="Nothing has been through the gate yet." />
            ) : (
              decisions.map((d, i) => (
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
                    </Text>
                  </View>
                  <VerdictChip verdict={d.verdict} />
                </View>
              ))
            )}
          </Card>
        </>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.paper },
  content: { padding: 16, paddingBottom: 32 },
  hello: { fontSize: 25, fontWeight: "700", color: T.ink, letterSpacing: -0.5 },
  sub: { fontSize: 12.5, color: T.inkFaint, marginTop: 4, marginBottom: 18 },
  figures: { flexDirection: "row", gap: 12 },
  figuresGap: { marginTop: 18 },
  coverRow: { flexDirection: "row", alignItems: "baseline", gap: 10 },
  coverPct: { fontSize: 34, fontWeight: "700", color: T.ink, letterSpacing: -1 },
  coverNote: { fontSize: 12, color: T.inkFaint, flexShrink: 1 },
  meter: {
    height: 6,
    borderRadius: 99,
    backgroundColor: T.lineSoft,
    marginTop: 12,
    overflow: "hidden",
  },
  meterFill: { height: 6, borderRadius: 99, backgroundColor: T.thread },
  driftBig: { fontSize: 17, fontWeight: "600", color: T.warnInk },
  driftNote: { fontSize: 12.5, color: T.inkSoft, marginTop: 4, lineHeight: 18 },
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
