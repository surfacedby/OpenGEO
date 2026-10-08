import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as safeFetch } from "undici";
import { ProviderError } from "./contracts.js";
import identity from "../brand/identity.json";
export function isPublicIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0) ||
      a >= 224 ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPublicIp(v.slice(7));
    return v.startsWith("2") || v.startsWith("3");
  }
  return false;
}
export function publicUrl(value: string): URL {
  const u = new URL(value.includes("://") ? value : "https://" + value);
  if (
    !["https:", "http:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    (u.port && !["80", "443"].includes(u.port))
  )
    throw new Error("Use a public HTTP or HTTPS website");
  if (
    u.hostname === "localhost" ||
    u.hostname.endsWith(".local") ||
    (isIP(u.hostname.replace(/[\[\]]/g, "")) &&
      !isPublicIp(u.hostname.replace(/[\[\]]/g, "")))
  )
    throw new Error("Private network access is disabled");
  u.hash = "";
  return u;
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
    const rawCode = typeof body?.error === "string" ? body.error : body?.error?.code ?? body?.error?.type;
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
