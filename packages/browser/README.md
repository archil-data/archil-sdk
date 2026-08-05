# @archildata/browser

Run a persistent headless Chromium browser in an Archil sandbox and connect to it
over the Chrome DevTools Protocol.

## Install

```sh
npm install disk @archildata/browser puppeteer-core
```

## Usage

`createBrowserSandbox()` creates a sandbox using Archil's ARM64 Node and
Chromium image and returns both the native sandbox and its browser controller.

```ts
import { createBrowserSandbox } from "@archildata/browser";
import puppeteer from "puppeteer-core";

const { sandbox, browser } = await createBrowserSandbox();

try {
  const { cdpUrl } = await browser.start();
  const puppeteerBrowser = await puppeteer.connect({ browserWSEndpoint: cdpUrl });

  const page = await puppeteerBrowser.newPage();
  await page.goto("https://example.com");

  puppeteerBrowser.disconnect();
} finally {
  await sandbox.stop();
}
```

The returned `sandbox` is the native `disk` SDK sandbox, so its normal
`pause()`, `resume()`, `start()`, `stop()`, and `exec()` methods remain
available.

`start()` registers Chromium as a supervised sandbox service and exposes its
CDP endpoint on port 9222. Chromium stores its user data under
`/home/node/.archil-browser/profile`, which is persisted by the sandbox's
Archil-backed root filesystem. `stop()` stops Chrome and removes its service;
it does not stop the sandbox. Calling `sandbox.stop()` stops the browser as part
of stopping the whole sandbox, so calling `browser.stop()` first is
optional when the entire sandbox is no longer needed.

The CDP endpoint grants full control of the browser to anyone who knows its
hostname. Treat `cdpUrl` as a secret and stop the browser when it is not in use.

## Screenshot example

Create a browser sandbox, inspect `archil.com`, and save `screenshot.png` in the
current directory:

```sh
pnpm --filter @archildata/browser example:screenshot
```

The example also prints the sandbox ID, Chromium version, page title, heading,
and link count. See [`examples/screenshot.ts`](./examples/screenshot.ts).

## Integration test

With `ARCHIL_API_KEY` and `ARCHIL_REGION` configured:

```sh
pnpm --filter @archildata/browser test:integration
```
