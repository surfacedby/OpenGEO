import { fetch as safeFetch } from "undici";
import { publicAgent, publicUrl } from "./network.js";

export type SiteIcon = { bytes: Buffer; contentType: string };
type FetchIcon = (
  url: URL,
  signal: AbortSignal,
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  body: (AsyncIterable<Uint8Array> & { cancel?(): Promise<void> }) | null;
}>;
const request: FetchIcon = (url, signal) =>
  safeFetch(url, {
    dispatcher: publicAgent,
    redirect: "manual",
    signal,
    headers: {
      "User-Agent": "Local website icon request",
      Accept: "image/png,image/x-icon,image/vnd.microsoft.icon",
    },
  });

/** Only bounded raster icons are returned; active SVG/HTML and credential-bearing URLs never reach the renderer. */
export function rasterIcon(bytes: Buffer): SiteIcon | null {
  if (bytes.length < 24 || bytes.length > 131072) return null;
  if (
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  ) {
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 && width <= 512 && height <= 512
      ? { bytes, contentType: "image/png" }
      : null;
  }
  if (bytes.readUInt32LE(0) !== 65536) return null;
  const count = bytes.readUInt16LE(4);
  if (!count || count > 16 || bytes.length < 6 + count * 16) return null;
  for (let i = 0; i < count; i++) {
    const offset = 6 + i * 16,
      size = bytes.readUInt32LE(offset + 8),
      start = bytes.readUInt32LE(offset + 12);
    if (!size || start < 6 + count * 16 || start + size > bytes.length)
      return null;
  }
  return { bytes, contentType: "image/vnd.microsoft.icon" };
}

/** Fetch directly from a known website, with the crawler's DNS protections and no third-party favicon service. */
export class SiteIcons {
  private cache = new Map<string, { until: number; icon: SiteIcon | null }>();
  private pending = new Map<string, Promise<SiteIcon | null>>();
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private fetcher: FetchIcon = request) {}
  async get(domain: string): Promise<SiteIcon | null> {
    const url = publicUrl("https://" + domain + "/favicon.ico");
    if (
      url.hostname !== domain ||
      url.search ||
      url.pathname !== "/favicon.ico"
    )
      throw new Error("Invalid icon domain");
    const cached = this.cache.get(domain);
    if (cached && cached.until > Date.now()) return cached.icon;
    if (this.pending.has(domain)) return this.pending.get(domain)!;
    // Queue decorative requests so large result tables remain usable with bounded sockets.
    const task = (async () => {
      if (this.active >= 8)
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      else this.active++;
      return this.load(url).catch(() => null);
    })()
      .then((icon) => {
        this.cache.delete(domain);
        this.cache.set(domain, {
          until: Date.now() + (icon ? 86400000 : 7200000),
          icon,
        });
        while (this.cache.size > 256)
          this.cache.delete(this.cache.keys().next().value!);
        return icon;
      })
      .finally(() => {
        const next = this.waiters.shift();
        if (next) next();
        else this.active--;
        this.pending.delete(domain);
      });
    this.pending.set(domain, task);
    return task;
  }
  private async load(initial: URL) {
    let url = initial;
    const signal = AbortSignal.timeout(3500);
    for (let i = 0; i < 3; i++) {
      const response = await this.fetcher(url, signal);
      try {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          const next = location ? publicUrl(new URL(location, url).href) : null;
          if (
            !next ||
            next.hostname.replace(/^www\./, "") !==
              initial.hostname.replace(/^www\./, "")
          )
            return null;
          url = next;
          continue;
        }
        if (response.status !== 200 || !response.body) return null;
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of response.body) {
          length += chunk.length;
          if (length > 131072) return null;
          chunks.push(Buffer.from(chunk));
        }
        return rasterIcon(Buffer.concat(chunks));
      } finally {
        await response.body?.cancel?.().catch(() => {});
      }
    }
    return null;
  }
}
