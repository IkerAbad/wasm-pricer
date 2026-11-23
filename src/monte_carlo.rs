//! Arithmetic-average Asian options by Monte Carlo.
//!
//! Paths follow the exact lognormal transition of the risk-neutral geometric
//! Brownian motion, so there is no discretisation bias in the marginal
//! distribution. Monitoring is discrete, at the same steps used to build the
//! path: the average excludes spot and uses the prices at t_1 ... t_n.
//!
//! The arithmetic average has no simple closed form. The geometric average does,
//! and it is almost perfectly correlated with the arithmetic one, so it is used
//! as a control variate. The raw estimate is reported next to the adjusted one.

use crate::black_scholes::{norm_cdf, OptionKind};
use crate::prng::Rng;
use libm::{exp, log, sqrt};

#[derive(Clone, Debug)]
pub struct AsianEstimate {
    pub call_price: f64,
    pub call_standard_error: f64,
    pub call_raw_price: f64,
    pub call_raw_standard_error: f64,
    pub put_price: f64,
    pub put_standard_error: f64,
    pub put_raw_price: f64,
    pub put_raw_standard_error: f64,
    pub geometric_call: f64,
    pub geometric_put: f64,
    pub european_call: f64,
    pub european_call_standard_error: f64,
    pub european_put: f64,
    pub european_put_standard_error: f64,
    pub paths: usize,
    pub steps: usize,
}

/// Exact price of an option on the discrete geometric average of
/// S(t_1) ... S(t_n), with t_i = i * expiry / steps.
#[allow(clippy::too_many_arguments)]
pub fn geometric_asian_price(
    kind: OptionKind,
    spot: f64,
    strike: f64,
    rate: f64,
    vol: f64,
    expiry: f64,
    dividend_yield: f64,
    steps: usize,
) -> f64 {
    let n = steps as f64;
    let mean_log =
        log(spot) + (rate - dividend_yield - 0.5 * vol * vol) * expiry * (n + 1.0) / (2.0 * n);
    let variance = vol * vol * expiry * (n + 1.0) * (2.0 * n + 1.0) / (6.0 * n * n);
    let std_dev = sqrt(variance);
    let expected_geometric = exp(mean_log + 0.5 * variance);
    let d1 = (log(expected_geometric / strike) + 0.5 * variance) / std_dev;
    let d2 = d1 - std_dev;
    let discount = exp(-rate * expiry);

    match kind {
        OptionKind::Call => discount * (expected_geometric * norm_cdf(d1) - strike * norm_cdf(d2)),
        OptionKind::Put => discount * (strike * norm_cdf(-d2) - expected_geometric * norm_cdf(-d1)),
    }
}

fn mean_and_error(values: &[f64]) -> (f64, f64) {
    let n = values.len() as f64;
    let mean = values.iter().sum::<f64>() / n;
    let variance = values
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / (n - 1.0);
    (mean, sqrt(variance / n))
}

/// Raw and control-variate estimates for one payoff and its geometric twin.
fn summarise(y: &[f64], x: &[f64], known_geometric: f64) -> (f64, f64, f64, f64) {
    let n = y.len() as f64;
    let (mean_y, error_y) = mean_and_error(y);
    let mean_x = x.iter().sum::<f64>() / n;

    let mut covariance = 0.0;
    let mut variance_x = 0.0;
    for (value_y, value_x) in y.iter().zip(x.iter()) {
        covariance += (value_y - mean_y) * (value_x - mean_x);
        variance_x += (value_x - mean_x).powi(2);
    }
    covariance /= n - 1.0;
    variance_x /= n - 1.0;

    if variance_x <= 0.0 || !covariance.is_finite() {
        return (mean_y, error_y, mean_y, error_y);
    }

    let beta = covariance / variance_x;
    let adjusted = mean_y - beta * (mean_x - known_geometric);

    let residual_variance = y
        .iter()
        .zip(x.iter())
        .map(|(value_y, value_x)| (value_y - beta * value_x).powi(2))
        .sum::<f64>()
        / (n - 1.0);
    let adjusted_error = sqrt(residual_variance / n);

    (mean_y, error_y, adjusted, adjusted_error)
}

#[allow(clippy::too_many_arguments)]
pub fn asian_estimate(
    spot: f64,
    strike: f64,
    rate: f64,
    vol: f64,
    expiry: f64,
    dividend_yield: f64,
    steps: usize,
    paths: usize,
    seed: u32,
) -> AsianEstimate {
    let dt = expiry / steps as f64;
    let drift = (rate - dividend_yield - 0.5 * vol * vol) * dt;
    let diffusion = vol * sqrt(dt);
    let discount = exp(-rate * expiry);
    let log_spot = log(spot);

    let mut rng = Rng::new(seed as u64);
    let mut call_raw = Vec::with_capacity(paths);
    let mut call_geo = Vec::with_capacity(paths);
    let mut put_raw = Vec::with_capacity(paths);
    let mut put_geo = Vec::with_capacity(paths);
    let mut european_call = Vec::with_capacity(paths);
    let mut european_put = Vec::with_capacity(paths);

    for _ in 0..paths {
        let mut price = spot;
        let mut sum_prices = 0.0;
        let mut cumulative_log = 0.0;
        let mut sum_logs = 0.0;

        for _ in 0..steps {
            let increment = drift + diffusion * rng.normal();
            price *= exp(increment);
            cumulative_log += increment;
            sum_prices += price;
            sum_logs += cumulative_log;
        }

        let arithmetic = sum_prices / steps as f64;
        let geometric = exp(log_spot + sum_logs / steps as f64);

        call_raw.push(discount * (arithmetic - strike).max(0.0));
        put_raw.push(discount * (strike - arithmetic).max(0.0));
        call_geo.push(discount * (geometric - strike).max(0.0));
        put_geo.push(discount * (strike - geometric).max(0.0));
        european_call.push(discount * (price - strike).max(0.0));
        european_put.push(discount * (strike - price).max(0.0));
    }

    let geometric_call = geometric_asian_price(
        OptionKind::Call,
        spot,
        strike,
        rate,
        vol,
        expiry,
        dividend_yield,
        steps,
    );
    let geometric_put = geometric_asian_price(
        OptionKind::Put,
        spot,
        strike,
        rate,
        vol,
        expiry,
        dividend_yield,
        steps,
    );

    let (call_raw_price, call_raw_standard_error, call_price, call_standard_error) =
        summarise(&call_raw, &call_geo, geometric_call);
    let (put_raw_price, put_raw_standard_error, put_price, put_standard_error) =
        summarise(&put_raw, &put_geo, geometric_put);
    let (european_call, european_call_standard_error) = mean_and_error(&european_call);
    let (european_put, european_put_standard_error) = mean_and_error(&european_put);

    AsianEstimate {
        call_price,
        call_standard_error,
        call_raw_price,
        call_raw_standard_error,
        put_price,
        put_standard_error,
        put_raw_price,
        put_raw_standard_error,
        geometric_call,
        geometric_put,
        european_call,
        european_call_standard_error,
        european_put,
        european_put_standard_error,
        paths,
        steps,
    }
}
