import { lookup } from "node:dns/promises";
import net from "node:net";

import type { SourceDescriptor } from "./contracts";

export class SourceAccessError extends Error {
  readonly code = "SOURCE_ACCESS_REJECTED";

  constructor(message = "The requested source URL is not permitted.") {
    super(message);
    this.name = "SourceAccessError";
  }
}

export type AddressResolver = (hostname: string) => Promise<string[]>;

export const resolvePublicAddresses: AddressResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((address) => address.address);
};

export function isPublicInternetAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const [first, second] = address.split(".").map(Number);
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      first >= 224 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127)
    );
  }

  if (family === 6) {
    const normalized = address.toLowerCase();
    return !(
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  }

  return false;
}

function assertAllowedUrl(url: URL, source: SourceDescriptor): void {
  if (url.protocol !== "https:") {
    throw new SourceAccessError();
  }

  if (url.port && url.port !== "443") {
    throw new SourceAccessError();
  }

  if (!source.allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new SourceAccessError();
  }

  if (net.isIP(url.hostname) !== 0) {
    throw new SourceAccessError();
  }
}

export async function assertApprovedSourceUrl(
  value: string,
  source: SourceDescriptor,
  resolveAddresses: AddressResolver = resolvePublicAddresses,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SourceAccessError();
  }

  assertAllowedUrl(url, source);
  const addresses = await resolveAddresses(url.hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicInternetAddress(address))) {
    throw new SourceAccessError();
  }

  return url;
}

/**
 * Validate a URL returned by an observable web-search result before it can be
 * stored as product provenance. This intentionally does not grant browser
 * navigation permission; callers must still apply a separate navigation
 * policy if they fetch the page.
 */
export async function assertObservedWebUrl(
  value: string,
  resolveAddresses: AddressResolver = resolvePublicAddresses,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SourceAccessError();
  }

  if (
    url.protocol !== "https:" ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password ||
    net.isIP(url.hostname) !== 0 ||
    !url.hostname.includes(".")
  ) {
    throw new SourceAccessError();
  }

  const addresses = await resolveAddresses(url.hostname.toLowerCase());
  if (addresses.length === 0 || addresses.some((address) => !isPublicInternetAddress(address))) {
    throw new SourceAccessError();
  }

  return url;
}

export function isAllowedBrowserRequest(value: string, source: SourceDescriptor): boolean {
  try {
    assertAllowedUrl(new URL(value), source);
    return true;
  } catch {
    return false;
  }
}
