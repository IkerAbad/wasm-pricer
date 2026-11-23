//! Raw SVI total-variance slices and the synthetic surface shown in the page.
//!
//! The raw SVI form is
//!
//! ```text
//! w(k) = a + b * (rho * (k - m) + sqrt((k - m)^2 + sigma^2))
//! ```
//!
//! where k = ln(K / F) is log-moneyness and w = implied_vol^2 * T is total
//! implied variance. This mirrors options-pricer's surface module.
//!
//! The displayed surface is pedagogical, not a market quote: every maturity is
//! pinned to the ATM volatility from the slider and uses a fixed skew and
//! curvature. It reacts to spot, rate and volatility because those change the
//! forward and the level of the smile.

use libm::{exp, log, sqrt};

#[derive(Clone, Copy, Debug)]
pub struct SviParams {
    pub a: f64,
    pub b: f64,
    pub rho: f64,
    pub m: f64,
    pub sigma: f64,
}

pub const STRIKE_MIN: f64 = 40.0;
pub const STRIKE_MAX: f64 = 160.0;
pub const STRIKES: usize = 49;
pub const MATURITY_MIN: f64 = 1.0 / 12.0;
pub const MATURITY_MAX: f64 = 2.0;
pub const MATURITIES: usize = 20;

pub fn total_variance(k: f64, params: &SviParams) -> f64 {
    let d = k - params.m;
    params.a + params.b * (params.rho * d + sqrt(d * d + params.sigma * params.sigma))
}

pub fn implied_vol(k: f64, expiry: f64, params: &SviParams) -> f64 {
    sqrt(total_variance(k, params).max(1e-12) / expiry)
}

/// Slice whose ATM total variance equals `atm_vol^2 * expiry`.
///
/// b, rho, m and sigma keep the shape of options-pricer's example term
/// structure. Only `a` moves, which shifts the whole slice vertically and pins
/// the smile at the money.
pub fn atm_slice(expiry: f64, atm_vol: f64) -> SviParams {
    let b = 0.06 + 0.04 * sqrt(expiry);
    let rho = -0.35;
    let m = -0.05;
    let sigma = 0.15;
    let atm_shape = rho * (-m) + sqrt(m * m + sigma * sigma);
    let a = atm_vol * atm_vol * expiry - b * atm_shape;

    SviParams {
        a,
        b,
        rho,
        m,
        sigma,
    }
}

pub fn strike_grid() -> Vec<f64> {
    (0..STRIKES)
        .map(|index| STRIKE_MIN + (STRIKE_MAX - STRIKE_MIN) * index as f64 / (STRIKES - 1) as f64)
        .collect()
}

pub fn maturity_grid() -> Vec<f64> {
    (0..MATURITIES)
        .map(|index| {
            MATURITY_MIN + (MATURITY_MAX - MATURITY_MIN) * index as f64 / (MATURITIES - 1) as f64
        })
        .collect()
}

pub struct SurfaceData {
    pub strikes: Vec<f64>,
    pub maturities: Vec<f64>,
    pub values: Vec<f64>,
    pub marker_vol: f64,
}

pub fn build_surface(spot: f64, strike: f64, rate: f64, vol: f64, expiry: f64) -> SurfaceData {
    let strikes = strike_grid();
    let maturities = maturity_grid();
    let mut values = Vec::with_capacity(STRIKES * MATURITIES);

    for &maturity in &maturities {
        let params = atm_slice(maturity, vol);
        let forward = spot * exp(rate * maturity);
        for &strike in &strikes {
            let k = log(strike / forward);
            values.push(implied_vol(k, maturity, &params));
        }
    }

    let marker_params = atm_slice(expiry, vol);
    let marker_forward = spot * exp(rate * expiry);
    let marker_vol = implied_vol(log(strike / marker_forward), expiry, &marker_params);

    SurfaceData {
        strikes,
        maturities,
        values,
        marker_vol,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atm_slice_pins_the_money() {
        for expiry in [1.0 / 12.0, 0.5, 1.0, 2.0] {
            let vol = 0.2;
            let params = atm_slice(expiry, vol);
            let w = total_variance(0.0, &params);
            assert!((w - vol * vol * expiry).abs() < 1e-14);
            assert!((implied_vol(0.0, expiry, &params) - vol).abs() < 1e-12);
        }
    }

    #[test]
    fn raw_svi_matches_the_python_formula() {
        let params = SviParams {
            a: 0.010,
            b: 0.08,
            rho: -0.45,
            m: -0.04,
            sigma: 0.12,
        };
        // Reference computed with options-pricer.surface.total_variance.
        let expected = 0.019_711_271_131_668_62;
        assert!((total_variance(0.1, &params) - expected).abs() < 1e-15);
    }

    #[test]
    fn grid_has_the_advertised_shape() {
        assert_eq!(strike_grid().len(), STRIKES);
        assert_eq!(maturity_grid().len(), MATURITIES);
        let surface = build_surface(100.0, 100.0, 0.05, 0.2, 1.0);
        assert_eq!(surface.values.len(), STRIKES * MATURITIES);
        assert!(surface
            .values
            .iter()
            .all(|value| value.is_finite() && *value > 0.0));
        assert!(surface.marker_vol > 0.0);
    }
}
