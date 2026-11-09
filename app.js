// app.js
// ---------------------------------------------------------------------------
// UI glue: builds the controls, starts Web Audio, sends engine/RPM/params to
// the DSP in dsp.js, and draws the crank timeline + oscilloscope.
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const MIN_RPM = 800, MAX_RPM = 18000;
const BANK_COLORS = ['#ff8a3d', '#3db8ff'];
const BANK_NAMES = ['A', 'B'];

let audioCtx = null;
let engineNode = null;           // AudioWorkletNode, or ScriptProcessorNode fallback
let send = () => {};             // sends a message to the DSP (whichever thread it runs on)
let dspStatus = null;            // { rpm, load, cut } reported by the DSP
let wetGain = null;              // room reverb level
let analyserL = null, analyserR = null;

let engine = ENGINES.find((e) => e.id === 'v8-cross');
let events = buildEvents(engine);
let setRpm = 1200;      // what the user selected
let revving = false;    // Space / "Hold to rev"
let sweepTimer = null;

// ---- Controls --------------------------------------------------------------

function populateEngines() {
  const select = $('engineSelect');
  const groups = {};
  for (const e of ENGINES) {
    if (!groups[e.group]) {
      groups[e.group] = document.createElement('optgroup');
      groups[e.group].label = e.group;
      select.appendChild(groups[e.group]);
    }
    const opt = new Option(e.name, e.id);
    groups[e.group].appendChild(opt);
  }
  select.value = engine.id;
  select.addEventListener('change', () => selectEngine(select.value));
}

function selectEngine(id) {
  engine = ENGINES.find((e) => e.id === id);
  events = buildEvents(engine);
  send({ type: 'engine', events, bankCount: engine.banks });
  applySoundPreset();
  updateInfo();
}

/** Load the engine's exhaust preset into the sliders (which also sends it to the DSP). */
function applySoundPreset() {
  const preset = soundFor(engine);
  $('redline').value = preset.redline;
  for (const [key, value] of Object.entries(preset)) {
    const el = document.querySelector(`[data-param="${key}"]`);
    if (!el) continue;
    el.value = value;
    el.dispatchEvent(new Event('input'));
  }
}

function getParams() {
  const params = {};
  document.querySelectorAll('[data-param]').forEach((el) => { params[el.dataset.param] = parseFloat(el.value); });
  return params;
}

function setupSliders() {
  document.querySelectorAll('[data-param]').forEach((el) => {
    const out = el.parentElement.querySelector('output');
    const show = () => { out.textContent = el.value; };
    show();
    el.addEventListener('input', () => {
      show();
      if (el.dataset.param === 'room' && wetGain) wetGain.gain.value = roomLevel();
      send({ type: 'params', params: { [el.dataset.param]: parseFloat(el.value) } });
    });
  });
}

function setupRpm() {
  const slider = $('rpmSlider'), input = $('rpmInput');
  slider.addEventListener('input', () => { stopSweep(); setUserRpm(+slider.value); });
  input.addEventListener('change', () => { stopSweep(); setUserRpm(+input.value); });
}

function setUserRpm(rpm) {
  setRpm = Math.round(Math.min(MAX_RPM, Math.max(MIN_RPM, rpm || MIN_RPM)));
  $('rpmSlider').value = setRpm;
  $('rpmInput').value = setRpm;
  sendTargetRpm();
}

function redline() {
  return Math.min(MAX_RPM, Math.max(MIN_RPM, +$('redline').value || 7500));
}

function targetRpm() { return revving ? redline() : setRpm; }

function sendTargetRpm() {
  // While revving, the DSP's rev limiter cuts ignition at the redline (bouncing "brrrap").
  send({ type: 'rpm', rpm: targetRpm(), limiter: revving });
}

function roomLevel() {
  return 0.6 * parseFloat(document.querySelector('[data-param=room]').value);
}

function setRevving(on) {
  if (!engineNode || revving === on) return;
  revving = on;
  $('revBtn').classList.toggle('active', on);
  sendTargetRpm();
}

function setupRev() {
  const btn = $('revBtn');
  btn.addEventListener('pointerdown', () => setRevving(true));
  btn.addEventListener('pointerup', () => setRevving(false));
  btn.addEventListener('pointerleave', () => setRevving(false));
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
      e.preventDefault();
      setRevving(true);
    }
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') setRevving(false); });
}

