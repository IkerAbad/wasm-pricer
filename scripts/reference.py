#!/usr/bin/env python3
"""Regenerate tests/reference.json with options-pricer.

The Rust and Node tests do not import options-pricer: they read the JSON this
script writes. Run it from the repository root with the options-pricer virtual
environment active, or point OPTIONS_PRICER_SRC at its src directory.

    OPTIONS_PRICER_SRC=../options-pricer/src python scripts/reference.py
"""

from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SRC = ROOT.parent / "options-pricer" / "src"
source = Path(os.environ.get("OPTIONS_PRICER_SRC", DEFAULT_SRC))
sys.path.insert(0, str(source))

import options_pricer  # noqa: E402
from options_pricer import black_scholes, monte_carlo, path_dependent  # noqa: E402

SPOT = 100.0
STRIKE = 100.0
RATE = 0.05
VOL = 0.20
EXPIRY = 1.0
STEPS = 64
REFERENCE_PATHS = 2_000_000
REFERENCE_SEED = 42


def geometric_asian(option_type: str) -> float:
    """Discrete geometric-average Asian, same monitoring dates as the MC."""
    n = float(STEPS)
    mean_log = math.log(SPOT) + (RATE - 0.5 * VOL * VOL) * EXPIRY * (n + 1.0) / (2.0 * n)
    variance = VOL * VOL * EXPIRY * (n + 1.0) * (2.0 * n + 1.0) / (6.0 * n * n)
    expected = math.exp(mean_log + 0.5 * variance)
    d1 = (math.log(expected / STRIKE) + 0.5 * variance) / math.sqrt(variance)
    d2 = d1 - math.sqrt(variance)
    discount = math.exp(-RATE * EXPIRY)

    if option_type == "call":
        return discount * (expected * black_scholes._norm_cdf(d1) - STRIKE * black_scholes._norm_cdf(d2))
    return discount * (STRIKE * black_scholes._norm_cdf(-d2) - expected * black_scholes._norm_cdf(-d1))


def main() -> None:
    greeks = black_scholes.greeks("call", SPOT, STRIKE, RATE, VOL, EXPIRY)
    european = monte_carlo.price_european(
        "call", SPOT, STRIKE, RATE, VOL, EXPIRY,
        paths=REFERENCE_PATHS, seed=REFERENCE_SEED, antithetic=False,
    )
    asian_call = path_dependent.asian_price(
        "call", SPOT, STRIKE, RATE, VOL, EXPIRY,
        steps=STEPS, paths=REFERENCE_PATHS, seed=REFERENCE_SEED, antithetic=False,
    )
    asian_put = path_dependent.asian_price(
        "put", SPOT, STRIKE, RATE, VOL, EXPIRY,
        steps=STEPS, paths=REFERENCE_PATHS, seed=REFERENCE_SEED, antithetic=False,
    )

    dividend_yield = 0.03
    dividend_greeks = black_scholes.greeks("call", SPOT, STRIKE, RATE, VOL, EXPIRY, dividend_yield)

    payload = {
        "source": f"options-pricer {getattr(options_pricer, '__version__', 'unknown')}",
        "command": "OPTIONS_PRICER_SRC=../options-pricer/src python scripts/reference.py",
        "market": {
            "spot": SPOT,
            "strike": STRIKE,
            "rate": RATE,
            "vol": VOL,
            "expiry": EXPIRY,
        },
        "black_scholes": {
            "call": black_scholes.call_price(SPOT, STRIKE, RATE, VOL, EXPIRY),
            "put": black_scholes.put_price(SPOT, STRIKE, RATE, VOL, EXPIRY),
            "greeks": {
                "delta": greeks.delta,
                "gamma": greeks.gamma,
                "vega": greeks.vega,
                "theta": greeks.theta,
                "rho": greeks.rho,
                "vanna": greeks.vanna,
                "volga": greeks.volga,
                "charm": greeks.charm,
            },
        },
        "dividend_case": {
            "dividend_yield": dividend_yield,
            "call": black_scholes.call_price(SPOT, STRIKE, RATE, VOL, EXPIRY, dividend_yield),
            "put": black_scholes.put_price(SPOT, STRIKE, RATE, VOL, EXPIRY, dividend_yield),
            "delta": dividend_greeks.delta,
        },
        "monte_carlo": {
            "steps": STEPS,
            "reference_paths": REFERENCE_PATHS,
            "reference_seed": REFERENCE_SEED,
            "european_call": {
                "price": european.price,
                "standard_error": european.standard_error,
            },
            "asian_call": {
                "price": asian_call.price,
                "standard_error": asian_call.standard_error,
            },
            "asian_put": {
                "price": asian_put.price,
                "standard_error": asian_put.standard_error,
            },
            "geometric_asian_call": geometric_asian("call"),
            "geometric_asian_put": geometric_asian("put"),
        },
        "tolerances": {
            "closed_form_absolute": 1e-9,
            "monte_carlo": "four combined standard errors for raw estimates; 0.01 absolute for the control-variate estimate",
        },
    }

    output = ROOT / "tests" / "reference.json"
    output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {output}")


if __name__ == "__main__":
    main()

