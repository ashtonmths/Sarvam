import { Redirect } from "expo-router";
import { View } from "react-native";
import { BrandGate } from "../lib/brand";
import { useSession } from "../lib/session";
import { T } from "../lib/theme";

/** The gate. Nothing renders until the keychain has been read. */
export default function Index() {
  const { ready, user } = useSession();
  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: T.paper }}>
        <BrandGate />
      </View>
    );
  }
  return <Redirect href={user ? "/(tabs)" : "/signin"} />;
}
