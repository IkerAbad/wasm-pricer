//! Reference values generated with options-pricer 0.7.0.
//!
//! The European values are closed form and must agree to 1e-9. The Monte Carlo
//! values come from independent random streams, so they are compared
//! statistically: the tolerance is four combined standard errors, as documented
//! in the README.

use wasm_pricer::black_scholes::{self, OptionKind};
use wasm_pricer::monte_carlo;
use wasm_pricer::svi;

const SPOT: f64 = 100.0;
const STRIKE: f64 = 100.0;
const RATE: f64 = 0.05;
const VOL: f64 = 0.20;
const EXPIRY: f64 = 1.0;
const TOLERANCE: f64 = 1e-9;

fn assert_close(actual: f64, expected: f64, tolerance: f64, label: &str) {
    let difference = (actual - expected).abs();
    assert!(
        difference <= tolerance,
        "{label}: expected {expected:.15}, got {actual:.15}, difference {difference:.3e}"
    );
}

#[test]
fn european_prices_match_options_pricer() {
    let call = black_scholes::price(OptionKind::Call, SPOT, STRIKE, RATE, VOL, EXPIRY, 0.0);
    let put = black_scholes::price(OptionKind::Put, SPOT, STRIKE, RATE, VOL, EXPIRY, 0.0);

    assert_close(call, 10.450_583_572_185_565, TOLERANCE, "call");
    assert_close(put, 5.573_526_022_256_971, TOLERANCE, "put");
    assert_close(
        call - put,
        SPOT - STRIKE * libm::exp(-RATE * EXPIRY),
        1e-12,
        "put-call parity",
    );
}

#[test]
fn greeks_match_options_pricer() {
    let quote = black_scholes::quote(OptionKind::Call, SPOT, STRIKE, RATE, VOL, EXPIRY, 0.0);

    assert_close(quote.delta, 0.636_830_651_175_619_1, TOLERANCE, "delta");
    assert_close(quote.gamma, 0.018_762_017_345_846_895, TOLERANCE, "gamma");
    assert_close(quote.vega, 37.524_034_691_693_79, TOLERANCE, "vega");
    assert_close(quote.theta, -6.414_027_546_438_197, TOLERANCE, "theta");
    assert_close(quote.rho, 53.232_481_545_376_345, TOLERANCE, "rho");
    assert_close(quote.vanna, -0.281_430_260_187_703_45, TOLERANCE, "vanna");
    assert_close(quote.volga, 9.850_059_106_569_622, TOLERANCE, "volga");
    assert_close(quote.charm, -0.065_667_060_710_464_13, TOLERANCE, "charm");
}

#[test]
fn dividend_yield_matches_options_pricer() {
    let call = black_scholes::price(OptionKind::Call, SPOT, STRIKE, RATE, VOL, EXPIRY, 0.03);
    let put = black_scholes::price(OptionKind::Put, SPOT, STRIKE, RATE, VOL, EXPIRY, 0.03);

    assert_close(call, 8.652_528_553_942_709, TOLERANCE, "call with q=3%");
    assert_close(put, 6.730_917_649_163_302_5, TOLERANCE, "put with q=3%");
}

#[test]
fn greeks_agree_with_finite_differences() {
    let base = black_scholes::quote(OptionKind::Call, SPOT, STRIKE, RATE, VOL, EXPIRY, 0.0);
    let step = 1e-4;

    let up = black_scholes::price(
        OptionKind::Call,
        SPOT + step,
        STRIKE,
        RATE,
        VOL,
        EXPIRY,
        0.0,
    );
    let down = black_scholes::price(
        OptionKind::Call,
        SPOT - step,
        STRIKE,
        RATE,
        VOL,
        EXPIRY,
        0.0,
    );
    assert_close(
        base.delta,
        (up - down) / (2.0 * step),
        1e-6,
        "delta by bump",
    );

    let up = black_scholes::price(
        OptionKind::Call,
        SPOT,
        STRIKE,
        RATE,
        VOL + step,
        EXPIRY,
        0.0,
    );
    let down = black_scholes::price(
        OptionKind::Call,
        SPOT,
        STRIKE,
        RATE,
        VOL - step,
        EXPIRY,
        0.0,
    );
    assert_close(base.vega, (up - down) / (2.0 * step), 1e-4, "vega by bump");
}