function setupSweep() {
  $('sweepBtn').addEventListener('click', () => {
    if (sweepTimer) { stopSweep(); return; }
    const from = MIN_RPM, to = redline(), duration = 10000, t0 = performance.now();
    $('sweepBtn').classList.add('active');
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / duration);
      setUserRpm(from + (to - from) * k);
      if (k < 1) sweepTimer = requestAnimationFrame(step); else stopSweep();
    };
    sweepTimer = requestAnimationFrame(step);
  });
}

function stopSweep() {
  if (sweepTimer) cancelAnimationFrame(sweepTimer);
  sweepTimer = null;
  $('sweepBtn').classList.remove('active');
}

// ---- Audio -----------------------------------------------------------------

async function startAudio() {
  if (audioCtx) {
    // Toggle start/stop.
    if (audioCtx.state === 'running') { await audioCtx.suspend(); $('startBtn').textContent = '▶ Start engine'; }
    else { await audioCtx.resume(); $('startBtn').textContent = '■ Stop engine'; }
    return;
  }

  audioCtx = new AudioContext({ latencyHint: 'interactive' });
  await createEngineNode();

  send({ type: 'params', params: getParams() });
  send({ type: 'engine', events, bankCount: engine.banks });
  sendTargetRpm();

  // Dry engine + a little room reverb (makes it sound recorded, not synthesized).
  const convolver = audioCtx.createConvolver();
  convolver.buffer = makeRoomImpulse(audioCtx, 1.6);
  wetGain = audioCtx.createGain();
  wetGain.gain.value = roomLevel();
  engineNode.connect(audioCtx.destination);
  engineNode.connect(convolver).connect(wetGain).connect(audioCtx.destination);

  // Two analysers (left/right) so you can see each bank's pulse train.
  const splitter = audioCtx.createChannelSplitter(2);
  analyserL = audioCtx.createAnalyser();
  analyserR = audioCtx.createAnalyser();
  analyserL.fftSize = analyserR.fftSize = 4096;
  engineNode.connect(splitter);
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);

  $('startBtn').textContent = '■ Stop engine';
  $('revBtn').disabled = false;
  $('sweepBtn').disabled = false;
  $('driveBtn').disabled = false;
}

// ---- Launch & drive --------------------------------------------------------

const IDLE_RPM = 900;
let wasDriving = false;

function setupDrive() {
  $('driveBtn').addEventListener('click', () => {
    if (dspStatus?.drive) { send({ type: 'driveStop' }); sendTargetRpm(); return; }
    stopSweep();
    // The DSP runs the whole sequence itself (sample-accurate shifts).
    send({ type: 'drive', redline: redline(), idle: IDLE_RPM });
    dspStatus = { ...(dspStatus || {}), drive: { phase: 'launch', gear: 1 } }; // until the DSP reports
  });
}

function updateDriveUi() {
  const driving = !!dspStatus?.drive;
  $('driveBtn').classList.toggle('active', driving);
  $('driveBtn').textContent = driving ? '■ Stop drive' : '🏁 Launch & drive';
  if (wasDriving && !driving) setUserRpm(IDLE_RPM); // sequence ended: sync the RPM slider
  wasDriving = driving;
}

const PHASE_NAMES = {
  launch: 'launch control', clutch: 'clutch drop', pull: 'full throttle',
  upshift: 'upshift', brake: 'braking', downshift: 'downshift (blip)', idle: 'clutch in',
};

/**
 * Preferred: AudioWorklet (audio thread, glitch-free).
 * Chrome refuses worklet modules on pages opened from file:// ("blob:null"),
 * so fall back to a ScriptProcessorNode running the same DSP on the main thread.
 */
async function createEngineNode() {
  try {
    const url = URL.createObjectURL(new Blob([buildWorkletSource()], { type: 'application/javascript' }));
    await audioCtx.audioWorklet.addModule(url);
    engineNode = new AudioWorkletNode(audioCtx, 'engine-processor', { outputChannelCount: [2] });
    engineNode.port.onmessage = (e) => { dspStatus = e.data; };
    send = (m) => engineNode.port.postMessage(m);
  } catch (err) {
    console.warn('AudioWorklet unavailable, using ScriptProcessor fallback:', err.message);
    const EngineDSP = createEngineDSPClass();
    const dsp = new EngineDSP(audioCtx.sampleRate);
    engineNode = audioCtx.createScriptProcessor(1024, 0, 2);
    engineNode.onaudioprocess = (e) => {
      dsp.render(e.outputBuffer.getChannelData(0), e.outputBuffer.getChannelData(1));
      dspStatus = dsp.status();
    };
    send = (m) => dsp.handle(m);
  }
}

