import { Feather } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { R, SHADOW, T } from "./theme";
import { body, mono } from "./type";

/**
 * The bottom bar.
 *
 * Written by hand rather than configured, for one reason: the default bar
 * divides the width by the number of tabs, so every tab added makes every tab
 * narrower until the labels truncate and the row reads as a smear. That is a
 * cliff you fall off on the day you add a fifth screen, and it is not obvious
 * beforehand.
 *
 * So the count is bounded here instead. Up to MAX_VISIBLE tabs are laid out
 * flat; past that, the last slot becomes "More" and the overflow moves into a
 * sheet. Adding screens stays cheap and nothing reflows.
 *
 * It floats rather than docking. A bar welded to the bottom edge borrows the
 * screen's own border for its container and so reads as part of the frame; an
 * inset card with its own shadow reads as a control sitting on top of the
 * page, which is what it is. The cost is that it no longer displaces content —
 * hence `TAB_CLEARANCE`, which every scrolling screen pays at the bottom.
 *
 * The props are typed structurally. `@react-navigation/bottom-tabs` is not
 * resolvable from this package under pnpm's strict linking, and installing it
 * directly would put a second copy beside the one expo-router already carries.
 */

/** Past this, the final slot becomes the overflow menu rather than a tab. */
const MAX_VISIBLE = 5;

/** Horizontal inset of the floating bar from the screen edges. */
const BAR_INSET = 14;
/** Padding inside the bar, which the pill has to be offset by. */
const BAR_PAD = 6;
const PILL_HEIGHT = 46;

type IconName = React.ComponentProps<typeof Feather>["name"];

/** Route name → glyph. Anything unmapped still renders, with a neutral dot. */
const ICONS: Record<string, IconName> = {
  index: "activity",
  ask: "compass",
  decisions: "check-square",
  alerts: "bell",
  account: "user",
};

interface TabRoute {
  key: string;
  name: string;
}

export interface TabBarProps {
  state: { index: number; routes: TabRoute[] };
  descriptors: Record<string, { options: { title?: string } }>;
  navigation: {
    navigate: (name: string) => void;
    emit: (event: { type: "tabPress"; target: string; canPreventDefault: true }) => {
      defaultPrevented: boolean;
    };
  };
}

