import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chaukanna | Anti-Scam Voice Drill Simulator",
  description: "Consented practice scam calls that train Indian families against digital arrest fraud.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full antialiased dark">
      <body className="min-h-full flex flex-col font-sans bg-slate-950 text-slate-100">
        {children}
      </body>
    </html>
  );
}
