import Constants, { ExecutionEnvironment } from "expo-constants";
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
 * Whether local pings can work at all here.
 *
 * Importing `expo-notifications` is not free: its entry module runs
 * DevicePushTokenAutoRegistration at import time, which registers a *push
 * token* listener whether or not the app ever asks for remote push. Expo Go on
 * Android removed remote push in SDK 53, so that side effect throws there — and
 * it threw during route load, because the Alerts screen imports this file. An
 * app that only schedules local notifications was crashing on a feature it
 * never used.
 *
 * There is no way to import the module without the registration, so the check
 * has to happen before the import rather than around the calls.
 */
export const PINGS_SUPPORTED =
  Platform.OS !== "web" &&
  !(
    Platform.OS === "android" &&
    Constants.executionEnvironment === ExecutionEnvironment.StoreClient
  );

/** Why pings are off, for the screen to show instead of a dead switch. */
export const PINGS_UNAVAILABLE_REASON =
  Platform.OS === "web"
    ? "Notifications are not available on web."
    : "Expo Go dropped notification support on Android in SDK 53. Pings work in a development build or a release APK.";

type NotificationsModule = typeof import("expo-notifications");

let cached: NotificationsModule | null = null;

/** Required on first use, never at module scope. Null where unsupported. */
function notifications(): NotificationsModule | null {
  if (!PINGS_SUPPORTED) return null;
  if (!cached) cached = require("expo-notifications") as NotificationsModule;
  return cached;
}

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
  const N = notifications();
  if (!N) return;
  configured = true;
  N.setNotificationHandler({
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
  const N = notifications();
  if (!N) return false;
  const existing = await N.getPermissionsAsync();
  if (existing.granted) return true;
  const asked = await N.requestPermissionsAsync();
  return asked.granted;
}

export async function ping(alert: Alert) {
  const N = notifications();
  if (!N) return;
  try {
    await N.scheduleNotificationAsync({
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
