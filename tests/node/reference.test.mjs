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

function quote(kind, dividend = 0) {
  return wasm.quote(
    kind,
    market.spot,
    market.strike,
    market.rate,
    market.vol,
    market.expiry,
    dividend,
  );
}

function asian(dividend = 0, paths = PATHS) {
  return wasm.asian_monte_carlo(
    market.spot,
    market.strike,
    market.rate,
    market.vol,
    market.expiry,
    dividend,
    STEPS,
    paths,
    SEED,
  );
}

function surface(dividend = 0) {
  return wasm.build_vol_surface(
    market.spot,
    market.strike,
    market.rate,
    market.vol,
    market.expiry,
    dividend,
  );
}

test("Black-Scholes prices match options-pricer", () => {
  const call = quote("call");
  const put = quote("put");

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
  const result = quote("call");

  for (const [name, expected] of Object.entries(reference.black_scholes.greeks)) {
    close(result[name], expected, CLOSED_FORM_TOLERANCE, name);
  }

  result.free();
});

test("continuous dividend yield matches options-pricer", () => {
  const dividend = reference.dividend_case.dividend_yield;
  const call = quote("call", dividend);
  const put = quote("put", dividend);

  close(call.price, reference.dividend_case.call, CLOSED_FORM_TOLERANCE, "call with q");
  close(put.price, reference.dividend_case.put, CLOSED_FORM_TOLERANCE, "put with q");
  close(call.delta, reference.dividend_case.delta, CLOSED_FORM_TOLERANCE, "delta with q");

  call.free();
  put.free();
});

test("geometric Asian closed form matches options-pricer", () => {
  const result = asian(0, 100);

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
  const result = asian();

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
  const result = asian();

  close(
    result.european_call,
    reference.black_scholes.call,
    4 * result.european_call_standard_error,
    "European Monte Carlo",
  );

  result.free();
});

test("same seed gives the same Monte Carlo result", () => {
  const first = asian();
  const second = asian();

  assert.equal(first.call_price, second.call_price);
  assert.equal(first.put_price, second.put_price);
  assert.equal(first.european_call, second.european_call);

  first.free();
  second.free();
});

test("dividend yield lowers the Asian call and raises the put", () => {
  const base = asian(0);
  const withDividend = asian(reference.dividend_case.dividend_yield);

  assert.ok(withDividend.call_price < base.call_price);
  assert.ok(withDividend.put_price > base.put_price);
  assert.ok(withDividend.geometric_call < base.geometric_call);
  assert.ok(withDividend.geometric_put > base.geometric_put);

  base.free();
  withDividend.free();
});

test("volatility surface is well formed", () => {
  const result = surface();

  assert.equal(result.width, 49);
  assert.equal(result.height, 20);
  assert.equal(result.values.length, 49 * 20);
  assert.ok(result.strikes[0] === 40 && result.strikes.at(-1) === 160);
  assert.ok(result.values.every((value) => Number.isFinite(value) && value > 0));
  assert.ok(result.marker_vol > 0);

  result.free();
});

test("surface accepts a dividend yield", () => {
  const without = surface(0);
  const withDividend = surface(reference.dividend_case.dividend_yield);

  assert.ok(withDividend.values.every((value) => Number.isFinite(value) && value > 0));
  assert.notEqual(withDividend.marker_vol, without.marker_vol);

  without.free();
  withDividend.free();
});

test("price curve matches the scalar quote", () => {
  const curve = wasm.price_curve(
    "call",
    50,
    150,
    101,
    market.strike,
    market.rate,
    market.vol,
    market.expiry,
    0,
  );

  assert.equal(curve.points, 101);
  assert.equal(curve.spots.length, 101);
  assert.equal(curve.values.length, 101);
  assert.equal(curve.spots[0], 50);
  assert.equal(curve.spots.at(-1), 150);
  assert.ok(curve.values.every((value, index) => index === 0 || value >= curve.values[index - 1]));

  const left = wasm.quote(
    "call",
    50,
    market.strike,
    market.rate,
    market.vol,
    market.expiry,
    0,
  );
  close(curve.values[0], left.price, 1e-12, "curve left");
  left.free();

  const right = wasm.quote(
    "call",
    150,
    market.strike,
    market.rate,
    market.vol,
    market.expiry,
    0,
  );
  close(curve.values.at(-1), right.price, 1e-12, "curve right");
  right.free();

  curve.free();
});

test("invalid market inputs are rejected", () => {
  assert.throws(() => wasm.quote("call", -100, 100, 0.05, 0.2, 1, 0));
  assert.throws(() => wasm.quote("call", 100, 100, 0.05, 0.2, 1, Number.NaN));
  assert.throws(() => wasm.asian_monte_carlo(100, 100, 0.05, 0, 1, 0, 64, 100, 1));
  assert.throws(() => wasm.price_curve("call", 50, 50, 101, 100, 0.05, 0.2, 1, 0));
  assert.throws(() => wasm.price_curve("call", 50, 150, 1, 100, 0.05, 0.2, 1, 0));
});

test("recalculation time is reported", () => {
  const times = [];
  for (let index = 0; index < 15; index += 1) {
    const started = performance.now();
    const call = quote("call");
    const put = quote("put");
    const asianResult = asian();
    const surfaceResult = surface();
    times.push(performance.now() - started);
    call.free();
    put.free();
    asianResult.free();
    surfaceResult.free();
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(`wasm recalculation median: ${median.toFixed(2)} ms`);
  assert.ok(median > 0);
});

