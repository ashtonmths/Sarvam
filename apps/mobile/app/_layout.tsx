import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { configureNotifications } from "../lib/alerts";
import { SessionProvider } from "../lib/session";
import { T } from "../lib/theme";

configureNotifications();

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: T.paper },
          }}
        />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
