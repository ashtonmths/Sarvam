import { Redirect } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";
import { API_URL } from "../lib/api";
import { useSession } from "../lib/session";
import { T } from "../lib/theme";
import { ErrorNote } from "../lib/ui";

export default function SignIn() {
  const { user, ready, signIn } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (ready && user) return <Redirect href="/(tabs)" />;

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = email.trim().length > 0 && password.length > 0 && !busy;

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <Text style={s.brand}>साधक</Text>
        <Text style={s.title}>Sign in</Text>
        <Text style={s.sub}>
          The read-only companion. Every control that changes something stays on the web
          app.
        </Text>

        {error ? <ErrorNote message={error} /> : null}

        <Text style={s.label}>WORK EMAIL</Text>
        <TextInput
          style={s.input}
          value={email}
          onChangeText={setEmail}
          placeholder="you@company.com"
          placeholderTextColor={T.inkFaint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          returnKeyType="next"
        />

        <Text style={s.label}>PASSWORD</Text>
        <TextInput
          style={s.input}
          value={password}
          onChangeText={setPassword}
          placeholder="Your password"
          placeholderTextColor={T.inkFaint}
          secureTextEntry
          autoCapitalize="none"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={submit}
        />

        <Pressable
          style={[s.button, !canSubmit && s.buttonOff]}
          onPress={submit}
          disabled={!canSubmit}
          accessibilityRole="button"
        >
          {busy ? (
            <ActivityIndicator color={T.paper} />
          ) : (
            <Text style={s.buttonText}>Sign in</Text>
          )}
        </Pressable>

        <Text style={s.host}>{API_URL.replace(/^https?:\/\//, "")}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.paper },
  scroll: { padding: 24, paddingTop: 90, flexGrow: 1 },
  brand: { fontSize: 26, fontWeight: "700", color: T.ink, marginBottom: 26 },
  title: { fontSize: 30, fontWeight: "700", color: T.ink, letterSpacing: -0.6 },
  sub: { fontSize: 14, color: T.inkSoft, marginTop: 8, marginBottom: 26, lineHeight: 20 },
  label: { fontSize: 10, letterSpacing: 1.3, color: T.inkFaint, marginBottom: 7 },
  input: {
    backgroundColor: T.card,
    borderWidth: 1,
    borderColor: T.line,
    borderRadius: 14,
    paddingHorizontal: 15,
    paddingVertical: 13,
    fontSize: 15,
    color: T.ink,
    marginBottom: 18,
  },
  button: {
    backgroundColor: T.ink,
    borderRadius: 99,
    paddingVertical: 15,
    alignItems: "center",
    marginTop: 6,
  },
  buttonOff: { opacity: 0.45 },
  buttonText: { color: T.paper, fontSize: 15, fontWeight: "600" },
  host: { textAlign: "center", marginTop: 22, fontSize: 11, color: T.inkFaint },
});
