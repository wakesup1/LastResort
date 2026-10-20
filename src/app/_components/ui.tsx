import type { ReactNode } from "react";

type IconName = "asterisk" | "arrow" | "back" | "refresh" | "ticket" | "info" | "warning" | "monitor";

export function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    asterisk: <path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" />,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    back: <path d="M20 12H4m6-6-6 6 6 6" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.2 6.2A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.8 5.8" /></>,
    ticket: <><path d="M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4V5Z" /><path d="M15 5v2m0 3v4m0 3v2" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.1" /></>,
    warning: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5m0 3v.1" /></>,
    monitor: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M12 17v4m-4 0h8" /></>,
  };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

export function StatusBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: "success" | "warning" | "neutral" }) {
  return <span className={`status-badge tone-${tone}`}><span className="status-dot" aria-hidden="true" />{children}</span>;
}

export function Notice({ title, children, tone = "info" }: { title: string; children: ReactNode; tone?: "info" | "warning" }) {
  return <div className={`notice tone-${tone}`}><Icon name={tone === "warning" ? "warning" : "info"} /><div><p className="notice-title">{title}</p><p>{children}</p></div></div>;
}
