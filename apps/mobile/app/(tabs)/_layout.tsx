import { Redirect, Tabs } from "expo-router";
import { View } from "react-native";
import { BrandGate } from "../../lib/brand";
import { useSession } from "../../lib/session";
import { TabBar, type TabBarProps } from "../../lib/tabbar";
import { T } from "../../lib/theme";

export default function TabsLayout() {
  const { ready, user } = useSession();
  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: T.paper }}>
        <BrandGate />
      </View>
    );
  }
  if (!user) return <Redirect href="/signin" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: T.paper },
      }}
      // Our own bar: see lib/tabbar.tsx for why the default one does not
      // survive a fifth screen, and why this one floats.
      tabBar={(props: unknown) => <TabBar {...(props as TabBarProps)} />}
    >
      <Tabs.Screen name="index" options={{ title: "Overview" }} />
      <Tabs.Screen name="decisions" options={{ title: "Decisions" }} />
      <Tabs.Screen name="alerts" options={{ title: "Alerts" }} />
      <Tabs.Screen name="account" options={{ title: "Account" }} />
    </Tabs>
  );
}
