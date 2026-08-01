import { Redirect } from "expo-router";
import { View } from "react-native";
import { useSession } from "../lib/session";
import { Loading } from "../lib/ui";

/** The gate. Nothing renders until the keychain has been read. */
export default function Index() {
  const { ready, user } = useSession();
  if (!ready) {
    return (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <Loading label="SADHAK" />
      </View>
    );
  }
  return <Redirect href={user ? "/(tabs)" : "/signin"} />;
}
