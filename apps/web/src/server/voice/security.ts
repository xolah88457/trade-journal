import { verifySession, AUTH_COOKIE } from "../auth";

const ALLOWED_LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface ParsedLoopbackAuthority {
  hostname: string;
  port: number | null;
}

/**
 * Strictly parses a direct Host header authority:
 * - Direct Host only (no x-forwarded-host fallback)
 * - Strict canonical allowed loopback hostnames: 127.0.0.1, localhost, [::1], ::1
 * - Optional valid integer port (1-65535)
 * - Strictly rejects userinfo (@), paths (/), query (?), fragments (#), and non-loopback DNS lookalikes
 */
export function parseLoopbackHost(hostHeader: string | null): ParsedLoopbackAuthority | null {
  if (!hostHeader) return null;
  const trimmed = hostHeader.trim();
  if (
    !trimmed ||
    trimmed.includes("@") ||
    trimmed.includes("/") ||
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    trimmed.includes("\\")
  ) {
    return null;
  }

  let hostname: string;
  let port: number | null = null;

  if (trimmed.startsWith("[")) {
    // IPv6 authority: [::1] or [::1]:port
    const closeBracket = trimmed.indexOf("]");
    if (closeBracket === -1) return null;
    hostname = trimmed.slice(0, closeBracket + 1);
    const rest = trimmed.slice(closeBracket + 1);
    if (rest) {
      if (!rest.startsWith(":")) return null;
      const portStr = rest.slice(1);
      if (!/^\d{1,5}$/.test(portStr)) return null;
      port = parseInt(portStr, 10);
      if (port < 1 || port > 65535) return null;
    }
  } else {
    // IPv4 or named hostname: 127.0.0.1, 127.0.0.1:port, localhost, localhost:port
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex !== -1) {
      // Must not contain multiple colons unless enclosed IPv6
      if (trimmed.indexOf(":", colonIndex + 1) !== -1) return null;
      hostname = trimmed.slice(0, colonIndex);
      const portStr = trimmed.slice(colonIndex + 1);
      if (!/^\d{1,5}$/.test(portStr)) return null;
      port = parseInt(portStr, 10);
      if (port < 1 || port > 65535) return null;
    } else {
      hostname = trimmed;
    }
  }

  hostname = hostname.toLowerCase();
  if (!ALLOWED_LOOPBACK_HOSTNAMES.has(hostname)) {
    return null;
  }

  return { hostname, port };
}

/**
 * Validates direct loopback authority, cross-origin/rebinding security, and optional session auth.
 */
export function checkSameOrigin(request: Request): {
  ok: boolean;
  status: number;
  reason?: string;
} {
  // 1. Cross-site fetch block
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite === "cross-site") {
    return { ok: false, status: 403, reason: "Cross-site requests are forbidden." };
  }

  // 2. Strict direct Host authority validation (never use x-forwarded-host)
  const hostHeader = request.headers.get("host");
  const parsedHost = parseLoopbackHost(hostHeader);
  if (!parsedHost) {
    return {
      ok: false,
      status: 403,
      reason: "Direct loopback Host authority (127.0.0.1/localhost/[::1]) is required.",
    };
  }

  // 3. Strict Origin header validation when present
  const originHeader = request.headers.get("origin");
  if (originHeader) {
    if (
      originHeader.includes("@") ||
      originHeader.includes("?") ||
      originHeader.includes("#") ||
      originHeader.includes("\\")
    ) {
      return { ok: false, status: 403, reason: "Malformed Origin authority." };
    }

    let originUrl: URL;
    try {
      originUrl = new URL(originHeader);
    } catch {
      return { ok: false, status: 403, reason: "Malformed Origin header." };
    }

    if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
      return { ok: false, status: 403, reason: "Forbidden Origin scheme." };
    }

    // Origin protocol must match request URL protocol
    if (request.url) {
      try {
        const requestUrl = new URL(request.url);
        if (originUrl.protocol !== requestUrl.protocol) {
          return { ok: false, status: 403, reason: "Origin protocol mismatch." };
        }
      } catch {}
    }

    // Reject Origin path other than '/' (browser Origin never contains path)
    if (originUrl.pathname !== "/" && originUrl.pathname !== "") {
      return { ok: false, status: 403, reason: "Forbidden Origin path." };
    }

    if (originUrl.username || originUrl.password || originUrl.search || originUrl.hash) {
      return { ok: false, status: 403, reason: "Forbidden Origin components." };
    }

    const originHostname = originUrl.hostname.toLowerCase();
    const normalizedOriginHost = originHostname === "::1" ? "[::1]" : originHostname;
    const normalizedTargetHost = parsedHost.hostname === "::1" ? "[::1]" : parsedHost.hostname;

    // Reject non-loopback origins
    if (
      !ALLOWED_LOOPBACK_HOSTNAMES.has(originHostname) &&
      !ALLOWED_LOOPBACK_HOSTNAMES.has(normalizedOriginHost)
    ) {
      return { ok: false, status: 403, reason: "Forbidden non-loopback Origin." };
    }

    // Strict same-origin requires exact host match (no localhost <-> 127 alias fallback)
    if (normalizedOriginHost !== normalizedTargetHost) {
      return { ok: false, status: 403, reason: "Origin and Host mismatch." };
    }

    // Port must match
    const originPort = originUrl.port
      ? parseInt(originUrl.port, 10)
      : originUrl.protocol === "https:"
        ? 443
        : 80;
    const hostPort = parsedHost.port ?? (originUrl.protocol === "https:" ? 443 : 80);

    if (originPort !== hostPort) {
      return { ok: false, status: 403, reason: "Origin port mismatch." };
    }
  }

  // 4. Session authentication when JOURNAL_PASSWORD is set
  if (process.env.JOURNAL_PASSWORD) {
    const cookieHeader = request.headers.get("cookie");
    if (!cookieHeader) {
      return { ok: false, status: 401, reason: "Unauthorized." };
    }

    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]*)`));
    if (!match || !match[1]) {
      return { ok: false, status: 401, reason: "Unauthorized." };
    }

    let token: string;
    try {
      token = decodeURIComponent(match[1]);
    } catch {
      // Malformed percent-encoding must return 400 Bad Request, never 500
      return { ok: false, status: 400, reason: "Malformed cookie header." };
    }

    if (!verifySession(token)) {
      return { ok: false, status: 401, reason: "Unauthorized." };
    }
  }

  return { ok: true, status: 200 };
}