/** Synthetic room: stereo noise with an exponential decay, darker over time. */
function makeRoomImpulse(ctx, seconds) {
  const len = Math.round(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / ctx.sampleRate;
      const k = Math.min(0.95, 0.2 + t * 1.2); // gets darker as it decays
      lp = lp * k + (Math.random() * 2 - 1) * (1 - k);
      d[i] = lp * Math.exp(-t * 4.5) * (i < 200 ? i / 200 : 1);
    }
  }
  return buf;
}

// ---- Info panel ------------------------------------------------------------

function updateInfo() {
  $('engineName').textContent = engine.name;
  $('engineNote').textContent = engine.note;
  $('statOrder').textContent = engine.firingOrder.join(' - ');
  $('statIntervals').textContent = engine.intervals.map((d) => `${d}°`).join(' ');

  const banks = $('statBanks');
  banks.innerHTML = '';
  if (engine.banks === 1) {
    banks.textContent = 'single exhaust: ' + bankGaps(events, 0).map((d) => `${d}°`).join(' ');
  } else {
    for (let b = 0; b < 2; b++) {
      const div = document.createElement('div');
      div.className = b === 0 ? 'bankA' : 'bankB';
      const cyls = events.filter((e) => e.bank === b).map((e) => e.cyl).join(',');
      div.textContent = `Bank ${BANK_NAMES[b]} (cyl ${cyls}): ` + bankGaps(events, b).map((d) => `${d}°`).join(' ');
      banks.appendChild(div);
    }
  }
}

function updateLiveStats(dt) {
  // Real values reported by the DSP when running; otherwise preview the selected RPM.
  const running = dspStatus && audioCtx && audioCtx.state === 'running';
  const rpm = running ? dspStatus.rpm : setRpm;
  const freq = (rpm / 120) * engine.firingOrder.length; // firings per second
  const msPerDeg = 1000 / (rpm * 6);
  const minGap = Math.min(...engine.intervals);
  const drive = running && dspStatus.drive;
  const cutText = dspStatus?.cut ? (drive ? ' · IGNITION CUT' : ' · LIMITER') : '';
  const driveText = drive ? ` · gear ${drive.gear} · ${PHASE_NAMES[drive.phase] || drive.phase}` : '';
  const loadText = running ? ` · load ${Math.round(dspStatus.load * 100)}%${cutText}${driveText}` : '';
  $('statRpm').textContent = `${Math.round(rpm)} rpm (${(rpm / 60).toFixed(1)} rev/s)${loadText}`;
  $('statFreq').textContent =
    `${freq.toFixed(1)} Hz average · shortest gap ${minGap}° = ${(minGap * msPerDeg).toFixed(2)} ms`;
}

// ---- Drawing ---------------------------------------------------------------

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  if (w && canvas.width !== w) { canvas.width = w; canvas.height = Math.round(w * 0.22); }
  return dpr;
}

