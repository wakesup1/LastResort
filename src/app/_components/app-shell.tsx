import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "./ui.tsx";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="site-header"><Link className="wordmark" href="/" aria-label="LastResort event"><Icon name="asterisk" /><span>LASTRESORT</span></Link><nav className="site-nav" aria-label="Main navigation"><Link href="/history">My bookings</Link><span className="demo-label">DEMO EVENT</span></nav></header>
      <main className="main-content" id="main-content" tabIndex={-1}>{children}</main>
      <footer className="site-footer"><span>LASTRESORT / FICTIONAL EVENT</span><span>Bangkok time · UTC+7</span></footer>
    </div>
  );
}
