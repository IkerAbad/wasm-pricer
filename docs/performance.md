# Performance log

Measured on **2026-11-23** against the published page, version **0.1.0**,
commit `79e79f7`.

- URL: https://ikerabad.github.io/wasm-pricer/
- Machine: AMD Ryzen 9 5900X, 32 GB RAM, Windows 11 (build 10.0.26300)
- Viewport: 1000 × 700
- Network: GitHub Pages CDN, unthrottled
- Motion: `prefers-reduced-motion: reduce`, so the 3D auto-rotation is off
  while timing.

## Results

| Browser | Version | Mode | Load, first run | Load, median of 3 | Calc median | Calc p95, worst run |
|---|---|---:|---:|---:|---:|---:|
| Chrome | 152.0.7977.167 | Desktop browser | 501 ms | 77 ms | 6.7 ms | 7.9 ms |
| Microsoft Edge | 136.0.3240.64 | Playwright headless | 516 ms | 224 ms | 6.3 ms | 6.9 ms |
| Firefox | 159.0 | Playwright headless | 402 ms | 218 ms | 8.0 ms | 10.0 ms |

Every observed load is below the 1,000 ms limit. Every recalculation is below
the 16 ms limit. The first run is the conservative load number because it
includes a new connection. Later runs reuse DNS, TLS and warm caches.

## What is measured

**Load** is the `load` value in the page header: `performance.now()` at
navigation start to the first rendered surface. It includes the HTML, CSS,
JavaScript, WASM download and instantiation, plus two recalculation passes, one
of them a warm-up.

**Recalculation** is measured by the page's benchmark API:

```js
window.__wasmPricer.benchmark(30)
```

It performs three warm-ups and then 30 synchronous recalculation passes. One
pass is two European quotes, the Asian Monte Carlo (3,000 paths × 64 steps,
including the geometric control variate) and the 49 × 20 SVI surface. The
reported figure excludes DOM updates and canvas drawing.

## Method

- Edge and Firefox were launched by Playwright in headless mode. Each of the
  three runs used a fresh browser context, so no HTTP cache or page state was
  carried over. Version strings come from the browser binaries.
- Chrome was measured in a desktop browser. The first run opened a
  new tab. The next two runs used cache-disabled reloads.
- All runs loaded the public GitHub Pages URL, not a local server.
- The page was fully ready (`window.__wasmPricer.ready === true`) before the
  benchmark started.
- No CPU throttling or network throttling was applied.
- Raw per-run data and asset hashes are in [performance.json](performance.json).
  The four hashes identify the exact HTML, CSS, JavaScript and WASM served at
  measurement time.

## Limits

| Measurement | Limit | Observed worst |
|---|---:|---:|
| First load | 1,000 ms | 516 ms |
| Any load | 1,000 ms | 516 ms |
| Recalculation median | 16 ms | 8.0 ms |
| Recalculation p95 | 16 ms | 10.0 ms |

These are single-machine figures, not a claim about every device or network.
They are published so the demo's performance budget can be checked against a
recorded build rather than taken on trust.
