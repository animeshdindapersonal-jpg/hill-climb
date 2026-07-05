/* ============================================================================
 * main.js  —  App controller (boot, navigation, game loop, input, HUD)
 * ----------------------------------------------------------------------------
 * This file wires everything together:
 *   • Boots Storage + Audio and shows the main menu.
 *   • Implements a simple SCREEN MANAGER with a back-stack (each sub-screen has
 *     a working ← Back). In-game is a special "screen" that just hides the
 *     menu DOM and shows the canvas + HUD.
 *   • Builds the dynamic lists (100 tracks, garage, editor, settings).
 *   • Runs the single requestAnimationFrame GAME LOOP (step physics → render).
 *   • Handles keyboard + touch input and the pause / results overlays.
 * ==========================================================================*/

(function () {
  'use strict';
  const HCR = (window.HCR = window.HCR || {});
  const el = (id) => document.getElementById(id);
  const $ = (sel, root) => (root || document).querySelector(sel);

  // ---- global game state -----------------------------------------------------
  const state = {
    mode: 'menu',            // menu | playing | paused | results
    world: null, terrain: null, key: null, trackIndex: -1, record: false,
    testCarParams: null,     // when test-driving a custom build from the Garage
    camX: 0, camY: 0, scale: 1.1,   // camera follows the car
    input: { gas: false, brake: false },
    settings: null,
  };
  const S = HCR.Storage;

  // ---- canvas setup ----------------------------------------------------------
  const canvas = el('game');
  const ctx = canvas.getContext('2d');
  function resizeCanvas() {
    // In "low" quality mode we skip the devicePixelRatio bump for performance.
    const dpr = (state.settings && state.settings.quality === 'low') ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = window.innerWidth * dpr; canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px'; canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---- SCREEN MANAGER ---------------------------------------------------------
  const screensEl = el('screens');
  const stack = [];           // back-stack of screen names
  let current = 'menu';

  function hideAllScreens() { document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active')); }

  // Switch to the in-game view: hide all menu screens, show HUD + (maybe) touch controls.
  function enterGame() {
    hideAllScreens(); screensEl.style.display = 'none';
    el('hud').classList.remove('hidden');
    el('controls').classList.toggle('hidden', !state.settings.showTouch);
  }
  // Show a named screen and populate it.
  function showScreen(name, opts) {
    // Close modules we're leaving (stops their preview/editor loops).
    if (current === 'builder') HCR.Garage.close();
    if (current === 'editor') HCR.Editor.close();
    screensEl.style.display = '';
    el('hud').classList.add('hidden');
    el('controls').classList.add('hidden');
    hideAllScreens();
    const scr = el('screen-' + name); if (scr) scr.classList.add('active');
    current = name;
    if (name === 'menu') refreshMenu();
    else if (name === 'play') buildTrackGrid();
    else if (name === 'garage') buildGarageList();
    else if (name === 'editorList') buildEditorList();
    else if (name === 'settings') buildSettings();
    else if (name === 'builder') HCR.Garage.open(opts && opts.carId);
    else if (name === 'editor') HCR.Editor.open(opts && opts.id, opts);
  }
  // Navigate forward, remembering where we came from.
  function go(name, opts) { stack.push(current); showScreen(name, opts); }
  // Back button: pop the stack and return to the previous screen.
  function back() { const p = stack.pop() || 'menu'; showScreen(p); }

  // ---- MENU ------------------------------------------------------------------
  function refreshMenu() {
    const d = S.get();
    let best = 0, total = 0;
    for (const k in d.progress.terrainBest) best = Math.max(best, d.progress.terrainBest[k]);
    total = d.progress.totalCoins || 0;
    el('menuCoins').textContent = total;
    el('menuBest').textContent = best;
  }

  // ---- TRACK GRID (Play) ------------------------------------------------------
  function trackThumb(canvas, terrainObj, length) {
    const w = canvas.width = canvas.clientWidth, h = canvas.height = canvas.clientHeight;
    const c = canvas.getContext('2d');
    c.clearRect(0, 0, w, h); c.fillStyle = '#0e1733'; c.fillRect(0, 0, w, h);
    const N = 120; const hs = []; let minH = 1e9, maxH = -1e9;
    for (let i = 0; i <= N; i++) { const hh = terrainObj.height((i / N) * length); hs.push(hh); if (hh < minH) minH = hh; if (hh > maxH) maxH = hh; }
    const range = Math.max(1, maxH - minH); const pad = 8;
    c.beginPath();
    for (let i = 0; i <= N; i++) { const x = pad + (i / N) * (w - 2 * pad); const y = h - pad - ((hs[i] - minH) / range) * (h - 2 * pad); if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); }
    c.lineTo(w - pad, h); c.lineTo(pad, h); c.closePath(); c.fillStyle = '#3a5a2a'; c.fill();
    c.strokeStyle = '#5cc36a'; c.lineWidth = 1.5; c.stroke();
  }

  function buildTrackGrid() {
    const grid = el('trackGrid'); grid.innerHTML = '';
    const d = S.get();
    const sort = el('trackSort').value;
    const cards = [];
    // Custom tracks first, then the 100 built-ins.
    for (const t of d.terrains) cards.push({ type: 'custom', t, name: t.name, biome: t.biome, diff: t.difficulty || 3, best: d.progress.terrainBest[t.id] || 0 });
    for (let i = 0; i < HCR.Terrain.TOTAL; i++) {
      const spec = HCR.Terrain.getSpec(i);
      cards.push({ type: 'builtin', i, spec, name: spec.name, biome: spec.biome, diff: spec.difficulty, best: d.progress.terrainBest[spec.id] || 0 });
    }
    if (sort === 'diff') cards.sort((a, b) => a.diff - b.diff);
    else if (sort === 'best') cards.sort((a, b) => b.best - a.best);

    for (const card of cards) {
      const div = document.createElement('div'); div.className = 'cardItem';
      const cv = document.createElement('canvas'); cv.style.width = '100%'; cv.style.height = '84px'; div.appendChild(cv);
      const meta = document.createElement('div'); meta.className = 'meta';
      const stars = '★'.repeat(card.diff) + '☆'.repeat(5 - card.diff);
      meta.innerHTML = '<div class="name">' + card.name + '</div><div class="sub"><span class="stars">' + stars + '</span><span>' + (card.best || 0) + 'm</span></div>';
      div.appendChild(meta); grid.appendChild(div);
      // Thumbnails are drawn after layout so clientWidth is known.
      setTimeout(() => {
        if (card.type === 'builtin') { const terr = HCR.Terrain.makeBuiltin(card.spec); trackThumb(cv, terr, card.spec.length); }
        else { const terr = HCR.Terrain.makeCustom(card.t); trackThumb(cv, terr, card.t.length); }
      }, 0);
      div.addEventListener('click', () => {
        HCR.Audio.ensure(); HCR.Audio.sfxClick();
        if (card.type === 'builtin') { state.trackIndex = card.i; startTrack(HCR.Terrain.makeBuiltin(card.spec), card.spec.id, true); }
        else { state.trackIndex = -1; startTrack(HCR.Terrain.makeCustom(card.t), card.t.id, true); }
      });
    }
    if (!cards.length) grid.innerHTML = '<div class="empty">No tracks yet.</div>';
  }

  // ---- GARAGE LIST ------------------------------------------------------------
  function carThumb(canvas, params) {
    const w = canvas.width = canvas.clientWidth, h = canvas.height = canvas.clientHeight;
    const c = canvas.getContext('2d');
    c.clearRect(0, 0, w, h);
    HCR.Render.drawBackground(c, w, h, 0, false, '#bfe8ff');
    c.strokeStyle = '#3fa34d'; c.lineWidth = 4; c.beginPath(); c.moveTo(0, h * 0.72); c.lineTo(w, h * 0.72); c.stroke();
    const car = HCR.Physics.makeCar(params);
    HCR.Physics.spawn(car, { height: () => 0, normal: () => ({ x: 0, y: 1 }) });
    HCR.Render.drawCar(c, car, car.pos.x, car.pos.y - 6, 0.6, w, h, w * 0.4, h * 0.72);
  }
  function buildGarageList() {
    const grid = el('garageGrid'); grid.innerHTML = '';
    const d = S.get();
    for (const car of d.cars) {
      const div = document.createElement('div'); div.className = 'cardItem';
      const cv = document.createElement('canvas'); cv.style.width = '100%'; cv.style.height = '84px'; div.appendChild(cv);
      const meta = document.createElement('div'); meta.className = 'meta';
      const active = (car.id === d.selectedCarId) ? ' ✓' : '';
      meta.innerHTML = '<div class="name">' + car.params.name + active + '</div><div class="sub"><span>' + car.params.drive.mode.toUpperCase() + '</span><span>' + (car.params.wheels.count > 2 ? '4WD' : '2WD') + '</span></div>';
      div.appendChild(meta); grid.appendChild(div);
      setTimeout(() => carThumb(cv, car.params), 0);
      div.addEventListener('click', () => { HCR.Audio.ensure(); HCR.Audio.sfxClick(); go('builder', { carId: car.id }); });
    }
  }

  // ---- EDITOR LIST ------------------------------------------------------------
  function buildEditorList() {
    const grid = el('editorGrid'); grid.innerHTML = '';
    const d = S.get();
    if (!d.terrains.length) { grid.innerHTML = '<div class="empty">No custom tracks yet. Tap “+ New”.</div>'; }
    for (const t of d.terrains) {
      const div = document.createElement('div'); div.className = 'cardItem';
      const cv = document.createElement('canvas'); cv.style.width = '100%'; cv.style.height = '84px'; div.appendChild(cv);
      const meta = document.createElement('div'); meta.className = 'meta';
      meta.innerHTML = '<div class="name">' + t.name + '</div><div class="sub"><span>' + (t.biome || 'Custom') + '</span></div>';
      div.appendChild(meta); grid.appendChild(div);
      setTimeout(() => trackThumb(cv, HCR.Terrain.makeCustom(t), t.length), 0);
      div.addEventListener('click', () => { HCR.Audio.ensure(); HCR.Audio.sfxClick(); go('editor', { id: t.id }); });
    }
  }

  // ---- SETTINGS ---------------------------------------------------------------
  function buildSettings() {
    const host = el('settingsControls'); host.innerHTML = '';
    const st = state.settings;
    function row(label, desc, control) {
      const r = document.createElement('div'); r.className = 'setRow';
      const left = document.createElement('div');
      left.innerHTML = '<div class="lbl">' + label + '</div><div class="desc">' + (desc || '') + '</div>';
      r.appendChild(left); r.appendChild(control); host.appendChild(r);
    }
    function slider(val, min, max, step, on) {
      const inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = val;
      inp.addEventListener('input', () => on(parseFloat(inp.value))); return inp;
    }
    function toggle(val, on) {
      const b = document.createElement('button'); b.className = 'toggle' + (val ? ' on' : '');
      b.addEventListener('click', () => { val = !val; b.classList.toggle('on', val); on(val); }); return b;
    }
    row('Music Volume', '', slider(st.musicVol, 0, 1, 0.05, (v) => { st.musicVol = v; S.setSetting('musicVol', v); HCR.Audio.setMusicVol(v); }));
    row('SFX Volume', '', slider(st.sfxVol, 0, 1, 0.05, (v) => { st.sfxVol = v; S.setSetting('sfxVol', v); HCR.Audio.setSfxVol(v); }));
    row('Mute', '', toggle(st.muted, (v) => { st.muted = v; S.setSetting('muted', v); HCR.Audio.setMuted(v); }));
    row('Invert Controls', 'Swap gas / brake', toggle(st.invert, (v) => { st.invert = v; S.setSetting('invert', v); }));
    row('Show Touch Buttons', '', toggle(st.showTouch, (v) => { st.showTouch = v; S.setSetting('showTouch', v); }));
    row('Graphics Quality', 'Low = better performance', toggle(st.quality !== 'low', (v) => { st.quality = v ? 'high' : 'low'; S.setSetting('quality', st.quality); resizeCanvas(); }));
    row('Reduced Motion', '', toggle(st.reduceMotion, (v) => { st.reduceMotion = v; S.setSetting('reduceMotion', v); }));

    // Save management.
    const exp = document.createElement('button'); exp.className = 'miniBtn'; exp.textContent = 'Export Save';
    exp.addEventListener('click', () => {
      const blob = new Blob([S.exportSave()], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'hillclimb-save.json'; a.click();
    });
    const imp = document.createElement('button'); imp.className = 'miniBtn'; imp.textContent = 'Import Save';
    const file = document.createElement('input'); file.type = 'file'; file.accept = 'application/json'; file.style.display = 'none';
    file.addEventListener('change', () => { const f = file.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { if (S.importSave(rd.result)) { state.settings = S.get().settings; buildSettings(); refreshMenu(); alert('Save imported!'); } }; rd.readAsText(f); });
    imp.addEventListener('click', () => file.click());
    const rst = document.createElement('button'); rst.className = 'miniBtn danger'; rst.textContent = 'Reset All';
    rst.addEventListener('click', () => { if (confirm('Erase all cars, tracks and progress?')) { S.reset(); state.settings = S.get().settings; buildSettings(); refreshMenu(); } });
    const mgmt = document.createElement('div'); mgmt.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:16px';
    mgmt.append(exp, imp, rst, file); host.appendChild(mgmt);
  }

  // ---- START / TEST DRIVE ------------------------------------------------------
  function startTrack(terrainObj, key, record) {
    // Use the test car if one was supplied, else the player's active saved car.
    const params = state.testCarParams || S.getSelectedCar().params;
    const car = HCR.Physics.makeCar(params);
    state.world = HCR.Physics.createWorld(car, terrainObj);
    state.terrain = terrainObj; state.key = key; state.record = record;
    state.camX = car.pos.x; state.camY = car.pos.y;
    state.mode = 'playing';
    enterGame();
    HCR.Audio.ensure();
    HCR.Audio.startMusic(terrainObj.biome);
    HCR.Audio.engineStart();
  }

  // Launch a quick test drive (from Garage/Editor). carParams optional.
  function testDrive(carParams, terrainObj) {
    state.testCarParams = carParams || null;
    const terr = terrainObj || HCR.Terrain.makeBuiltin(HCR.Terrain.getSpec(1));
    state.trackIndex = -1;
    startTrack(terr, 'test', false);
  }
  HCR.Main = { testDrive, startTrack };

  // ---- PAUSE / RESULTS / QUIT -------------------------------------------------
  function restart() {
    if (!state.terrain) return;
    const params = state.testCarParams || S.getSelectedCar().params;
    const car = HCR.Physics.makeCar(params);
    state.world = HCR.Physics.createWorld(car, state.terrain);
    state.mode = 'playing';
    el('overlay-results').classList.add('hidden');
    el('overlay-pause').classList.add('hidden');
    HCR.Audio.engineStart();
  }
  function quitToMenu() {
    state.mode = 'menu'; state.world = null; state.testCarParams = null;
    HCR.Audio.engineStop(); HCR.Audio.stopMusic();
    el('overlay-results').classList.add('hidden');
    el('overlay-pause').classList.add('hidden');
    go('menu');
  }
  function nextTrack() {
    if (state.trackIndex < 0) { quitToMenu(); return; }
    const ni = (state.trackIndex + 1) % HCR.Terrain.TOTAL;
    state.trackIndex = ni;
    startTrack(HCR.Terrain.makeBuiltin(HCR.Terrain.getSpec(ni)), HCR.Terrain.getSpec(ni).id, true);
  }
  function pauseGame() {
    if (state.mode !== 'playing') return;
    state.mode = 'paused';
    HCR.Audio.engineStop();
    el('overlay-pause').classList.remove('hidden');
  }
  function resumeGame() {
    if (state.mode !== 'paused') return;
    state.mode = 'playing';
    el('overlay-pause').classList.add('hidden');
    HCR.Audio.engineStart();
  }
  function showResults() {
    state.mode = 'results';
    HCR.Audio.engineStop(); HCR.Audio.sfxCrash();
    if (state.record && state.key) S.recordResult(state.key, state.world.score, state.world.coinsTotal);
    el('finalDist').textContent = state.world.score;
    el('finalCoins').textContent = state.world.coinsTotal;
    el('overlay-results').classList.remove('hidden');
    // Hide "Next Track" unless we're on a numbered built-in track.
    const nb = el('resultsNext');
    if (nb) nb.style.display = state.trackIndex >= 0 ? '' : 'none';
    el('resultsTitle').textContent = 'Crashed!';
  }

  // ---- INPUT ------------------------------------------------------------------
  function setGas(v) { state.input.gas = v; }
  function setBrake(v) { state.input.brake = v; }
  // Apply the "invert controls" setting at read time.
  function readInput() {
    const inv = state.settings.invert;
    return { gas: inv ? state.input.brake : state.input.gas, brake: inv ? state.input.gas : state.input.brake };
  }

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const lay = state.settings.layout;
    const gas = lay === 'wasd' ? 'd' : 'ArrowRight';
    const brake = lay === 'wasd' ? 'a' : 'ArrowLeft';
    if (e.key === gas || e.key === 'ArrowRight' || e.key === 'd') setGas(true);
    if (e.key === brake || e.key === 'ArrowLeft' || e.key === 'a') setBrake(true);
    if (e.key === 'Escape' && state.mode === 'playing') pauseGame();
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'd') setGas(false);
    if (e.key === 'ArrowLeft' || e.key === 'a') setBrake(false);
  });

  // Touch buttons (pointerdown/up). They also ensure audio on first tap.
  function bindHold(b, on, off) {
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); HCR.Audio.ensure(); on(); });
    b.addEventListener('pointerup', (e) => { e.preventDefault(); off(); });
    b.addEventListener('pointerleave', (e) => { e.preventDefault(); off(); });
    b.addEventListener('pointercancel', () => off());
  }
  bindHold(el('gasBtn'), () => setGas(true), () => setGas(false));
  bindHold(el('brakeBtn'), () => setBrake(true), () => setBrake(false));

  // ---- HUD + RENDER -----------------------------------------------------------
  function updateHUD() {
    const w = state.world; if (!w) return;
    el('distVal').textContent = w.score;
    el('coinVal').textContent = w.coinsTotal;
    el('bestVal').textContent = S.getBest(state.key) || 0;
    el('fuelBar').style.width = (w.fuel / w.maxFuel * 100) + '%';
  }
  const W_ = () => window.innerWidth, H_ = () => window.innerHeight;
  function render() {
    const w = state.world; if (!w) return;
    const W = W_(), H = H_();
    HCR.Render.drawBackground(ctx, W, H, state.camX, state.settings.quality !== 'low', state.terrain.sky);
    HCR.Render.drawTerrain(ctx, state.terrain, state.camX, state.camY, state.scale, W, H);
    HCR.Render.drawCoins(ctx, state.terrain, state.camX, state.camY, state.scale, W, H);
    HCR.Render.drawCar(ctx, w.car, state.camX, state.camY, state.scale, W, H);
  }

  // ---- MAIN GAME LOOP ---------------------------------------------------------
  // Hardened with try/catch so a single runtime error can never freeze the app.
  let last = performance.now();
  function frame(now) {
    try {
      let dt = (now - last) / 1000; last = now;
      if (dt > 0.05) dt = 0.05; // clamp big gaps (tab switch) to keep physics stable
      if (state.mode === 'playing') {
        const inp = readInput();
        HCR.Physics.step(state.world, dt, inp);
        // Smooth camera follow.
        state.camX += (state.world.car.pos.x - state.camX) * 0.12;
        state.camY += (state.world.car.pos.y - state.camY) * 0.10;
        // Engine sound follows wheel speed (RPM proxy).
        let spd = 0; for (const wh of state.world.car.wheels) { const ts = Math.abs(wh.vel.x * Math.cos(state.world.car.angle) + wh.vel.y * Math.sin(state.world.car.angle)); if (ts > spd) spd = ts; }
        const rpm = Math.max(0, Math.min(1, spd / 1200));
        HCR.Audio.engineUpdate(rpm, (inp.gas && state.world.fuel > 0) ? 1 : (inp.brake ? 0.6 : 0.08));
        if (state.world.crashed) showResults();
      }
      if (state.world && state.mode !== 'menu') { render(); updateHUD(); }
    } catch (e) {
      console.error('frame error (game loop kept alive):', e);
    }
    requestAnimationFrame(frame);
  }

  // ---- GLOBAL CLICK DELEGATION (menu/back/overlays) --------------------------
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action;
    HCR.Audio.ensure(); HCR.Audio.sfxClick();
    if (a === 'play') go('play');
    else if (a === 'garage') go('garage');
    else if (a === 'editor') go('editorList');
    else if (a === 'settings') go('settings');
    else if (a === 'back') back();
    else if (a === 'newCar') go('builder', { carId: null });
    else if (a === 'editorNew') go('editor', { fresh: true });
    else if (a === 'resume') resumeGame();
    else if (a === 'restart') restart();
    else if (a === 'quit') quitToMenu();
    else if (a === 'retry') restart();
    else if (a === 'next') nextTrack();
  });

  el('pauseBtn').addEventListener('click', pauseGame);
  el('builderTest').addEventListener('click', () => HCR.Garage.testDrive());
  el('builderSave').addEventListener('click', () => HCR.Garage.save());
  el('builderSaveAs').addEventListener('click', () => HCR.Garage.saveAs());
  el('builderDelete').addEventListener('click', () => HCR.Garage.del());
  el('builderActive').addEventListener('click', () => HCR.Garage.setActive());
  el('editorTest').addEventListener('click', () => HCR.Editor.testDrive());
  el('editorSave').addEventListener('click', () => HCR.Editor.save());
  el('editorNew').addEventListener('click', () => go('editor', { fresh: true }));
  el('trackSort').addEventListener('change', buildTrackGrid);

  window.addEventListener('resize', () => { if (state.mode !== 'menu') resizeCanvas(); });

  // ---- BOOT -------------------------------------------------------------------
  function boot() {
    S.load();
    state.settings = S.get().settings;
    resizeCanvas();
    const v = HCR.Audio.getVols();
    HCR.Audio.setMusicVol(state.settings.musicVol);
    HCR.Audio.setSfxVol(state.settings.sfxVol);
    HCR.Audio.setMuted(state.settings.muted);
    showScreen('menu');
    requestAnimationFrame(frame);
  }
  boot();
})();
