import { useEffect, useRef } from "react";
import { Animated, Easing, Image, StyleSheet, Text, View } from "react-native";
import { T } from "./theme";
import { body, display } from "./type";

/**
 * The brand, in three pieces.
 *
 * The mark is the labyrinth from the web app's `public/logo.png`, copied into
 * `assets/` rather than fetched — a 192px PNG bundles smaller than the round
 * trip costs, and a logo that arrives late is worse than one that ships.
 *
 * The wordmark is साधक. It is deliberately *not* given a `fontFamily`:
 * Schibsted Grotesk has no Devanagari coverage, so naming it would fall the
 * glyphs back to the system face anyway on iOS and risk tofu on older Android.
 * Letting the platform pick its own Devanagari is the reliable spelling of the
 * same result.
 */

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <Image
      source={require("../assets/logo.png")}
      style={{ width: size, height: size, borderRadius: size * 0.24 }}
      accessibilityIgnoresInvertColors
      // Decorative: the wordmark beside it already carries the name, and a
      // screen reader announcing "logo, Sadhak" reads the brand twice.
      accessible={false}
      alt=""
    />
  );
}

/** Mark + wordmark, the lockup used in headers and on the sign-in screen. */
export function Brand({
  size = 28,
  tone = "ink",
}: {
  size?: number;
  /** `paper` inverts the wordmark for use on a dark surface. */
  tone?: "ink" | "paper";
}) {
  return (
    <View style={s.lockup} accessibilityRole="header" accessibilityLabel="Sadhak">
      <LogoMark size={size} />
      <Text
        style={[
          s.wordmark,
          { fontSize: size * 0.72, color: tone === "paper" ? T.paper : T.ink },
        ]}
      >
        साधक
      </Text>
    </View>
  );
}

/**
 * The gate screen, shown while the keychain is read and the session checked.
 *
 * This replaced an `ActivityIndicator` captioned "SADHAK", which read as a
 * loading state that had lost its label. A brand hold is the same wait dressed
 * as an intention: the mark breathes, so the screen is visibly alive without
 * a spinner claiming progress it cannot measure.
 */
export function BrandGate({ caption }: { caption?: string }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] });

  return (
    <View style={s.gate}>
      <Animated.View style={{ transform: [{ scale }], opacity }}>
        <LogoMark size={56} />
      </Animated.View>
      <Text style={s.gateWord}>साधक</Text>
      {caption ? <Text style={s.gateCaption}>{caption}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  lockup: { flexDirection: "row", alignItems: "center", gap: 9 },
  wordmark: {
    // No fontFamily on purpose — see the note at the top of this file.
    fontWeight: "600",
    letterSpacing: -0.2,
    // Devanagari sits high in its em box; this pulls the word onto the mark's
    // optical centre instead of leaving it floating above.
    marginTop: 2,
  },

  gate: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14 },
  gateWord: { fontSize: 21, fontWeight: "600", color: T.ink, letterSpacing: -0.2 },
  gateCaption: {
    fontFamily: body("400"),
    fontSize: 12.5,
    color: T.inkFaint,
    marginTop: -6,
  },
});

/**
 * Screen header. Every tab screen opened with its own hand-rolled title and
 * subtitle pair, four copies of the same two `Text`s with the same three
 * numbers — which is how they drifted apart by a point and a half. One
 * component, so they cannot.
 */
export function ScreenHead({
  title,
  subtitle,
  right,
  brand,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  /** Show the lockup above the title. The first tab only. */
  brand?: boolean;
}) {
  return (
    <View style={h.wrap}>
      {brand ? (
        <View style={h.brandRow}>
          <Brand size={24} />
        </View>
      ) : null}
      {/*
        `right` sits on the title's own line rather than beside the whole text
        block. Aligned to the block, it floated down next to the subtitle and
        read as belonging to the sentence instead of to the heading.
      */}
      <View style={h.row}>
        <Text
          style={h.title}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.8}
        >
          {title}
        </Text>
        {right}
      </View>
      {subtitle ? <Text style={h.sub}>{subtitle}</Text> : null}
    </View>
  );
}

const h = StyleSheet.create({
  wrap: { marginBottom: 18 },
  brandRow: { marginBottom: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  title: {
    flex: 1,
    minWidth: 0,
    fontFamily: display("700"),
    fontSize: 27,
    letterSpacing: -0.7,
    color: T.ink,
  },
  sub: {
    fontFamily: body("400"),
    fontSize: 12.5,
    lineHeight: 18,
    color: T.inkFaint,
    marginTop: 5,
  },
});
