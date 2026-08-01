import { Redirect, Tabs } from "expo-router";
import { useSession } from "../../lib/session";
import { TabBar, type TabBarProps } from "../../lib/tabbar";
import { Loading } from "../../lib/ui";

export default function TabsLayout() {
  const { ready, user } = useSession();
  if (!ready) return <Loading label="SADHAK" />;
  if (!user) return <Redirect href="/signin" />;

  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      // Our own bar: see lib/tabbar.tsx for why the default one does not
      // survive a fifth screen.
      tabBar={(props: unknown) => <TabBar {...(props as TabBarProps)} />}
    >
      <Tabs.Screen name="index" options={{ title: "Overview" }} />
      <Tabs.Screen name="decisions" options={{ title: "Decisions" }} />
      <Tabs.Screen name="alerts" options={{ title: "Alerts" }} />
      <Tabs.Screen name="account" options={{ title: "Account" }} />
    </Tabs>
  );
}
