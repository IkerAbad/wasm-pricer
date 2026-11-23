//! Closed-form Black-Scholes prices and Greeks for European options.
//!
//! Conventions match options-pricer:
//! - spot, strike and prices are in currency units.
//! - rate, volatility, dividend yield and expiry are annualised. Expiry is in years.
//! - vega is the derivative with respect to volatility in units (0.20, not 20).
//! - theta is the derivative with respect to calendar time, per year.
//! - rho is the derivative with respect to the continuously compounded rate.
//! - vanna is the cross derivative with respect to spot and volatility.
//! - volga is the second derivative with respect to volatility.
//! - charm is minus the derivative of delta with respect to time to expiry.

use libm::erfc;

const SQRT_2: f64 = std::f64::consts::SQRT_2;
const SQRT_2PI: f64 = 2.506_628_274_631_000_2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OptionKind {
    Call,
    Put,
}

impl OptionKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "call" => Some(Self::Call),
            "put" => Some(Self::Put),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Quote {
    pub price: f64,
    pub delta: f64,
    pub gamma: f64,
    pub vega: f64,
    pub theta: f64,
    pub rho: f64,
    pub vanna: f64,
    pub volga: f64,
    pub charm: f64,
}

/// Standard normal CDF through erfc, which keeps accuracy in the tails.
#[inline]
pub fn norm_cdf(x: f64) -> f64 {
    0.5 * erfc(-x / SQRT_2)
}

#[inline]
pub fn norm_pdf(x: f64) -> f64 {
    libm::exp(-0.5 * x * x) / SQRT_2PI
}

pub fn validate(spot: f64, strike: f64, vol: f64, expiry: f64) -> Result<(), String> {
    if !spot.is_finite() || spot <= 0.0 {
        return Err("spot must be positive and finite".into());
    }
    if !strike.is_finite() || strike <= 0.0 {
        return Err("strike must be positive and finite".into());
    }
    if !vol.is_finite() || vol <= 0.0 {
        return Err("volatility must be positive and finite".into());
    }
    if !expiry.is_finite() || expiry <= 0.0 {
        return Err("expiry must be positive and finite, in years".into());
    }
    Ok(())
}

#[inline]
pub fn d1_d2(
    spot: f64,
    strike: f64,
    rate: f64,
    vol: f64,
    expiry: f64,
    dividend_yield: f64,
) -> (f64, f64) {
    let sqrt_t = libm::sqrt(expiry);
    let carry = rate - dividend_yield;
    let d1 = (libm::log(spot / strike) + (carry + 0.5 * vol * vol) * expiry) / (vol * sqrt_t);
    (d1, d1 - vol * sqrt_t)
}

pub fn price(
    kind: OptionKind,
    spot: f64,
    strike: f64,
    rate: f64,
    vol: f64,
    expiry: f64,
    dividend_yield: f64,
) -> f64 {
    let (d1, d2) = d1_d2(spot, strike, rate, vol, expiry, dividend_yield);
    let discount_r = libm::exp(-rate * expiry);
    let discount_q = libm::exp(-dividend_yield * expiry);

    match kind {
        OptionKind::Call => spot * discount_q * norm_cdf(d1) - strike * discount_r * norm_cdf(d2),
        OptionKind::Put => strike * discount_r * norm_cdf(-d2) - spot * discount_q * norm_cdf(-d1),
    }
}

/// Price and first and second order Greeks, using the conventions above.
pub fn quote(
    kind: OptionKind,
    spot: f64,
    strike: f64,
    rate: f64,
    vol: f64,
    expiry: f64,
    dividend_yield: f64,
) -> Quote {
    let (d1, d2) = d1_d2(spot, strike, rate, vol, expiry, dividend_yield);
    let sqrt_t = libm::sqrt(expiry);
    let discount_r = libm::exp(-rate * expiry);
    let discount_q = libm::exp(-dividend_yield * expiry);
    let pdf_d1 = norm_pdf(d1);
    let carry = rate - dividend_yield;

    let gamma = discount_q * pdf_d1 / (spot * vol * sqrt_t);
    let vega = spot * discount_q * pdf_d1 * sqrt_t;
    let vanna = -discount_q * pdf_d1 * d2 / vol;
    let volga = vega * d1 * d2 / vol;
    let charm_common =
        discount_q * pdf_d1 * (libm::log(spot / strike) - (carry + 0.5 * vol * vol) * expiry)
            / (2.0 * vol * expiry * sqrt_t);
    let theta_common = -spot * discount_q * pdf_d1 * vol / (2.0 * sqrt_t);

    let (value, delta, theta, rho, charm) = match kind {
        OptionKind::Call => {
            let value = spot * discount_q * norm_cdf(d1) - strike * discount_r * norm_cdf(d2);
            let delta = discount_q * norm_cdf(d1);
            let theta = theta_common + dividend_yield * spot * discount_q * norm_cdf(d1)
                - rate * strike * discount_r * norm_cdf(d2);
            let rho = strike * expiry * discount_r * norm_cdf(d2);
            let charm = charm_common + dividend_yield * discount_q * norm_cdf(d1);
            (value, delta, theta, rho, charm)
        }
        OptionKind::Put => {
            let value = strike * discount_r * norm_cdf(-d2) - spot * discount_q * norm_cdf(-d1);
            let delta = -discount_q * norm_cdf(-d1);
            let theta = theta_common - dividend_yield * spot * discount_q * norm_cdf(-d1)
                + rate * strike * discount_r * norm_cdf(-d2);
            let rho = -strike * expiry * discount_r * norm_cdf(-d2);
            let charm = charm_common - dividend_yield * discount_q * norm_cdf(-d1);
            (value, delta, theta, rho, charm)
        }
    };

    Quote {
        price: value,
        delta,
        gamma,
        vega,
        theta,
        rho,
        vanna,
        volga,
        charm,
    }
}

/// European option value for a grid of spot prices, holding every other input
/// fixed. Used by the comparison chart.
#[allow(clippy::too_many_arguments)]
pub fn price_curve(
    kind: OptionKind,
    spot_min: f64,
    spot_max: f64,
    points: usize,
    strike: f64,
    rate: f64,
    vol: f64,
    expiry: f64,
    dividend_yield: f64,
) -> Vec<f64> {
    let step = (spot_max - spot_min) / (points - 1) as f64;
    (0..points)
        .map(|index| {
            let spot = spot_min + step * index as f64;
            price(kind, spot, strike, rate, vol, expiry, dividend_yield)
        })
        .collect()
}
