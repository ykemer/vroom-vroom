// engines.js
// ---------------------------------------------------------------------------
// Engine definitions.
//
// A 4-stroke engine fires every cylinder once per 720° of crankshaft rotation
// (two revolutions). An engine is described by:
//   firingOrder : cylinder numbers in the order they fire
//   intervals   : crank degrees from each firing to the NEXT one (sums to 720)
//   bankOf(cyl) : which exhaust bank (0 or 1) the cylinder belongs to.
//                 Inline engines have one bank. V engines have two, and each
//                 bank usually has its own exhaust pipe, which is where most of
//                 the character comes from (e.g. the cross-plane V8 burble).
// ---------------------------------------------------------------------------

const oddEven = (cyl) => (cyl % 2 === 1 ? 0 : 1);   // odd cylinders = bank A
const firstHalf = (n) => (cyl) => (cyl <= n ? 0 : 1); // 1..n = bank A
const single = () => 0;
const repeat = (pattern, times) => Array.from({ length: times }, () => pattern).flat();

const ENGINES = [
  // ---- Singles & twins ----------------------------------------------------
  {
    id: 'single', group: 'Singles & twins', name: '1 cylinder (single)',
    firingOrder: [1], intervals: [720], banks: 1, bankOf: single,
    note: 'One bang every two crank revolutions. Long silent gaps make the classic "thump".',
  },
  {
    id: 'twin-360', group: 'Singles & twins', name: '2 cyl parallel twin, 360° crank',
    firingOrder: [1, 2], intervals: [360, 360], banks: 1, bankOf: single,
    note: 'Pistons move together, fire one revolution apart. Even, sounds like a fast single.',
  },
  {
    id: 'twin-180', group: 'Singles & twins', name: '2 cyl parallel twin, 180° crank',
    firingOrder: [1, 2], intervals: [180, 540], banks: 1, bankOf: single,
    note: 'Better balance, uneven firing: bang-bang ... pause.',
  },
  {
    id: 'twin-270', group: 'Singles & twins', name: '2 cyl parallel twin, 270° crank',
    firingOrder: [1, 2], intervals: [270, 450], banks: 1, bankOf: single,
    note: 'Imitates a 90° V-twin firing: 270° then 450°. Lumpy, "V-twin" sound.',
  },
  {
    id: 'vtwin-45', group: 'Singles & twins', name: '2 cyl V-twin 45° (shared crank pin)',
    firingOrder: [1, 2], intervals: [315, 405], banks: 1, bankOf: single,
    note: 'The famous "potato-potato" cruiser sound: 315° then 405°.',
  },

  // ---- Inline -------------------------------------------------------------
  {
    id: 'i3', group: 'Inline', name: 'Inline 3',
    firingOrder: [1, 2, 3], intervals: repeat([240], 3), banks: 1, bankOf: single,
    note: 'Even 240° spacing. Slightly off-beat, raspy sound.',
  },
  {
    id: 'i4', group: 'Inline', name: 'Inline 4',
    firingOrder: [1, 3, 4, 2], intervals: repeat([180], 4), banks: 1, bankOf: single,
    note: 'Even 180° spacing, two pulses per revolution.',
  },
  {
    id: 'i5', group: 'Inline', name: 'Inline 5',
    firingOrder: [1, 2, 4, 5, 3], intervals: repeat([144], 5), banks: 1, bankOf: single,
    note: 'Even 144° spacing, 2.5 pulses per revolution: the distinctive warble.',
  },
  {
    id: 'i6', group: 'Inline', name: 'Inline 6',
    firingOrder: [1, 5, 3, 6, 2, 4], intervals: repeat([120], 6), banks: 2, bankOf: firstHalf(3),
    note: 'Even 120° spacing, perfectly balanced. Performance I6 exhausts collect the front three (1-2-3) ' +
          'and rear three (4-5-6) cylinders separately; with firing order 1-5-3-6-2-4 the groups alternate, ' +
          'so each fires every 240°, like two inline-3s merging. That gives the hollow, raspy I6 sound.',
  },
  {
    id: 'i6-rb26', group: 'Inline', name: 'Inline 6 twin-turbo (Nissan RB26DETT style)',
    firingOrder: [1, 5, 3, 6, 2, 4], intervals: repeat([120], 6), banks: 2, bankOf: firstHalf(3),
    note: 'Front three cylinders drive one turbo, rear three the other. High-revving, raspy, ' +
          'with turbo whistle and blow-off on every shift (Skyline GT-R).',
  },
  {
    id: 'i6-2jz', group: 'Inline', name: 'Inline 6 turbo (Toyota 2JZ-GTE style)',
    firingOrder: [1, 5, 3, 6, 2, 4], intervals: repeat([120], 6), banks: 2, bankOf: firstHalf(3),
    note: 'Big, under-stressed iron-block turbo six (Supra). Deeper and smoother than the RB26, ' +
          'with a longer exhaust and lots of boost noise.',
  },
  {
    id: 'i6-s54', group: 'Inline', name: 'Inline 6 NA (BMW S54 / M3 style)',
    firingOrder: [1, 5, 3, 6, 2, 4], intervals: repeat([120], 6), banks: 2, bankOf: firstHalf(3),
    note: 'Naturally aspirated, 8000 rpm, individual throttle bodies: a lot of the sound is intake howl. ' +
          'Headers collect front three and rear three cylinders before merging.',
  },

  // ---- Boxer (flat) ---------------------------------------------------------
  {
    id: 'flat4-ej', group: 'Boxer (flat)', name: 'Flat 4 turbo (Subaru EJ / WRX STI style)',
    firingOrder: [1, 3, 2, 4], intervals: repeat([180], 4), banks: 1, bankOf: single,
    // Unequal-length headers: cylinders 2 and 4 have the longer pipes (factor 1 = full extra length).
    uelPattern: { 1: 0, 2: 1, 3: 0, 4: 1 },
    note: 'Fires evenly every 180°. The boxer rumble comes from unequal-length headers: pulses from ' +
          'cylinders 2 and 4 travel further, so they reach the collector late and the even beat turns lopey. ' +
          'Set "Unequal header length" to 0 for the smooth equal-length sound of later Subarus.',
  },
  {
    id: 'flat6', group: 'Boxer (flat)', name: 'Flat 6 NA (Porsche 911 GT3 style)',
    firingOrder: [1, 6, 2, 4, 3, 5], intervals: repeat([120], 6), banks: 2, bankOf: firstHalf(3),
    note: 'Even 120°. Banks (1-3 and 4-6) alternate, so each bank fires every 240°, like two inline-3s. ' +
          'High-revving, intake-heavy, raspy howl.',
  },

  // ---- V engines ----------------------------------------------------------
  {
    id: 'v6', group: 'V engines', name: 'V6 60° even-fire, twin-turbo (GT-R style)',
    firingOrder: [1, 2, 3, 4, 5, 6], intervals: repeat([120], 6), banks: 2, bankOf: oddEven,
    note: 'Even 120°; banks alternate, so each bank fires evenly every 240°. ' +
          'Twin turbos soften the exhaust pulses; listen for turbo whistle, blow-off on shifts and gear whine. ' +
          'Set Turbo to 0 for a naturally aspirated V6.',
  },
  {
    id: 'v6-odd', group: 'V engines', name: 'V6 (90°, odd-fire)',
    firingOrder: [1, 6, 5, 4, 3, 2], intervals: repeat([90, 150], 3), banks: 2, bankOf: oddEven,
    note: 'Bonus: early 90° V6 with a common crank pin, 90°/150° spacing. Rough and lumpy.',
  },
  {
    id: 'v8-cross', group: 'V engines', name: 'V8 cross-plane (AMG 6.2 style)',
    firingOrder: [1, 8, 4, 3, 6, 5, 7, 2], intervals: repeat([90], 8), banks: 2, bankOf: oddEven,
    note: 'Engine fires evenly every 90°, but each bank fires 90-180-270-180. ' +
          'Each exhaust pipe gets uneven pulses: the muscle-car burble. ' +
          'Turn stereo width up and use headphones.',
  },
  {
    id: 'v8-flat', group: 'V engines', name: 'V8 flat-plane (Ferrari style)',
    firingOrder: [1, 5, 3, 7, 4, 8, 2, 6], intervals: repeat([90], 8), banks: 2, bankOf: firstHalf(4),
    note: 'Banks strictly alternate, so each bank fires evenly every 180°, ' +
          'like two inline-4s. Screaming, race-car sound.',
  },
  {
    id: 'v10-even', group: 'V engines', name: 'V10 even-fire 72° (LFA style)',
    firingOrder: [1, 6, 5, 10, 2, 7, 3, 8, 4, 9], intervals: repeat([72], 10), banks: 2, bankOf: firstHalf(5),
    note: 'Even 72° spacing, banks alternate (each bank every 144°, like two inline-5s). ' +
          'Short equal-length headers, strong induction howl, rasp: the F1-like scream.',
  },
  {
    id: 'v10-s85', group: 'V engines', name: 'V10 odd-fire 90°/54° (BMW S85 / E60 M5 style)',
    firingOrder: [1, 6, 5, 10, 2, 7, 3, 8, 4, 9], intervals: repeat([90, 54], 5), banks: 2, bankOf: firstHalf(5),
    note: '90° V10 with shared crank pins: firings alternate 90° and 54° apart. Banks alternate, so each ' +
          'bank fires evenly every 144° (like two inline-5s), offset 90° from each other. ' +
          'Unlike the Viper, a high-revving, F1-inspired engine with a raspy, hollow scream.',
  },
  {
    id: 'v10-odd', group: 'V engines', name: 'V10 odd-fire 90°/54° (Viper style)',
    firingOrder: [1, 10, 9, 4, 3, 6, 5, 8, 7, 2], intervals: repeat([90, 54], 5), banks: 2, bankOf: oddEven,
    note: '90° V10 with shared crank pins: firings alternate 90° and 54° apart. Truck-like, uneven growl.',
  },
  {
    id: 'v10-f1', group: 'V engines', name: 'V10 F1 (2000s, 72° even-fire, 19 000 rpm)',
    firingOrder: [1, 6, 5, 10, 2, 7, 3, 8, 4, 9], intervals: repeat([72], 10), banks: 2, bankOf: firstHalf(5),
    note: 'Representative mid-2000s 3.0 L Formula 1 V10. Firing every 72° (a 72° V angle with shared ' +
          'crank pins fires evenly); V angle and crank details varied between manufacturers. ' +
          'Tiny flywheel, ~4000 rpm idle, very short open exhaust, airbox intake above the driver, 7 close gears. ' +
          'At 19 000 rpm it fires 1583 times per second.',
  },
  {
    id: 'v12', group: 'V engines', name: 'V12 (60°)',
    firingOrder: [1, 7, 5, 11, 3, 9, 6, 12, 2, 8, 4, 10], intervals: repeat([60], 12), banks: 2, bankOf: firstHalf(6),
    note: 'Even 60° spacing, six pulses per revolution. Smooth, silky wail.',
  },
];

