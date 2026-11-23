//! WebAssembly bindings for the pricing core.
//!
//! The pure Rust modules are public so integration tests can exercise them
//! without going through JavaScript. The exported structs below are thin
//! wrappers that hand the numbers to wasm-bindgen.

pub mod black_scholes;
pub mod monte_carlo;
pub mod svi;

mod prng;

use black_scholes::{OptionKind, Quote as CoreQuote};
use monte_carlo::AsianEstimate as CoreAsian;
use svi::SurfaceData;
use wasm_bindgen::prelude::*;

fn js_error(message: impl Into<String>) -> JsValue {
    JsValue::from_str(&message.into())
}

fn validate_market(
    spot: f64,
    strike: f64,
    rate: f64,
    vol: f64,
    expiry: f64,
    dividend: f64,
) -> Result<(), JsValue> {
    black_scholes::validate(spot, strike, vol, expiry).map_err(js_error)?;
    if !rate.is_finite() {
        return Err(js_error("rate must be finite"));
    }
    if !dividend.is_finite() {
        return Err(js_error("dividend yield must be finite"));
    }
    Ok(())
}

fn parse_kind(value: &str) -> Result<OptionKind, JsValue> {
    OptionKind::parse(value).ok_or_else(|| js_error("kind must be 'call' or 'put'"))
}

#[wasm_bindgen]
pub struct Quote {
    inner: CoreQuote,
}

#[wasm_bindgen]
impl Quote {
    #[wasm_bindgen(getter)]
    pub fn price(&self) -> f64 {
        self.inner.price
    }

    #[wasm_bindgen(getter)]
    pub fn delta(&self) -> f64 {
        self.inner.delta
    }

    #[wasm_bindgen(getter)]
    pub fn gamma(&self) -> f64 {
        self.inner.gamma
    }

    #[wasm_bindgen(getter)]
    pub fn vega(&self) -> f64 {
        self.inner.vega
    }

    #[wasm_bindgen(getter)]
    pub fn theta(&self) -> f64 {
        self.inner.theta
    }

    #[wasm_bindgen(getter)]
    pub fn rho(&self) -> f64 {
        self.inner.rho
    }

    #[wasm_bindgen(getter)]
    pub fn vanna(&self) -> f64 {
        self.inner.vanna
    }

    #[wasm_bindgen(getter)]
    pub fn volga(&self) -> f64 {
        self.inner.volga
    }

    #[wasm_bindgen(getter)]
    pub fn charm(&self) -> f64 {
        self.inner.charm
    }
}

#[wasm_bindgen]
pub fn quote(
    kind: &str,
    spot: f64,
    strike: f64,
    rate: f64,
    vol: f64,
    expiry: f64,
    dividend_yield: f64,
) -> Result<Quote, JsValue> {
    validate_market(spot, strike, rate, vol, expiry, dividend_yield)?;
    let option_kind = parse_kind(kind)?;
    Ok(Quote {
        inner: black_scholes::quote(option_kind, spot, strike, rate, vol, expiry, dividend_yield),
    })
}

#[wasm_bindgen]
pub struct AsianResult {
    inner: CoreAsian,
}

#[wasm_bindgen]
impl AsianResult {
    #[wasm_bindgen(getter)]
    pub fn call_price(&self) -> f64 {
        self.inner.call_price
    }

    #[wasm_bindgen(getter)]
    pub fn call_standard_error(&self) -> f64 {
        self.inner.call_standard_error
    }

    #[wasm_bindgen(getter)]
    pub fn call_raw_price(&self) -> f64 {
        self.inner.call_raw_price
    }

    #[wasm_bindgen(getter)]
    pub fn call_raw_standard_error(&self) -> f64 {
        self.inner.call_raw_standard_error
    }

    #[wasm_bindgen(getter)]
    pub fn put_price(&self) -> f64 {
        self.inner.put_price
    }

    #[wasm_bindgen(getter)]
    pub fn put_standard_error(&self) -> f64 {
        self.inner.put_standard_error
    }

    #[wasm_bindgen(getter)]
    pub fn put_raw_price(&self) -> f64 {
        self.inner.put_raw_price
    }

    #[wasm_bindgen(getter)]
    pub fn put_raw_standard_error(&self) -> f64 {
        self.inner.put_raw_standard_error
    }

    #[wasm_bindgen(getter)]
    pub fn geometric_call(&self) -> f64 {
        self.inner.geometric_call
    }

    #[wasm_bindgen(getter)]
    pub fn geometric_put(&self) -> f64 {
        self.inner.geometric_put
    }

    #[wasm_bindgen(getter)]
    pub fn european_call(&self) -> f64 {
        self.inner.european_call
    }

    #[wasm_bindgen(getter)]
    pub fn european_call_standard_error(&self) -> f64 {
        self.inner.european_call_standard_error
    }

    #[wasm_bindgen(getter)]
    pub fn european_put(&self) -> f64 {
        self.inner.european_put
    }

    #[wasm_bindgen(getter)]
    pub fn european_put_standard_error(&self) -> f64 {
        self.inner.european_put_standard_error
    }

    #[wasm_bindgen(getter)]
    pub fn paths(&self) -> usize {
        self.inner.paths
    }

    #[wasm_bindgen(getter)]
    pub fn steps(&self) -> usize {
        self.inner.steps
    }
}

#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn asian_monte_carlo(
    spot: f64,
    strike: f64,
    rate: f64,
    vol: f64,
    expiry: f64,
    steps: usize,
    paths: usize,
    seed: u32,
) -> Result<AsianResult, JsValue> {
    validate_market(spot, strike, rate, vol, expiry, 0.0)?;
    if steps == 0 || steps > 512 {
        return Err(js_error("steps must be between 1 and 512"));
    }
    if !(2..=2_000_000).contains(&paths) {
        return Err(js_error("paths must be between 2 and 2,000,000"));
    }
    Ok(AsianResult {
        inner: monte_carlo::asian_estimate(spot, strike, rate, vol, expiry, steps, paths, seed),
    })
}

#[wasm_bindgen]
pub struct VolatilitySurface {
    strikes: Vec<f64>,
    maturities: Vec<f64>,
    values: Vec<f64>,
    marker_vol: f64,
}

#[wasm_bindgen]
impl VolatilitySurface {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> usize {
        svi::STRIKES
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> usize {
        svi::MATURITIES
    }

    #[wasm_bindgen(getter)]
    pub fn strikes(&self) -> Vec<f64> {
        self.strikes.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn maturities(&self) -> Vec<f64> {
        self.maturities.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn values(&self) -> Vec<f64> {
        self.values.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn marker_vol(&self) -> f64 {
        self.marker_vol
    }
}

#[wasm_bindgen]
pub fn build_vol_surface(
    spot: f64,
    strike: f64,
    rate: f64,
    vol: f64,
    expiry: f64,
) -> Result<VolatilitySurface, JsValue> {
    validate_market(spot, strike, rate, vol, expiry, 0.0)?;
    let SurfaceData {
        strikes,
        maturities,
        values,
        marker_vol,
    } = svi::build_surface(spot, strike, rate, vol, expiry);
    Ok(VolatilitySurface {
        strikes,
        maturities,
        values,
        marker_vol,
    })
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