function drawTimeline(now) {
  const canvas = $('timeline');
  const dpr = fitCanvas(canvas);
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  g.clearRect(0, 0, W, H);

  const m = 40 * dpr;
  const x = (deg) => m + (deg / 720) * (W - 2 * m);
  const rows = engine.banks === 1 ? [{ label: 'Exhaust', bank: 0 }] :
    [{ label: 'All', bank: -1 }, { label: 'Bank A', bank: 0 }, { label: 'Bank B', bank: 1 }];
  const rowH = (H - 24 * dpr) / rows.length;

  const cursor = slowCrank;

  g.font = `${11 * dpr}px system-ui, sans-serif`;
  g.textBaseline = 'middle';

  // Revolution markers.
  g.strokeStyle = '#2a2f3a';
  g.fillStyle = '#9aa1b2';
  g.lineWidth = dpr;
  for (const deg of [0, 180, 360, 540, 720]) {
    g.beginPath(); g.moveTo(x(deg), 0); g.lineTo(x(deg), H - 16 * dpr); g.stroke();
    g.textAlign = 'center';
    g.fillText(`${deg}°`, x(deg), H - 8 * dpr);
  }

  rows.forEach((row, r) => {
    const y = rowH * r + rowH * 0.62;
    const evs = row.bank < 0 ? events : events.filter((e) => e.bank === row.bank);

    g.fillStyle = '#9aa1b2';
    g.textAlign = 'right';
    g.fillText(row.label, m - 6 * dpr, y);
    g.strokeStyle = '#3a4050';
    g.beginPath(); g.moveTo(x(0), y); g.lineTo(x(720), y); g.stroke();

    evs.forEach((ev, i) => {
      // Gap label between this firing and the next one in this row.
      const nextAngle = i + 1 < evs.length ? evs[i + 1].angle : evs[0].angle + 720;
      const gap = nextAngle - ev.angle;
      const labelAt = (ev.angle + gap / 2) % 720; // wraps to the start for the last gap
      g.fillStyle = '#6c7386';
      g.textAlign = 'center';
      if (evs.length > 1 && x(gap) - x(0) > 26 * dpr) {
        g.fillText(`${gap}°`, x(labelAt), y + 12 * dpr);
      }

      // Pulse tick; glows briefly after the cursor passes it.
      const since = (cursor - ev.angle + 720) % 720;
      // Brightness follows the real combustion strength (load); dim when the limiter cuts.
      const glow = Math.max(0, 1 - since / 60) * glowStrength;
      const color = row.bank < 0 && engine.banks > 1 ? BANK_COLORS[ev.bank] : BANK_COLORS[row.bank < 0 ? 0 : row.bank];
      const h = rowH * (0.35 + 0.25 * glow);
      g.fillStyle = color;
      g.globalAlpha = 0.55 + 0.45 * glow;
      g.fillRect(x(ev.angle) - 2 * dpr, y - h, 4 * dpr, h);
      g.globalAlpha = 1;
      g.fillStyle = '#e6e8ee';
      g.fillText(String(ev.cyl), x(ev.angle), y - h - 7 * dpr);
    });
  });

  // Cursor.
  g.strokeStyle = '#ffffff';
  g.globalAlpha = 0.7;
  g.beginPath(); g.moveTo(x(cursor), 0); g.lineTo(x(cursor), H - 16 * dpr); g.stroke();
  g.globalAlpha = 1;
}

const scopeBuf = new Float32Array(4096);

function drawScope() {
  const canvas = $('scope');
  const dpr = fitCanvas(canvas);
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  g.clearRect(0, 0, W, H);
  g.strokeStyle = '#2a2f3a';
  g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
  if (!analyserL) {
    g.fillStyle = '#6c7386';
    g.font = `${13 * dpr}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.fillText('Press "Start engine"', W / 2, H / 2 - 12 * dpr);
    return;
  }
  [[analyserL, BANK_COLORS[0]], [analyserR, BANK_COLORS[1]]].forEach(([an, color]) => {
    an.getFloatTimeDomainData(scopeBuf);
    g.strokeStyle = color;
    g.globalAlpha = 0.85;
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    for (let i = 0; i < scopeBuf.length; i++) {
      const px = (i / (scopeBuf.length - 1)) * W;
      const py = H / 2 - scopeBuf[i] * H * 0.45;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.stroke();
  });
  g.globalAlpha = 1;
}

// The timeline cursor is the engine's real crank angle, slowed down SLOW_MOTION times
// (at 9000 rpm the real crank turns 150 times per second, impossible to see).
const SLOW_MOTION = 50;
let slowCrank = 0;
let glowStrength = 0;

function liveState() {
  const running = !!(dspStatus && audioCtx && audioCtx.state === 'running');
  return running ? { running, ...dspStatus } : { running, rpm: 0, load: 0, cut: false };
}

function updateTach(rpm) {
  const pct = (v) => `${Math.min(100, (v / MAX_RPM) * 100)}%`;
  $('tachFill').style.width = pct(rpm);
  $('tachFill').classList.toggle('over', rpm >= redline() - 50);
  $('tachRedline').style.left = pct(redline());
}

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const s = liveState();
  slowCrank = (slowCrank + (s.rpm * 6 * dt) / SLOW_MOTION) % 720; // rpm*6 = degrees per second
  glowStrength = s.running ? (s.cut ? 0.15 : 0.35 + 0.65 * s.load) : 0;
  updateTach(s.rpm);
  updateDriveUi();
  updateLiveStats(dt);
  drawTimeline(now);
  drawScope();
  requestAnimationFrame(frame);
}

// ---- Boot ------------------------------------------------------------------

populateEngines();
setupSliders();
applySoundPreset();
$('resetPresetBtn').addEventListener('click', applySoundPreset);
setupRpm();
setupRev();
setupSweep();
setupDrive();
$('startBtn').addEventListener('click', () => startAudio().catch((err) => {
  console.error(err);
  alert('Could not start audio: ' + err.message);
}));
updateInfo();
requestAnimationFrame(frame);
