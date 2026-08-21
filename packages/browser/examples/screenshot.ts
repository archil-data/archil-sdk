import puppeteer from "puppeteer-core";
import { createBrowserSandbox } from "@archildata/browser";

const { sandbox, browser } = await createBrowserSandbox();

try {
  const { cdpUrl } = await browser.start();
  console.log(`Archil browser started at ${cdpUrl}`);
  const puppeteerBrowser = await puppeteer.connect({ browserWSEndpoint: cdpUrl });
  console.log(`Puppeteer connected to Archil browser`);

  try {
    const page = await puppeteerBrowser.newPage();
    console.log(`New page created`);
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto("https://archil.com");
    console.log(`Navigated to https://archil.com`);
    const screenshotPath = "screenshot.png";
    await page.screenshot({ path: screenshotPath });
    console.log(`Screenshot saved as ${screenshotPath}`);

    const pageInfo = await page.evaluate(() => ({
      title: document.title,
      heading: document.querySelector("h1")?.textContent?.trim(),
      linkCount: document.links.length,
    }));

    console.log({
      sandboxId: sandbox.id,
      browserVersion: await puppeteerBrowser.version(),
      screenshot: screenshotPath,
      ...pageInfo,
    });
  } finally {
    puppeteerBrowser.disconnect();
  }
} finally {
  await sandbox.stop();
}
