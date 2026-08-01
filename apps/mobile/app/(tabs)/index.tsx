import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  api,
  type Coverage,
  type DecisionRow,
  type DriftSummary,
  type GraphStats,
  type Page,
} from "../../lib/api";
import { ScreenHead } from "../../lib/brand";
import { useSession } from "../../lib/session";
import { T, timeAgo } from "../../lib/theme";
import { body, display, mono } from "../../lib/type";
import {
  Card,
  Empty,
  ErrorNote,
  Figure,
  Loading,
  Meter,
  Row,
  Screen,
  VerdictChip,
} from "../../lib/ui";

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

/** `remove target/path/thing` → "remove thing". The tail is what identifies it. */
function describe(change: Record<string, string>): string {
  const tail = String(change.externalId ?? change.target ?? "")
    .split("/")
    .filter(Boolean)
    .pop();
  return `${change.operation ?? "change"} ${tail ?? ""}`.trim();
}

export default function Overview() {
  const { user, org } = useSession();
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
  const drifting = (drift?.open ?? 0) > 0;

  return (
    <Screen onRefresh={onRefresh} refreshing={refreshing}>
      <ScreenHead
        brand
        title={org?.name ?? "Overview"}
        subtitle={`Signed in as ${user?.name ?? user?.email ?? "you"} · pull to refresh`}
      />

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
            <Meter value={covered} />
          </Card>

          <Card title="Drift">
            {drifting ? (
              <View style={s.drift}>
                <View style={s.driftDot} />
                <View style={s.driftBody}>
                  <Text style={s.driftBig}>
                    {drift?.open} finding{drift?.open === 1 ? "" : "s"} open
                  </Text>
                  <Text style={s.driftNote}>
                    The live systems and the map disagree
                    {drift?.lastCheckedAt
                      ? ` · checked ${timeAgo(drift.lastCheckedAt)}`
                      : ""}
                  </Text>
                </View>
              </View>
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
              <Empty icon="inbox" text="Nothing has been through the gate yet." />
            ) : (
              decisions.map((d, i) => (
                <Row
                  key={d.id}
                  first={i === 0}
                  title={describe(d.change)}
                  meta={`${d.mode} · ${d.computedInMs}ms · ${timeAgo(d.createdAt)}`}
                  right={<VerdictChip verdict={d.verdict} />}
                />
              ))
            )}
          </Card>
        </>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  figures: { flexDirection: "row", gap: 12 },
  figuresGap: { marginTop: 20 },

  coverRow: { flexDirection: "row", alignItems: "baseline", gap: 11 },
  coverPct: {
    fontFamily: display("700"),
    fontSize: 36,
    letterSpacing: -1.4,
    color: T.ink,
  },
  coverNote: {
    fontFamily: mono("400"),
    fontSize: 11.5,
    color: T.inkFaint,
    flexShrink: 1,
  },

  drift: { flexDirection: "row", alignItems: "flex-start", gap: 11 },
  driftDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: T.warn,
    marginTop: 6,
  },
  driftBody: { flex: 1, minWidth: 0 },
  driftBig: { fontFamily: display("600"), fontSize: 17, color: T.warnInk },
  driftNote: {
    fontFamily: body("400"),
    fontSize: 12.5,
    color: T.inkSoft,
    marginTop: 5,
    lineHeight: 18,
  },
});
