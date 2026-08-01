import { Feather } from "@expo/vector-icons";
import { useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { T } from "./theme";

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
 * The props are typed structurally. `@react-navigation/bottom-tabs` is not
 * resolvable from this package under pnpm's strict linking, and installing it
 * directly would put a second copy beside the one expo-router already carries.
 */

/** Past this, the final slot becomes the overflow menu rather than a tab. */
const MAX_VISIBLE = 5;

type IconName = React.ComponentProps<typeof Feather>["name"];

/** Route name → glyph. Anything unmapped still renders, with a neutral dot. */
const ICONS: Record<string, IconName> = {
  index: "activity",
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
  const [overflowOpen, setOverflowOpen] = useState(false);

  const overflowing = state.routes.length > MAX_VISIBLE;
  // One slot is spent on "More" itself, so only MAX_VISIBLE - 1 tabs remain.
  const visible = overflowing ? state.routes.slice(0, MAX_VISIBLE - 1) : state.routes;
  const hidden = overflowing ? state.routes.slice(MAX_VISIBLE - 1) : [];

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
  const hiddenActive = hidden.some((r) => state.routes[state.index]?.key === r.key);

  return (
    <>
      <View
        style={[
          s.bar,
          // Gesture-bar devices report an inset; button-nav ones report 0 and
          // still need breathing room, hence the floor.
          { paddingBottom: Math.max(insets.bottom, 10) },
        ]}
      >
        {visible.map((route) => {
          const focused = state.index === state.routes.indexOf(route);
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

      <Modal
        visible={overflowOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setOverflowOpen(false)}
      >
        <Pressable style={s.scrim} onPress={() => setOverflowOpen(false)}>
          {/* Stops a tap inside the sheet from closing it. */}
          <Pressable
            style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}
            onPress={() => undefined}
          >
            <View style={s.grabber} />
            {hidden.map((route) => {
              const focused = state.index === state.routes.indexOf(route);
              return (
                <Pressable
                  key={route.key}
                  accessibilityRole="button"
                  accessibilityState={{ selected: focused }}
                  onPress={() => {
                    setOverflowOpen(false);
                    go(route, focused);
                  }}
                  style={({ pressed }) => [s.sheetRow, pressed && s.sheetRowPressed]}
                >
                  <Feather
                    name={ICONS[route.name] ?? "circle"}
                    size={19}
                    color={focused ? T.thread : T.inkSoft}
                  />
                  <Text style={[s.sheetLabel, focused && s.sheetLabelOn]}>
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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={label}
      onPress={onPress}
      style={s.item}
      // Android's default ripple is a rectangle that overflows the pill.
      android_ripple={{ color: T.threadSoft, borderless: true, radius: 34 }}
    >
      <View style={[s.pill, focused && s.pillOn]}>
        <Feather name={icon} size={19} color={focused ? T.thread : T.inkFaint} />
      </View>
      <Text style={[s.label, focused && s.labelOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: T.card,
    borderTopWidth: 1,
    borderTopColor: T.lineSoft,
    paddingTop: 8,
    paddingHorizontal: 6,
  },
  item: { flex: 1, alignItems: "center", gap: 3, paddingVertical: 2 },
  pill: {
    width: 56,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  pillOn: { backgroundColor: T.threadSoft },
  label: { fontSize: 11, fontWeight: "600", color: T.inkFaint },
  labelOn: { color: T.ink },

  scrim: {
    flex: 1,
    backgroundColor: "rgba(23,25,30,0.32)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: T.card,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingTop: 10,
    paddingHorizontal: 10,
    ...Platform.select({
      ios: {
        shadowColor: T.ink,
        shadowOpacity: 0.18,
        shadowRadius: 20,
        shadowOffset: { width: 0, height: -6 },
      },
      android: { elevation: 16 },
      default: {},
    }),
  },
  grabber: {
    alignSelf: "center",
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: T.line,
    marginBottom: 10,
  },
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 15,
    paddingHorizontal: 12,
    borderRadius: 14,
  },
  sheetRowPressed: { backgroundColor: T.panel },
  sheetLabel: { fontSize: 15, fontWeight: "600", color: T.inkSoft },
  sheetLabelOn: { color: T.ink },
});
