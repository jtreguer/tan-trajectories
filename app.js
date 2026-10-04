const { SYSTEMS, PALETTES } = flowModule();
const $ = (id) => document.getElementById(id);

// Worker built from flow.js source, so the page also works opened from file://.
const workerUrl = URL.createObjectURL(new Blob([`
  const M = (${flowModule.toString()})();
  onmessage = (e) => {
    const { W, H, opts } = e.data;
    const buf = M.render(W, H, { ...opts, onProgress: (p) => postMessage({ progress: p }) });
    postMessage({ buf }, [buf.buffer]);
  };
`], { type: "text/javascript" }));

const state = {
  system: "whirlpools",
  params: {},
  cx: 0, cy: 0, span: 12.6,
  seeds: 1500, arc: 30, width: 1.2,
  exposure: 0.35, kappa0: 1.5,
};

// ---------- slider helper ----------
function slider(container, key, spec, target) {
  const label = document.createElement("label");
  label.textContent = spec.label;
  const row = document.createElement("div");
  row.className = "row";
  const input = document.createElement("input");
  Object.assign(input, { type: "range", min: spec.min, max: spec.max, step: spec.step, value: target[key] });
  const val = document.createElement("span");
  val.className = "val";
  const decimals = (String(spec.step).split(".")[1] || "").length;
  const show = () => (val.textContent = Number(target[key]).toFixed(decimals));
  input.addEventListener("input", () => {
    target[key] = +input.value;
    show();
    if (spec.onEdit) spec.onEdit();
    schedulePreview();
  });
  row.append(input, val);
  container.append(label, row);
  show();
  return { set(v) { target[key] = v; input.value = v; show(); } };
}

// ---------- equations, presets, view ----------
let paramSliders = {}, viewSliders = {};
const markCustom = () => { $("preset").value = ""; };

const VIEW = {
  cx: { label: "Centre x", min: -15, max: 15, step: 0.05, onEdit: markCustom },
  cy: { label: "Centre y", min: -15, max: 15, step: 0.05, onEdit: markCustom },
  span: { label: "Visible height (world units)", min: 2, max: 60, step: 0.1, onEdit: markCustom },
};
for (const [k, spec] of Object.entries(VIEW)) viewSliders[k] = slider($("view"), k, spec, state);

for (const [key, s] of Object.entries(SYSTEMS)) $("system").add(new Option(s.label, key));

function buildSystem() {
  const sys = SYSTEMS[state.system];
  $("formula").textContent = sys.formula;
  $("preset").innerHTML = "";
  $("preset").add(new Option("— custom —", ""));
  for (const name of Object.keys(sys.presets)) $("preset").add(new Option(name, name));
  $("params").innerHTML = "";
  state.params = {};
  paramSliders = {};
  for (const [k, spec] of Object.entries(sys.params)) {
    state.params[k] = spec.value;
    paramSliders[k] = slider($("params"), k, { ...spec, onEdit: markCustom }, state.params);
  }
  applyPreset(Object.keys(sys.presets)[0]);
}

function applyPreset(name) {
  const p = SYSTEMS[state.system].presets[name];
  if (!p) return;
  $("preset").value = name;
  for (const k of Object.keys(paramSliders)) paramSliders[k].set(p[k]);
  for (const k of Object.keys(viewSliders)) viewSliders[k].set(p[k]);
  schedulePreview();
}

$("system").addEventListener("change", (e) => { state.system = e.target.value; buildSystem(); });
$("preset").addEventListener("change", (e) => applyPreset(e.target.value));

// ---------- trajectories & look ----------
slider($("traj"), "seeds", { label: "Number of trajectories", min: 100, max: 6000, step: 50 }, state);
slider($("traj"), "arc", { label: "Max length per trajectory", min: 2, max: 120, step: 1 }, state);
slider($("look"), "kappa0", { label: "Curvature scale (colour saturates around this κ)", min: 0.05, max: 10, step: 0.05 }, state);
slider($("look"), "width", { label: "Line width (px at full resolution)", min: 0.5, max: 4, step: 0.1 }, state);
slider($("look"), "exposure", { label: "Exposure", min: 0.02, max: 2, step: 0.01 }, state);

