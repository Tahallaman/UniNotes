/**
 * Every Panopto URL the tool builds, derived from one configured host.
 *
 * Panopto is multi-tenant: each institution gets its own hostname, but the paths
 * underneath (`/Panopto/Pages/...`, `/Panopto/Podcast/...`) are identical on
 * every tenant. So the host is the only thing worth asking a new user for, and
 * deriving the rest removes the class of bug where the listing page points at
 * one institution and the download template at another.
 *
 * Kept out of config.ts because it reads the environment: config.ts describes
 * *defaults*, and the control panel needs those to stay a pure literal so it can
 * tell an override from a default.
 */

import { CONFIG } from "../../config.js";

/** Thrown instead of letting a request go out against an empty hostname. */
export class PanoptoNotConfiguredError extends Error {
  constructor() {
    super(
      "No Panopto site configured. Set panopto.baseUrl in config.ts (or the " +
        "UNINOTES_PANOPTO_URL environment variable, or Settings → Institution in " +
        "the control panel) to your institution's Panopto address, e.g. " +
        "https://yourschool.hosted.panopto.com — it's the first part of the URL " +
        "you see when watching a recording.",
    );
    this.name = "PanoptoNotConfiguredError";
  }
}

/** Configured host with any trailing slash removed. Empty when unset. */
export function panoptoBaseUrl(): string {
  const raw = process.env.UNINOTES_PANOPTO_URL || CONFIG.panopto.baseUrl;
  return raw.trim().replace(/\/+$/, "");
}

export function isPanoptoConfigured(): boolean {
  return panoptoBaseUrl().length > 0;
}

function requireBaseUrl(): string {
  const base = panoptoBaseUrl();
  if (base.length === 0) throw new PanoptoNotConfiguredError();
  return base;
}

/** The "subscriptions" listing the scraper reads new lectures from. */
export function subscriptionsUrl(): string {
  return requireBaseUrl() + CONFIG.panopto.subscriptionsPath;
}

/** Watch page for one recording — used as the download request's Referer. */
export function viewerUrl(id: string): string {
  return `${requireBaseUrl()}/Panopto/Pages/Viewer.aspx?id=${id}`;
}

/** Direct MP4 podcast URL for one recording. */
export function downloadUrl(id: string): string {
  return `${requireBaseUrl()}/Panopto/Podcast/Social/${id}.mp4?mediaTargetType=videoPodcast`;
}

/**
 * Is this URL a signed-in Panopto app page (rather than the SSO redirect chain)?
 *
 * Used by the auth flow to decide when the session is worth saving. Compares
 * hostnames rather than substrings so a lookalike host on the redirect chain
 * can't satisfy it.
 */
export function isPanoptoAppUrl(url: string): boolean {
  const base = panoptoBaseUrl();
  if (base.length === 0) return false;
  try {
    const seen = new URL(url);
    const expected = new URL(base);
    return seen.host === expected.host && seen.pathname.startsWith("/Panopto/Pages");
  } catch {
    return false;
  }
}
