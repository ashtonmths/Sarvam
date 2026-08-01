import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { api, type DecisionRow, type Page, type VerdictName } from "../../lib/api";
import { ScreenHead } from "../../lib/brand";
import { R, T, timeAgo, VERDICT } from "../../lib/theme";
import { mono } from "../../lib/type";
import {
  Card,
  Empty,
  ErrorNote,
  Figure,
  Loading,
  Row,
  Screen,
  VerdictChip,
} from "../../lib/ui";

/** Every verdict the gate issued, with a filter. Read-only. */

const FILTERS: (VerdictName | "ALL")[] = ["ALL", "BLOCK", "WARN", "APPROVE"];

export default function Decisions() {
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
    <Screen onRefresh={onRefresh} refreshing={refreshing}>
      <ScreenHead title="Decisions" subtitle="The last 50 verdicts, newest first" />

      {error ? <ErrorNote message={error} /> : null}

      <Card title="Verdict mix">
        <View style={s.figures}>
          {/* Coloured, because a count of blocks is not the same kind of fact
              as a count of approvals and the eye should not have to read the
              label to know which is which. */}
          <Figure value={counts.APPROVE} label="Approved" tone={T.approveInk} />
          <Figure value={counts.WARN} label="Warned" tone={T.warnInk} />
          <Figure value={counts.BLOCK} label="Blocked" tone={T.blockInk} />
        </View>
      </Card>

      {/*
        Horizontal rather than wrapping. Four chips fit on every phone in
        portrait, but they wrapped to a second line on the narrow ones and the
        list below jumped by a row height depending on the device. A scroller
        is the same control at any width.
      */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.filters}
        style={s.filterStrip}
      >
        {FILTERS.map((f) => {
          const on = filter === f;
          const tint = f === "ALL" ? null : VERDICT[f];
          return (
            <Pressable
              key={f}
              onPress={() => setFilter(f)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={({ pressed }) => [
                s.filter,
                on && s.filterOn,
                pressed && !on && s.filterPressed,
              ]}
            >
              {tint ? (
                <View
                  style={[s.filterDot, { backgroundColor: on ? T.paper : tint.dot }]}
                />
              ) : null}
              <Text style={[s.filterText, on && s.filterTextOn]}>{f}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {loading ? <Loading /> : null}

      {!loading && (
        <Card>
          {shown.length === 0 ? (
            <Empty
              icon={rows.length === 0 ? "inbox" : "filter"}
              text={rows.length === 0 ? "No decisions yet." : `No ${filter} verdicts.`}
            />
          ) : (
            shown.map((d, i) => (
              <Row
                key={d.id}
                first={i === 0}
                title={`${d.change.operation ?? "change"} ${
                  String(d.change.externalId ?? "")
                    .split("/")
                    .filter(Boolean)
                    .pop() ?? ""
                }`.trim()}
                meta={`${d.mode} · ${d.computedInMs}ms · ${timeAgo(d.createdAt)}${
                  d.dryRun ? " · dry run" : ""
                }`}
                right={<VerdictChip verdict={d.verdict} />}
              />
            ))
          )}
        </Card>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  figures: { flexDirection: "row", gap: 12 },

  // Negative margins let the strip bleed to the screen edges so a chip
  // scrolling past does not stop short of the gutter and look clipped.
  filterStrip: { marginHorizontal: -16, marginBottom: 14 },
  filters: { paddingHorizontal: 16, gap: 7, alignItems: "center" },
  filter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: R.pill,
    backgroundColor: T.panel,
    borderWidth: 1,
    borderColor: T.lineSoft,
  },
  filterOn: { backgroundColor: T.ink, borderColor: T.ink },
  filterPressed: { backgroundColor: T.lineSoft },
  filterDot: { width: 6, height: 6, borderRadius: 3 },
  filterText: {
    fontFamily: mono("500"),
    fontSize: 10.5,
    letterSpacing: 0.5,
    color: T.inkSoft,
  },
  filterTextOn: { fontFamily: mono("600"), color: T.paper },
});
