//! Small deterministic PRNG and normal sampler.
//!
//! xoshiro256** provides the uniform stream. Normals come from the polar form
//! of the Box-Muller transform, which needs no trigonometry and caches the
//! second value of every accepted pair. All transcendental functions go through
//! `libm`, so native and WebAssembly builds produce the same bits.

use libm::log;

pub struct Rng {
    state: [u64; 4],
    spare: Option<f64>,
}

#[inline]
fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        let mut sm = seed;
        let state = [
            splitmix64(&mut sm),
            splitmix64(&mut sm),
            splitmix64(&mut sm),
            splitmix64(&mut sm),
        ];
        Self { state, spare: None }
    }

    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        let result = self.state[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.state[1] << 17;

        self.state[2] ^= self.state[0];
        self.state[3] ^= self.state[1];
        self.state[1] ^= self.state[2];
        self.state[0] ^= self.state[3];
        self.state[2] ^= t;
        self.state[3] = self.state[3].rotate_left(45);

        result
    }

    /// Uniform in [0, 1) with 53 random bits.
    #[inline]
    pub fn next_f64(&mut self) -> f64 {
        ((self.next_u64() >> 11) as f64) * (1.0 / 9_007_199_254_740_992.0)
    }

    #[inline]
    pub fn normal(&mut self) -> f64 {
        if let Some(value) = self.spare.take() {
            return value;
        }

        loop {
            let u = 2.0 * self.next_f64() - 1.0;
            let v = 2.0 * self.next_f64() - 1.0;
            let s = u * u + v * v;
            if s > 0.0 && s < 1.0 {
                let factor = libm::sqrt(-2.0 * log(s) / s);
                self.spare = Some(v * factor);
                return u * factor;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Rng;

    #[test]
    fn uniforms_are_in_range_and_not_constant() {
        let mut rng = Rng::new(7);
        let mut sum = 0.0;
        for _ in 0..10_000 {
            let value = rng.next_f64();
            assert!((0.0..1.0).contains(&value));
            sum += value;
        }
        let mean = sum / 10_000.0;
        assert!((mean - 0.5).abs() < 0.02, "mean was {mean}");
    }

    #[test]
    fn normals_have_expected_moments() {
        let mut rng = Rng::new(42);
        let n = 200_000;
        let mut sum = 0.0;
        let mut sum_sq = 0.0;
        for _ in 0..n {
            let value = rng.normal();
            sum += value;
            sum_sq += value * value;
        }
        let mean = sum / n as f64;
        let variance = sum_sq / n as f64 - mean * mean;
        assert!(mean.abs() < 0.02, "mean was {mean}");
        assert!((variance - 1.0).abs() < 0.03, "variance was {variance}");
    }

    #[test]
    fn same_seed_gives_same_stream() {
        let mut a = Rng::new(123);
        let mut b = Rng::new(123);
        for _ in 0..100 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }
}
