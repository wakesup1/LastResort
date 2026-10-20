import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const spaceGrotesk = localFont({
  src: "./fonts/space-grotesk-variable.ttf",
  variable: "--font-space-grotesk",
  weight: "300 700",
  display: "swap",
  fallback: ["Arial", "sans-serif"],
});

export const metadata: Metadata = { title: "LastResort", description: "Ticket booking for a demo event." };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={spaceGrotesk.variable}><body>{children}</body></html>;
}
