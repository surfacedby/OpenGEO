import { fetch as safeFetch } from "undici";
import { publicAgent, publicUrl } from "./network.js";
import { load } from "cheerio";

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
      Accept: "image/png,image/webp,image/x-icon,image/vnd.microsoft.icon,text/html;q=0.5",
    },
  });

/** Only bounded raster icons are returned; active SVG/HTML and credential-bearing URLs never reach the renderer. */
export function rasterIcon(bytes: Buffer): SiteIcon | null {
  if (bytes.length < 24 || bytes.length > 131072) return null;
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) return null;
    let image = false, canvas: [number, number] | undefined;
    for (let offset = 12; offset < bytes.length;) {
      if (offset + 8 > bytes.length) return null;
      const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
      const end = start + length + (length % 2);
      if (end > bytes.length || (length % 2 && bytes[end - 1] !== 0)) return null;
      let dimensions: [number, number] | undefined;
      if (type === 'VP8X') {
        if (offset !== 12 || length !== 10 || (bytes[start] & 2)) return null;
        canvas = dimensions = [bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1];
      } else if (type === 'VP8L') {
        if (image || length < 5 || bytes[start] !== 47) return null;
        const bits = bytes.readUInt32LE(start + 1);
        if (bits >>> 29) return null;
        image = true; dimensions = [(bits & 16383) + 1, ((bits >>> 14) & 16383) + 1];
      } else if (type === 'VP8 ') {
        if (image || length < 10 || (bytes[start] & 1) || !bytes.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42]))) return null;
        image = true; dimensions = [bytes.readUInt16LE(start + 6) & 16383, bytes.readUInt16LE(start + 8) & 16383];
      } else if (type === 'ANIM' || type === 'ANMF') return null;
      if (dimensions && (dimensions.some(value => value < 1 || value > 512) || (canvas && image && dimensions.some((value, index) => value !== canvas![index])))) return null;
      offset = end;
    }
    return image ? { bytes, contentType: 'image/webp' } : null;
  }
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
    const signal = AbortSignal.timeout(5000);
    const direct = await this.read(initial, signal);
    if (!direct) return null;
    const icon = direct?.status === 200 ? rasterIcon(direct.bytes) : null;
    if (icon) return icon;
    const home = await this.read(new URL('/', initial), signal, true);
    if (!home || home.status !== 200) return null;
    const $ = load(home.bytes.toString('utf8'));
    const candidates = new Set<string>();
    for (const element of $('link[rel]').toArray()) {
      const rel = $(element).attr('rel')?.toLowerCase().split(/\s+/) ?? [];
      if (!rel.includes('icon') && !rel.includes('apple-touch-icon')) continue;
      try {
        const candidate = publicUrl(new URL($(element).attr('href') ?? '', home.url).href);
        if (candidate.hostname.replace(/^www\./, '') !== initial.hostname.replace(/^www\./, '') || candidate.href === initial.href) continue;
        candidates.add(candidate.href);
      } catch { /* Invalid page links cannot authorize icon requests. */ }
    }
    const ordered = [...candidates].sort((a, b) => Number(/\.svg(?:$|\?)/i.test(a)) - Number(/\.svg(?:$|\?)/i.test(b)));
    for (const candidate of ordered.slice(0, 4)) {
      const response = await this.read(new URL(candidate), signal);
      const icon = response?.status === 200 ? rasterIcon(response.bytes) : null;
      if (icon) return icon;
    }
    return null;
  }
  /** Website metadata can name a raster icon, but cannot redirect decorative requests to another host. */
  private async read(initial: URL, signal: AbortSignal, html = false) {
    let url = initial;
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
        if (response.status !== 200) return { status: response.status, bytes: Buffer.alloc(0), url };
        if (!response.body) return null;
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of response.body) {
          length += chunk.length;
          if (length > 131072) {
            if (!html) return null;
            chunks.push(Buffer.from(chunk).subarray(0, 131072 - (length - chunk.length)));
            break;
          }
          chunks.push(Buffer.from(chunk));
        }
        return { status: 200, bytes: Buffer.concat(chunks), url };
      } finally {
        await response.body?.cancel?.().catch(() => {});
      }
    }
    return null;
  }
}
