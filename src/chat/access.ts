/**
 * The chat host listens on localhost, but any web page the user visits can still try to
 * open ws://127.0.0.1. Browsers always send Origin, so an allowlist keeps other sites from
 * driving Claude or reading the live PCB through the panel.
 */

export const DEFAULT_ALLOWED_ORIGINS = [
  "https://pro.easyeda.com",
  "https://pro.lceda.cn",
  "https://easyeda.com",
  "https://lceda.cn"
];

export type AccessPolicy = {
  allowAnyOrigin: boolean;
  allowedOrigins: Set<string>;
};

export function createAccessPolicy(port: number, env: Record<string, string | undefined> = process.env): AccessPolicy {
  const extra = (env.EASYEDA_CHAT_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return {
    allowAnyOrigin: extra.includes("*"),
    allowedOrigins: new Set([
      ...DEFAULT_ALLOWED_ORIGINS,
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      ...extra.filter((origin) => origin !== "*")
    ])
  };
}

/** `undefined` origin means a non-browser client on this machine (for example Claude Code itself). */
export function isOriginAllowed(policy: AccessPolicy, origin: string | undefined): boolean {
  if (origin === undefined) {
    return true;
  }
  return policy.allowAnyOrigin || policy.allowedOrigins.has(origin);
}

/** Rejects DNS-rebinding requests whose Host header is not this loopback listener. */
export function isLoopbackHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) {
    return false;
  }
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(hostHeader.toLowerCase());
}
