import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useCallback } from "react";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { configureNotifications } from "../lib/alerts";
import { SessionProvider } from "../lib/session";
import { T } from "../lib/theme";
import { FONT_MAP } from "../lib/type";

configureNotifications();

// Held until the faces are in memory. Without this the first frame paints in
// the system font and reflows a beat later, which is the single most visible
// tell that an app's type is not its own.
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const [loaded, error] = useFonts(FONT_MAP);

  const onReady = useCallback(() => {
    if (loaded || error) SplashScreen.hideAsync().catch(() => {});
  }, [loaded, error]);

  // A font that fails to decode is not worth a blank app: `error` releases the
  // hold and the tree renders in the platform default rather than never.
  if (!loaded && !error) return null;

  return (
    <SafeAreaProvider>
      <SessionProvider>
        <View style={{ flex: 1, backgroundColor: T.paper }} onLayout={onReady}>
          <StatusBar style="dark" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: T.paper },
              animation: "slide_from_right",
            }}
          >
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="signin" options={{ animation: "fade" }} />
          </Stack>
        </View>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
