/**
 * The type system, transcribed from the web app's three families so a screen
 * looks the same on a phone as it does in a browser.
 *
 * - Schibsted Grotesk — display. Headings, screen titles, the wordmark.
 * - Instrument Sans — body. Everything you read in a sentence.
 * - IBM Plex Mono — data. Counts, durations, timestamps, hostnames.
 *
 * React Native has no `fontWeight` synthesis for custom families: asking for
 * `fontWeight: "700"` on a face loaded as Regular renders Regular, or on
 * Android renders a smeared fake bold. So weight is part of the family name
 * and these helpers are the only way to spell it.
 */

export type DisplayWeight = "500" | "600" | "700" | "800";
export type BodyWeight = "400" | "500" | "600" | "700";
export type MonoWeight = "400" | "500" | "600";

const DISPLAY: Record<DisplayWeight, string> = {
  "500": "SchibstedGrotesk_500Medium",
  "600": "SchibstedGrotesk_600SemiBold",
  "700": "SchibstedGrotesk_700Bold",
  "800": "SchibstedGrotesk_800ExtraBold",
};

const BODY: Record<BodyWeight, string> = {
  "400": "InstrumentSans_400Regular",
  "500": "InstrumentSans_500Medium",
  "600": "InstrumentSans_600SemiBold",
  "700": "InstrumentSans_700Bold",
};

const MONO: Record<MonoWeight, string> = {
  "400": "IBMPlexMono_400Regular",
  "500": "IBMPlexMono_500Medium",
  "600": "IBMPlexMono_600SemiBold",
};

export const display = (weight: DisplayWeight = "700") => DISPLAY[weight];
export const body = (weight: BodyWeight = "400") => BODY[weight];
export const mono = (weight: MonoWeight = "400") => MONO[weight];

/**
 * Every face this app loads, in the shape `useFonts` wants. Kept here rather
 * than in the layout so adding a weight is a one-file change.
 */
export const FONT_MAP = {
  SchibstedGrotesk_500Medium: require("@expo-google-fonts/schibsted-grotesk/500Medium/SchibstedGrotesk_500Medium.ttf"),
  SchibstedGrotesk_600SemiBold: require("@expo-google-fonts/schibsted-grotesk/600SemiBold/SchibstedGrotesk_600SemiBold.ttf"),
  SchibstedGrotesk_700Bold: require("@expo-google-fonts/schibsted-grotesk/700Bold/SchibstedGrotesk_700Bold.ttf"),
  SchibstedGrotesk_800ExtraBold: require("@expo-google-fonts/schibsted-grotesk/800ExtraBold/SchibstedGrotesk_800ExtraBold.ttf"),
  InstrumentSans_400Regular: require("@expo-google-fonts/instrument-sans/400Regular/InstrumentSans_400Regular.ttf"),
  InstrumentSans_500Medium: require("@expo-google-fonts/instrument-sans/500Medium/InstrumentSans_500Medium.ttf"),
  InstrumentSans_600SemiBold: require("@expo-google-fonts/instrument-sans/600SemiBold/InstrumentSans_600SemiBold.ttf"),
  InstrumentSans_700Bold: require("@expo-google-fonts/instrument-sans/700Bold/InstrumentSans_700Bold.ttf"),
  IBMPlexMono_400Regular: require("@expo-google-fonts/ibm-plex-mono/400Regular/IBMPlexMono_400Regular.ttf"),
  IBMPlexMono_500Medium: require("@expo-google-fonts/ibm-plex-mono/500Medium/IBMPlexMono_500Medium.ttf"),
  IBMPlexMono_600SemiBold: require("@expo-google-fonts/ibm-plex-mono/600SemiBold/IBMPlexMono_600SemiBold.ttf"),
} as const;

/**
 * Type ramp. Sizes and tracking are paired here rather than at each call site,
 * because the two move together — the larger the size, the tighter the track —
 * and getting that relationship right in twelve places by hand does not happen.
 */
export const TYPE = {
  /** Screen title. One per screen, at the top. */
  title: { fontFamily: display("700"), fontSize: 27, letterSpacing: -0.7 },
  /** Card and section heading. */
  heading: { fontFamily: display("600"), fontSize: 16, letterSpacing: -0.2 },
  /** The one big number on a card. */
  figure: { fontFamily: display("700"), fontSize: 27, letterSpacing: -0.8 },
  /** Row titles and anything that names a thing. */
  strong: { fontFamily: body("600"), fontSize: 14, letterSpacing: -0.1 },
  /** Running text. */
  body: { fontFamily: body("400"), fontSize: 14, lineHeight: 20 },
  /** Secondary text under a title. */
  caption: { fontFamily: body("400"), fontSize: 12.5, lineHeight: 18 },
  /** The all-caps micro-label above a value or field. */
  label: { fontFamily: mono("500"), fontSize: 9.5, letterSpacing: 1.1 },
  /** Counts, durations, timestamps. Anything the eye scans as data. */
  data: { fontFamily: mono("400"), fontSize: 11.5, letterSpacing: -0.1 },
} as const;
