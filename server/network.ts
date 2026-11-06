import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as safeFetch } from "undici";
import { ProviderError } from "./contracts.js";
import identity from "../brand/identity.json";
const unavailable = new BlockList();
// Apply each IPv4 refusal to the address embedded in a 6to4 route as well.
// DNS answers and direct URL literals must use the same destination policy.
const ipv4Subnets: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
];
for (const [network, prefix] of ipv4Subnets) {
  unavailable.addSubnet(network, prefix, 'ipv4');
  const [a, b, c, d] = network.split('.').map(Number);
  unavailable.addSubnet(`2002:${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}::`, 16 + prefix, 'ipv6');
}
const ipv6Subnets: [string, number][] = [
  ['2001::', 32], ['2001:2::', 48], ['2001:10::', 28], ['2001:db8::', 32], ['3fff::', 20],
];
for (const [network, prefix] of ipv6Subnets) unavailable.addSubnet(network, prefix, 'ipv6');
const directIPv6 = new BlockList();
directIPv6.addSubnet('2000::', 3, 'ipv6');
directIPv6.addSubnet('::ffff:0:0', 96, 'ipv6');

export function isPublicIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !unavailable.check(ip, 'ipv4');
  return family === 6 && directIPv6.check(ip, 'ipv6') && !unavailable.check(ip, 'ipv6');
}
export function publicUrl(value: string): URL {
  if (/[\\\s\u0000-\u001f\u007f]/u.test(value) || value.startsWith('//'))
    throw new Error("Use an unambiguous public website address");
  const u = new URL(value.includes("://") ? value : "https://" + value);
  if (
    !["https:", "http:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    (u.port && !["80", "443"].includes(u.port))
  )
    throw new Error("Use a public HTTP or HTTPS website");
  const host = u.hostname.replace(/\.$/, "");
  const literal = host.replace(/^\[|\]$/g, "");
  if (
    (!isIP(literal) && !host.includes(".")) || host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    (isIP(literal) && !isPublicIp(literal))
  )
    throw new Error("Private network access is disabled");
  u.hash = "";
  return u;
}
/** Evidence retains its original clickable href. Never repair it as a typed project domain. */
export function isPublicEvidenceUrl(value: string): boolean {
  if (!/^https?:\/\/[^/]/i.test(value)) return false;
  try { publicUrl(value); return true; } catch { return false; }
}
/** A site's apex and www address share crawl scope; other subdomains do not. */
export function sameSiteHost(left: URL, right: URL) {
  return left.hostname.replace(/^www\./, "") === right.hostname.replace(/^www\./, "");
}
export type CrawlPermission = (url: string) => boolean | Promise<boolean>;
export const publicAgent = new Agent({
  connect: {
    lookup: (host, options, callback) => {
      lookup(host, { all: true })
        .then((addresses) => {
          if (
            !addresses.length ||
            addresses.some((a) => !isPublicIp(a.address))
          )
            throw new Error("Private network access is disabled");
          if ((options as any).all) (callback as any)(null, addresses);
          else {
            const a =
              addresses.find(
                (x) => !options.family || x.family === options.family,
              ) || addresses[0];
            callback(null, a.address, a.family);
          }
        })
        .catch((err) => callback(err, "", 4));
    },
  },
});
export async function readLimited(
  response: { body: any },
  max = 2_000_000,
): Promise<string> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const part of response.body) {
    total += part.length;
    if (total > max) {
      await response.body.cancel?.().catch(() => {});
      throw new Error("Response exceeded the safe size limit");
    }
    chunks.push(Buffer.from(part));
  }
  return Buffer.concat(chunks).toString("utf8");
}
/** Busy responses defer the crawl; their HTML is not evidence about the site's content. */
export class CrawlBackoff extends Error {
  constructor(readonly url: string, readonly retryAt?: number) {
    super('The website is busy. Saved pages are preserved while discovery waits.');
  }
}

/** Waiting on another crawl's response does not consume a network retry. */
export class CrawlDeferred extends CrawlBackoff {}

export function crawlRetryAt(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const text = value.trim();
  const at = /^\d+$/.test(text) ? now + Number(text) * 1000 : Date.parse(text);
  return Number.isFinite(at) && at >= 0 && at <= 8.64e15 ? Math.max(now, at) : undefined;
}

export async function crawlFetch(value: string, signal?: AbortSignal, allowed?: CrawlPermission) {
  let u = publicUrl(value);
  for (let i = 0; i < 6; i++) {
    if (allowed && !await allowed(u.href)) throw new Error("The URL is outside the website's permitted crawl scope");
    const r = await safeFetch(u, {
      dispatcher: publicAgent,
      redirect: "manual",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000),
      headers: { "User-Agent": identity.slug + "/0.1 (+local website audit)" },
    });
    if (r.status === 429 || r.status === 503) {
      const retryAt = crawlRetryAt(r.headers.get('retry-after'));
      await r.body?.cancel();
      throw new CrawlBackoff(u.href, retryAt);
    }
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const target = r.headers.get("location");
      await r.body?.cancel();
      if (!target) throw new Error("Invalid redirect");
      u = publicUrl(new URL(target, u).href);
      continue;
    }
    return {
      url: u.href,
      status: r.status,
      contentType: r.headers.get("content-type") ?? "",
      ...(r.headers.has('x-robots-tag') ? { robotsHeader: r.headers.get('x-robots-tag')! } : {}),
      text: await readLimited(r),
    };
  }
  throw new Error("Too many redirects");
}
export async function providerJson(
  url: string,
  init: RequestInit = {},
  timeout = 150000,
): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
    });
  } catch {
    throw new ProviderError(
      "connection_interrupted",
      "The provider connection was interrupted. Review usage before retrying.",
      true,
    );
  }
  const body = await readLimited(response, 10_000_000)
    .then(JSON.parse)
    .catch(() => null);
  if (!response.ok) {
    const problemPrefix = 'https://docs.surfacedby.com/v1/api/errors#';
    const consoleProblem = url.startsWith('https://api.surfacedby.com/api/v1/console/') &&
      typeof body?.type === 'string' && body.type.startsWith(problemPrefix) ? body.type.slice(problemPrefix.length) : undefined;
    const rawCode = consoleProblem ?? (typeof body?.error === "string" ? body.error : body?.error?.code ?? body?.error?.type);
    const code = typeof rawCode === "string" && /^[a-z_]{1,100}$/.test(rawCode) ? rawCode : undefined;
    const quota =
      response.status === 429 ||
      code === "subscription_sharing_usage_limit_exceeded";
    throw new ProviderError(
      quota ? "quota" : response.status === 401 ? "auth" : "provider",
      quota
        ? "Provider usage limit reached. Work is paused."
        : response.status === 401
          ? "Reconnect this provider."
          : "Provider rejected this request. Check its account and capabilities.",
      response.status >= 500,
      code,
      response.status,
    );
  }
  if (!body)
    throw new ProviderError(
      "invalid_response",
      "Provider returned an unreadable response.",
      true,
    );
  return body;
}
