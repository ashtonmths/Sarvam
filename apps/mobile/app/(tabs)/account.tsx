import { Feather } from "@expo/vector-icons";
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { API_URL } from "../../lib/api";
import { Brand, ScreenHead } from "../../lib/brand";
import { useSession } from "../../lib/session";
import { T } from "../../lib/theme";
import { body, display, mono } from "../../lib/type";
import { Button, Card, Empty, ErrorNote, Label, Screen } from "../../lib/ui";

/**
 * Account, org, and the way out.
 *
 * These lived on the Alerts tab, which meant signing out was something you
 * found by scrolling past a list of blocked changes. Identity is not an alert.
 */

/** Initials for the avatar. Falls back to the email when there is no name. */
function initials(name: string | undefined, email: string | undefined): string {
  const source = (name ?? email ?? "?").trim();
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  // Only two letters, and only when the second part is a real word rather than
  // the domain half of an email.
  const second = parts.length > 1 && !source.includes("@") ? (parts[1]?.[0] ?? "") : "";
  return (first + second).toUpperCase();
}

export default function Account() {
  const { user, org, orgs, signOut, switchOrg } = useSession();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSwitch = useCallback(
    async (orgId: number) => {
      if (orgId === org?.orgId || busy !== null) return;
      setBusy(orgId);
      setError(null);
      try {
        await switchOrg(orgId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not switch org");
      } finally {
        setBusy(null);
      }
    },
    [org?.orgId, busy, switchOrg],
  );

  return (
    <Screen>
      <ScreenHead title="Account" subtitle="Who you are and which org you are reading" />

      {error ? <ErrorNote message={error} /> : null}

      <Card>
        <View style={s.identity}>
          <View style={s.avatar}>
            <Text style={s.avatarText}>{initials(user?.name, user?.email)}</Text>
          </View>
          <View style={s.identityBody}>
            <Text style={s.name} numberOfLines={1}>
              {user?.name ?? "Signed in"}
            </Text>
            <Text style={s.email} numberOfLines={1}>
              {user?.email ?? ""}
            </Text>
          </View>
        </View>
      </Card>

      <Card title="Organisation">
        {orgs.length === 0 ? (
          <Empty icon="users" text="No memberships on this account." />
        ) : (
          orgs.map((o, i) => {
            const active = o.orgId === org?.orgId;
            const switching = busy === o.orgId;
            return (
              <Pressable
                key={o.orgId}
                onPress={() => void onSwitch(o.orgId)}
                accessibilityRole="button"
                accessibilityState={{ selected: active, busy: switching }}
                style={({ pressed }) => [
                  s.orgRow,
                  i === 0 && s.orgRowFirst,
                  pressed && !active && s.orgRowPressed,
                ]}
              >
                <View style={[s.tick, active && s.tickOn]}>
                  {active ? <Feather name="check" size={12} color={T.card} /> : null}
                </View>
                <View style={s.orgBody}>
                  <Text style={[s.orgName, active && s.orgNameOn]} numberOfLines={1}>
                    {o.name}
                  </Text>
                  <Text style={s.orgRole}>
                    {switching ? "Switching…" : o.role.toUpperCase()}
                  </Text>
                </View>
                {switching ? <ActivityIndicator size="small" color={T.thread} /> : null}
              </Pressable>
            );
          })
        )}
        {orgs.length > 1 ? (
          <Text style={s.orgNote}>
            Switching changes what every screen reads, on this device and the web.
          </Text>
        ) : null}
      </Card>

      <Card title="Connection">
        <View style={s.metaRow}>
          <Label>API</Label>
          <Text style={s.metaValue} numberOfLines={1}>
            {API_URL.replace(/^https?:\/\//, "")}
          </Text>
        </View>
      </Card>

      <Button label="Sign out" tone="quiet" onPress={() => void signOut()} />

      {/* The wordmark closes the scroll rather than opening it: the top of this
          screen belongs to whoever is signed in, not to the product. */}
      <View style={s.footer}>
        <Brand size={19} />
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  identity: { flexDirection: "row", alignItems: "center", gap: 14 },
  avatar: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: T.threadSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontFamily: display("700"),
    fontSize: 18,
    color: T.thread,
    letterSpacing: 0.2,
  },
  identityBody: { flex: 1, minWidth: 0 },
  name: {
    fontFamily: display("700"),
    fontSize: 18,
    color: T.ink,
    letterSpacing: -0.4,
  },
  email: { fontFamily: mono("400"), fontSize: 11.5, color: T.inkFaint, marginTop: 4 },

  orgRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    paddingVertical: 13,
    borderTopWidth: 1,
    borderTopColor: T.lineSoft,
  },
  orgRowFirst: { borderTopWidth: 0 },
  orgRowPressed: { opacity: 0.55 },
  tick: {
    width: 21,
    height: 21,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: T.line,
    alignItems: "center",
    justifyContent: "center",
  },
  tickOn: { borderColor: T.thread, backgroundColor: T.thread },
  orgBody: { flex: 1, minWidth: 0 },
  orgName: { fontFamily: body("600"), fontSize: 14.5, color: T.inkSoft },
  orgNameOn: { color: T.ink },
  orgRole: {
    fontFamily: mono("400"),
    fontSize: 10,
    letterSpacing: 0.8,
    color: T.inkFaint,
    marginTop: 3,
  },
  orgNote: {
    fontFamily: body("400"),
    fontSize: 11.5,
    color: T.inkFaint,
    lineHeight: 17,
    marginTop: 13,
    paddingTop: 13,
    borderTopWidth: 1,
    borderTopColor: T.lineSoft,
  },

  metaRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  metaValue: { fontFamily: mono("400"), fontSize: 12.5, color: T.ink, flex: 1 },

  footer: { alignItems: "center", marginTop: 26, opacity: 0.45 },
});
