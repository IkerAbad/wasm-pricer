import init, {
  asian_monte_carlo,
  build_vol_surface,
  quote,
  version,
} from "./pkg/wasm_pricer.js";

const PATHS = 3_000;
const STEPS = 64;
const SEED = 20_261_123;
const TARGET_MS = 16;
const LOAD_TARGET_MS = 1_000;
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const byId = (id) => document.getElementById(id);

const controls = {
  spot: {
    input: byId("spot"),
    output: byId("spot-value"),
    read: (value) => value,
    format: (value) => value.toFixed(1),
  },
  strike: {
    input: byId("strike"),
    output: byId("strike-value"),
    read: (value) => value,
    format: (value) => value.toFixed(1),
  },
  vol: {
    input: byId("vol"),
    output: byId("vol-value"),
    read: (value) => value / 100,
    format: (value) => `${value.toFixed(1)}%`,
  },
  rate: {
    input: byId("rate"),
    output: byId("rate-value"),
    read: (value) => value / 100,
    format: (value) => `${value.toFixed(1)}%`,
  },
  expiry: {
    input: byId("expiry"),
    output: byId("expiry-value"),
    read: (value) => value / 12,
    format: (value) => {
      const months = Math.round(value);
      const label = months === 1 ? "1 month" : `${months} months`;
      return `${label} (${(value / 12).toFixed(2)} y)`;
    },
  },
};

const state = {
  spot: 100,
  strike: 100,
  vol: 0.2,
  rate: 0.05,
  expiry: 1,
};

const view = {
  yaw: -0.7,
  pitch: 0.34,
  zoom: 1.1,
  auto: !REDUCED_MOTION,
  dragging: false,
};

let wasmReady = false;
let dirty = true;
let drawDirty = true;
let lastResult = null;
let lastFrameTime = performance.now();
let lastAutoDraw = 0;
const calcHistory = [];
const drawHistory = [];

window.__wasmPricer = {
  ready: false,
  version: null,
  loadMs: null,
  lastCalcMs: null,
  medianCalcMs: null,
  lastDrawMs: null,
  medianDrawMs: null,
  lastResult: null,
};

function median(values) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function formatNumber(value, digits = 4) {
  if (!Number.isFinite(value)) return "—";
  const threshold = 10 ** -digits;
  if (value !== 0 && Math.abs(value) < threshold) {
    return value.toExponential(2);
  }
  const rounded = Math.abs(value) < threshold * 0.5 ? 0 : value;
  return rounded.toFixed(digits);
}

