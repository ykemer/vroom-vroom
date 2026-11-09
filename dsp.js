// dsp.js
// ---------------------------------------------------------------------------
// The engine sound model. Pure JS, no browser APIs, so the same code runs in:
//   * an AudioWorklet (audio thread)            - preferred
//   * a ScriptProcessorNode (main thread)       - fallback when opened from file://
//   * Node.js                                   - test/render.js
//
// Everything is wrapped in createEngineDSPClass() so it can be stringified
// into the worklet Blob.
//
// MODEL (physically informed, per cylinder):
//
//   crank angle θ (local to each cylinder, 0° = firing TDC)
//     │
//     ├─ combustion at 0°: picks this cycle's pressure (load × random variation)
//     ├─ exhaust valve opens at 135°: BLOWDOWN pulse (steep rise, decay over ~30°)
//     ├─ 180°-360°: piston pushes the rest of the gas out (DISPLACEMENT hump)
//     └─ 350°-590°: intake valve open (INTAKE roar)
//
//   The source is shaped in CRANK DEGREES (so it stretches/shrinks with RPM),
//   while the pipes and muffler are fixed in TIME (fixed resonances/formants).
//   That split is what makes it sound like an engine and not a buzzer.
//
//   cyl ─► header runner (own length) ─┐
//   cyl ─► header runner (own length) ─┼─► collector ─► saturation ─► main pipe
//   ...                                 │      ─► mid resonator ─► muffler ─► tailpipe
//   overrun pops / afterfire ──────────┘
//
//   bank A → left, bank B → right, + engine block resonance + intake roar.
// ---------------------------------------------------------------------------

