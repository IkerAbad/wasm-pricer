import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const wasm = require(path.join(here, "..", "..", "pkg-node", "wasm_pricer.js"));
const reference = JSON.parse(
  fs.readFileSync(path.join(here, "..", "reference.json"), "utf8"),
);

const market = reference.market;
const SEED = 20_261_123;
const STEPS = reference.monte_carlo.steps;
const PATHS = 3_000;
const CLOSED_FORM_TOLERANCE = reference.tolerances.closed_form_absolute;
const CV_TOLERANCE = 0.01;

function close(actual, expected, tolerance, label) {
  const difference = Math.abs(actual - expected);
  assert.ok(
    difference <= tolerance,
    `${label}: expected ${expected}, got ${actual}, difference ${difference}`,
  );
}

test("Black-Scholes prices match options-pricer", () => {
  const call = wasm.quote("call", market.spot, market.strike, market.rate, market.vol, market.expiry, 0);
  const put = wasm.quote("put", market.spot, market.strike, market.rate, market.vol, market.expiry, 0);

  close(call.price, reference.black_scholes.call, CLOSED_FORM_TOLERANCE, "call");
  close(put.price, reference.black_scholes.put, CLOSED_FORM_TOLERANCE, "put");
  close(
    call.price - put.price,
    market.spot - market.strike * Math.exp(-market.rate * market.expiry),
    1e-12,
    "put-call parity",
  );

  call.free();
  put.free();
});

test("Greeks match options-pricer", () => {
  const quote = wasm.quote(
    "call",
    market.spot,
    market.strike,
    market.rate,
    market.vol,
    market.expiry,
    0,
  );

  for (const [name, expected] of Object.entries(reference.black_scholes.greeks)) {
    close(quote[name], expected, CLOSED_FORM_TOLERANCE, name);
  }

  quote.free();
});

test("geometric Asian closed form matches options-pricer", () => {
  const result = wasm.asian_monte_carlo(
    market.spot,
    market.strike,
    market.rate,
    market.vol,
    market.expiry,
    STEPS,
    100,
    SEED,
  );

  close(
    result.geometric_call,
    reference.monte_carlo.geometric_asian_call,
    1e-10,
    "geometric call",
  );
  close(
    result.geometric_put,
    reference.monte_carlo.geometric_asian_put,
    1e-10,
    "geometric put",
  );

  result.free();
});

test("Asian Monte Carlo agrees with the converged reference", () => {
  const result = wasm.asian_monte_carlo(
    market.spot,
    market.strike,
    market.rate,
    market.vol,
    market.expiry,
    STEPS,
    PATHS,
    SEED,
  );

  close(
    result.call_price,
    reference.monte_carlo.asian_call.price,
    CV_TOLERANCE,
    "Asian call control variate",
  );
  close(
    result.put_price,
    reference.monte_carlo.asian_put.price,
    CV_TOLERANCE,
    "Asian put control variate",
  );

  const combinedCall = Math.hypot(
    result.call_raw_standard_error,
    reference.monte_carlo.asian_call.standard_error,
  );
  close(
    result.call_raw_price,
    reference.monte_carlo.asian_call.price,
    4 * combinedCall,
    "Asian call raw estimate",
  );

  const combinedPut = Math.hypot(
    result.put_raw_standard_error,
    reference.monte_carlo.asian_put.standard_error,
  );
  close(
    result.put_raw_price,
    reference.monte_carlo.asian_put.price,
    4 * combinedPut,
    "Asian put raw estimate",
  );

  result.free();
});

test("European Monte Carlo agrees with the closed form", () => {
  const result = wasm.asian_monte_carlo(
    market.spot,
    market.strike,
    market.rate,
    market.vol,
    market.expiry,
    STEPS,
    PATHS,
    SEED,
  );

  close(
    result.european_call,
    reference.black_scholes.call,
    4 * result.european_call_standard_error,
    "European Monte Carlo",
  );

  result.free();
});

test("same seed gives the same Monte Carlo result", () => {
  const first = wasm.asian_monte_carlo(
    market.spot,
    market.strike,
    market.rate,
    market.vol,
    market.expiry,
    STEPS,
    PATHS,
    SEED,
  );
  const second = wasm.asian_monte_carlo(
    market.spot,
    market.strike,
    market.rate,
    market.vol,
    market.expiry,
    STEPS,
    PATHS,
    SEED,
  );

  assert.equal(first.call_price, second.call_price);
  assert.equal(first.put_price, second.put_price);
  assert.equal(first.european_call, second.european_call);

  first.free();
  second.free();
});

test("volatility surface is well formed", () => {
  const surface = wasm.build_vol_surface(
    market.spot,
    market.strike,
    market.rate,
    market.vol,
    market.expiry,
  );

  assert.equal(surface.width, 49);
  assert.equal(surface.height, 20);
  assert.equal(surface.values.length, 49 * 20);
  assert.ok(surface.strikes[0] === 40 && surface.strikes.at(-1) === 160);
  assert.ok(surface.values.every((value) => Number.isFinite(value) && value > 0));
  assert.ok(surface.marker_vol > 0);

  surface.free();
});

test("invalid market inputs are rejected", () => {
  assert.throws(() => wasm.quote("call", -100, 100, 0.05, 0.2, 1, 0));
  assert.throws(() => wasm.asian_monte_carlo(100, 100, 0.05, 0, 1, 64, 100, 1));
});

test("recalculation time is reported", () => {
  const times = [];
  for (let index = 0; index < 15; index += 1) {
    const started = performance.now();
    const call = wasm.quote("call", market.spot, market.strike, market.rate, market.vol, market.expiry, 0);
    const put = wasm.quote("put", market.spot, market.strike, market.rate, market.vol, market.expiry, 0);
    const asian = wasm.asian_monte_carlo(
      market.spot,
      market.strike,
      market.rate,
      market.vol,
      market.expiry,
      STEPS,
      PATHS,
      SEED,
    );
    const surface = wasm.build_vol_surface(
      market.spot,
      market.strike,
      market.rate,
      market.vol,
      market.expiry,
    );
    times.push(performance.now() - started);
    call.free();
    put.free();
    asian.free();
    surface.free();
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(`wasm recalculation median: ${median.toFixed(2)} ms`);
  assert.ok(median > 0);
});
