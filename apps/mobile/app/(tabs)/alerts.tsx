import { Feather } from "@expo/vector-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, StyleSheet, Switch, Text, View } from "react-native";
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
 * Polls on POLL_MS and raises a local notification for anything it has not
 * shown before. Still not remote push — the API has no push registry — so the
 * checks stop with the foreground. The on-screen copy no longer says so, which
 * is a deliberate product call and not an oversight: it means the interval is
 * the only remaining hint, so anyone shortening it further should know they are
 * also shortening the only thing that sets expectations.
 */
export default function Alerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pingsOn, setPingsOn] = useState(false);
  const [testing, setTesting] = useState(false);

  // Ids already surfaced, so a poll does not re-ping the same block forever.
  const seen = useRef<Set<string>>(new Set());
  const primed = useRef(false);

  /**
   * What the last tick saw, as an id list. A poll this frequent is almost
   * always a no-op, and `setAlerts` with a fresh array is not: every tick would
   * hand React a new reference, re-render the list and rebuild every row, twelve
   * times a minute, to draw exactly what is already on screen. Comparing first
   * makes the quiet case cost one string compare.
   */
  const signature = useRef("");

  const load = useCallback(async () => {
    try {
      const next = await fetchAlerts();
      setError((prev) => (prev === null ? prev : null));

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

      // Ids and order are the whole of what this list draws, so they are the
      // whole of what has to change for a re-render to be worth doing.
      const nextSignature = next.map((a) => a.id).join("|");
      if (nextSignature !== signature.current) {
        signature.current = nextSignature;
        setAlerts(next);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load alerts");
    } finally {
      // Only the first tick can flip this, and setting it every five seconds
      // is another needless render.
      setLoading((prev) => (prev ? false : prev));
    }
  }, [pingsOn]);

  useEffect(() => {
    void load();
    let id = setInterval(() => void load(), POLL_MS);

    // Polling a backgrounded app spends battery on answers nobody can see, and
    // the OS throttles the timer anyway — so the interval it resumes on is not
    // the one it was given. Stopping on the way out and loading once on the way
    // back is both cheaper and fresher: the first thing shown after unlocking
    // the phone is current rather than up to a minute stale.
    const sub = AppState.addEventListener("change", (next) => {
      clearInterval(id);
      if (next === "active") {
        void load();
        id = setInterval(() => void load(), POLL_MS);
      }
    });

    return () => {
      clearInterval(id);
      sub.remove();
    };
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

  /**
   * Fires one notification on demand.
   *
   * Every other ping is a side effect of an alert the org did not have a moment
   * ago, which is correct and untestable: turning the switch on shows nothing,
   * because the first poll seeds a baseline rather than replaying history. So
   * there was no way to confirm notifications worked short of breaking
   * something in production and waiting.
   *
   * It asks for permission if the switch is off, since "nothing happened" is
   * the one outcome a test button must never produce.
   */
  const sendTestPing = useCallback(async () => {
    setTesting(true);
    setError(null);
    try {
      const granted = pingsOn || (await askPermission());
      if (!granted) {
        setError("Notifications are off for Sadhak in system settings.");
        return;
      }
      setPingsOn(true);
      await ping({
        // Shaped like a real block alert rather than a lorem string: what is
        // being checked is whether a real one would read well on the lock
        // screen. `test` keeps it honest to anyone reading over a shoulder.
        id: `test-${Date.now()}`,
        kind: "block",
        title: "Change blocked",
        body: "delete invoices.vat_rate · test",
        at: new Date().toISOString(),
      });
    } finally {
      setTesting(false);
    }
  }, [pingsOn]);

  // Blocks and failed workflows both stopped something. Counting only blocks
  // showed "0 needing attention" beside a list of broken workflows.
  const blocks = alerts.filter((a) => a.kind === "block" || a.kind === "workflow").length;

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
            {/* Nothing to say when it works. The note is only worth the space
                when the switch cannot do what its label promises. */}
            {PINGS_SUPPORTED ? null : (
              <Text style={s.pingNote}>{PINGS_UNAVAILABLE_REASON}</Text>
            )}
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

        {PINGS_SUPPORTED ? (
          <Pressable
            onPress={() => void sendTestPing()}
            disabled={testing}
            accessibilityRole="button"
            accessibilityLabel="Send a test notification"
            style={({ pressed }) => [s.test, pressed && s.testPressed]}
          >
            <Feather name="bell" size={13} color={T.thread} />
            <Text style={s.testText}>
              {testing ? "Sending…" : "Send a test notification"}
            </Text>
          </Pressable>
        ) : null}
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
                      {
                        // Three kinds now, and a workflow failure is not a
                        // drift finding — colouring both amber made a broken
                        // filing look like a map that had drifted.
                        backgroundColor:
                          a.kind === "block"
                            ? T.block
                            : a.kind === "workflow"
                              ? T.block
                              : T.warn,
                      },
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
  test: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 14,
    paddingVertical: 11,
    borderRadius: 99,
    borderWidth: 1,
    borderColor: T.line,
    backgroundColor: T.card,
  },
  testPressed: { backgroundColor: T.threadSoft, borderColor: T.thread },
  testText: { fontFamily: body("600"), fontSize: 13, color: T.thread },
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
