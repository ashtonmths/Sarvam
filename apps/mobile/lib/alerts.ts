import {
  getPermissionsAsync,
  requestPermissionsAsync,
} from "expo-notifications/build/NotificationPermissions";
import { setNotificationHandler } from "expo-notifications/build/NotificationsHandler";
import scheduleNotificationAsync from "expo-notifications/build/scheduleNotificationAsync";
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

/**
 * Pings work anywhere but web, Expo Go included.
 *
 * The imports above reach the three modules directly instead of the package
 * root, and that is load-bearing rather than a style choice. `index.js` pulls
 * DevicePushTokenAutoRegistration, which registers a *push token* listener at
 * import time whether or not the app ever asks for remote push. Expo Go on
 * Android dropped remote push in SDK 53, so that side effect errored during
 * route load — the Alerts screen imports this file — and an app that only
 * schedules local notifications was falling over on a feature it never used.
 *
 * Local notifications were never the thing Expo Go removed. Skipping the entry
 * module skips the registration and keeps them, so the switch works on the
 * phone in your hand today rather than only in a future dev build.
 *
 * The cost is a deep import: no `exports` field in expo-notifications makes it
 * legal, and the three modules pull only expo-modules-core and their own native
 * wrappers. It is pinned to ~0.32.17 and would need rechecking on an SDK bump —
 * a broken build, not a silent regression, since the paths simply stop
 * resolving.
 */
export const PINGS_SUPPORTED = Platform.OS !== "web";

/** Why pings are off, for the screen to show instead of a dead switch. */
export const PINGS_UNAVAILABLE_REASON = "Notifications are not available on web.";

export interface Alert {
  id: string;
  kind: "block" | "drift";
  title: string;
  body: string;
  at: string;
}

let configured = false;

export function configureNotifications() {
  if (configured || !PINGS_SUPPORTED) return;
  configured = true;
  setNotificationHandler({
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
  if (!PINGS_SUPPORTED) return false;
  const existing = await getPermissionsAsync();
  if (existing.granted) return true;
  const asked = await requestPermissionsAsync();
  return asked.granted;
}

export async function ping(alert: Alert) {
  if (!PINGS_SUPPORTED) return;
  try {
    await scheduleNotificationAsync({
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
