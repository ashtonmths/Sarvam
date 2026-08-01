import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { API_URL } from "../../lib/api";
import { useSession } from "../../lib/session";
import { T } from "../../lib/theme";
import { Card, Empty, ErrorNote } from "../../lib/ui";

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
  const insets = useSafeAreaInsets();
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
    <ScrollView
      style={s.root}
      contentContainerStyle={[s.content, { paddingTop: insets.top + 16 }]}
    >
      <Text style={s.title}>Account</Text>
      <Text style={s.sub}>Who you are and which org you are reading</Text>

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
          <Empty text="No memberships on this account." />
        ) : (
          orgs.map((o, i) => {
            const active = o.orgId === org?.orgId;
            return (
              <Pressable
                key={o.orgId}
                onPress={() => void onSwitch(o.orgId)}
                accessibilityRole="button"
                accessibilityState={{ selected: active, busy: busy === o.orgId }}
                style={({ pressed }) => [
                  s.orgRow,
                  i === 0 && s.orgRowFirst,
                  pressed && !active && s.orgRowPressed,
                ]}
              >
                <View style={[s.tick, active && s.tickOn]}>
                  {active ? <View style={s.tickDot} /> : null}
                </View>
                <View style={s.orgBody}>
                  <Text style={[s.orgName, active && s.orgNameOn]} numberOfLines={1}>
                    {o.name}
                  </Text>
                  <Text style={s.orgRole}>
                    {busy === o.orgId ? "Switching…" : o.role}
                  </Text>
                </View>
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
          <Text style={s.metaKey}>API</Text>
          <Text style={s.metaValue}>{API_URL.replace(/^https?:\/\//, "")}</Text>
        </View>
      </Card>

      <Pressable
        style={({ pressed }) => [s.signout, pressed && s.signoutPressed]}
        onPress={() => void signOut()}
        accessibilityRole="button"
      >
        <Text style={s.signoutText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.paper },
  content: { padding: 16, paddingBottom: 40 },
  title: { fontSize: 25, fontWeight: "700", color: T.ink, letterSpacing: -0.5 },
  sub: { fontSize: 12.5, color: T.inkFaint, marginTop: 4, marginBottom: 18 },

  identity: { flexDirection: "row", alignItems: "center", gap: 14 },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: T.threadSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 17, fontWeight: "700", color: T.thread, letterSpacing: 0.5 },
  identityBody: { flex: 1, minWidth: 0 },
  name: { fontSize: 17, fontWeight: "700", color: T.ink, letterSpacing: -0.3 },
  email: { fontSize: 12.5, color: T.inkFaint, marginTop: 3 },

  orgRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: T.lineSoft,
  },
  orgRowFirst: { borderTopWidth: 0 },
  orgRowPressed: { opacity: 0.55 },
  tick: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: T.line,
    alignItems: "center",
    justifyContent: "center",
  },
  tickOn: { borderColor: T.thread, backgroundColor: T.thread },
  tickDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: T.card },
  orgBody: { flex: 1, minWidth: 0 },
  orgName: { fontSize: 14, fontWeight: "600", color: T.inkSoft },
  orgNameOn: { color: T.ink },
  orgRole: { fontSize: 11.5, color: T.inkFaint, marginTop: 2 },
  orgNote: {
    fontSize: 11.5,
    color: T.inkFaint,
    lineHeight: 16,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: T.lineSoft,
  },

  metaRow: { flexDirection: "row", alignItems: "baseline", gap: 12 },
  metaKey: {
    fontSize: 9.5,
    letterSpacing: 1.2,
    color: T.inkFaint,
    width: 40,
  },
  metaValue: { fontSize: 13, color: T.ink, flex: 1 },

  signout: {
    marginTop: 4,
    borderWidth: 1,
    borderColor: T.line,
    borderRadius: 99,
    paddingVertical: 13,
    alignItems: "center",
    backgroundColor: T.card,
  },
  signoutPressed: { backgroundColor: T.blockSoft, borderColor: T.block },
  signoutText: { fontSize: 13.5, fontWeight: "600", color: T.blockInk },
});
