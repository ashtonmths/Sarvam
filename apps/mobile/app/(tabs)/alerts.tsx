import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  type Alert,
  askPermission,
  fetchAlerts,
  newSince,
  PINGS_SUPPORTED,
  PINGS_UNAVAILABLE_REASON,
  POLL_MS,
  ping,
} from "../../lib/alerts";
import { T, timeAgo } from "../../lib/theme";
import { Card, Empty, ErrorNote, Loading } from "../../lib/ui";

/**
 * Alerts and pings.
 *
 * Polls every minute while the app is open and raises a local notification for
 * anything it has not shown before. The API has no push registry, so this is
 * deliberately not remote push — and the copy on screen says so rather than
 * implying a delivery guarantee the app cannot make.
 */
export default function Alerts() {
  const insets = useSafeAreaInsets();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pingsOn, setPingsOn] = useState(false);

  // Ids already surfaced, so a poll does not re-ping the same block forever.
  const seen = useRef<Set<string>>(new Set());
  const primed = useRef(false);

  const load = useCallback(async () => {
    try {
      const next = await fetchAlerts();
      setError(null);

      // The first load seeds the baseline rather than pinging for history.
      if (!primed.current) {
        for (const a of next) seen.current.add(a.id);
        primed.current = true;
      } else if (pingsOn) {
        for (const a of newSince(seen.current, next)) {
          seen.current.add(a.id);
          await ping(a);
        }
      } else {
        for (const a of next) seen.current.add(a.id);
      }

      setAlerts(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load alerts");
    } finally {
      setLoading(false);
    }
  }, [pingsOn]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const togglePings = useCallback(async (value: boolean) => {
    if (!value) {
      setPingsOn(false);
      return;
    }
    const granted = await askPermission();
    setPingsOn(granted);
    if (!granted) setError("Notifications are off for Sadhak in system settings.");
  }, []);

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
      <Text style={s.title}>Alerts</Text>
      <Text style={s.sub}>Blocked changes and open drift</Text>

      {error ? <ErrorNote message={error} /> : null}

      <Card title="Pings">
        <View style={s.pingRow}>
          <View style={s.pingBody}>
            <Text style={s.pingLabel}>Notify me on this device</Text>
            <Text style={s.pingNote}>
              {PINGS_SUPPORTED
                ? `Checks every ${Math.round(POLL_MS / 1000)}s while the app is open. Not remote push — closing the app stops the checks.`
                : PINGS_UNAVAILABLE_REASON}
            </Text>
          </View>
          <Switch
            value={pingsOn}
            onValueChange={togglePings}
            disabled={!PINGS_SUPPORTED}
            trackColor={{ true: T.thread, false: T.line }}
          />
        </View>
      </Card>

      {loading ? <Loading /> : null}

      {!loading && (
        <Card title={`Open (${alerts.length})`}>
          {alerts.length === 0 ? (
            <Empty text="Nothing to flag. No blocked changes, no drift." />
          ) : (
            alerts.map((a, i) => (
              <View key={a.id} style={[s.row, i === 0 && s.rowFirst]}>
                <View
                  style={[
                    s.dot,
                    { backgroundColor: a.kind === "block" ? T.block : T.warn },
                  ]}
                />
                <View style={s.rowBody}>
                  <Text style={s.rowTitle}>{a.title}</Text>
                  <Text style={s.rowMeta} numberOfLines={2}>
                    {a.body} · {timeAgo(a.at)}
                  </Text>
                </View>
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
  pingRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  pingBody: { flex: 1 },
  pingLabel: { fontSize: 14, fontWeight: "600", color: T.ink },
  pingNote: { fontSize: 11.5, color: T.inkFaint, marginTop: 3, lineHeight: 16 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingVertical: 11,
    borderTopWidth: 1,
    borderTopColor: T.lineSoft,
  },
  rowFirst: { borderTopWidth: 0 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 13.5, fontWeight: "600", color: T.ink },
  rowMeta: { fontSize: 11.5, color: T.inkFaint, marginTop: 2, lineHeight: 16 },
});
