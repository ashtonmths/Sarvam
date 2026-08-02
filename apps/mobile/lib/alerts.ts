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
 * Polling runs while the screen is mounted and stops when the app leaves the
 * foreground.
 */

/**
 * Five seconds, chosen for how fast a blocked change should surface.
 *
 * Two requests per tick against a per-IP budget of 60/min (RATE_LIMIT_IP_PER_MIN)
 * means one device on this screen spends 24 of them continuously. That is fine
 * for one user and not fine for several behind one NAT — an office or a carrier
 * CGNAT puts every phone on the same key, and the fourth one starts collecting
 * 429s. Raise the limit or lengthen this before more than a handful of people
 * sit on Alerts at once.
 */
export const POLL_MS = 5_000;

/**
 * Pings work anywhere but web, Expo Go included.
 *
 * Expo Go on Android prints one alarming line on SDK 53+ — that remote push
 * was removed and you should use a development build. It is worth reading
 * `warnOfExpoGoPushUsage` in expo-notifications before acting on it:
 *
 *     if (__DEV__ && isRunningInExpoGo() && !didWarn) { ... console.error(...) }
 *
 * A `console.error`, not a throw. Guarded by `__DEV__`, so it cannot reach a
 * release build; guarded by Expo Go, so a development build never sees it;
 * guarded by `didWarn`, so it happens once. It surfaces during route load
 * because the Alerts screen imports this file, and a red LogBox entry under a
 * stack trace reads exactly like a crash. It is not one, and nothing here was
 * ever broken by it.
 *
 * What SDK 53 removed from Expo Go is *remote push*. This module only ever
 * schedules local notifications, which still work — so the plain public import
 * is correct, and the message is noise that disappears the moment this runs
 * anywhere but Expo Go in dev.
 */
const IS_WEB = Platform.OS === "web";

/**
 * The browser's own notification API, on web only.
 *
 * expo-notifications does not implement web, which is why pings used to be
 * switched off there — but the browser has had this natively for years, and
 * running the app in a tab is the fastest way to exercise the whole path
 * without a phone. Typed locally rather than by pulling the DOM lib into a
 * React Native tsconfig, which would make every other web-only global look
 * available on a device too.
 */
interface WebNotification {
  permission: "granted" | "denied" | "default";
  requestPermission(): Promise<"granted" | "denied" | "default">;
  new (
    title: string,
    options?: { body?: string; tag?: string },
  ): {
    onclick: (() => void) | null;
    close(): void;
  };
}

const webNotify: WebNotification | null = IS_WEB
  ? ((globalThis as { Notification?: WebNotification }).Notification ?? null)
  : null;

/**
 * Pings work everywhere: expo-notifications on a device, the browser API on
 * web. Only a browser too old to have `Notification` is left out.
 *
 * On device, Expo Go prints one alarming line on SDK 53+ — that remote push was
 * removed and you should use a development build. It is worth reading
 * `warnOfExpoGoPushUsage` in expo-notifications before acting on it:
 *
 *     if (__DEV__ && isRunningInExpoGo() && !didWarn) { ... console.error(...) }
 *
 * A `console.error`, not a throw. `__DEV__` only, so a release build cannot
 * reach it; Expo Go only, so a development build never sees it; once, by the
 * `didWarn` latch. It surfaces during route load because the Alerts screen
 * imports this file, and a red LogBox entry under a stack trace reads exactly
 * like a crash. It is not one. What SDK 53 removed is *remote push*, which this
 * module never used — local notifications were working throughout.
 */
export const PINGS_SUPPORTED = IS_WEB ? webNotify !== null : true;

/** Why pings are off, for the screen to show instead of a dead switch. */
export const PINGS_UNAVAILABLE_REASON = "This browser has no notification support.";

interface WorkflowFailure {
  id: number;
  workflowName: string | null;
  diagnosisState: string;
  detectedAt: string;
  diagnosedAt: string | null;
  diagnosis: {
    recommendation?: string;
    narrative?: { headline?: string; action?: string };
  } | null;
}

