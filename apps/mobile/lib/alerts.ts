import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { api, type DecisionRow, type DriftSummary, type Page } from "./api";

/**
 * Alerts and pings.
 *
 * The API has no push-token registry and no outbound push service, so real
 * remote push would need a server change — out of scope here. What this does
 * instead is poll the two things worth waking someone for and raise a *local*
 * notification when they change: a BLOCK verdict, and drift findings opening.
 *
 * Polling is honest about its limits: it only runs while the app is open. It is
 * also why the interval is 60s rather than 5s — nothing here is worth a battery.
 */

export const POLL_MS = 60_000;

export interface Alert {
  id: string;
  kind: "block" | "drift";
  title: string;
  body: string;
  at: string;
}

let configured = false;

export function configureNotifications() {
  if (configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: false,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

/** Asks once. A refusal is a valid answer — the in-app list still works. */
export async function askPermission(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted) return true;
  const asked = await Notifications.requestPermissionsAsync();
  return asked.granted;
}

export async function ping(alert: Alert) {
  if (Platform.OS === "web") return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title: alert.title, body: alert.body },
      trigger: null,
    });
  } catch {
    /* a denied permission must never break the refresh loop */
  }
}

/**
 * Reads the current alert-worthy state. Returns newest first.
 */
export async function fetchAlerts(): Promise<Alert[]> {
  const out: Alert[] = [];

  const [decisions, drift] = await Promise.allSettled([
    api.get<Page<DecisionRow>>("/api/gate/decisions?limit=20"),
    api.get<DriftSummary>("/api/drift/summary"),
  ]);

  if (decisions.status === "fulfilled") {
    for (const d of decisions.value.items) {
      if (d.verdict !== "BLOCK") continue;
      const target = String(d.change.externalId ?? d.change.target ?? "a change")
        .split("/")
        .filter(Boolean)
        .pop();
      out.push({
        id: `block-${d.id}`,
        kind: "block",
        title: "Change blocked",
        body: `${d.change.operation ?? "change"} ${target ?? ""}`.trim(),
        at: d.createdAt,
      });
    }
  }

  if (drift.status === "fulfilled" && drift.value.open > 0) {
    out.push({
      id: `drift-${drift.value.open}-${drift.value.lastCheckedAt ?? ""}`,
      kind: "drift",
      title: `${drift.value.open} drift finding${drift.value.open === 1 ? "" : "s"}`,
      body: "The live systems and the map disagree",
      at: drift.value.lastCheckedAt ?? new Date().toISOString(),
    });
  }

  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** Which alerts are new since last time, by id. */
export function newSince(seen: Set<string>, alerts: Alert[]): Alert[] {
  return alerts.filter((a) => !seen.has(a.id));
}
