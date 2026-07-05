/* ============================================================================
 * terrain.js  —  100 unique tracks + terrain samplers
 * ----------------------------------------------------------------------------
 * A "track" is just a function height(x) plus a few extras (coins, start/finish,
 * difficulty, biome). Two flavours:
 *   • Built-in tracks are generated procedurally from a SEED (deterministic,
 *     tiny to store) so we get 100 different but reproducible hills.
 *   • Custom tracks (made in the Editor) are stored as a fixed array of height
 *     SAMPLES, which is what makes hand-painting a track possible.
 *
 * Every track exposes the same interface the physics needs:
 *   terrain.height(x)  → ground height at world x
 *   terrain.normal(x)  → unit up-normal (for collision response)
 *   terrain.coins      → array of {x,y,taken,spin}
 * ==========================================================================*/

(function () {
  'use strict';
  const HCR = (window.HCR = window.HCR || {});

  // ---- deterministic PRNG (mulberry32) -------------------------------------
  // Same seed → same sequence forever. This is what makes each of the 100
  // tracks unique yet identical every time you play it.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = (rng, a, b) => a + rng() * (b - a);

  // ---- biomes: each biome is a "personality" of hills ----------------------
  // baseFreq/amp ranges + feature type shape how the sine components and
  // special ramps/pits are generated below.
  const BIOMES = [
    { name: 'Rolling Hills', baseFreq: 0.0024, ampMin: 90, ampMax: 150, rough: 0.010, feat: 'none', sky: '#bfe8ff' },
    { name: 'Big Air',       baseFreq: 0.0020, ampMin: 70, ampMax: 110, rough: 0.012, feat: 'ramp', sky: '#cfeaff' },
    { name: 'Rocky',         baseFreq: 0.0040, ampMin: 60, ampMax: 120, rough: 0.030, feat: 'none', sky: '#d8d2c4' },
    { name: 'Lunar',         baseFreq: 0.0020, ampMin: 80, ampMax: 140, rough: 0.008, feat: 'none', sky: '#aab4d8' },
    { name: 'Forest Bumps',  baseFreq: 0.0060, ampMin: 40, ampMax: 80,  rough: 0.040, feat: 'none', sky: '#cfeede' },
    { name: 'Desert Dunes',  baseFreq: 0.0018, ampMin: 120, ampMax: 200, rough: 0.006, feat: 'none', sky: '#ffe9c2' },
    { name: 'Ice',           baseFreq: 0.0030, ampMin: 80, ampMax: 140, rough: 0.020, feat: 'none', sky: '#dff3ff' },
    { name: 'Canyon',        baseFreq: 0.0035, ampMin: 100, ampMax: 180, rough: 0.025, feat: 'pit',  sky: '#f0c9a0' },
    { name: 'Mega Ramp',     baseFreq: 0.0022, ampMin: 60, ampMax: 100, rough: 0.010, feat: 'bigramp', sky: '#cfeaff' },
    { name: 'Technical',     baseFreq: 0.0080, ampMin: 30, ampMax: 70,  rough: 0.060, feat: 'none', sky: '#d6e0ff' },
    { name: 'Endless Climb', baseFreq: 0.0026, ampMin: 70, ampMax: 160, rough: 0.012, feat: 'none', sky: '#cfe0ff' },
    { name: 'Mixed',         baseFreq: 0.0040, ampMin: 60, ampMax: 150, rough: 0.030, feat: 'ramp', sky: '#d8e6ff' },
  ];

  // Word lists for procedural track names (e.g. "Crimson Ridge 07").
  const ADJ = ['Crimson', 'Azure', 'Golden', 'Shadow', 'Frost', 'Ember', 'Jade', 'Storm', 'Solar', 'Lunar', 'Misty', 'Iron'];
  const NOUN = ['Ridge', 'Valley', 'Peak', 'Gorge', 'Dunes', 'Climb', 'Hollow', 'Summit', 'Bend', 'Mesa', 'Crest', 'Pit'];

  const FLAT = 250, RAMP = 950; // spawn area is flat, then hills ramp in
  const TOTAL = 100;

  // Build one fully-described track specification from its index.
  function genSpec(index) {
    const biome = BIOMES[index % BIOMES.length];
    const rng = mulberry32(index * 2654435761 + 12345); // unique seed per index

    // 4–5 primary sine "hills", each with a frequency a bit higher than the
    // last (like real terrain: big sweeps + smaller bumps on top).
    const n = 4 + Math.floor(rng() * 2);
    const defs = [];
    let f = biome.baseFreq;
    for (let i = 0; i < n; i++) {
      defs.push({
        amp: rand(rng, biome.ampMin, biome.ampMax),
        freq: f * rand(rng, 0.7, 1.4),
        phase: rng() * 6.283,
      });
      f *= rand(rng, 1.6, 2.5);
    }
    // A little extra high-frequency roughness for texture.
    defs.push({ amp: rand(rng, 6, 18), freq: biome.rough * (1 + rng()), phase: rng() * 6.283 });

    const length = Math.round(rand(rng, 6000, 12000));
    const features = [];
    // Optional big feature: a Gaussian ramp (jump) or pit (dip).
    if (biome.feat === 'ramp') features.push({ x: rand(rng, length * 0.4, length * 0.7), amp: rand(rng, 120, 220), sig: rand(rng, 140, 240) });
    if (biome.feat === 'bigramp') features.push({ x: rand(rng, length * 0.45, length * 0.6), amp: rand(rng, 240, 360), sig: rand(rng, 200, 320) });
    if (biome.feat === 'pit') features.push({ x: rand(rng, length * 0.5, length * 0.8), amp: -rand(rng, 160, 260), sig: rand(rng, 120, 200) });

    // Difficulty 1–5 derived from how aggressive the biome is.
    const difficulty = Math.max(1, Math.min(5, Math.round(
      (biome.ampMax / 40) * 0.6 + (biome.rough * 100) * 0.4 + n * 0.2
    )));

    const name = ADJ[Math.floor(rng() * ADJ.length)] + ' ' + NOUN[index % NOUN.length] + ' ' + String(index + 1).padStart(2, '0');

    return {
      id: 't' + index, index, name, biome: biome.name, sky: biome.sky,
      difficulty, length, startX: 120, finishX: length - 200,
      hillDefs: defs, features, flat: FLAT, ramp: RAMP,
    };
  }

  // Generate all 100 specs once at load (cheap — they're just data).
  const SPECS = [];
  for (let i = 0; i < TOTAL; i++) SPECS.push(genSpec(i));

  // Scatter coins along a track for the player to grab.
  function genCoins(terrain, length) {
    const coins = [];
    let cx = 600;
    while (cx < length - 200) {
      const gy = terrain.height(cx);
      coins.push({ x: cx, y: gy + 70 + Math.random() * 50, taken: false, spin: Math.random() * 6 });
      cx += 280 + Math.random() * 420;
    }
    return coins;
  }

  // Turn a built-in spec into a live terrain object the game can use.
  function makeBuiltin(spec) {
    const defs = spec.hillDefs, features = spec.features || [];
    // Height = sum of sines (ramped in after the flat spawn) + Gaussian features.
    function height(x) {
      const s = HCR.Physics.smoothstep(spec.flat, spec.ramp, x);
      let h = 0;
      for (let i = 0; i < defs.length; i++) h += defs[i].amp * Math.sin(defs[i].freq * x + defs[i].phase);
      let v = h * s;
      for (let i = 0; i < features.length; i++) {
        const f = features[i];
        v += f.amp * Math.exp(-((x - f.x) * (x - f.x)) / (2 * f.sig * f.sig));
      }
      return v;
    }
    const terrain = {
      id: spec.id, name: spec.name, biome: spec.biome, sky: spec.sky,
      difficulty: spec.difficulty, length: spec.length,
      startX: spec.startX, finishX: spec.finishX,
      custom: false, spec,
      height,
      // Slope is computed numerically (cheap, works for any height fn).
      slope(x) { const e = 1.2; return (height(x + e) - height(x - e)) / (2 * e); },
      // Surface normal: perpendicular to the tangent (1, slope).
      normal(x) { const dh = this.slope(x); const l = Math.hypot(dh, 1); return { x: -dh / l, y: 1 / l }; },
      coins: null,
    };
    terrain.coins = genCoins(terrain, spec.length);
    return terrain;
  }

  // Build a terrain from a raw sample array (used by custom/editor tracks).
  // Linear interpolation between samples keeps it smooth enough for gameplay.
  function makeSampleSampler(samples, spacing, length, extra) {
    function height(x) {
      if (x <= 0) return samples[0];
      const fi = x / spacing, i = Math.floor(fi), f = fi - i;
      if (i >= samples.length - 1) return samples[samples.length - 1];
      return samples[i] * (1 - f) + samples[i + 1] * f;
    }
    const terrain = Object.assign({
      custom: true,
      height,
      slope(x) { const e = 1.2; return (height(x + e) - height(x - e)) / (2 * e); },
      normal(x) { const dh = this.slope(x); const l = Math.hypot(dh, 1); return { x: -dh / l, y: 1 / l }; },
    }, extra || {});
    return terrain;
  }

  // Convert a stored custom-track record into a live terrain object.
  // Coins are cloned so a replay starts fresh (taken=false).
  function makeCustom(t) {
    const spacing = t.spacing || 8;
    const terrain = makeSampleSampler(t.samples, spacing, t.length, {
      id: t.id, name: t.name, biome: t.biome || 'Custom', sky: t.sky || '#cfe0ff',
      difficulty: t.difficulty || 3, length: t.length,
      startX: t.startX != null ? t.startX : 120, finishX: t.finishX != null ? t.finishX : t.length - 200,
    });
    terrain.coins = (t.coins || []).map((c) => ({ x: c.x, y: c.y, taken: false, spin: Math.random() * 6 }));
    return terrain;
  }

  // Draw a small thumbnail of a built-in spec into a 2D context (for the grid).
  function drawThumb(ctx, w, h, spec) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0e1733'; ctx.fillRect(0, 0, w, h);
    const t = makeBuiltin(spec);
    const len = spec.length;
    const pad = 8;
    let minH = 1e9, maxH = -1e9;
    const N = 120;
    const hs = [];
    for (let i = 0; i <= N; i++) { const hh = t.height((i / N) * len); hs.push(hh); if (hh < minH) minH = hh; if (hh > maxH) maxH = hh; }
    const range = Math.max(1, maxH - minH);
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const x = pad + (i / N) * (w - 2 * pad);
      const y = h - pad - ((hs[i] - minH) / range) * (h - 2 * pad);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.lineTo(w - pad, h); ctx.lineTo(pad, h); ctx.closePath();
    ctx.fillStyle = '#3a5a2a'; ctx.fill();
    ctx.strokeStyle = '#5cc36a'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  // Public terrain API.
  HCR.Terrain = {
    BIOMES, SPECS, TOTAL, FLAT, RAMP,
    genSpec, makeBuiltin, makeCustom, makeSampleSampler, genCoins, drawThumb,
    getSpec: (i) => SPECS[i],
  };
})();
