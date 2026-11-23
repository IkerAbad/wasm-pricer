import { expect } from "@playwright/test";

export async function openPricer(page, { warmLoad = false } = {}) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  let cdp = null;
  if (warmLoad) {
    // A cold DNS/TLS handshake is outside the application's control. Warm the
    // connection, disable the HTTP cache and measure the second navigation.
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  }

  const load = async () => {
    await page.goto("./", { waitUntil: "load" });
    await page.waitForFunction(() => window.__wasmPricer?.ready === true, null, {
      timeout: 30_000,
    });
    await expect(page.locator("#canvas-loading")).toHaveClass(/is-hidden/);
  };

  await load();
  if (warmLoad) {
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => window.__wasmPricer?.ready === true, null, {
      timeout: 30_000,
    });
    await expect(page.locator("#canvas-loading")).toHaveClass(/is-hidden/);
  }

  if (cdp) await cdp.detach();
  return errors;
}

export async function expectValue(page, selector, text) {
  await expect(page.locator(selector)).toHaveText(text);
}

export async function pressRange(page, selector, presses) {
  const slider = page.locator(selector);
  await slider.focus();
  for (let index = 0; index < presses; index += 1) {
    await page.keyboard.press("ArrowRight");
  }
}
