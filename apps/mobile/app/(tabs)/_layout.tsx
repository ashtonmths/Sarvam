import { Redirect, Tabs } from "expo-router";
import { View } from "react-native";
import { useSession } from "../../lib/session";
import { T } from "../../lib/theme";
import { Loading } from "../../lib/ui";

/** A glyph-free tab bar: three tabs, so the labels carry it. */
function Dot({ focused }: { focused: boolean }) {
  return (
    <View
      style={{
        width: 5,
        height: 5,
        borderRadius: 3,
        marginBottom: 2,
        backgroundColor: focused ? T.thread : "transparent",
      }}
    />
  );
}

export default function TabsLayout() {
  const { ready, user } = useSession();
  if (!ready) return <Loading label="SADHAK" />;
  if (!user) return <Redirect href="/signin" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: T.ink,
        tabBarInactiveTintColor: T.inkFaint,
        tabBarStyle: {
          backgroundColor: T.card,
          borderTopColor: T.lineSoft,
          height: 62,
          paddingBottom: 8,
          paddingTop: 8,
        },
        tabBarLabelStyle: { fontSize: 12, fontWeight: "600" },
        tabBarIcon: ({ focused }: { focused: boolean }) => <Dot focused={focused} />,
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Overview" }} />
      <Tabs.Screen name="decisions" options={{ title: "Decisions" }} />
      <Tabs.Screen name="alerts" options={{ title: "Alerts" }} />
    </Tabs>
  );
}
