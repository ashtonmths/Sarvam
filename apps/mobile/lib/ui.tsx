import { Feather } from "@expo/vector-icons";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { R, SHADOW, T, TAB_CLEARANCE, VERDICT } from "./theme";
import { body, display, mono } from "./type";

type IconName = React.ComponentProps<typeof Feather>["name"];

/**
 * The screen frame.
 *
 * Four screens each opened with the same ScrollView, the same paper
 * background, the same `insets.top + 16`, and the same pull-to-refresh wiring
 * — four chances to get the bottom padding wrong now that the tab bar floats
 * over the content instead of displacing it. One component owns all of it.
 */
export function Screen({
  children,
  onRefresh,
  refreshing = false,
}: {
  children: React.ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={[
        s.screenContent,
        { paddingTop: insets.top + 14, paddingBottom: TAB_CLEARANCE + insets.bottom },
      ]}
      // The bar is a floating card; content sliding under its shadow rather
      // than stopping short of it is what makes the lift read as depth.
      showsVerticalScrollIndicator={false}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={T.thread}
            colors={[T.thread]}
          />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  );
}

export function Card({
  title,
  action,
  children,
  style,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View style={[s.card, style]}>
      {title ? (
        <View style={s.cardHead}>
          {/* Shrinks rather than shoving `action` off the right edge. */}
          <Text style={s.cardTitle} numberOfLines={1}>
            {title}
          </Text>
          {action}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function Figure({
  value,
  label,
  tone,
}: {
  value: string | number;
  label: string;
  /** Colours the numeral. For counts that carry a verdict's weight. */
  tone?: string;
}) {
  return (
    <View style={s.figure}>
      <Text
        style={[s.figureValue, tone ? { color: tone } : null]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
      >
        {value}
      </Text>
      <Text style={s.figureLabel} numberOfLines={2}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

/**
 * The list row shared by Overview, Decisions and Alerts: something named on
 * the left, its metadata beneath, and a status object on the right. All three
 * had their own copy, and all three had drifted on font size and padding.
 */
export function Row({
  title,
  meta,
  metaKind = "data",
  right,
  lead,
  first,
}: {
  title: string;
  meta?: string;
  /**
   * `data` sets the meta in mono — for counts, durations and timestamps, where
   * the fixed advance is what makes a column of them scannable. `prose` sets
   * it in the body face, because a sentence in mono reads as a log line and
   * costs about a third more width to say the same thing.
   */
  metaKind?: "data" | "prose";
  right?: React.ReactNode;
  /** A leading dot or icon. */
  lead?: React.ReactNode;
  /** Suppresses the divider on the first row of a group. */
  first?: boolean;
}) {
  return (
    <View
      style={[
        s.row,
        first && s.rowFirst,
        // Centring works when the row is one object beside a chip. It breaks
        // for a leading dot against a meta line that wraps: the dot drifts to
        // the middle of the block and stops pointing at the title it marks.
        lead ? s.rowTop : null,
      ]}
    >
      {lead ? <View style={s.rowLead}>{lead}</View> : null}
      <View style={s.rowBody}>
        <Text style={s.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        {meta ? (
          <Text
            style={[s.rowMeta, metaKind === "prose" && s.rowMetaProse]}
            numberOfLines={2}
          >
            {meta}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  );
}

/** A horizontal progress track. `value` is 0–100. */
export function Meter({ value, tone = T.thread }: { value: number; tone?: string }) {
  // Clamped, because a coverage figure above 100 would otherwise render a fill
  // wider than its own track and bleed past the card's rounded corner.
  const pct = Math.max(0, Math.min(100, value));
  return (
    <View
      style={s.meter}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct) }}
    >
      <View style={[s.meterFill, { width: `${pct}%`, backgroundColor: tone }]} />
    </View>
  );
}

export function VerdictChip({ verdict }: { verdict: keyof typeof VERDICT }) {
  const c = VERDICT[verdict];
  return (
    <View style={[s.chip, { backgroundColor: c.bg }]}>
      <View style={[s.chipDot, { backgroundColor: c.dot }]} />
      <Text style={[s.chipText, { color: c.fg }]}>{verdict}</Text>
    </View>
  );
}

/** The uppercase micro-label used above values and form fields. */
export function Label({ children }: { children: string }) {
  return <Text style={s.microLabel}>{children.toUpperCase()}</Text>;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <View style={s.loading}>
      <ActivityIndicator color={T.thread} />
      <Text style={s.loadingText}>{label.toUpperCase()}</Text>
    </View>
  );
}

/**
 * The nothing-here state. An icon and a line of prose, rather than a bare
 * sentence floating in a card — empty is a state worth designing, since on a
 * healthy system it is the one people see most.
 */
export function Empty({ text, icon = "check" }: { text: string; icon?: IconName }) {
  return (
    <View style={s.empty}>
      <View style={s.emptyIcon}>
        <Feather name={icon} size={16} color={T.inkFaint} />
      </View>
      <Text style={s.emptyText}>{text}</Text>
    </View>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <View style={s.error} accessibilityRole="alert">
      <Feather name="alert-triangle" size={15} color={T.blockInk} />
      <Text style={s.errorText}>{message}</Text>
    </View>
  );
}

/** Filled dark button. The one primary action per screen. */
export function Button({
  label,
  onPress,
  disabled,
  busy,
  tone = "solid",
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** Rendered in place of the label — a spinner, while the action is in flight. */
  busy?: React.ReactNode;
  /** `quiet` is the outlined, destructive-leaning variant. */
  tone?: "solid" | "quiet";
}) {
  const quiet = tone === "quiet";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        s.button,
        quiet ? s.buttonQuiet : s.buttonSolid,
        pressed && (quiet ? s.buttonQuietPressed : s.buttonPressed),
        disabled && s.buttonOff,
      ]}
    >
      {busy ?? <Text style={[s.buttonText, quiet && s.buttonTextQuiet]}>{label}</Text>}
    </Pressable>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: T.paper },
  screenContent: { paddingHorizontal: 16 },

  card: {
    backgroundColor: T.card,
    borderRadius: R.lg,
    borderWidth: 1,
    borderColor: T.lineSoft,
    padding: 18,
    marginBottom: 14,
    ...SHADOW.card,
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 14,
    paddingBottom: 13,
    borderBottomWidth: 1,
    borderBottomColor: T.lineSoft,
  },
  cardTitle: {
    fontFamily: display("600"),
    fontSize: 16,
    letterSpacing: -0.2,
    color: T.ink,
    flexShrink: 1,
  },

  /**
   * No minimum width. A `minWidth: 120` here fitted the two-up rows on
   * Overview and quietly overflowed the three-up row on Decisions: three
   * columns plus gaps plus card and screen padding wants ~450pt, and no phone
   * in portrait has it. Shrinking is the only behaviour that works at both
   * counts, so the constraint has to come off rather than be tuned.
   */
  figure: { flex: 1, minWidth: 0, flexShrink: 1 },
  figureValue: {
    fontFamily: display("700"),
    fontSize: 27,
    letterSpacing: -0.8,
    color: T.ink,
  },
  figureLabel: {
    fontFamily: mono("500"),
    fontSize: 9,
    letterSpacing: 1,
    lineHeight: 13,
    color: T.inkFaint,
    marginTop: 5,
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: T.lineSoft,
  },
  rowFirst: { borderTopWidth: 0 },
  rowTop: { alignItems: "flex-start" },
  // Drops the lead onto the title's optical centre: half the title's line box
  // less half the dot. Hardcoded rather than measured — both are fixed here.
  rowLead: { paddingTop: 6 },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: {
    fontFamily: body("600"),
    fontSize: 14,
    letterSpacing: -0.1,
    color: T.ink,
  },
  rowMeta: {
    fontFamily: mono("400"),
    fontSize: 11,
    lineHeight: 16,
    color: T.inkFaint,
    marginTop: 3,
  },
  rowMetaProse: { fontFamily: body("400"), fontSize: 12, lineHeight: 17 },

  meter: {
    height: 7,
    borderRadius: R.pill,
    backgroundColor: T.lineSoft,
    marginTop: 14,
    overflow: "hidden",
  },
  meterFill: { height: 7, borderRadius: R.pill },

  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: R.pill,
    // Never let a long row title squeeze the verdict into an ellipsis: the
    // verdict is the one thing on the row that must stay readable.
    flexShrink: 0,
  },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  chipText: { fontFamily: mono("600"), fontSize: 9.5, letterSpacing: 0.6 },

  microLabel: {
    fontFamily: mono("500"),
    fontSize: 9.5,
    letterSpacing: 1.1,
    color: T.inkFaint,
  },

  loading: { paddingVertical: 44, alignItems: "center", gap: 12 },
  loadingText: {
    fontFamily: mono("500"),
    fontSize: 9.5,
    letterSpacing: 1.4,
    color: T.inkFaint,
  },

  empty: { paddingVertical: 26, alignItems: "center", gap: 11 },
  emptyIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: T.panel,
    borderWidth: 1,
    borderColor: T.lineSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    fontFamily: body("400"),
    fontSize: 13,
    color: T.inkFaint,
    textAlign: "center",
    lineHeight: 19,
    maxWidth: 280,
  },

  error: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 9,
    backgroundColor: T.blockSoft,
    borderColor: T.block,
    borderWidth: 1,
    borderRadius: R.md,
    padding: 13,
    marginBottom: 14,
  },
  errorText: {
    fontFamily: body("500"),
    color: T.blockInk,
    fontSize: 13,
    lineHeight: 18,
    flex: 1,
  },

  button: {
    borderRadius: R.pill,
    paddingVertical: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonSolid: { backgroundColor: T.ink },
  buttonPressed: { opacity: 0.82 },
  buttonQuiet: { backgroundColor: T.card, borderWidth: 1, borderColor: T.line },
  buttonQuietPressed: { backgroundColor: T.blockSoft, borderColor: T.block },
  buttonOff: { opacity: 0.42 },
  buttonText: { fontFamily: body("600"), color: T.paper, fontSize: 15 },
  buttonTextQuiet: { color: T.blockInk, fontSize: 14 },
});
