import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { createBrowserSandbox } from "../src/index.js";

const { sandbox, browser } = await createBrowserSandbox();

try {
  const { cdpUrl } = await browser.start();
  const puppeteerBrowser = await puppeteer.connect({ browserWSEndpoint: cdpUrl });

  try {
    const page = await puppeteerBrowser.newPage();
    await page.setContent("<title>Archil browser integration</title><h1>connected</h1>");
    assert.equal(await page.title(), "Archil browser integration");
    assert.equal(await page.$eval("h1", (element) => element.textContent), "connected");
  } finally {
    puppeteerBrowser.disconnect();
  }
} finally {
  await sandbox.stop();
}