// ---------------------------------------------------------------------------
// Exhaust "sound presets". The firing pattern is physics; the exhaust system is
// what the manufacturer tuned. Same V8 firing order can sound like a muscle car
// or a race car depending on headers, pipes and mufflers.
//
//   pipeLength   main pipe length (m)       -> drone frequency
//   resonance    pipe reflection strength   -> deep boom vs clean pitch
//   muffler      lowpass cutoff (Hz)        -> dark vs raspy
//   brighten     how much it opens with RPM -> exotic scream at the top
//   headerSpread unequal header lengths     -> lumpy rumble
//   bankSkew     bank A vs B pipe asymmetry -> burble on V engines
//   width        stereo separation of banks -> hear each bank's own rhythm
//   redline      rev limit; also where Launch & drive shifts gears
//   rasp         saturated upper band       -> metallic tearing edge
//   intake       induction howl level       -> LFA / Ferrari intake scream
//   turbo        0 = NA, 1 = big turbos     -> softer pulses, whistle, blow-off
//   whine        gearbox whine in Launch & drive
//   inertia      flywheel: how fast RPM follows the throttle
//   idleRpm      idle speed (also where Launch & drive ends)
//   launchRpm    launch control RPM (null = automatic)
//   gearRatios   gearbox used by Launch & drive
//   uelLength    unequal-length headers (m): pulses from some cylinders arrive late -> boxer rumble
// Selecting an engine loads its preset into the sliders.
// ---------------------------------------------------------------------------

