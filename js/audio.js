/* ============================================================================
 * audio.js  —  Fully synthesized music + SFX via the Web Audio API
 * ----------------------------------------------------------------------------
 * No audio files are shipped — everything is generated at runtime with
 * oscillators and noise buffers. This keeps the game 100% offline.
 *
 *   • Music  : a tiny step-sequencer (bass + lead + kick + hat) that loops.
 *              The "mood" (root note + tempo) changes per biome.
 *   • SFX    : engine drone (tracks wheel RPM), coin ping, crash, landing, UI.
 *
 * Browsers block audio until the first user gesture, so AudioContext is created
 * lazily inside ensure(), which every button/key handler calls.
 * ==========================================================================*/

(function () {
  'use strict';
  const HCR = (window.HCR = window.HCR || {});

  let ctx = null, master = null, musicGain = null, sfxGain = null;
  let musicVol = 0.5, sfxVol = 0.7, muted = false;
  let engine = null; // {osc, sub, filter, gain}
  // Music state for the scheduler loop.
  let music = { timer: null, step: 0, next: 0, tempo: 120, scale: [0, 3, 5, 7, 10], root: 220, playing: false };

  // Create the AudioContext + gain nodes (idempotent). Returns false if the
  // browser has no Web Audio support.
  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      musicGain = ctx.createGain();
      sfxGain = ctx.createGain();
      musicGain.connect(master); sfxGain.connect(master); master.connect(ctx.destination);
      applyVolumes();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  function applyVolumes() {
    if (!master) return;
    master.gain.value = muted ? 0 : 1;
    musicGain.gain.value = musicVol;
    sfxGain.gain.value = sfxVol;
  }
  function setMusicVol(v) { musicVol = v; applyVolumes(); }
  function setSfxVol(v) { sfxVol = v; applyVolumes(); }
  function setMuted(b) { muted = b; applyVolumes(); }

  // semitone → frequency helper.
  function noteFreq(root, semi) { return root * Math.pow(2, semi / 12); }

  // Generic short tone used by music + UI.
  function playNote(freq, t, dur, type, gainVal, dest) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gainVal, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest || sfxGain);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function playKick(t) {
    const o = ctx.createOscillator(); o.type = 'sine';
    const g = ctx.createGain();
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    o.connect(g); g.connect(musicGain); o.start(t); o.stop(t + 0.18);
  }
  function playHat(t) {
    // short burst of white noise, high-passed → hat sound.
    const buf = ctx.createBuffer(1, 1024, ctx.sampleRate);
    const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
    const g = ctx.createGain(); g.gain.value = 0.18;
    src.connect(hp); hp.connect(g); g.connect(musicGain); src.start(t);
  }

  // Look-ahead scheduler: schedule any notes due in the next ~120 ms.
  function scheduler() {
    if (!music.playing || !ctx) return;
    const spb = 60 / (music.tempo || 120) / 2; // 8th notes
    while (music.next < ctx.currentTime + 0.12) {
      const s = music.step % 16;
      const t = music.next;
      if (s % 4 === 0) playNote(noteFreq(music.root, 0) / 2, t, spb * 1.8, 'triangle', 0.22, musicGain);
      if (s === 0 || s === 8) playKick(t);
      if (s % 2 === 1) playHat(t);
      // simple arpeggio over the scale
      const deg = music.scale[(s + (s >> 2)) % music.scale.length];
      if (s % 2 === 0) playNote(noteFreq(music.root, deg + 12), t, spb * 0.9, 'square', 0.10, musicGain);
      music.step++; music.next += spb;
    }
  }

  function startMusic(biome) {
    if (!ensure()) return;
    // Pick a root/tempo that fits the biome's vibe.
    const map = { 'Lunar': [110, 100], 'Ice': [247, 130], 'Desert Dunes': [196, 110],
      'Forest Bumps': [220, 120], 'Rocky': [165, 100], 'Canyon': [147, 96] };
    const cfg = map[biome] || [220, 120];
    music.root = cfg[0]; music.tempo = cfg[1];
    if (music.playing) return;
    music.playing = true; music.step = 0; music.next = ctx.currentTime + 0.05;
    music.timer = setInterval(scheduler, 25);
  }
  function stopMusic() {
    music.playing = false;
    if (music.timer) { clearInterval(music.timer); music.timer = null; }
  }

  // ---- engine drone (the signature HCR "brrr") ------------------------------
  function engineStart() {
    if (!ensure()) return;
    if (engine) return;
    const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 60;
    const sub = ctx.createOscillator(); sub.type = 'square'; sub.frequency.value = 30;
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 600;
    const g = ctx.createGain(); g.gain.value = 0;
    osc.connect(filter); sub.connect(filter); filter.connect(g); g.connect(sfxGain);
    osc.start(); sub.start();
    engine = { osc, sub, filter, gain: g, base: 60 };
  }
  // rpm01 (0..1) raises pitch, throttle raises volume.
  function engineUpdate(rpm01, throttle) {
    if (!engine || !ctx) return;
    const f = 55 + rpm01 * 240;
    engine.osc.frequency.setTargetAtTime(f, ctx.currentTime, 0.03);
    engine.sub.frequency.setTargetAtTime(f / 2, ctx.currentTime, 0.03);
    engine.filter.frequency.setTargetAtTime(400 + rpm01 * 1600, ctx.currentTime, 0.05);
    engine.gain.gain.setTargetAtTime(0.04 + throttle * 0.10, ctx.currentTime, 0.05);
  }
  function engineStop() {
    if (!engine) return;
    try { engine.osc.stop(); engine.sub.stop(); } catch (e) {}
    engine = null;
  }

  // ---- one-shot SFX -----------------------------------------------------------
  function sfxCoin() {
    if (!ensure()) return;
    const t = ctx.currentTime;
    playNote(880, t, 0.09, 'sine', 0.25, sfxGain);
    playNote(1320, t + 0.07, 0.12, 'sine', 0.25, sfxGain);
  }
  function sfxCrash() {
    if (!ensure()) return;
    const t = ctx.currentTime;
    // noise burst
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
    const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain(); g.gain.value = 0.5;
    src.connect(g); g.connect(sfxGain); src.start(t);
    // low thud
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.3);
    const og = ctx.createGain(); og.gain.setValueAtTime(0.5, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(og); og.connect(sfxGain); o.start(t); o.stop(t + 0.4);
  }
  function sfxLand(impact) {
    if (!ensure()) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine';
    const amp = Math.min(0.5, 0.08 + impact / 2000);
    o.frequency.setValueAtTime(90 + Math.random() * 30, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    const g = ctx.createGain(); g.gain.setValueAtTime(amp, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    o.connect(g); g.connect(sfxGain); o.start(t); o.stop(t + 0.2);
  }
  function sfxClick() {
    if (!ensure()) return;
    playNote(520, ctx.currentTime, 0.05, 'square', 0.12, sfxGain);
  }

  HCR.Audio = {
    ensure, setMusicVol, setSfxVol, setMuted,
    startMusic, stopMusic,
    engineStart, engineUpdate, engineStop,
    sfxCoin, sfxCrash, sfxLand, sfxClick,
    getVols: () => ({ musicVol, sfxVol, muted }),
  };
})();
