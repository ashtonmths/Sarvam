export const metadata = {
  title: "Ariadne",
  description: "The change intelligence layer for business operations",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