const DEFAULT_SOUND = {
  redline: 7500, inertia: 0.35, idleRpm: 900, launchRpm: null,
  gearRatios: [3.5, 2.2, 1.6, 1.25],
  pipeLength: 1.4, resonance: 0.5, muffler: 1800, brighten: 0.8,
  headerSpread: 0.08, bankSkew: 0.03, width: 0.35, roughness: 0.15,
  rasp: 0.25, intake: 0.2, turbo: 0, whine: 0.1, crackle: 0.4,
  uelLength: 0, // extra header length (m) for cylinders marked in an engine's uelPattern
};

const SOUND_PRESETS = {
  'single':   { redline: 9000, pipeLength: 1.0, resonance: 0.6, muffler: 1400, brighten: 0.6, roughness: 0.2 },
  'twin-360': { redline: 9500, pipeLength: 1.1, resonance: 0.55, muffler: 1600, brighten: 0.7 },
  'twin-180': { redline: 10000, pipeLength: 1.1, resonance: 0.55, muffler: 1800, brighten: 0.8 },
  'twin-270': { redline: 9000, pipeLength: 1.3, resonance: 0.6, muffler: 1400, brighten: 0.6, roughness: 0.2 },
  'vtwin-45': { redline: 5800, pipeLength: 1.7, resonance: 0.75, muffler: 900, brighten: 0.3, roughness: 0.25 },
  'i3':       { redline: 7000, pipeLength: 1.3, resonance: 0.5, muffler: 1700, brighten: 0.8 },
  'i4':       { redline: 8000, pipeLength: 1.2, resonance: 0.45, muffler: 2000, brighten: 1.0 },
  'i5':       { redline: 7000, pipeLength: 1.5, resonance: 0.55, muffler: 1600, brighten: 0.8, headerSpread: 0.12 },
  // Inline 6s: two exhaust groups (1-2-3 / 4-5-6) merging into one pipe -> low width,
  // some group asymmetry so the 240° per-group rhythm comes through.
  'i6':       { redline: 7500, pipeLength: 1.5, resonance: 0.45, muffler: 2000, brighten: 0.9, headerSpread: 0.05,
                bankSkew: 0.05, width: 0.2, rasp: 0.35, intake: 0.25 },
  'i6-rb26':  { redline: 8000, pipeLength: 1.3, resonance: 0.4, muffler: 2600, brighten: 1.0, headerSpread: 0.06,
                bankSkew: 0.06, width: 0.15, rasp: 0.55, intake: 0.15, turbo: 0.55, whine: 0.3, crackle: 0.45 },
  'i6-2jz':   { redline: 7000, pipeLength: 1.9, resonance: 0.55, muffler: 1500, brighten: 0.7, headerSpread: 0.05,
                bankSkew: 0.06, width: 0.15, rasp: 0.3, intake: 0.1, turbo: 0.75, whine: 0.2, crackle: 0.3 },
  'i6-s54':   { redline: 8000, pipeLength: 1.6, resonance: 0.45, muffler: 2200, brighten: 1.0, headerSpread: 0.04,
                bankSkew: 0.05, width: 0.25, rasp: 0.45, intake: 0.6, crackle: 0.3 },
  // GT-R VR38DETT: twin turbo, titanium exhaust, famous transmission whine.
  'v6':       { redline: 7000, pipeLength: 1.6, resonance: 0.45, muffler: 1500, brighten: 0.7, width: 0.4,
                rasp: 0.2, intake: 0.1, turbo: 0.8, whine: 0.7, crackle: 0.25 },
  'v6-odd':   { redline: 6000, pipeLength: 1.8, resonance: 0.65, muffler: 1100, brighten: 0.4, headerSpread: 0.25, bankSkew: 0.08, width: 0.6, roughness: 0.2 },
  // AMG M156 6.2: long pipes, big mufflers, unequal headers, separate banks, lots of crackle.
  'v8-cross': { redline: 6800, pipeLength: 2.3, resonance: 0.75, muffler: 850, brighten: 0.3, headerSpread: 0.35, bankSkew: 0.1, width: 0.8, roughness: 0.2,
                rasp: 0.25, intake: 0.15, crackle: 0.7 },
  // Ferrari (458-style): short equal headers, open exhaust, raspy and howling.
  'v8-flat':  { bankSkew: 0, redline: 9000, pipeLength: 1.2, resonance: 0.45, muffler: 2200, brighten: 1.0, headerSpread: 0.04, width: 0.35,
                rasp: 0.6, intake: 0.35, crackle: 0.4 },
  // LFA 1LR-GUE: equal-length headers, tuned intake "sound channel", F1 scream.
  'v10-even': { bankSkew: 0, redline: 9000, pipeLength: 1.1, resonance: 0.4, muffler: 2400, brighten: 1.3, headerSpread: 0.03, width: 0.3,
                rasp: 0.5, intake: 0.7, crackle: 0.3 },
  // BMW S85 (E60 M5): same firing, longer road exhaust, darker but still a scream at the top.
  'v10-s85':  { bankSkew: 0.01, redline: 8250, pipeLength: 1.7, resonance: 0.55, muffler: 1600, brighten: 1.1, headerSpread: 0.06, width: 0.4,
                rasp: 0.35, intake: 0.35, crackle: 0.3 },
  // Viper-style truck-derived V10: lumpy and deep.
  'v10-odd':  { redline: 6200, pipeLength: 2.0, resonance: 0.65, muffler: 1000, brighten: 0.4, headerSpread: 0.25, bankSkew: 0.08, width: 0.7, roughness: 0.2 },
  'flat4-ej': { redline: 7000, pipeLength: 1.6, resonance: 0.55, muffler: 1400, brighten: 0.6, headerSpread: 0.08,
                rasp: 0.3, intake: 0.15, turbo: 0.6, whine: 0.2, crackle: 0.4, roughness: 0.2, uelLength: 0.45 },
  'flat6':    { bankSkew: 0, redline: 9000, inertia: 0.25, pipeLength: 1.2, resonance: 0.4, muffler: 2600, brighten: 1.2,
                headerSpread: 0.03, width: 0.35, rasp: 0.5, intake: 0.55, crackle: 0.3 },
  // 2000s F1: open short exhaust, huge intake howl, featherweight flywheel, 7 close gears.
  'v10-f1':   { bankSkew: 0, redline: 19000, idleRpm: 4000, launchRpm: 11000, inertia: 0.08,
                gearRatios: [2.9, 2.4, 2.0, 1.7, 1.47, 1.29, 1.15],
                pipeLength: 0.7, resonance: 0.3, muffler: 6000, brighten: 1.0, headerSpread: 0.02, width: 0.25,
                rasp: 0.6, intake: 0.6, roughness: 0.08, crackle: 0.2, whine: 0.25 },
  'v12':      { bankSkew: 0, redline: 9000, pipeLength: 1.2, resonance: 0.4, muffler: 2400, brighten: 1.1, headerSpread: 0.04, width: 0.3,
                rasp: 0.4, intake: 0.4 },
};

