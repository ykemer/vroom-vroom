# Exhaust Synth

A browser simulator of engine exhaust sound. Every combustion produces one pressure pulse,
fired at the exact crank angle the engine's firing order dictates.

## Run

Open `index.html` in Chrome, Edge or Firefox and click **Start engine**. No build and no server needed.
(If your browser blocks it from `file://`, run `npm run serve` and open http://localhost:8080.)

Controls: pick an engine, set RPM (800–18 000), hold **Space** or *Hold to rev* to rev to the
redline, or *Sweep* to ramp up.

**🏁 Launch & drive** runs a full sequence inside the DSP (`startDrive` / `stepDrive` in `dsp.js`):
1. About 2 s of launch control (ignition-cut bangs at ~3k rpm).
2. A clutch drop.
3. Full-throttle pulls through 4 gears, with 150 ms ignition-cut upshifts near the redline.
4. Hard braking with overrun crackle and rev-matched, throttle-blipped downshifts.
5. Clutch in, back to idle.

RPM climbs and falls faster in low gears, because the rate scales with the gear ratio.
Touching the RPM slider or revving cancels the sequence. Use headphones for V engines: bank A goes left and bank B goes right.

## How it works

| File | What it does |
|---|---|
| `engines.js` | Engine table: firing order, intervals between firings (degrees, sum = 720°), bank of each cylinder |
| `dsp.js` | The sound model (pure JS). Runs in an AudioWorklet, or in a ScriptProcessor fallback when the page is opened from `file://` |
| `app.js` | UI, Web Audio setup, crank timeline + oscilloscope drawing |
| `test/render.js` | Runs the DSP in Node: checks firing angles and levels, writes WAV samples to `test/out/` |

1. **Crank:** each audio sample the crank advances `rpm × 6 / sampleRate` degrees. When it crosses
   a cylinder's firing angle, a pulse starts. Sub-sample timing keeps it exact even at 18 000 rpm.
2. **Source, shaped in crank degrees:** each cylinder's gas flow is read from tables indexed by
   its own crank angle. The exhaust valve opens at 135° after firing, giving a blowdown pulse
   (steep rise, ~30° decay). Then the piston pushes the rest of the gas out (180°–360°).
   Because the shape is in degrees, it stretches at idle (deep thump) and shrinks at high RPM (sharp crack).
3. **Combustion:** at each firing, that cylinder's pressure is set from engine load, a fixed
   per-cylinder trim, and random cycle-to-cycle variation. Accelerating means high load;
   lifting off means engine braking, low load and afterfire pops.
4. **Pipes, fixed in time:** each cylinder has its own header runner (a slightly different length).
   They merge into a collector, then pass through saturation, the main pipe (feedback comb, delay = 2L / 343 m/s,
   inverted open-end reflection), a mid resonator, the muffler lowpass, a drone resonance and tailpipe radiation.
   A source shaped in crank degrees fed through resonances fixed in time is what makes it sound like an engine.
5. **Intake:** when an intake valve slams shut, it sends a pulse ringing through the plenum and runner
   resonances. This is the induction howl that dominates the LFA sound.
6. **Rasp:** the upper band of the exhaust saturates, giving the metallic edge of Ferrari and LFA exhausts.
7. **Turbo (GT-R):**
   - The turbines soften the exhaust pulses.
   - Boost builds with lag, and the whistle pitch follows boost.
   - The blow-off valve vents on lift-off and on every upshift.
8. **Natural variation and space:**
   - Each combustion's blowdown is slightly stretched or squeezed.
   - Flow noise is tinted, not white.
   - A ground reflection off the road, plus room reverb.
9. **Extras:** engine-block vibration, gearbox whine during Launch & drive, and a rev limiter (hold Space).
10. **Banks:** V engines have two exhaust banks. In a cross-plane V8 the engine fires evenly
   every 90°, but each bank gets 90°-180°-270°-180°. That uneven per-pipe rhythm is the burble.
   Set *Stereo width* to 0 to merge both pipes and hear it smooth out.

## Engines

Single, parallel twin (360°/180°/270°), V-twin 45°, I3, I4, I5, I6, V6 60° even, V6 90° odd-fire,
V8 cross-plane, V8 flat-plane, V10 even (72°), V10 odd (90°/54°), V12.

Add an engine by appending one entry to `ENGINES` in `engines.js`.

Each engine also has an exhaust preset (`SOUND_PRESETS` in `engines.js`), loaded into the sliders
when you select it. The firing order is physics; the exhaust is what the manufacturer tuned. For example:
- **Cross-plane V8 (AMG/muscle):** long pipes, strong resonance, dark muffler, unequal headers, wide bank separation.
- **Even-fire V10 (LFA/M5):** short equal-length headers, weak resonance, exhaust that opens up at high RPM.

## Test

```
npm test
```