export interface Alert {
  id: string;
  kind: "block" | "drift" | "workflow";
  title: string;
  body: string;
  at: string;
}

let configured = false;

export function configureNotifications() {
  // Nothing to configure on web: the browser owns presentation, and there is no
  // foreground/background distinction for it to be told about.
  if (configured || !PINGS_SUPPORTED || IS_WEB) return;
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

/**
 * Sends the user to Alerts when they tap a ping.
 *
 * Without this, tapping one opens the app on whatever screen it was last on
 * and leaves them to find the thing that just interrupted them — which is a
 * worse outcome than not having notified at all.
 *
 * Two arrivals to cover, and only one of them is an event. A tap on a *running*
 * app fires the listener; a tap that cold-starts the app happens long before
 * any listener exists, and is readable only as the "last response" the module
 * held onto. Handling just the first is the common bug, and it is invisible in
 * testing because the app is nearly always already running.
 */
export function onAlertTap(go: () => void): () => void {
  if (!PINGS_SUPPORTED) return () => undefined;

  // Web has no cold-start case to recover: a browser notification cannot
  // outlive the tab that created it, so the click is always a live event and
  // `ping` wires it directly.
  if (IS_WEB) {
    onWebTap = go;
    return () => {
      onWebTap = null;
    };
  }

  void Notifications.getLastNotificationResponseAsync().then((response) => {
    if (response) go();
  });

  const sub = Notifications.addNotificationResponseReceivedListener(() => go());
  return () => sub.remove();
}

/** Set by `onAlertTap` on web, read by `ping` when it builds a notification. */
let onWebTap: (() => void) | null = null;

/** Asks once. A refusal is a valid answer — the in-app list still works. */
export async function askPermission(): Promise<boolean> {
  if (!PINGS_SUPPORTED) return false;

  if (webNotify) {
    // Browsers only show the prompt for a user gesture, which the switch is.
    // A previous "denied" is final until the user clears it in site settings —
    // asking again returns "denied" without showing anything.
    if (webNotify.permission === "granted") return true;
    return (await webNotify.requestPermission()) === "granted";
  }

  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted) return true;
  const asked = await Notifications.requestPermissionsAsync();
  return asked.granted;
}

export async function ping(alert: Alert) {
  if (!PINGS_SUPPORTED) return;
  try {
    if (webNotify) {
      if (webNotify.permission !== "granted") return;
      // `tag` collapses repeats of the same alert into one toast rather than
      // stacking them, which matters because the poll re-reads the same list.
      const shown = new webNotify(alert.title, { body: alert.body, tag: alert.id });
      shown.onclick = () => {
        onWebTap?.();
        shown.close();
      };
      return;
    }

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

  const [decisions, drift, workflows] = await Promise.allSettled([
    api.get<Page<DecisionRow>>("/api/gate/decisions?limit=20"),
    api.get<DriftSummary>("/api/drift/summary"),
    api.get<{ items: WorkflowFailure[] }>("/api/n8n/failures?limit=10"),
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

  /**
   * A workflow that failed and has been explained.
   *
   * Only once it is diagnosed, which is the difference between a phone that
   * buzzes with "something broke" and one that buzzes with what to do about it.
   * The gap is seconds, and waking someone twice for one failure is how an
   * alert app gets its notifications turned off.
   */
  if (workflows.status === "fulfilled") {
    for (const f of workflows.value.items ?? []) {
      if (f.diagnosisState !== "diagnosed" && f.diagnosisState !== "fix_pending")
        continue;

      const d = f.diagnosis ?? {};
      out.push({
        id: `workflow-${f.id}`,
        kind: "workflow",
        title: d.narrative?.headline ?? `${f.workflowName ?? "A workflow"} failed`,
        // The action, not the error. It is what a phone screen has room for and
        // the only part that is any use before you open anything.
        body: d.narrative?.action ?? d.recommendation ?? "Diagnosed — open for detail",
        at: f.diagnosedAt ?? f.detectedAt,
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
