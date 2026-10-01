import { crawlFetch } from "./network.js";
import identity from "../brand/identity.json";

type Rule = { allow: boolean; path: string };
type Group = { agents: string[]; rules: Rule[] };
// Percent-encoded unreserved octets compare as characters. Reserved octets
// remain encoded so /a%2Fb is not mistaken for /a/b.
function octets(value: string) {
  return value
    .replace(/%[\da-f]{2}/gi, (encoded) => {
      const character = String.fromCharCode(parseInt(encoded.slice(1), 16));
      return /[\w.~\-]/.test(character) ? character : encoded.toUpperCase();
    })
    .replace(/[^\x00-\x7f]/gu, (character) => encodeURIComponent(character));
}
export function robotsPolicy(text: string, product = identity.slug) {
  const groups: Group[] = [];
  let group: Group | undefined;
  let hadRule = false;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n|\r/)) {
    const line = raw.split("#", 1)[0].trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase(),
      value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!group || hadRule) {
        group = { agents: [], rules: [] };
        groups.push(group);
        hadRule = false;
      }
      group.agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && group) {
      hadRule = true;
      if (value.startsWith("/"))
        group.rules.push({ allow: key === "allow", path: octets(value) });
    }
  }
  const exact = groups.filter((g) => g.agents.includes(product.toLowerCase()));
  const rules = (
    exact.length ? exact : groups.filter((g) => g.agents.includes("*"))
  ).flatMap((g) => g.rules);
  return (url: string) => {
    const parsed = new URL(url),
      path = octets(parsed.pathname + parsed.search);
    if (parsed.pathname === "/robots.txt") return true;
    let longest = -1,
      allowed = true;
    for (const rule of rules) {
      const anchored = rule.path.endsWith("$"),
        pattern = anchored ? rule.path.slice(0, -1) : rule.path;
      const regex = new RegExp(
        "^" +
          pattern
            .split("*")
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*") +
          (anchored ? "$" : ""),
      );
      if (!regex.test(path)) continue;
      const specificity = Buffer.byteLength(pattern);
      if (specificity > longest || (specificity === longest && rule.allow)) {
        longest = specificity;
        allowed = rule.allow;
      }
    }
    return allowed;
  };
}
export async function loadRobots(
  base: URL,
  signal: AbortSignal,
  fetcher = crawlFetch,
) {
  const result = await fetcher(new URL("/robots.txt", base).href, signal);
  if (result.status >= 500 || result.status === 429)
    throw new Error(
      "The website's crawl policy is temporarily unavailable. Retry the audit later.",
    );
  const allowed = result.status >= 400 ? (_url: string) => true : robotsPolicy(result.text);
  const sitemaps = result.status >= 400 ? [] : result.text.split(/\r?\n/).flatMap(line => {
    const match = /^sitemap:\s*(\S+)/i.exec(line.trim());
    return match ? [match[1]] : [];
  });
  return Object.assign(allowed, { sitemaps });
}
