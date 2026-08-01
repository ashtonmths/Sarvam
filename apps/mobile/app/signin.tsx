import { Redirect } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { API_URL } from "../lib/api";
import { Brand } from "../lib/brand";
import { useSession } from "../lib/session";
import { R, T } from "../lib/theme";
import { body, display, mono } from "../lib/type";
import { Button, ErrorNote, Label } from "../lib/ui";

export default function SignIn() {
  const insets = useSafeAreaInsets();
  const { user, ready, signIn } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Focus is the only feedback a text field gives before you submit it, and
  // RN has no `:focus-within`, so the state has to be held rather than styled.
  const [focused, setFocused] = useState<"email" | "password" | null>(null);

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
      <ScrollView
        contentContainerStyle={[
          s.scroll,
          { paddingTop: insets.top + 52, paddingBottom: insets.bottom + 32 },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Brand size={34} />

        <Text style={s.title}>Sign in</Text>
        <Text style={s.sub}>
          The read-only companion. Every control that changes something stays on the web
          app.
        </Text>

        {error ? <ErrorNote message={error} /> : null}

        <View style={s.field}>
          <Label>Work email</Label>
          <TextInput
            style={[s.input, focused === "email" && s.inputOn]}
            value={email}
            onChangeText={setEmail}
            onFocus={() => setFocused("email")}
            onBlur={() => setFocused(null)}
            placeholder="you@company.com"
            placeholderTextColor={T.inkFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            returnKeyType="next"
          />
        </View>

        <View style={s.field}>
          <Label>Password</Label>
          <TextInput
            style={[s.input, focused === "password" && s.inputOn]}
            value={password}
            onChangeText={setPassword}
            onFocus={() => setFocused("password")}
            onBlur={() => setFocused(null)}
            placeholder="Your password"
            placeholderTextColor={T.inkFaint}
            secureTextEntry
            autoCapitalize="none"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={submit}
          />
        </View>

        <View style={s.action}>
          <Button
            label="Sign in"
            onPress={submit}
            disabled={!canSubmit}
            busy={busy ? <ActivityIndicator color={T.paper} /> : undefined}
          />
        </View>

        <View style={s.host}>
          <View style={s.hostDot} />
          <Text style={s.hostText}>{API_URL.replace(/^https?:\/\//, "")}</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.paper },
  scroll: { paddingHorizontal: 24, flexGrow: 1 },

  title: {
    fontFamily: display("700"),
    fontSize: 32,
    letterSpacing: -0.9,
    color: T.ink,
    marginTop: 34,
  },
  sub: {
    fontFamily: body("400"),
    fontSize: 14,
    lineHeight: 21,
    color: T.inkSoft,
    marginTop: 9,
    marginBottom: 28,
    maxWidth: 340,
  },

  field: { marginBottom: 18, gap: 8 },
  input: {
    fontFamily: body("500"),
    backgroundColor: T.card,
    borderWidth: 1,
    borderColor: T.line,
    borderRadius: R.md,
    paddingHorizontal: 15,
    paddingVertical: 14,
    fontSize: 15,
    color: T.ink,
  },
  // Two rings would be cleaner, but a second border reflows the field by a
  // pixel on focus. Colour alone moves nothing.
  inputOn: { borderColor: T.thread, backgroundColor: T.panel },

  action: { marginTop: 10 },

  host: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    marginTop: 26,
  },
  hostDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: T.approve },
  hostText: { fontFamily: mono("400"), fontSize: 11, color: T.inkFaint },
});