function soundFor(engine) {
  return { ...DEFAULT_SOUND, ...(SOUND_PRESETS[engine.id] || {}) };
}

/**
 * Turn an engine definition into a list of firing events within one 720° cycle.
 * @returns {{cyl:number, angle:number, bank:number, gap:number}[]}
 */
function buildEvents(engine) {
  let angle = 0;
  return engine.firingOrder.map((cyl, i) => {
    const ev = {
      cyl, angle, bank: engine.banks > 1 ? engine.bankOf(cyl) : 0, gap: engine.intervals[i],
      uel: engine.uelPattern ? engine.uelPattern[cyl] || 0 : 0, // unequal-length header factor
    };
    angle += engine.intervals[i];
    return ev;
  });
}

/** Gaps (degrees) between consecutive firings of a single bank, wrapping around 720°. */
function bankGaps(events, bank) {
  const angles = events.filter((e) => e.bank === bank).map((e) => e.angle);
  return angles.map((a, i) => {
    const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + 720;
    return next - a;
  });
}

// Sanity check the table so mistakes show up in the console immediately.
for (const e of ENGINES) {
  const sum = e.intervals.reduce((a, b) => a + b, 0);
  console.assert(sum === 720, `${e.id}: intervals sum to ${sum}, expected 720`);
  console.assert(e.intervals.length === e.firingOrder.length, `${e.id}: intervals/firingOrder length mismatch`);
}

if (typeof module !== 'undefined') module.exports = { ENGINES, buildEvents, bankGaps, soundFor };
