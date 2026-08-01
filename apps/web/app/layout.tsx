import type { Metadata } from "next";
import { IBM_Plex_Mono, Instrument_Sans, Schibsted_Grotesk } from "next/font/google";
import "./globals.css";

const display = Schibsted_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-schibsted",
});

const body = Instrument_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-instrument",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://sadhak.online"),
  title: {
    default: "Sadhak. See the blast radius before you break it.",
    template: "%s | Sadhak",
  },
  description:
    "Sadhak keeps a living dependency graph of your automations, data and APIs, fused with the human reasoning behind every connection, and gates the changes that would break them.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
