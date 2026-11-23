import { expect, test } from "@playwright/test";
import { openPricer } from "./helpers.mjs";

test("default page matches the visual reference", async ({ page }) => {
  await openPricer(page);

  // The performance figures change on every run, so they are not part of the
  // visual contract. Everything else in the reference image is deterministic:
  // the surface auto-rotation is disabled by reducedMotion, and the Monte Carlo
  // seed is fixed.
  await page.addStyleTag({
    content: ".perf { visibility: hidden !important; } .canvas-loading { display: none !important; }",
  });
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );

  await expect(page).toHaveScreenshot("home.png", {
    fullPage: true,
    maxDiffPixelRatio: 0.02,
  });
});
