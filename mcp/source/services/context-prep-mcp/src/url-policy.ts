import { lookup } from "node:dns/promises";
import net from "node:net";
import { ContextPrepConfig } from "./config.js";

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return false;
  }

  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized === "::"
  );
}

function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    return isPrivateIpv4(address);
  }
  if (version === 6) {
    return isPrivateIpv6(address);
  }
  return false;
}

export async function assertSafePublicUrl(rawUrl: string, config: ContextPrepConfig): Promise<URL> {
  const parsed = new URL(rawUrl);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  if (!config.allowAnyUrl && !config.allowedHosts.includes(parsed.hostname)) {
    throw new Error(`Host is not in CONTEXT_PREP_ALLOWED_HOSTS: ${parsed.hostname}`);
  }

  if (config.allowPrivateUrls) {
    return parsed;
  }

  const literalIpVersion = net.isIP(parsed.hostname);
  if (literalIpVersion && isPrivateAddress(parsed.hostname)) {
    throw new Error(`Blocked private URL host: ${parsed.hostname}`);
  }

  const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
  const privateAddress = addresses.find((item) => isPrivateAddress(item.address));
  if (privateAddress) {
    throw new Error(`Blocked URL resolving to private address: ${parsed.hostname}`);
  }

  return parsed;
}