for (const name of Object.keys(PALETTES)) $("palette").add(new Option(name, name));
function showSwatch() {
  const stops = [...PALETTES[$("palette").value]];
  if ($("reverse").checked) stops.reverse();
  $("swatch").style.background = `linear-gradient(90deg, ${stops.join(",")})`;
}
for (const id of ["palette", "reverse", "colorMode", "bg", "both", "seed", "res"]) {
  $(id).addEventListener("input", () => { showSwatch(); schedulePreview(); });
}
$("shuffle").addEventListener("click", () => {
  $("seed").value = Math.floor(Math.random() * 1e6);
  schedulePreview();
});

// ---------- rendering ----------
function outputSize() {
  const [W, H] = $("res").value.split("x").map(Number);
  return { W, H };
}

function renderOpts(scale, step) {
  return {
    system: state.system, params: { ...state.params },
    cx: state.cx, cy: state.cy, span: state.span,
    seeds: state.seeds, seed: +$("seed").value || 0, arc: state.arc,
    step, both: $("both").checked,
    width: Math.max(0.5, state.width * scale),
    exposure: state.exposure, kappa0: state.kappa0,
    colorMode: $("colorMode").value, palette: $("palette").value,
    reverse: $("reverse").checked, bg: $("bg").value,
  };
}

function runJob(W, H, opts, onProgress) {
  const worker = new Worker(workerUrl);
  const promise = new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      if (e.data.progress !== undefined) return onProgress(e.data.progress);
      worker.terminate();
      resolve(e.data.buf);
    };
    worker.onerror = (e) => { worker.terminate(); reject(e); };
  });
  worker.postMessage({ W, H, opts });
  return { worker, promise };
}

const setStatus = (text, p) => {
  $("statusText").textContent = text;
  $("progress").style.width = `${Math.round((p ?? 0) * 100)}%`;
};

let previewJob = null, previewTimer = null, busyDownload = false;

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 200);
}

async function renderPreview() {
  if (previewJob) previewJob.worker.terminate();
  const { W, H } = outputSize();
  const stage = document.querySelector(".stage");
  const fit = Math.min(stage.clientWidth / W, stage.clientHeight / H, 1);
  const scale = Math.min(fit * Math.min(window.devicePixelRatio || 1, 2), 1280 / W);
  const pw = Math.max(64, Math.round(W * scale)), ph = Math.max(36, Math.round(H * scale));
  const t0 = performance.now();
  const job = (previewJob = runJob(pw, ph, renderOpts(pw / W, 1.0), (p) => {
    if (!busyDownload) setStatus("Rendering preview…", p);
  }));
  const buf = await job.promise;
  if (job !== previewJob) return;
  previewJob = null;
  const canvas = $("canvas");
  canvas.width = pw; canvas.height = ph;
  canvas.style.width = `${Math.round(W * fit)}px`;
  canvas.getContext("2d").putImageData(new ImageData(buf, pw, ph), 0, 0);
  if (!busyDownload) setStatus(`Preview ${pw}×${ph} in ${((performance.now() - t0) / 1000).toFixed(1)} s`, 0);
}

$("download").addEventListener("click", async () => {
  const { W, H } = outputSize();
  busyDownload = true;
  $("download").disabled = true;
  const t0 = performance.now();
  const job = runJob(W, H, renderOpts(1, 0.5), (p) => setStatus(`Rendering ${W}×${H}…`, p));
  const buf = await job.promise;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  c.getContext("2d").putImageData(new ImageData(buf, W, H), 0, 0);
  c.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tan-${state.system}-${$("palette").value.replace(/\W+/g, "").toLowerCase()}-${W}x${H}-${$("seed").value}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setStatus(`Saved ${W}×${H} in ${((performance.now() - t0) / 1000).toFixed(1)} s`, 0);
    busyDownload = false;
    $("download").disabled = false;
  }, "image/png");
});

window.addEventListener("resize", schedulePreview);

$("palette").value = "Magma";
showSwatch();
buildSystem();