#[test]
fn geometric_asian_closed_form_matches_options_pricer() {
    let call =
        monte_carlo::geometric_asian_price(OptionKind::Call, SPOT, STRIKE, RATE, VOL, EXPIRY, 64);
    let put =
        monte_carlo::geometric_asian_price(OptionKind::Put, SPOT, STRIKE, RATE, VOL, EXPIRY, 64);

    assert_close(call, 5.620_434_431_825_337, 1e-10, "geometric Asian call");
    assert_close(put, 3.498_889_929_431_685_5, 1e-10, "geometric Asian put");
}

#[test]
fn asian_control_variate_matches_converged_reference() {
    let result =
        monte_carlo::asian_estimate(SPOT, STRIKE, RATE, VOL, EXPIRY, 64, 3_000, 20_261_123);

    // Reference: 2,000,000 paths, seed 42, options-pricer 0.7.0.
    assert_close(
        result.call_price,
        5.839_498_280_542_845,
        0.01,
        "Asian call CV",
    );
    assert_close(
        result.put_price,
        3.379_982_287_152_001_8,
        0.01,
        "Asian put CV",
    );
    assert_close(
        result.geometric_call,
        5.620_434_431_825_337,
        1e-10,
        "geometric call",
    );

    let combined =
        (result.call_raw_standard_error.powi(2) + 0.005_712_779_709_158_374_f64.powi(2)).sqrt();
    assert!(
        (result.call_raw_price - 5.839_498_280_542_845).abs() <= 4.0 * combined,
        "raw call {:.6} is more than four combined standard errors from the reference",
        result.call_raw_price
    );
}

#[test]
fn asian_estimate_is_deterministic() {
    let first = monte_carlo::asian_estimate(SPOT, STRIKE, RATE, VOL, EXPIRY, 32, 2_000, 7);
    let second = monte_carlo::asian_estimate(SPOT, STRIKE, RATE, VOL, EXPIRY, 32, 2_000, 7);
    assert_eq!(first.call_price, second.call_price);
    assert_eq!(first.put_price, second.put_price);
    assert_eq!(first.european_call, second.european_call);
}

#[test]
fn european_monte_carlo_agrees_with_the_closed_form() {
    let result =
        monte_carlo::asian_estimate(SPOT, STRIKE, RATE, VOL, EXPIRY, 64, 3_000, 20_261_123);
    let closed = black_scholes::price(OptionKind::Call, SPOT, STRIKE, RATE, VOL, EXPIRY, 0.0);
    let combined = (result.european_call_standard_error.powi(2)
        + 0.010_413_624_062_323_492_f64.powi(2))
    .sqrt();

    assert!(
        (result.european_call - closed).abs() <= 4.0 * combined,
        "European MC {:.6} vs closed form {:.6}",
        result.european_call,
        closed
    );
}

#[test]
fn surface_is_pinned_to_the_slider_volatility() {
    let surface = svi::build_surface(SPOT, STRIKE, RATE, VOL, EXPIRY);
    assert_eq!(surface.values.len(), svi::STRIKES * svi::MATURITIES);

    let params = svi::atm_slice(EXPIRY, VOL);
    let expected = svi::implied_vol(0.0, EXPIRY, &params);
    assert_close(expected, VOL, 1e-12, "ATM vol");
    assert!(surface.marker_vol > 0.0);
}

#[test]
fn surface_stays_positive_across_the_slider_range() {
    for spot in [50.0, 100.0, 150.0] {
        for vol in [0.05, 0.2, 0.8] {
            let surface = svi::build_surface(spot, 100.0, 0.1, vol, 2.0);
            assert!(
                surface
                    .values
                    .iter()
                    .all(|value| value.is_finite() && *value > 0.0),
                "surface has a non-positive point at spot {spot}, vol {vol}"
            );
        }
    }
}
