import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Switch, Text, View } from "react-native";
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
import { ScreenHead } from "../../lib/brand";
import { T, timeAgo } from "../../lib/theme";
import { body, display } from "../../lib/type";
import { Card, Empty, ErrorNote, Loading, Row, Screen } from "../../lib/ui";

/**
 * Alerts and pings.
 *
 * Polls every minute while the app is open and raises a local notification for
 * anything it has not shown before. The API has no push registry, so this is
 * deliberately not remote push — and the copy on screen says so rather than
 * implying a delivery guarantee the app cannot make.
 */
export default function Alerts() {
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

  const blocks = alerts.filter((a) => a.kind === "block").length;

  return (
    <Screen onRefresh={onRefresh} refreshing={refreshing}>
      <ScreenHead
        title="Alerts"
        subtitle="Blocked changes and open drift"
        // The count belongs beside the title, not buried in a card heading —
        // it is the one number this screen exists to report.
        right={
          !loading && alerts.length > 0 ? (
            <View style={[s.count, blocks > 0 && s.countBad]}>
              <Text style={[s.countText, blocks > 0 && s.countTextBad]}>
                {alerts.length}
              </Text>
            </View>
          ) : null
        }
      />

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
            thumbColor={T.card}
            ios_backgroundColor={T.line}
          />
        </View>
      </Card>

      {loading ? <Loading /> : null}

      {!loading && (
        <Card title="Open">
          {alerts.length === 0 ? (
            <Empty text="Nothing to flag. No blocked changes, no drift." />
          ) : (
            alerts.map((a, i) => (
              <Row
                key={a.id}
                first={i === 0}
                title={a.title}
                meta={`${a.body} · ${timeAgo(a.at)}`}
                metaKind="prose"
                lead={
                  <View
                    style={[
                      s.dot,
                      { backgroundColor: a.kind === "block" ? T.block : T.warn },
                    ]}
                  />
                }
              />
            ))
          )}
        </Card>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  count: {
    minWidth: 30,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 99,
    backgroundColor: T.warnSoft,
    alignItems: "center",
    marginBottom: 3,
  },
  countBad: { backgroundColor: T.blockSoft },
  countText: { fontFamily: display("700"), fontSize: 13, color: T.warnInk },
  countTextBad: { color: T.blockInk },

  pingRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  pingBody: { flex: 1 },
  pingLabel: { fontFamily: body("600"), fontSize: 14, color: T.ink },
  pingNote: {
    fontFamily: body("400"),
    fontSize: 11.5,
    color: T.inkFaint,
    marginTop: 4,
    lineHeight: 17,
  },

  dot: { width: 8, height: 8, borderRadius: 4 },
});