function createEngineDSPClass() {
  const C = 343;          // speed of sound in m/s
  const RES = 4;          // crank table resolution: entries per degree
  const TLEN = 720 * RES;
  const EVO = 135;        // exhaust valve opens (deg after firing TDC)
  const EVC = 380;        // exhaust valve closes
  const IVC = 590;        // intake valve closes
  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const hash = (i) => { const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); };

  // ---------------- small DSP building blocks ----------------

  class Biquad {
    constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
    _set(b0, b1, b2, a0, a1, a2) { this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; }
    _wc(f, q, sr) { const w = (2 * Math.PI * clamp(f, 10, sr * 0.45)) / sr; return [Math.cos(w), Math.sin(w) / (2 * q)]; }
    lowpass(f, q, sr) { const [c, a] = this._wc(f, q, sr); this._set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + a, -2 * c, 1 - a); return this; }
    highpass(f, q, sr) { const [c, a] = this._wc(f, q, sr); this._set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + a, -2 * c, 1 - a); return this; }
    bandpass(f, q, sr) { const [c, a] = this._wc(f, q, sr); this._set(a, 0, -a, 1 + a, -2 * c, 1 - a); return this; }
    process(x) {
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
      return y;
    }
  }

  class OnePole {
    constructor() { this.y = 0; this.a = 0; }
    set(f, sr) { this.a = Math.exp((-2 * Math.PI * f) / sr); return this; }
    process(x) { this.y = x + this.a * (this.y - x); return this.y; }
  }

  /** Feedback comb = a pipe section: the wave travels to the end and back. */
  class PipeSection {
    constructor(maxSamples) { this.buf = new Float32Array(maxSamples); this.w = 0; this.d = 1; this.g = 0; this.lp = new OnePole(); }
    set(lengthM, reflection, dampHz, sr) {
      this.d = clamp(Math.round(((2 * lengthM) / C) * sr), 1, this.buf.length - 1);
      this.g = reflection;
      this.lp.set(dampHz, sr);
    }
    process(x) {
      let r = this.w - this.d; if (r < 0) r += this.buf.length;
      const y = x + this.g * this.lp.process(this.buf[r]);
      this.buf[this.w] = y;
      if (++this.w >= this.buf.length) this.w = 0;
      return y;
    }
  }

  // ---------------- crank-angle tables (one 720° cycle of one cylinder) ----------------

  function buildTables() {
    const blow = new Float32Array(TLEN + 1);   // exhaust blowdown
    const disp = new Float32Array(TLEN + 1);   // piston displacement push
    const intake = new Float32Array(TLEN + 1); // intake flow
    const ivc = new Float32Array(TLEN + 1);    // intake valve closing pulse
    const press = new Float32Array(TLEN + 1);  // in-cylinder combustion pressure
    for (let k = 0; k <= TLEN; k++) {
      const th = (k % TLEN) / RES;
      if (th >= EVO && th <= EVC) {
        const u = th - EVO;
        const taper = Math.min(1, (EVC - th) / 40);
        blow[k] = (1 - Math.exp(-u / 3.5)) * Math.exp(-u / 28) * taper;
      }
      if (th >= 180 && th <= 360) disp[k] = Math.sin((Math.PI * (th - 180)) / 180);
      if (th >= 350 && th <= 590) intake[k] = Math.sin((Math.PI * (th - 350)) / 240);
      // Intake valve slamming shut stops the moving air column: a sharp pressure
      // pulse that rings in the intake runners. This is the "induction howl".
      if (th >= IVC && th <= IVC + 90) { const u = th - IVC; ivc[k] = (1 - Math.exp(-u / 2)) * Math.exp(-u / 14); }
      const t = th > 360 ? th - 720 : th;
      press[k] = Math.exp(-(((t - 10) / 16) ** 2));
    }
    const peak = Math.max(...blow);
    for (let k = 0; k <= TLEN; k++) blow[k] /= peak;
    const ivcPeak = Math.max(...ivc);
    for (let k = 0; k <= TLEN; k++) ivc[k] /= ivcPeak;
    // Rate of change of intake flow: the suction wave when the intake valve opens
    // (and the stop when it closes). With ITBs this is heard directly at the trumpet.
    const intakeD = new Float32Array(TLEN + 1);
    for (let k = 0; k <= TLEN; k++) intakeD[k] = intake[(k + 1) % TLEN] - intake[(k + TLEN - 1) % TLEN];
    const idPeak = Math.max(...intakeD.map(Math.abs));
    for (let k = 0; k <= TLEN; k++) intakeD[k] /= idPeak;
    // Block vibration is driven by the CHANGE of cylinder pressure (the "knock" of combustion).
    const mech = new Float32Array(TLEN + 1);
    for (let k = 0; k <= TLEN; k++) mech[k] = press[(k + 1) % TLEN] - press[(k + TLEN - 1) % TLEN];
    const mp = Math.max(...mech.map(Math.abs));
    for (let k = 0; k <= TLEN; k++) mech[k] /= mp;
    return { blow, disp, intake, intakeD, ivc, mech };
  }

  function lookup(table, th) {
    const x = th * RES, i = x | 0, f = x - i;
    return table[i] + (table[i + 1] - table[i]) * f;
  }

  // ---------------- one exhaust bank ----------------

  class Bank {
    constructor(sr, scale) {
      this.sr = sr; this.scale = scale;
      this.pipe = new PipeSection(Math.ceil(sr * 0.06));
      this.mid = new PipeSection(Math.ceil(sr * 0.02));
      this.m1 = new Biquad(); this.m2 = new Biquad();
      this.boom = new Biquad();
      this.boomGain = 0.5;
      this.prev = 0;
      this.turbine = new OnePole().set(700, sr);   // turbo turbine smooths the pulses
      this.raspSplit = new OnePole().set(900, sr); // splits off the upper band for rasp
      this.pops = Array.from({ length: 8 }, () => ({ wait: -1, t: 0, amp: 0, decay: 0 }));
      this.nextPop = 0;
    }
    configure(p) {
      // Bank B's pipe can differ from bank A's (asymmetric dual exhaust = more rumble).
      const L = p.pipeLength * (1 + this.scale * p.bankSkew), sr = this.sr, res = p.resonance;
      // Strong resonance = deep drone (muscle V8). Weak = firing pitch dominates (exotic V10/V12).
      this.pipe.set(L, -(0.1 + 0.6 * res), 1500 + 3000 * (1 - res), sr);
      this.mid.set(L * 0.27, -(0.1 + 0.3 * res), 2500, sr);
      this.boom.bandpass(clamp(C / (4 * L), 35, 220), 1.5, sr);
      this.boomGain = 0.1 + 0.8 * res;
      this.res = res;
    }
    /** Muffler cutoff changes continuously (exhaust valve flap opens with RPM/load). */
    setMuffler(hz) {
      this.m1.lowpass(hz, 0.7 + this.res * 0.6, this.sr);
      this.m2.lowpass(hz * 1.6, 0.707, this.sr);
    }
    schedulePop(delaySamples, amp) {
      const pop = this.pops[this.nextPop];
      this.nextPop = (this.nextPop + 1) % this.pops.length;
      pop.wait = delaySamples; pop.t = 0; pop.amp = amp;
      pop.decay = Math.exp(-1 / (this.sr * (0.002 + Math.random() * 0.004)));
    }
    process(x, noise, drive, rasp, turbo) {
      // Afterfire: unburnt fuel igniting in the hot pipe -> sharp crack + noise burst.
      for (const pop of this.pops) {
        if (pop.wait < 0) continue;
        if (pop.wait > 0) { pop.wait--; continue; }
        x += pop.amp * (noise * 1.2 + (pop.t < 24 ? 1.5 : 0));
        pop.amp *= pop.decay; pop.t++;
        if (pop.amp < 1e-3) pop.wait = -1;
      }
      // High-pressure gas is not linear: soft saturation adds grit under load.
      x = Math.tanh(x * drive) / drive;
      // Turbo: exhaust has to spin the turbine first, which soaks up and rounds off the pulses.
      if (turbo > 0) x = x * (1 - 0.6 * turbo) + this.turbine.process(x) * 0.9 * turbo;
      let y = this.pipe.process(x);
      y = this.mid.process(y);
      const lp = this.m2.process(this.m1.process(y));
      let out = lp + this.boomGain * this.boom.process(lp);
      // Rasp: the upper band saturates -> metallic, tearing edge (Ferrari / LFA).
      if (rasp > 0) { const hi = out - this.raspSplit.process(out); out += rasp * 0.28 * Math.tanh(4 * hi); }
      // Radiation from the tailpipe end emphasises the higher frequencies a bit.
      const rad = out + 1.2 * (out - this.prev);
      this.prev = out;
      return rad;
    }
  }

  // ---------------- the engine ----------------

  class EngineDSP {
    constructor(sr) {
      this.sr = sr;
      this.t = buildTables();
      this.params = {
        volume: 0.5, throttle: 0.3, inertia: 0.35, pipeLength: 1.4, resonance: 0.5,
        muffler: 1800, roughness: 0.15, crackle: 0.4, width: 0.35,
        headerSpread: 0.05, // ± fraction of header length variation between cylinders
        bankSkew: 0.03,     // bank B pipe is this much longer than bank A
        brighten: 1.0,      // how much the exhaust opens up / brightens with RPM
        rasp: 0.3,          // metallic edge (saturated upper band)
        intake: 0.2,        // induction howl level
        turbo: 0,           // 0 = naturally aspirated, 1 = big turbos
        whine: 0.1,         // gearbox whine during Launch & drive
        uelLength: 0,       // unequal-length headers: extra pipe length (m) for marked cylinders
        itb: 0,             // 0 = common intake plenum, 1 = individual throttle bodies
      };
      // Individual throttle bodies: trumpet radiation, butterfly hiss, lift-off chuff.
      this.itbPrev = 0;
      this.itbLP = new OnePole().set(7000, sr);
      this.itbHiss = new Biquad().bandpass(3200, 1.5, sr);
      this.chuffEnv = 0; this.chuffLP = new OnePole().set(900, sr); this.loadPeak = 0;
      // Flow noise is not white: tint it to the band where gas turbulence lives.
      this.noiseF = [0, 1].map(() => ({ lp: new OnePole().set(3500, sr), hp: new Biquad().highpass(350, 0.7, sr) }));
      // Intake: plenum/airbox resonance + runner resonance.
      this.intakeRes = [new Biquad().bandpass(380, 3, sr), new Biquad().bandpass(1300, 5, sr)];
      // Turbo state.
      this.boost = 0; this.whFreq = 2000; this.whPhase = 0; this.whBP = new Biquad();
      this.bovEnv = 0; this.bovPhase = 0; this.bovBP = new Biquad().bandpass(2600, 0.9, sr);
      // Gearbox whine.
      this.gearPh1 = 0; this.gearPh2 = 0;
      // Ground reflection: the mic hears the tailpipe directly and bounced off the road.
      this.erBuf = [new Float32Array(2048)]; this.erW = 0;
      this.erDelay = [Math.round(0.0031 * sr)];
      this.erLP = [new OnePole().set(2500, sr)];
      this.rpm = 900; this.target = 900; this.limiter = false; this.cut = false; this.load = 0.3;
      this.drive = null; // active launch-and-drive sequence, see startDrive()
      this.crank = 0; this.cycleBase = 0; this.idx = 0;
      this.ctrlCountdown = 0;
      this.banks = [new Bank(sr, 0), new Bank(sr, 1)]; // second arg: 1 = gets bankSkew
      this.body = [[170, 3, 0.3], [410, 5, 0.3], [980, 8, 0.25], [2300, 8, 0.15]]
        .map(([f, q, g]) => ({ f: new Biquad().bandpass(f, q, sr), g }));
      this.intakeBP = new Biquad().bandpass(900, 0.8, sr);
      this.dcL = new Biquad().highpass(22, 0.707, sr);
      this.dcR = new Biquad().highpass(22, 0.707, sr);
      this.setEngine([{ cyl: 1, angle: 0, bank: 0 }], 1);
      this.applyParams();
    }

    handle(m) {
      if (m.type === 'engine') this.setEngine(m.events, m.bankCount);
      else if (m.type === 'rpm') { this.drive = null; this.target = clamp(m.rpm, 300, 20000); this.limiter = !!m.limiter; }
      else if (m.type === 'params') { Object.assign(this.params, m.params); this.applyParams(); }
      else if (m.type === 'drive') this.startDrive(m.redline, m.idle, m.launchRpm, m.gearRatios);
      else if (m.type === 'driveStop') { this.drive = null; this.cut = false; }
    }

    status() {
      const d = this.drive;
      return { rpm: this.rpm, load: this.load, cut: this.cut, drive: d ? { phase: d.phase, gear: d.gear } : null };
    }

    // ---------------- launch control + gearbox drive sequence ----------------
    //
    //  launch   : launch control holds ~3k rpm by cutting ignition (bang-bang-bang)
    //  pull     : full throttle; RPM climbs fast in low gears, slower in high gears
    //  upshift  : ~150 ms ignition cut, RPM drops by the gear ratio step
    //  brake    : off throttle (overrun crackle), RPM falls as the car slows
    //  downshift: throttle blip, RPM jumps up to match the lower gear
    //  idle     : clutch in, engine settles back to idle
    //
    // RPM change per second in gear g scales with the gear ratio: with the same
    // engine force, a lower gear accelerates the car harder AND turns the engine
    // faster per km/h.

    startDrive(redline, idle, launchRpm, gearRatios) {
      const R = clamp(redline, 2000, 20000);
      const ratios = gearRatios && gearRatios.length >= 2 ? gearRatios : [3.5, 2.2, 1.6, 1.25];
      this.drive = {
        phase: 'launch', t: 0, gear: 1, gears: ratios.length, ratios,
        redline: R, idle: clamp(idle || 900, 600, 6000),
        launchRpm: launchRpm ? clamp(launchRpm, 1500, R * 0.8) : clamp(0.4 * R, 2800, 4500),
        shiftTarget: 0,
      };
      this.limiter = false;
    }

    stepDrive(dt) {
      const d = this.drive, R = d.redline, ratio = d.ratios;
      const g = d.gear - 1;
      d.t += dt;
      const toPhase = (phase) => { d.phase = phase; d.t = 0; };
      const approach = (target, tau) => { this.rpm += (target - this.rpm) * (1 - Math.exp(-dt / tau)); };

      switch (d.phase) {
        case 'launch': {
          // Launch control: rev limiter at launchRpm with hard ignition cut.
          if (this.rpm >= d.launchRpm) this.cut = true;
          else if (this.rpm < d.launchRpm - 250) this.cut = false;
          this.rpm += (this.cut ? -6000 : 9000) * dt;
          if (d.t > 2.2) { this.cut = false; toPhase('clutch'); }
          return this.cut ? 0 : 1;
        }
        case 'clutch': // clutch drop: RPM bogs down as the car starts moving
          approach(d.launchRpm * 0.8, 0.06);
          if (d.t > 0.18) toPhase('pull');
          return 1;
        case 'pull': {
          // Torque curve: a bit weaker at the very bottom and top of the rev range.
          const x = this.rpm / R;
          const torque = 0.75 + 0.25 * Math.sin(Math.PI * clamp(x, 0, 1));
          this.rpm += 0.42 * R * Math.pow(ratio[g] / ratio[0], 1.5) * torque * dt;
          if (this.rpm >= R * 0.97) {
            if (d.gear < d.gears) {
              d.shiftTarget = this.rpm * (ratio[g + 1] / ratio[g]);
              toPhase('upshift');
            } else toPhase('brake');
          }
          return 1;
        }
        case 'upshift':
          this.cut = true; // ignition cut during the shift -> "brap"
          approach(d.shiftTarget, 0.035);
          if (d.t > 0.15) { this.cut = false; d.gear++; toPhase('pull'); }
          return 0;
        case 'brake': {
          this.cut = false;
          this.rpm -= 0.6 * R * (ratio[g] / ratio[0]) * dt;
          // Downshift as soon as the lower gear would land at ~88% of redline (aggressive, high revs).
          if (d.gear > 1 && this.rpm <= R * 0.88 * (ratio[g] / ratio[g - 1])) {
            d.shiftTarget = this.rpm * (ratio[g - 1] / ratio[g]);
            toPhase('downshift');
          } else if (d.gear === 1 && this.rpm <= Math.max(R * 0.35, d.idle + 800)) toPhase('idle');
          return 0;
        }
        case 'downshift':
          // Rev-matching blip: throttle opens briefly, RPM jumps to the lower gear's speed.
          approach(d.shiftTarget, 0.05);
          if (d.t > 0.22) { d.gear--; toPhase('brake'); }
          return d.t < 0.12 ? 0.9 : 0;
        case 'idle':
          approach(d.idle, 0.45);
          if (d.t > 2.5) { this.target = d.idle; this.drive = null; }
          return this.params.throttle * 0.5;
      }
      return 0;
    }

    setEngine(events, bankCount) {
      this.events = events;
      this.bankCount = bankCount;
      const sr = this.sr;
      this.cyls = events.map((ev, i) => {
        // Every cylinder is a little different: header length, combustion strength.
        const runner = new PipeSection(Math.ceil(sr * 0.012));
        return {
          angle: ev.angle, bank: bankCount > 1 ? ev.bank : 0, amp: 0.4, warp: 1, trim: 0.88 + 0.24 * hash(i + 3), runner,
          // Unequal-length headers: extra travel time to the collector (pure delay).
          uel: ev.uel || 0, travel: new Float32Array(512), tw: 0, td: 0,
          // Own intake runner + trumpet, used when the engine has individual throttle bodies.
          irunner: new PipeSection(Math.ceil(sr * 0.01)),
        };
      });
      this.configureRunners();
      // Resync the event pointer to the current crank position.
      this.crank = (((this.crank - this.cycleBase) % 720) + 720) % 720;
      this.cycleBase = 0;
      this.idx = events.findIndex((ev) => ev.angle >= this.crank);
      if (this.idx < 0) { this.idx = 0; this.cycleBase = 720; }
    }

    applyParams() {
      const p = this.params;
      for (const b of this.banks) b.configure(p);
      if (this.cyls) this.configureRunners();
      this.ctrlCountdown = 0; // refresh muffler on next sample
    }

    /**
     * Header runner per cylinder. Equal-length headers (spread ~0) = clean, high
     * scream (LFA, F1). Unequal (spread 0.3+) = lumpy rumble with lots of
     * once-per-rev energy (muscle-car V8, Subaru boxer).
     */
    configureRunners() {
      const s = this.params.headerSpread;
      this.cyls.forEach((c, i) => {
        c.runner.set(0.5 * (1 + s * (2 * hash(i + 1) - 1)), -0.4, 3500 + 1000 * hash(i + 7), this.sr);
        // A longer pipe delays the pulse's arrival at the collector by extraLength / c.
        c.td = clamp(Math.round(((c.uel * this.params.uelLength) / C) * this.sr), 0, c.travel.length - 1);
        // ITB runner + velocity stack ~0.32 m: open trumpet end reflects inverted,
        // giving a ringing quarter-wave resonance (~270 Hz and odd multiples).
        c.irunner.set(0.32 * (1 + 0.03 * (2 * hash(i + 11) - 1)), -0.75, 5000, this.sr);
      });
    }

    /** Exhaust gets brighter as RPM and load rise (valve flaps open, more gas velocity). */
    updateMuffler() {
      const p = this.params;
      const hz = clamp(p.muffler * (0.7 + 0.5 * this.load) * (1 + (p.brighten * this.rpm) / 5000), 200, this.sr * 0.4);
      for (const b of this.banks) b.setMuffler(hz);
      if (p.turbo > 0) {
        // Turbo whistle pitch follows shaft speed, i.e. boost.
        this.whFreq = 1800 + 6000 * this.boost;
        this.whBP.bandpass(this.whFreq, 14, this.sr);
      }
    }

    /** A cylinder reaches firing TDC: decide how strong this combustion is. */
    fire(ev, frac) {
      const c = this.cyls[this.idx], p = this.params;
      const gauss = (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
      // Combustion gets more consistent at high RPM; unevenness adds sub-harmonics
      // that make a screaming engine sound lower and rougher than it is.
      const consistency = 1 / (1 + this.rpm / 3500);
      if (this.cut) {
        c.amp = 0.05; // ignition cut: only air is pumped
      } else {
        const trim = 1 + (c.trim - 1) * consistency;
        const variation = 1 + p.roughness * gauss * (0.3 + 0.7 * consistency);
        c.amp = (0.1 + 0.9 * this.load) * trim * Math.max(0.2, variation);
        // Burn speed varies too, so each blowdown pulse has a slightly different shape.
        c.warp = 1 + 0.1 * (Math.random() * 2 - 1) * (0.3 + 0.7 * consistency);
        // Occasional weak combustion at idle / light load.
        if (this.load < 0.35 && Math.random() < p.roughness * 0.08) c.amp *= 0.4;
      }
      // Overrun / limiter afterfire.
      const overrun = this.cut || (this.load < 0.1 && this.rpm > 1800);
      if (overrun && Math.random() < p.crackle * (this.cut ? 0.5 : 0.18)) {
        const delayDeg = EVO + Math.random() * 200;
        const delay = Math.round((delayDeg / (this.rpm * 6)) * this.sr);
        this.banks[c.bank].schedulePop(delay, 0.4 + Math.random() * 0.9);
      }
    }

    render(L, R) {
      const p = this.params, sr = this.sr, t = this.t;
      const smooth = 1 - Math.exp(-1 / (Math.max(0.02, p.inertia) * sr));
      const loadSmooth = 1 - Math.exp(-1 / (0.04 * sr));
      const events = this.events, n = events.length, cyls = this.cyls;
      const two = this.bankCount > 1;
      const w = two ? p.width : 0, near = 0.5 + 0.5 * w, far = 0.5 - 0.5 * w;
      const noiseAmt = 0.1 + 0.5 * p.roughness;            // turbulence in the gas flow
      const intakeNorm = 1 / Math.sqrt(Math.max(1, n / 2)); // intake strokes overlap on big engines
      const EXHAUST_GAIN = 2.8;
      const spoolUp = 1 - Math.exp(-1 / (0.6 * sr));   // turbo lag
      const spoolDown = 1 - Math.exp(-1 / (0.3 * sr));
      const bovDecay = Math.exp(-1 / (0.35 * sr));
      const ITB_GAIN = 2.5;
      const chuffDecay = Math.exp(-1 / (0.08 * sr));
      const chuffPeakDecay = Math.exp(-1 / (0.4 * sr));

      for (let i = 0; i < L.length; i++) {
        // ---- RPM, rev limiter, load ----
        let desired;
        if (this.drive) {
          desired = this.stepDrive(1 / sr); // launch-and-drive sequence controls everything
        } else {
          const goal = this.limiter ? this.target + 600 : this.target;
          if (this.limiter) {
            if (this.rpm >= this.target) this.cut = true;
            else if (this.rpm < this.target - 150) this.cut = false;
          } else this.cut = false;
          if (this.cut) this.rpm -= 5000 / sr; // engine drag while ignition is cut
          else this.rpm += (goal - this.rpm) * smooth;
          // Accelerating needs torque (high load), slowing down = engine braking (no load).
          desired = this.cut ? 0 : clamp(p.throttle + (goal - this.rpm) / 1500, 0, 1);
        }
        this.load += (desired - this.load) * loadSmooth;
        if (--this.ctrlCountdown <= 0) { this.updateMuffler(); this.ctrlCountdown = 64; }

        // ---- crank and firing events ----
        const dps = (this.rpm * 6) / sr;
        this.crank += dps;
        let next = this.cycleBase + events[this.idx].angle;
        while (this.crank >= next) {
          this.fire(events[this.idx], (this.crank - next) / dps);
          if (++this.idx >= n) { this.idx = 0; this.cycleBase += 720; }
          next = this.cycleBase + events[this.idx].angle;
        }
        if (this.cycleBase >= 720 && this.crank >= 720) { this.crank -= 720; this.cycleBase -= 720; }

        // ---- turbo boost (spools up with load and RPM, with lag) ----
        if (p.turbo > 0) {
          const target = this.load * clamp((this.rpm - 2000) / 3000, 0, 1);
          this.boost += (target - this.boost) * (target > this.boost ? spoolUp : spoolDown);
          // Lift-off or gear shift under boost: blow-off valve dumps the pressure.
          if (this.boost > 0.35 && this.load < 0.12 && this.bovEnv < 0.05) { this.bovEnv = this.boost; this.boost *= 0.3; }
        } else this.boost = 0;

        // ---- per-cylinder sources ----
        const nz0 = Math.random() * 2 - 1, nz1 = Math.random() * 2 - 1;
        const f0 = this.noiseF[0], f1 = this.noiseF[1];
        const cn0 = 2.5 * f0.hp.process(f0.lp.process(nz0));
        const cn1 = 2.5 * f1.hp.process(f1.lp.process(nz1));
        let in0 = 0, in1 = 0, mech = 0, intakeFlow = 0, intakePulse = 0, itbSum = 0;
        const itbOn = p.itb > 0;
        for (let k = 0; k < cyls.length; k++) {
          const c = cyls[k];
          let th = this.crank - c.angle;
          th -= 720 * Math.floor(th / 720);
          // Stretch/squeeze this cycle's blowdown a little (c.warp) for natural variation.
          let tb = th;
          if (th > EVO) { tb = EVO + (th - EVO) * c.warp; if (tb > 719.9) tb = 719.9; }
          const flow = c.amp * lookup(t.blow, tb) + 0.22 * lookup(t.disp, th);
          const x = flow * (1 + noiseAmt * (c.bank ? cn1 : cn0));
          let y = c.runner.process(x);
          if (c.td > 0) { // unequal-length header: pulse arrives late at the collector
            const tl = c.travel.length;
            c.travel[c.tw] = y;
            y = c.travel[(c.tw - c.td + tl) % tl];
            c.tw = (c.tw + 1) % tl;
          }
          if (c.bank) in1 += y; else in0 += y;
          mech += c.amp * lookup(t.mech, th);
          intakeFlow += lookup(t.intake, th);
          const ivcPulse = lookup(t.ivc, th);
          intakePulse += ivcPulse;
          // ITB: this cylinder's suction wave + valve-closing pulse ring in its own runner.
          if (itbOn) itbSum += c.trim * c.irunner.process(ivcPulse + 0.6 * lookup(t.intakeD, th));
        }

        // ---- exhaust banks ----
        const drive = 1 + 2.5 * this.load;
        const a = this.banks[0].process(in0, nz0, drive, p.rasp, p.turbo);
        const b = two ? this.banks[1].process(in1, nz1, drive, p.rasp, p.turbo) : a;

        // ---- engine block ----
        let block = 0;
        for (const m of this.body) block += m.g * m.f.process(mech);

        // ---- intake: valve-closing pulses ringing in plenum + runners, plus air roar ----
        const breath = (0.25 + 0.75 * this.load) * intakeNorm * (1 - 0.6 * p.turbo);
        const iSrc = (intakePulse + 0.3 * intakeFlow) * breath;
        const howl = 1.2 * this.intakeRes[0].process(iSrc) + 0.9 * this.intakeRes[1].process(iSrc);
        const roar = this.intakeBP.process(intakeFlow * (Math.random() * 2 - 1)) * (0.1 + this.load + p.turbo * this.boost) * intakeNorm;
        let intakeOut = p.intake * 3.2 * (howl + 0.2 * roar);

        // ---- individual throttle bodies ----
        if (itbOn) {
          // Sound radiates from the open trumpet mouths: radiation ~ rate of change (crisp bark).
          const bark = this.itbLP.process(itbSum - this.itbPrev);
          this.itbPrev = itbSum;
          // Part throttle: air hisses past the half-open butterflies.
          const partThrottle = this.load * (1 - this.load) * 4;
          const hiss = this.itbHiss.process(nz1) * intakeFlow * intakeNorm * partThrottle;
          // Lift-off: the moving air column in the runners stops abruptly -> "chuff".
          this.loadPeak = Math.max(this.load, this.loadPeak * chuffPeakDecay);
          if (this.loadPeak - this.load > 0.45 && this.chuffEnv < 0.05) { this.chuffEnv = this.loadPeak; this.loadPeak = this.load; }
          let chuff = 0;
          if (this.chuffEnv > 1e-3) { chuff = this.chuffLP.process(nz0) * this.chuffEnv; this.chuffEnv *= chuffDecay; }
          // Radiation rises with frequency, so tame it as RPM climbs or it drowns the exhaust.
          const rpmComp = Math.min(1.4, Math.sqrt(4000 / Math.max(this.rpm, 500)));
          const itbOut = breath * ITB_GAIN * rpmComp * bark + 0.12 * hiss + 0.5 * chuff;
          intakeOut = intakeOut * (1 - p.itb) + p.intake * 3.2 * p.itb * itbOut;
        }

        // ---- turbo whistle + blow-off valve ----
        let turboOut = 0;
        if (p.turbo > 0) {
          this.whPhase += (2 * Math.PI * this.whFreq) / sr;
          if (this.whPhase > 6.2832) this.whPhase -= 6.2832;
          const whistle = (0.5 * Math.sin(this.whPhase) + 1.5 * this.whBP.process(nz0)) * this.boost * this.boost;
          let bov = 0;
          if (this.bovEnv > 1e-3) {
            this.bovPhase += (2 * Math.PI * 22) / sr; // slight flutter
            bov = this.bovBP.process(nz1) * this.bovEnv * (0.75 + 0.25 * Math.sin(this.bovPhase));
            this.bovEnv *= bovDecay;
          }
          turboOut = p.turbo * (0.06 * whistle + 0.6 * bov);
        }

        // ---- gearbox whine (only with a gear engaged in Launch & drive) ----
        let whineOut = 0;
        const dr = this.drive;
        if (dr && p.whine > 0 && dr.phase !== 'launch' && dr.phase !== 'idle') {
          const inputHz = this.rpm / 60;
          this.gearPh1 += (2 * Math.PI * inputHz * 29) / sr;                        // input gear mesh
          this.gearPh2 += (2 * Math.PI * (inputHz / dr.ratios[dr.gear - 1]) * 41) / sr; // output gear mesh
          if (this.gearPh1 > 6.2832) this.gearPh1 -= 6.2832;
          if (this.gearPh2 > 6.2832) this.gearPh2 -= 6.2832;
          whineOut = p.whine * 0.03 * (0.4 + this.load) * (Math.sin(this.gearPh1) + 0.6 * Math.sin(this.gearPh2));
        }

        const common = 0.15 * block + intakeOut + turboOut + whineOut;
        let l = EXHAUST_GAIN * (a * near + b * far) + common;
        let r = EXHAUST_GAIN * (b * near + a * far) + common;

        // ---- ground reflection ----
        // One shared reflection for both channels: different L/R delays would
        // treat the two banks differently and bring back the half-rate "octave down".
        const eb = this.erBuf[0], len = eb.length;
        eb[this.erW] = 0.5 * (l + r);
        const refl = 0.3 * this.erLP[0].process(eb[(this.erW - this.erDelay[0] + len) % len]);
        l += refl; r += refl;
        this.erW = (this.erW + 1) % len;

        L[i] = p.volume * Math.tanh(this.dcL.process(l));
        R[i] = p.volume * Math.tanh(this.dcR.process(r));
      }
    }
  }

  return EngineDSP;
}

/** Source code for the AudioWorklet module (loaded through a Blob URL). */
function buildWorkletSource() {
  return `const EngineDSP = (${createEngineDSPClass.toString()})();
class EngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.dsp = new EngineDSP(sampleRate);
    this.counter = 0;
    this.port.onmessage = (e) => this.dsp.handle(e.data);
  }
  process(_inputs, outputs) {
    const o = outputs[0];
    this.dsp.render(o[0], o[1] || o[0]);
    this.counter += o[0].length;
    if (this.counter >= 2048) {
      this.counter = 0;
      this.port.postMessage(this.dsp.status());
    }
    return true;
  }
}
registerProcessor('engine-processor', EngineProcessor);`;
}

if (typeof module !== 'undefined') module.exports = { createEngineDSPClass, buildWorkletSource };