function formatSigned(value, digits = 2) {
  if (!Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;
}

function setMetric(name, milliseconds, budget) {
  const item = byId(`${name}-item`);
  const value = byId(`${name}-time`);
  if (!Number.isFinite(milliseconds)) {
    value.textContent = "—";
    return;
  }
  item.classList.add("ready");
  item.classList.toggle("over", milliseconds > budget);
  value.textContent =
    milliseconds < 100 ? `${milliseconds.toFixed(1)} ms` : `${Math.round(milliseconds)} ms`;
}

function pushMetric(name, milliseconds) {
  const history = name === "calc" ? calcHistory : drawHistory;
  const limit = name === "calc" ? 12 : 24;
  history.push(milliseconds);
  while (history.length > limit) history.shift();
  const value = median(history);
  setMetric(name, value, TARGET_MS);
  if (name === "calc") {
    window.__wasmPricer.lastCalcMs = milliseconds;
    window.__wasmPricer.medianCalcMs = value;
  } else {
    window.__wasmPricer.lastDrawMs = milliseconds;
    window.__wasmPricer.medianDrawMs = value;
  }
}

function showError(message) {
  const banner = byId("error-banner");
  banner.textContent = message;
  banner.hidden = false;
  console.error(message);
}

function syncControls() {
  for (const [key, control] of Object.entries(controls)) {
    const raw = Number(control.input.value);
    state[key] = control.read(raw);
    control.output.textContent = control.format(raw);
    const min = Number(control.input.min);
    const max = Number(control.input.max);
    const percent = ((raw - min) / (max - min)) * 100;
    control.input.style.setProperty("--pct", `${percent}%`);
  }
}

function bindControls() {
  for (const control of Object.values(controls)) {
    control.input.addEventListener("input", () => {
      syncControls();
      dirty = true;
    });
  }

  byId("reset-button").addEventListener("click", () => {
    const defaults = { spot: 100, strike: 100, vol: 20, rate: 5, expiry: 12 };
    for (const [key, value] of Object.entries(defaults)) {
      controls[key].input.value = String(value);
    }
    syncControls();
    view.yaw = -0.7;
    view.pitch = 0.34;
    view.zoom = 1.1;
    dirty = true;
    drawDirty = true;
  });
}

class SurfaceRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.dirty = true;
    this.palette = [
      [0.0, [30, 105, 160]],
      [0.22, [46, 196, 182]],
      [0.48, [167, 201, 87]],
      [0.72, [255, 209, 102]],
      [1.0, [239, 99, 81]],
    ];

    this.resize = this.resize.bind(this);
    new ResizeObserver(this.resize).observe(canvas);
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
  }

  color(normalized, shade) {
    const stops = this.palette;
    let left = stops[0];
    let right = stops[stops.length - 1];
    for (let index = 1; index < stops.length; index += 1) {
      if (normalized <= stops[index][0]) {
        left = stops[index - 1];
        right = stops[index];
        break;
      }
    }
    const span = right[0] - left[0] || 1;
    const t = Math.min(1, Math.max(0, (normalized - left[0]) / span));
    const r = Math.round((left[1][0] + (right[1][0] - left[1][0]) * t) * shade);
    const g = Math.round((left[1][1] + (right[1][1] - left[1][1]) * t) * shade);
    const b = Math.round((left[1][2] + (right[1][2] - left[1][2]) * t) * shade);
    return `rgb(${r},${g},${b})`;
  }

  draw(surface) {
    if (!surface || !surface.values || surface.values.length === 0) return;

    const { ctx, width, height } = this;
    const { strikes, maturities, values } = surface;
    const rows = maturities.length;
    const cols = strikes.length;
    const strikeMin = strikes[0];
    const strikeMax = strikes[cols - 1];
    const maturityMin = maturities[0];
    const maturityMax = maturities[rows - 1];

    let minVol = Infinity;
    let maxVol = -Infinity;
    for (const value of values) {
      if (value < minVol) minVol = value;
      if (value > maxVol) maxVol = value;
    }
    minVol = Math.max(0, minVol * 0.96);
    maxVol *= 1.04;
    if (maxVol - minVol < 0.02) {
      minVol = Math.max(0, minVol - 0.01);
      maxVol += 0.01;
    }

    const yaw = view.yaw;
    const pitch = view.pitch;
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const cosPitch = Math.cos(pitch);
    const sinPitch = Math.sin(pitch);

    const xWorld = (column) => -1.2 + (column / (cols - 1)) * 2.4;
    const zWorld = (row) => -1 + (row / (rows - 1)) * 2.0;
    const yWorld = (value) => ((value - minVol) / (maxVol - minVol)) * 1.15;

    const rawProject = (x, y, z) => {
      const x1 = x * cosYaw + z * sinYaw;
      const z1 = -x * sinYaw + z * cosYaw;
      const y1 = y * cosPitch - z1 * sinPitch;
      const z2 = y * sinPitch + z1 * cosPitch;
      const perspective = 1 / (1 - z2 * 0.075);
      return { rx: x1 * perspective, ry: -y1 * perspective, depth: z2 };
    };

    let minRx = Infinity;
    let maxRx = -Infinity;
    let minRy = Infinity;
    let maxRy = -Infinity;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < cols; column += 1) {
        const point = rawProject(xWorld(column), yWorld(values[row * cols + column]), zWorld(row));
        if (point.rx < minRx) minRx = point.rx;
        if (point.rx > maxRx) maxRx = point.rx;
        if (point.ry < minRy) minRy = point.ry;
        if (point.ry > maxRy) maxRy = point.ry;
      }
    }

    const padding = width > 560
      ? { left: 58, right: 74, top: 34, bottom: 46 }
      : { left: 38, right: 52, top: 28, bottom: 38 };
    const availableWidth = width - padding.left - padding.right;
    const availableHeight = height - padding.top - padding.bottom;
    const fit = Math.min(
      availableWidth / Math.max(maxRx - minRx, 0.001),
      availableHeight / Math.max(maxRy - minRy, 0.001),
    );
    const scale = fit * view.zoom;
    const centerX =
      padding.left + availableWidth / 2 - ((minRx + maxRx) / 2) * scale;
    const centerY =
      padding.top + availableHeight / 2 - ((minRy + maxRy) / 2) * scale;
    const project = (x, y, z) => {
      const point = rawProject(x, y, z);
      return {
        x: centerX + point.rx * scale,
        y: centerY + point.ry * scale,
        depth: point.depth,
      };
    };

    ctx.clearRect(0, 0, width, height);

    // Floor grid.
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(125, 180, 255, 0.09)";
    for (let column = 0; column < cols; column += 4) {
      const from = project(xWorld(column), 0, zWorld(0));
      const to = project(xWorld(column), 0, zWorld(rows - 1));
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
    for (let row = 0; row < rows; row += 3) {
      const from = project(xWorld(0), 0, zWorld(row));
      const to = project(xWorld(cols - 1), 0, zWorld(row));
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }

    // Surface mesh with painter's algorithm.
    const quads = [];
    const worldPoint = (column, row) => {
      const value = values[row * cols + column];
      return [xWorld(column), yWorld(value), zWorld(row), value];
    };
    const light = [-0.36, 0.78, 0.51];
    const lightLength = Math.hypot(...light);
    const lx = light[0] / lightLength;
    const ly = light[1] / lightLength;
    const lz = light[2] / lightLength;

    for (let row = 0; row < rows - 1; row += 1) {
      for (let column = 0; column < cols - 1; column += 1) {
        const a = worldPoint(column, row);
        const b = worldPoint(column + 1, row);
        const c = worldPoint(column, row + 1);
        const d = worldPoint(column + 1, row + 1);
        const pa = project(a[0], a[1], a[2]);
        const pb = project(b[0], b[1], b[2]);
        const pc = project(c[0], c[1], c[2]);
        const pd = project(d[0], d[1], d[2]);

        const ux = b[0] - a[0];
        const uy = b[1] - a[1];
        const uz = b[2] - a[2];
        const vx = c[0] - a[0];
        const vy = c[1] - a[1];
        const vz = c[2] - a[2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const normalLength = Math.hypot(nx, ny, nz) || 1;
        nx /= normalLength;
        ny /= normalLength;
        nz /= normalLength;
        const lightAmount = Math.abs(nx * lx + ny * ly + nz * lz);
        const shade = 0.64 + 0.36 * lightAmount;
        const normalized = (a[3] - minVol) / (maxVol - minVol);
        const depth = (pa.depth + pb.depth + pc.depth + pd.depth) / 4;

        quads.push({
          depth,
          color: this.color(normalized, shade),
          points: [pa, pb, pd, pc],
        });
      }
    }

    quads.sort((left, right) => left.depth - right.depth);

    ctx.lineJoin = "round";
    for (const quad of quads) {
      const [p0, p1, p2, p3] = quad.points;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.lineTo(p3.x, p3.y);
      ctx.closePath();
      ctx.fillStyle = quad.color;
      ctx.fill();
    }

    this.drawAxes(project, xWorld, zWorld, width, cols, rows);

    // Marker for the option currently being priced.
    if (surface.markerVol > 0) {
      const column = ((state.strike - strikeMin) / (strikeMax - strikeMin)) * (cols - 1);
      const row = ((state.expiry - maturityMin) / (maturityMax - maturityMin)) * (rows - 1);
      const x = xWorld(column);
      const z = zWorld(row);
      const y = yWorld(surface.markerVol);
      const base = project(x, 0, z);
      const point = project(x, y, z);

      ctx.save();
      ctx.strokeStyle = "rgba(238, 244, 250, 0.4)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(base.x, base.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.shadowColor = "rgba(94, 234, 212, 0.8)";
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4.6, 0, Math.PI * 2);
      ctx.fillStyle = "#f3f7fa";
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(point.x, point.y, 7.5, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(94, 234, 212, 0.55)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    this.dirty = false;
  }

  drawAxes(project, xWorld, zWorld, width, cols, rows) {
    const ctx = this.ctx;
    const dense = width > 560;
    ctx.font = dense ? "11px Consolas, monospace" : "10px Consolas, monospace";
    ctx.textBaseline = "middle";

    const backZ = zWorld(0);
    const forwardZ = zWorld(rows - 1);
    const frontZ = project(0, 0, forwardZ).depth >= project(0, 0, backZ).depth ? forwardZ : backZ;
    const leftX = xWorld(0);
    const rightX = xWorld(cols - 1);
    const frontX = project(rightX, 0, 0).depth >= project(leftX, 0, 0).depth ? rightX : leftX;
    const side = frontX > 0 ? 1 : -1;

    ctx.strokeStyle = "rgba(125, 180, 255, 0.24)";
    ctx.lineWidth = 1;

    let from = project(xWorld(0), 0, frontZ);
    let to = project(xWorld(cols - 1), 0, frontZ);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    from = project(frontX, 0, backZ);
    to = project(frontX, 0, forwardZ);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    from = project(frontX, 0, frontZ);
    to = project(frontX, 1.15, frontZ);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();

    const strikeTicks = dense ? [40, 70, 100, 130, 160] : [40, 100, 160];
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(170, 187, 202, 0.8)";
    for (const strike of strikeTicks) {
      const column = ((strike - 40) / 120) * (cols - 1);
      const point = project(xWorld(column), 0, frontZ);
      ctx.fillText(String(strike), point.x, point.y + 14);
    }

    const maturityTicks = dense ? [1 / 12, 0.5, 1.0, 1.5, 2.0] : [1 / 12, 1.0, 2.0];
    ctx.textAlign = side > 0 ? "left" : "right";
    for (const maturity of maturityTicks) {
      const row = ((maturity - 1 / 12) / (2 - 1 / 12)) * (rows - 1);
      const point = project(frontX, 0, zWorld(row));
      const label = maturity < 1 ? `${Math.round(maturity * 12)}m` : `${maturity.toFixed(1)}y`;
      ctx.fillText(label, point.x + side * 10, point.y);
    }
  }
}

const renderer = new SurfaceRenderer(byId("surface"));

function readQuote(result) {
  return {
    price: result.price,
    delta: result.delta,
    gamma: result.gamma,
    vega: result.vega,
    theta: result.theta,
    rho: result.rho,
    vanna: result.vanna,
    volga: result.volga,
    charm: result.charm,
  };
}

function readAsian(result) {
  return {
    callPrice: result.call_price,
    callStandardError: result.call_standard_error,
    callRawPrice: result.call_raw_price,
    callRawStandardError: result.call_raw_standard_error,
    putPrice: result.put_price,
    putStandardError: result.put_standard_error,
    geometricCall: result.geometric_call,
    geometricPut: result.geometric_put,
    europeanCall: result.european_call,
    europeanCallStandardError: result.european_call_standard_error,
    europeanPut: result.european_put,
    europeanPutStandardError: result.european_put_standard_error,
    paths: result.paths,
    steps: result.steps,
  };
}

function compute(measure = true) {
  const started = performance.now();
  let call = null;
  let put = null;
  let asian = null;
  let surfaceObject = null;

  try {
    const { spot, strike, rate, vol, expiry } = state;
    call = quote("call", spot, strike, rate, vol, expiry, 0);
    put = quote("put", spot, strike, rate, vol, expiry, 0);
    asian = asian_monte_carlo(spot, strike, rate, vol, expiry, STEPS, PATHS, SEED);
    surfaceObject = build_vol_surface(spot, strike, rate, vol, expiry);

    const surface = {
      width: surfaceObject.width,
      height: surfaceObject.height,
      strikes: surfaceObject.strikes,
      maturities: surfaceObject.maturities,
      values: surfaceObject.values,
      markerVol: surfaceObject.marker_vol,
    };

    lastResult = {
      call: readQuote(call),
      put: readQuote(put),
      asian: readAsian(asian),
      surface,
    };

    updateReadouts(lastResult);
    window.__wasmPricer.lastResult = {
      call: lastResult.call,
      put: lastResult.put,
      asian: lastResult.asian,
      markerVol: surface.markerVol,
    };
    drawDirty = true;
    renderer.dirty = true;
  } catch (error) {
    showError(`Pricing failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (surfaceObject) surfaceObject.free();
    if (asian) asian.free();
    if (put) put.free();
    if (call) call.free();
  }

  const elapsed = performance.now() - started;
  if (measure) pushMetric("calc", elapsed);
}

function updateReadouts(result) {
  const { call, put, asian, surface } = result;

  byId("call-price").textContent = formatNumber(call.price, 4);
  byId("call-price").title = call.price.toFixed(10);
  byId("put-price").textContent = formatNumber(put.price, 4);
  byId("put-price").title = put.price.toFixed(10);

  byId("greek-delta").textContent = formatNumber(call.delta, 4);
  byId("greek-gamma").textContent = formatNumber(call.gamma, 5);
  byId("greek-vega").textContent = formatNumber(call.vega, 3);
  byId("greek-theta").textContent = formatNumber(call.theta, 3);
  byId("greek-rho").textContent = formatNumber(call.rho, 3);
  byId("greek-vanna").textContent = formatNumber(call.vanna, 4);
  byId("greek-volga").textContent = formatNumber(call.volga, 4);
  byId("greek-charm").textContent = formatNumber(call.charm, 5);

  byId("mc-closed").textContent = formatNumber(call.price, 4);
  byId("mc-european").textContent = formatNumber(asian.europeanCall, 4);
  byId("mc-european-se").textContent = `±${formatNumber(asian.europeanCallStandardError, 4)}`;
  const z =
    asian.europeanCallStandardError > 0
      ? (asian.europeanCall - call.price) / asian.europeanCallStandardError
      : 0;
  byId("mc-european-z").textContent = `z = ${formatSigned(z, 2)}`;
  byId("mc-european-z").title = "Difference from the closed form in Monte Carlo standard errors";

  byId("mc-asian").textContent = formatNumber(asian.callPrice, 4);
  byId("mc-asian-se").textContent = `±${formatNumber(asian.callStandardError, 4)}`;
  byId("mc-asian-raw").textContent = `raw ${formatNumber(asian.callRawPrice, 3)} ± ${formatNumber(
    asian.callRawStandardError,
    3,
  )}`;
  byId("mc-geometric").textContent = formatNumber(asian.geometricCall, 4);

  byId("mc-sample").textContent = `${asian.paths.toLocaleString("en-US")} paths · ${asian.steps} steps`;
  byId("mc-sample").title = `Seed ${SEED}`;

  const markerPercent = surface.markerVol * 100;
  byId("marker-vol").textContent = `${markerPercent.toFixed(2)}%`;

  let min = Infinity;
  let max = -Infinity;
  for (const value of surface.values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  byId("legend").hidden = false;
  byId("legend-min").textContent = `${(min * 100).toFixed(1)}%`;
  byId("legend-max").textContent = `${(max * 100).toFixed(1)}%`;
}

function draw() {
  if (!lastResult) return;
  const started = performance.now();
  renderer.draw(lastResult.surface);
  const elapsed = performance.now() - started;
  pushMetric("draw", elapsed);
  drawDirty = false;
}

function frame(now) {
  const delta = Math.min((now - lastFrameTime) / 1000, 0.05);
  lastFrameTime = now;

  if (dirty && wasmReady) {
    dirty = false;
    compute();
  }

  if (view.auto && !view.dragging) {
    view.yaw += 0.11 * delta;
  }

  const animate = view.auto && !view.dragging && now - lastAutoDraw > 33;
  if (wasmReady && lastResult && (drawDirty || renderer.dirty || animate)) {
    draw();
    lastAutoDraw = now;
  }

  requestAnimationFrame(frame);
}

function bindCanvas() {
  const canvas = byId("surface");
  let pointer = null;

  canvas.addEventListener("pointerdown", (event) => {
    view.dragging = true;
    pointer = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!view.dragging || !pointer) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    pointer = { x: event.clientX, y: event.clientY };
    view.yaw += dx * 0.008;
    view.pitch = Math.min(1.15, Math.max(-0.15, view.pitch + dy * 0.006));
    drawDirty = true;
  });

  const endPointer = (event) => {
    view.dragging = false;
    pointer = null;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      view.zoom = Math.min(1.9, Math.max(0.62, view.zoom * Math.exp(-event.deltaY * 0.0009)));
      drawDirty = true;
    },
    { passive: false },
  );

  canvas.addEventListener("dblclick", () => {
    view.yaw = -0.7;
    view.pitch = 0.34;
    view.zoom = 1.1;
    drawDirty = true;
  });

  canvas.addEventListener("keydown", (event) => {
    const key = event.key;
    if (key === "ArrowLeft") view.yaw -= 0.08;
    else if (key === "ArrowRight") view.yaw += 0.08;
    else if (key === "ArrowUp") view.pitch = Math.max(-0.15, view.pitch - 0.06);
    else if (key === "ArrowDown") view.pitch = Math.min(1.15, view.pitch + 0.06);
    else if (key === "+" || key === "=") view.zoom = Math.min(1.9, view.zoom * 1.08);
    else if (key === "-") view.zoom = Math.max(0.62, view.zoom / 1.08);
    else if (key === "Home") {
      view.yaw = -0.7;
      view.pitch = 0.34;
      view.zoom = 1.1;
    } else {
      return;
    }
    event.preventDefault();
    drawDirty = true;
  });
}

function bindRotationToggle() {
  const button = byId("rotate-toggle");
  const update = () => {
    button.setAttribute("aria-pressed", String(view.auto));
    button.textContent = view.auto ? "Pause rotation" : "Start rotation";
  };
  update();
  button.addEventListener("click", () => {
    view.auto = !view.auto;
    update();
    drawDirty = true;
  });
}

async function boot() {
  syncControls();
  bindControls();
  bindCanvas();
  bindRotationToggle();
  requestAnimationFrame(frame);

  const start = performance.now();
  try {
    await init();
    wasmReady = true;
    window.__wasmPricer.version = version();
    document.querySelector(".brand").title = `wasm-pricer ${window.__wasmPricer.version}`;

    // One warm-up pass, then the pass whose numbers stay on screen.
    compute(false);
    compute();
    draw();
    dirty = false;
    const loadMs = performance.now();
    window.__wasmPricer.ready = true;
    window.__wasmPricer.loadMs = loadMs;
    setMetric("load", loadMs, LOAD_TARGET_MS);
    byId("canvas-loading").classList.add("is-hidden");
    byId("load-item").title = `Time from navigation start to the first rendered surface (started at ${start.toFixed(
      0,
    )} ms)`;
  } catch (error) {
    byId("canvas-loading").textContent = "failed to load the pricing core";
    showError(
      `Could not load WebAssembly: ${
        error instanceof Error ? error.message : String(error)
      }. Serve this folder over HTTP (for example: python -m http.server -d web 8000).`,
    );
  }
}

boot();






