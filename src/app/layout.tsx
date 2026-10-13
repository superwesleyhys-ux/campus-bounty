import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Campus Bounty · Opportunities and finds on campus",
  description:
    "Bounties and a marketplace for U.S. university communities. Local demo.",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
