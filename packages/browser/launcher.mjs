import { spawn } from "node:child_process";
import net from "node:net";

const chrome = spawn(
  "/usr/bin/chromium",
  [
    "--headless=new",
    "--user-data-dir=/home/node/.archil-browser/profile",
    "--remote-debugging-port=9223",
    "--remote-debugging-address=127.0.0.1",
    "--no-sandbox",
    "--disable-background-networking",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "inherit" },
);

const chromeExit = new Promise((resolve, reject) => {
  chrome.once("error", reject);
  chrome.once("exit", (code, signal) => {
    if (code === 0 || signal === "SIGTERM") resolve();
    else reject(new Error("Chromium exited with " + (signal ?? "code " + code)));
  });
});

process.once("SIGINT", () => chrome.kill("SIGTERM"));
process.once("SIGTERM", () => chrome.kill("SIGTERM"));

// Chromium only accepts localhost or an IP address in the Host header on its
// debugging endpoint. The Archil endpoint has a public hostname, so expose a
// small TCP proxy that rewrites the first request header before tunneling it.
const proxy = net.createServer((client) => {
  const chrome = net.connect(9223, "127.0.0.1");
  let request = Buffer.alloc(0);

  const forwardRequest = (chunk) => {
    request = Buffer.concat([request, chunk]);
    const headersEnd = request.indexOf("\r\n\r\n");
    if (headersEnd === -1) return;

    client.off("data", forwardRequest);
    const headers = request
      .subarray(0, headersEnd + 4)
      .toString("latin1")
      .replace(/^Host:.*$/im, "Host: localhost");
    chrome.write(headers, "latin1");
    chrome.write(request.subarray(headersEnd + 4));
    client.pipe(chrome);
    chrome.pipe(client);
  };

  client.on("data", forwardRequest);
  client.on("error", () => chrome.destroy());
  chrome.on("error", () => client.destroy());
});

await new Promise((resolve, reject) => {
  proxy.once("error", reject);
  proxy.listen(9222, "0.0.0.0", resolve);
});

await chromeExit;
await new Promise((resolve) => proxy.close(resolve));
