import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://babcord.withermask.net"),
  title: "Babcord — school communication, clearly organized",
  description:
    "A private, self-hosted community messenger for servers, channels, direct messages, discovery, and accountable moderation.",
  openGraph: {
    title: "Babcord",
    description: "School communication, clearly organized.",
    type: "website",
    images: [{ url: "/og.png", width: 1731, height: 909, alt: "Babcord messaging interface" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Babcord",
    description: "School communication, clearly organized.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
