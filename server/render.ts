import { chromium } from "playwright";
import { crawlFetch, publicUrl, type CrawlPermission } from "./network.js";
/** Browser traffic goes through the same pinned public-network fetcher as HTML audits. */
export async function renderedFetch(
  url: string,
  signal = AbortSignal.timeout(60000),
  allowed?: CrawlPermission,
) {
  publicUrl(url);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    await context.route("**/*", async (route) => {
      try {
        const navigation = route.request().isNavigationRequest();
        const response = await crawlFetch(route.request().url(), signal, navigation ? allowed : undefined);
        if (navigation && response.url !== route.request().url()) {
          await route.fulfill({ status: 302, headers: { location: response.url } });
          return;
        }
        if (!/text\/|javascript|json|xml/.test(response.contentType)) {
          await route.abort();
          return;
        }
        await route.fulfill({
          status: response.status,
          contentType: response.contentType,
          body: response.text,
        });
      } catch {
        await route.abort();
      }
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const page = await context.newPage();
    const abort = () => void browser.close();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page
        .waitForLoadState("networkidle", { timeout: 5000 })
        .catch(() => {});
      signal.throwIfAborted();
      return {
        url: publicUrl(page.url()).href,
        status: response?.status() ?? 200,
        contentType: "text/html",
        text: await page.content(),
      };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  } finally {
    await browser.close();
  }
}