export function TabBar({ state, descriptors, navigation }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [overflowOpen, setOverflowOpen] = useState(false);

  const overflowing = state.routes.length > MAX_VISIBLE;
  // One slot is spent on "More" itself, so only MAX_VISIBLE - 1 tabs remain.
  const visible = overflowing ? state.routes.slice(0, MAX_VISIBLE - 1) : state.routes;
  const hidden = overflowing ? state.routes.slice(MAX_VISIBLE - 1) : [];

  // "More" occupies a slot, so the pill travels across a row one wider than
  // the visible tab count whenever the overflow menu is present.
  const slots = visible.length + (overflowing ? 1 : 0);
  const slotWidth = (width - BAR_INSET * 2 - BAR_PAD * 2) / slots;

  const labelOf = (route: TabRoute) =>
    descriptors[route.key]?.options.title ??
    route.name.charAt(0).toUpperCase() + route.name.slice(1);

  const go = (route: TabRoute, focused: boolean) => {
    const event = navigation.emit({
      type: "tabPress",
      target: route.key,
      canPreventDefault: true,
    });
    if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
  };

  // A hidden tab being active has to colour "More", or the bar claims nothing
  // is selected while the user is looking at one of its screens.
  const activeKey = state.routes[state.index]?.key;
  const hiddenActive = hidden.some((r) => activeKey === r.key);
  // Where the pill belongs: under the active tab, or under "More" when the
  // active screen lives behind it.
  const pillSlot = hiddenActive
    ? slots - 1
    : visible.findIndex((r) => r.key === activeKey);

  const pillX = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (pillSlot < 0) return;
    Animated.spring(pillX, {
      toValue: pillSlot * slotWidth,
      useNativeDriver: true,
      speed: 20,
      bounciness: 6,
    }).start();
  }, [pillSlot, slotWidth, pillX]);

  return (
    <>
      <View
        style={[
          styles.region,
          // Gesture-bar devices report an inset; button-nav ones report 0 and
          // still need breathing room, hence the floor.
          { paddingBottom: Math.max(insets.bottom, 12) },
        ]}
        // The region is only a spacer around the bar. Letting it swallow taps
        // would put a dead gutter over whatever content scrolls beneath it.
        pointerEvents="box-none"
      >
        <View style={styles.bar}>
          {pillSlot >= 0 ? (
            <Animated.View
              style={[
                styles.pill,
                { width: slotWidth, transform: [{ translateX: pillX }] },
              ]}
            />
          ) : null}

          {visible.map((route) => {
            const focused = activeKey === route.key;
            return (
              <Item
                key={route.key}
                icon={ICONS[route.name] ?? "circle"}
                label={labelOf(route)}
                focused={focused}
                onPress={() => go(route, focused)}
              />
            );
          })}

          {overflowing ? (
            <Item
              icon="more-horizontal"
              label="More"
              focused={hiddenActive}
              onPress={() => setOverflowOpen(true)}
            />
          ) : null}
        </View>
      </View>

      <Modal
        visible={overflowOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setOverflowOpen(false)}
      >
        <Pressable style={styles.scrim} onPress={() => setOverflowOpen(false)}>
          {/* Stops a tap inside the sheet from closing it. */}
          <Pressable
            style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}
            onPress={() => undefined}
          >
            <View style={styles.grabber} />
            <Text style={styles.sheetHead}>MORE</Text>
            {hidden.map((route) => {
              const focused = activeKey === route.key;
              return (
                <Pressable
                  key={route.key}
                  accessibilityRole="button"
                  accessibilityState={{ selected: focused }}
                  onPress={() => {
                    setOverflowOpen(false);
                    go(route, focused);
                  }}
                  style={({ pressed }) => [
                    styles.sheetRow,
                    pressed && styles.sheetRowPressed,
                  ]}
                >
                  <Feather
                    name={ICONS[route.name] ?? "circle"}
                    size={19}
                    color={focused ? T.thread : T.inkSoft}
                  />
                  <Text style={[styles.sheetLabel, focused && styles.sheetLabelOn]}>
                    {labelOf(route)}
                  </Text>
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function Item({
  icon,
  label,
  focused,
  onPress,
}: {
  icon: IconName;
  label: string;
  focused: boolean;
  onPress: () => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;

  // A small pop on selection. Purely confirmatory — the pill is what actually
  // communicates state — so it fires on becoming focused and never on leaving,
  // which would animate every tab at once each time you switch.
  useEffect(() => {
    if (!focused) return;
    scale.setValue(0.86);
    Animated.spring(scale, {
      toValue: 1,
      useNativeDriver: true,
      speed: 20,
      bounciness: 10,
    }).start();
  }, [focused, scale]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.item}
      // Android's default ripple is a rectangle that overflows the pill.
      android_ripple={{ color: T.threadSoft, borderless: true, radius: 34 }}
    >
      <Animated.View style={{ transform: [{ scale }] }}>
        <Feather name={icon} size={19} color={focused ? T.thread : T.inkFaint} />
      </Animated.View>
      <Text style={[styles.label, focused && styles.labelOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  region: {
    paddingHorizontal: BAR_INSET,
    paddingTop: 6,
    // Transparent: the screen's own paper shows through, and the bar's shadow
    // needs page behind it rather than a panel of its own colour.
    backgroundColor: "transparent",
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: T.card,
    borderRadius: R.lg,
    borderWidth: 1,
    borderColor: T.lineSoft,
    padding: BAR_PAD,
    ...SHADOW.bar,
  },
  item: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    height: PILL_HEIGHT,
  },
  pill: {
    position: "absolute",
    left: BAR_PAD,
    top: BAR_PAD,
    height: PILL_HEIGHT,
    borderRadius: R.md + 4,
    backgroundColor: T.threadSoft,
  },
  label: { fontFamily: body("600"), fontSize: 10.5, color: T.inkFaint },
  labelOn: { fontFamily: body("700"), color: T.thread },

  scrim: {
    flex: 1,
    backgroundColor: "rgba(23,25,30,0.32)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: T.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 10,
    paddingHorizontal: 10,
    ...SHADOW.sheet,
  },
  grabber: {
    alignSelf: "center",
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: T.line,
    marginBottom: 12,
  },
  sheetHead: {
    fontFamily: mono("500"),
    fontSize: 9.5,
    letterSpacing: 1.1,
    color: T.inkFaint,
    paddingHorizontal: 12,
    marginBottom: 4,
  },
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 15,
    paddingHorizontal: 12,
    borderRadius: R.md,
  },
  sheetRowPressed: { backgroundColor: T.panel },
  sheetLabel: { fontFamily: body("600"), fontSize: 15, color: T.inkSoft },
  sheetLabelOn: { color: T.ink },
});
