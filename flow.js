// Flow-field renderer shared by the browser worker and the Node preview script.
// Pure functions only: no DOM access, so it can be stringified into a Worker.

function flowModule() {
  const SYSTEMS = {
    whirlpools: {
      label: "Damped whirlpools",
      formula: "x' = tan(k·sin(ω·y)) − d·x\ny' = −tan(k·sin(ω·x)) − d·y",
      params: {
        k: { label: "k (tan gain)", min: 0.2, max: 1.55, step: 0.01, value: 1.3 },
        w: { label: "ω (frequency)", min: 0.2, max: 3, step: 0.01, value: 1 },
        d: { label: "d (damping)", min: 0, max: 0.6, step: 0.005, value: 0.15 },
      },
      field: (p) => (x, y) => [
        Math.tan(p.k * Math.sin(p.w * y)) - p.d * x,
        -Math.tan(p.k * Math.sin(p.w * x)) - p.d * y,
      ],
      presets: {
        "Whirlpools (original)": { k: 1.3, w: 1, d: 0.15, cx: 0, cy: 0, span: 12.6 },
        "Slow drift": { k: 1.45, w: 1, d: 0.05, cx: 0, cy: 0, span: 12.6 },
        "Tight vortices": { k: 1.0, w: 1, d: 0.3, cx: 0, cy: 0, span: 12.6 },
        "Wide field": { k: 1.3, w: 1, d: 0.08, cx: 0, cy: 0, span: 30 },
        "High frequency": { k: 1.4, w: 2.2, d: 0.12, cx: 0, cy: 0, span: 12.6 },
        "Off-centre close-up": { k: 1.35, w: 1, d: 0.1, cx: 3.2, cy: 3.0, span: 7 },
      },
    },
    spirals: {
      label: "Mixed-angle spirals",
      formula: "x' = b·sin(y) + tan(a·cos(x+y))\ny' = −b·sin(x) + tan(a·sin(x−y))",
      params: {
        a: { label: "a (tan gain)", min: 0.05, max: 1.55, step: 0.01, value: 0.6 },
        b: { label: "b (rotation)", min: 0, max: 2, step: 0.01, value: 1 },
      },
      field: (p) => (x, y) => [
        p.b * Math.sin(y) + Math.tan(p.a * Math.cos(x + y)),
        -p.b * Math.sin(x) + Math.tan(p.a * Math.sin(x - y)),
      ],
      presets: {
        "Spiral garden (original)": { a: 0.6, b: 1, cx: 0, cy: 0, span: 12.6 },
        "Gentle": { a: 0.3, b: 1, cx: 0, cy: 0, span: 12.6 },
        "Strong shear": { a: 1.0, b: 1, cx: 0, cy: 0, span: 12.6 },
        "Shear-dominated": { a: 1.3, b: 0.5, cx: 0, cy: 0, span: 12.6 },
        "Wide field": { a: 0.6, b: 1, cx: 0, cy: 0, span: 30 },
        "Close-up": { a: 0.7, b: 1, cx: 0.8, cy: -0.8, span: 6 },
      },
    },
  };

  const PALETTES = {
    Magma: ["#000004", "#3b0f70", "#8c2981", "#de4968", "#fe9f6d", "#fcfdbf"],
    Viridis: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
    Ocean: ["#12305c", "#1f5f99", "#2e9cc4", "#7fd3f8", "#e6f9ff"],
    Ember: ["#5a1300", "#a8320a", "#e0601a", "#ffaa45", "#fff3c9"],
    Aurora: ["#3a1c7a", "#2353a8", "#00a6a6", "#7cfc9a", "#f4ffb8"],
    "Rose quartz": ["#6b3a63", "#a4567d", "#d989a8", "#f4c9d6", "#fff6f8"],
    Neon: ["#ff007f", "#a100ff", "#2d6bff", "#00e5ff"],
    Gold: ["#5c3b00", "#9c6b12", "#d4a63a", "#f5d77a", "#fffbe6"],
    "Ink (mono)": ["#3a3a3a", "#ffffff"],
  };

  function hexToRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // 256-entry lookup table, linear interpolation between evenly spaced stops.
  function paletteLut(stops, reverse) {
    const c = stops.map(hexToRgb);
    if (reverse) c.reverse();
    const lut = new Float32Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = (i / 255) * (c.length - 1);
      const j = Math.min(Math.floor(t), c.length - 2);
      const f = t - j;
      for (let ch = 0; ch < 3; ch++) lut[i * 3 + ch] = c[j][ch] * (1 - f) + c[j + 1][ch] * f;
    }
    return lut;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Gaussian splat kernel for the given line width (in output pixels).
  function makeKernel(width) {
    const sigma = Math.max(width, 0.5) * 0.45;
    const r = Math.max(1, Math.ceil(2.2 * sigma));
    return { sigma, r, inv2s2: 1 / (2 * sigma * sigma) };
  }

  /**
   * Render into a Uint8ClampedArray RGBA buffer of size W×H.
   * opts: system, params, cx, cy, span, seeds, seed, arc, step, both, width,
   *       exposure, kappa0, colorMode, palette, reverse, bg, onProgress
   * `step` is the integration step in output pixels.
   */
  function render(W, H, opts) {
    const sys = SYSTEMS[opts.system];
    const F = sys.field(opts.params);
    const ppu = H / opts.span;                  // pixels per world unit
    const h = opts.step / ppu;                  // world step
    const x0w = opts.cx - (W / 2) / ppu, y0w = opts.cy + (H / 2) / ppu;
    const margin = 0.15 * opts.span;
    const xmin = x0w - margin, xmax = x0w + W / ppu + margin;
    const ymax = y0w + margin, ymin = y0w - H / ppu - margin;
    const maxSteps = Math.ceil(opts.arc / h);
    const lut = paletteLut(PALETTES[opts.palette], opts.reverse);
    const kern = makeKernel(opts.width);
    const signed = opts.colorMode === "signed";
    const k0 = opts.kappa0;

    const acc = new Float32Array(W * H * 4);    // r, g, b, weight
    const rng = mulberry32(opts.seed >>> 0);

    const splat = (px, py, ci) => {
      const cr = lut[ci], cg = lut[ci + 1], cb = lut[ci + 2];
      const ix = Math.round(px), iy = Math.round(py), r = kern.r;
      for (let yy = iy - r; yy <= iy + r; yy++) {
        if (yy < 0 || yy >= H) continue;
        const dy = yy - py;
        for (let xx = ix - r; xx <= ix + r; xx++) {
          if (xx < 0 || xx >= W) continue;
          const dx = xx - px;
          const w = Math.exp(-(dx * dx + dy * dy) * kern.inv2s2);
          if (w < 0.01) continue;
          const o = (yy * W + xx) * 4;
          acc[o] += cr * w; acc[o + 1] += cg * w; acc[o + 2] += cb * w; acc[o + 3] += w;
        }
      }
    };

    const unit = (x, y) => {
      const v = F(x, y);
      const s = Math.hypot(v[0], v[1]);
      return [v[0] / s, v[1] / s, s];
    };

    const trace = (sx, sy, dir) => {
      let x = sx, y = sy;
      const hh = h * dir;
      for (let i = 0; i < maxSteps; i++) {
        const k1 = unit(x, y);
        if (!(k1[2] > 1e-4)) return;            // fixed point (or NaN): stop
        const k2 = unit(x + hh / 2 * k1[0], y + hh / 2 * k1[1]);
        // Curvature from the turn of the unit tangent over half a step.
        const kappa = (k1[0] * k2[1] - k1[1] * k2[0]) / (h / 2);
        const k3 = unit(x + hh / 2 * k2[0], y + hh / 2 * k2[1]);
        const k4 = unit(x + hh * k3[0], y + hh * k3[1]);
        x += hh * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]) / 6;
        y += hh * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]) / 6;
        if (!(x > xmin && x < xmax && y > ymin && y < ymax)) return;
        const t = signed ? 0.5 + 0.5 * Math.tanh(kappa / k0) : Math.tanh(Math.abs(kappa) / k0);
        splat((x - x0w) * ppu, (y0w - y) * ppu, Math.min(255, Math.max(0, Math.round(t * 255))) * 3);
      }
    };

    const n = opts.seeds;
    for (let s = 0; s < n; s++) {
      const sx = xmin + rng() * (xmax - xmin), sy = ymin + rng() * (ymax - ymin);
      trace(sx, sy, 1);
      if (opts.both) trace(sx, sy, -1);
      if (opts.onProgress && s % 64 === 0) opts.onProgress(s / n);
    }

    // Tone map: average colour per pixel, opacity from accumulated density.
    const bg = hexToRgb(opts.bg);
    const out = new Uint8ClampedArray(W * H * 4);
    const ex = opts.exposure * opts.step;       // density per pixel scales as 1/step
    for (let i = 0, o = 0; i < W * H; i++, o += 4) {
      const wsum = acc[o + 3];
      const a = 1 - Math.exp(-ex * wsum);
      const inv = wsum > 0 ? 1 / wsum : 0;
      out[o] = bg[0] + (acc[o] * inv - bg[0]) * a;
      out[o + 1] = bg[1] + (acc[o + 1] * inv - bg[1]) * a;
      out[o + 2] = bg[2] + (acc[o + 2] * inv - bg[2]) * a;
      out[o + 3] = 255;
    }
    return out;
  }

  return { SYSTEMS, PALETTES, render };
}

if (typeof module !== "undefined") module.exports = flowModule;
