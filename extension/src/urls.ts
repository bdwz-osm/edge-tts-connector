/** Refuse activate on privileged / PDF-ish URLs (.spec/extension.md). */

const BLOCKED_PREFIXES = [
  "chrome:",
  "chrome-extension:",
  "chrome-search:",
  "chrome-devtools:",
  "devtools:",
  "about:",
  "edge:",
  "edge-extension:",
  "moz-extension:",
  "view-source:",
  "data:",
  "blob:",
  "file:",
];

const BLOCKED_HOSTS = [
  "chrome.google.com",
  "addons.mozilla.org",
  "microsoftedge.microsoft.com",
];

export function isRestrictedUrl(url: string | undefined | null): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  for (const p of BLOCKED_PREFIXES) {
    if (lower.startsWith(p)) return true;
  }
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return true;
    if (BLOCKED_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) {
      return true;
    }
    if (u.pathname.toLowerCase().endsWith(".pdf")) return true;
    if (u.hostname === "docs.google.com" && u.pathname.includes("/viewer")) {
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

export function restrictedReason(url: string | undefined | null): string {
  if (!url) return "No active tab URL";
  if (url.toLowerCase().endsWith(".pdf") || url.includes("pdf")) {
    return "PDF / privileged pages are not supported";
  }
  return "This page cannot be read (privileged or restricted URL)";
}
