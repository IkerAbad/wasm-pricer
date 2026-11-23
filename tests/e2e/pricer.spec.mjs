import { expect, test } from "@playwright/test";
import { expectValue, openPricer, pressRange } from "./helpers.mjs";

const DEFAULT_CALL = "10.4506";
const DEFAULT_PUT = "5.5735";

test("loads under one second and shows the reference prices and Greeks", async ({ page }) => {
  const errors = await openPricer(page, { warmLoad: true });
  const loadMs = await page.evaluate(() => window.__wasmPricer.loadMs);

  expect(loadMs).toBeLessThan(1_000);
  await expectValue(page, "#call-price", DEFAULT_CALL);
  await expectValue(page, "#put-price", DEFAULT_PUT);
  await expectValue(page, "#greek-delta", "0.6368");
  await expectValue(page, "#greek-gamma", "0.01876");
  await expectValue(page, "#greek-vega", "37.524");
  await expectValue(page, "#greek-theta", "-6.414");
  await expectValue(page, "#greek-rho", "53.232");
  await expectValue(page, "#greek-vanna", "-0.2814");
  await expectValue(page, "#greek-volga", "9.8501");
  await expectValue(page, "#greek-charm", "-0.06567");
  expect(errors).toEqual([]);
});

test("moving spot, volatility and dividend updates prices and Greeks", async ({ page }) => {
  await openPricer(page);

  await pressRange(page, "#spot", 20);
  await expectValue(page, "#spot-value", "110.0");
  await expectValue(page, "#call-price", "17.6630");
  await expectValue(page, "#put-price", "2.7859");
  await expectValue(page, "#greek-delta", "0.7958");
  await expectValue(page, "#greek-gamma", "0.01289");
  await expectValue(page, "#greek-vega", "31.185");
  await expectValue(page, "#greek-theta", "-6.612");

  await page.getByRole("button", { name: "Reset" }).click();
  await expectValue(page, "#call-price", DEFAULT_CALL);

  await pressRange(page, "#vol", 20);
  await expectValue(page, "#vol-value", "30.0%");
  await expectValue(page, "#call-price", "14.2313");
  await expectValue(page, "#put-price", "9.3542");
  await expectValue(page, "#greek-delta", "0.6243");
  await expectValue(page, "#greek-vega", "37.943");
  await expectValue(page, "#greek-theta", "-8.101");

  await page.getByRole("button", { name: "Reset" }).click();
  await expectValue(page, "#call-price", DEFAULT_CALL);

  await pressRange(page, "#dividend", 30);
  await expectValue(page, "#dividend-value", "3.0%");
  await expectValue(page, "#call-price", "8.6525");
  await expectValue(page, "#put-price", "6.7309");
  await expectValue(page, "#greek-delta", "0.5621");
  await expectValue(page, "#greek-vega", "37.949");
  await expectValue(page, "#greek-theta", "-4.487");
});

test("comparison mode freezes two setups and reports the difference", async ({ page }) => {
  await openPricer(page);

  await page.getByRole("button", { name: /compare two setups/i }).click();
  await expect(page.locator("#compare-panel")).toBeVisible();
  await expect(page.locator("#compare-summary")).toContainText("B − A = +3.7807");
  await expect(page.locator("#config-b")).toContainText("30.0%");

  await page.locator('[data-compare-kind="put"]').click();
  await expect(page.locator("#compare-summary")).toContainText("B − A = +3.7807");
  await expect(page.locator("#compare-chart")).toHaveAttribute("aria-label", /Put value curves/);

  await page.keyboard.press("Escape");
  await expect(page.locator("#compare-panel")).toBeHidden();
  await expect(page.getByRole("button", { name: /compare two setups/i })).toBeFocused();
});

