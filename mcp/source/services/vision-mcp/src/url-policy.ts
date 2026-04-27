export function assertAllowedImageUrl(
  rawUrl: string,
  allowedHosts: string[],
  allowAnyImageUrl: boolean,
): URL {
  const parsed = new URL(rawUrl);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only HTTP/HTTPS URLs are supported");
  }

  if (allowAnyImageUrl) {
    return parsed;
  }

  const host = parsed.hostname.toLowerCase();
  const allowed = allowedHosts.some((candidate) => {
    const normalized = candidate.toLowerCase();
    if (normalized.startsWith("*.")) {
      const suffix = normalized.slice(1);
      return host.endsWith(suffix);
    }
    return host === normalized;
  });

  if (!allowed) {
    throw new Error(
      `Host "${parsed.hostname}" is not allowed. Allowed hosts: ${allowedHosts.join(", ")}`,
    );
  }

  return parsed;
}
