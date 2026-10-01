import { chromium } from "playwright";
import { connectionPage } from "../server/connection-page.js";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.setContent(connectionPage("connected", "chatgpt", "http://127.0.0.1:4318"));
  await page.screenshot({ path: "assets/connection-page-preview.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const state of ["connected", "identity", "error"] as const) {
    await page.setContent(connectionPage(state, "chatgpt", "http://127.0.0.1:4318"));
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("Connection page overflows on mobile");
    if (await page.locator("script,iframe,img").count()) throw new Error("The callback preview contains an unexpected dependency");
  }
  console.log("Connection page: success, missing permission and error layouts verified at desktop and mobile sizes.");
} finally { await browser.close(); }
