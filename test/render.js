// test/render.js
// Runs the real DSP in Node (no browser) to verify:
//   1. combustion events fire at exactly the configured crank angles, in order
//   2. output is finite, not silent and not clipping hard, from idle to 20 000 rpm
// and writes WAV files to test/out/ so you can listen without a browser.
//
// Usage: node test/render.js

const fs = require('fs');
const path = require('path');
const { ENGINES, buildEvents, soundFor } = require('../engines.js');
const { createEngineDSPClass } = require('../dsp.js');

const SR = 48000;
const EngineDSP = createEngineDSPClass();

function makeEngine(engine, rpm, params = {}) {
  const d = new EngineDSP(SR);
  d.handle({ type: 'params', params: { ...soundFor(engine), ...params } });
  d.handle({ type: 'engine', events: buildEvents(engine), bankCount: engine.banks });
  d.handle({ type: 'rpm', rpm });
  d.rpm = rpm; // skip the spin-up
  return d;
}

function render(d, seconds, script) {
  const n = Math.round(seconds * SR), block = 128;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i += block) {
    if (script) script(i / SR, d);
    const m = Math.min(block, n - i);
    d.render(L.subarray(i, i + m), R.subarray(i, i + m));
  }
  return { L, R };
}

function writeWav(file, { L, R }) {
  const n = L.length, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

function stats({ L, R }) {
  let peak = 0, sum = 0, finite = true;
  for (let i = 0; i < L.length; i++) {
    if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) finite = false;
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    sum += L[i] * L[i] + R[i] * R[i];
  }
  return { peak, rms: Math.sqrt(sum / (2 * L.length)), finite };
}

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL ' + msg); };

for (const engine of ENGINES) {
  // --- 1. Timing: record the exact crank time of every combustion ---
  const rpm = 3000;
  const d = makeEngine(engine, rpm);
  const fired = [];
  let sample = 0;
  const origFire = d.fire.bind(d);
  d.fire = (ev, frac) => { fired.push({ ev, t: sample - frac }); origFire(ev, frac); };
  const L1 = new Float32Array(1), R1 = new Float32Array(1);
  for (sample = 0; sample < SR; sample++) d.render(L1, R1);

  const degPerSample = (rpm * 6) / SR;
  let maxErr = 0, orderOk = true;
  for (let i = 1; i < fired.length; i++) {
    const prevIdx = engine.firingOrder.indexOf(fired[i - 1].ev.cyl);
    const measured = (fired[i].t - fired[i - 1].t) * degPerSample;
    maxErr = Math.max(maxErr, Math.abs(measured - engine.intervals[prevIdx]));
    if (engine.firingOrder[(prevIdx + 1) % engine.firingOrder.length] !== fired[i].ev.cyl) orderOk = false;
  }

  // --- 2. Levels across the RPM range ---
  const levels = [800, 3000, 8000, 20000].map((r) => ({ rpm: r, ...stats(render(makeEngine(engine, r), 0.5)) }));

  console.log(`${engine.id.padEnd(9)} err=${maxErr.toFixed(4)}° order=${orderOk ? 'ok' : 'BAD'}  ` +
    levels.map((l) => `${l.rpm}:${l.rms.toFixed(3)}/${l.peak.toFixed(2)}`).join('  ') + '   (rms/peak)');

  const expectedCount = Math.round((rpm / 120) * engine.firingOrder.length);
  if (Math.abs(fired.length - expectedCount) > 1) fail(`${engine.id}: ${fired.length} pulses, expected ~${expectedCount}`);
  if (maxErr > 0.01) fail(`${engine.id}: angle error ${maxErr}`);
  if (!orderOk) fail(`${engine.id}: firing order wrong`);
  for (const l of levels) {
    if (!l.finite) fail(`${engine.id}@${l.rpm}: non-finite output`);
    if (l.rms < 0.02) fail(`${engine.id}@${l.rpm}: too quiet (${l.rms})`);
  }
}

// --- 3. WAV samples ---
const outDir = path.join(__dirname, 'out');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const samples = [['v8-cross', 900], ['v8-flat', 1000], ['v10-odd', 1100], ['v10-even', 11000],
  ['i4', 2500], ['i5', 3000], ['i6', 4000], ['v12', 9000], ['single', 1300], ['vtwin-45', 1000]];
for (const [id, rpm] of samples) {
  writeWav(path.join(outDir, `${id}_${rpm}.wav`), render(makeEngine(ENGINES.find((e) => e.id === id), rpm), 3));
}
// Rev sequences: idle, blip to redline with limiter, lift off (overrun crackle), back to idle.
for (const id of ['v8-cross', 'v8-flat', 'i4', 'v10-even']) {
  const engine = ENGINES.find((e) => e.id === id);
  const redline = soundFor(engine).redline;
  const d = makeEngine(engine, 900);
  writeWav(path.join(outDir, `${id}_revs.wav`), render(d, 7, (t, dsp) => {
    if (t > 1.5 && t < 4) dsp.handle({ type: 'rpm', rpm: redline, limiter: true });
    else dsp.handle({ type: 'rpm', rpm: 900, limiter: false });
  }));
}

// --- 4. Launch & drive sequence ---
console.log('\nLaunch & drive:');
for (const id of ['v8-cross', 'v8-flat', 'v6', 'v10-even', 'v10-s85', 'v10-f1', 'v12', 'i6-rb26', 'i6-2jz', 'i6-s54', 'flat4-ej', 'flat6']) {
  const engine = ENGINES.find((e) => e.id === id);
  const redline = soundFor(engine).redline;
  const d = makeEngine(engine, 900);
  const sp = soundFor(engine);
  d.handle({ type: 'drive', redline, idle: sp.idleRpm, launchRpm: sp.launchRpm, gearRatios: sp.gearRatios });
  const log = [];
  let last = '', maxRpm = 0, done = -1;
  const out = render(d, 40, (t, dsp) => {
    const s = dsp.status();
    maxRpm = Math.max(maxRpm, s.rpm);
    const key = s.drive ? `${s.drive.phase}${s.drive.gear}` : 'done';
    if (key !== last) {
      if (s.drive && !['upshift', 'downshift', 'clutch'].includes(s.drive.phase)) log.push(`${t.toFixed(1)}s ${s.drive.phase} g${s.drive.gear} @${Math.round(s.rpm)}`);
      if (!s.drive && done < 0) done = t;
      last = key;
    }
  });
  const st = stats(out);
  console.log(`  ${id.padEnd(9)} redline ${redline}, max ${Math.round(maxRpm)}, finished at ${done.toFixed(1)}s, final ${Math.round(d.rpm)} rpm`);
  console.log('    ' + log.join(' → '));
  if (done < 0) fail(`${id}: drive sequence never finished`);
  if (maxRpm > redline * 1.02) fail(`${id}: over-revved to ${maxRpm}`);
  if (Math.abs(d.rpm - sp.idleRpm) > 60) fail(`${id}: did not return to idle (${d.rpm})`);
  if (!st.finite) fail(`${id}: non-finite output during drive`);
  writeWav(path.join(outDir, `${id}_launch_drive.wav`), { L: out.L.subarray(0, Math.round((done + 1.5) * SR)), R: out.R.subarray(0, Math.round((done + 1.5) * SR)) });
}
console.log(`\nWAV files written to ${outDir}`);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
