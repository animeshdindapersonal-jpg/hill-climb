/* ============================================================================
 * editor.js  —  Terrain Editor (paint your own tracks)
 * ----------------------------------------------------------------------------
 * The track is stored as a fixed array of height SAMPLES (one value every
 * `spacing` px). The editor lets you push the ground up/down with brushes,
 * smooth/flatten, drop ramps/pits, and place coins + start/finish. Everything
 * auto-saves to Storage as a "draft" so closing never loses work.
 *
 * Screen ↔ world mapping: the whole track is fit into the canvas width, so
 * worldX = screenX / scale. We re-fit vertically each frame from the samples.
 * ==========================================================================*/

(function () {
  'use strict';
  const HCR = (window.HCR = window.HCR || {});
  const el = (id) => document.getElementById(id);

  const SPACING = 8; // px between height samples
  // Tools the player can pick from the toolbar.
  const TOOLS = [
    { id: 'raise', label: 'Raise' }, { id: 'lower', label: 'Lower' },
    { id: 'smooth', label: 'Smooth' }, { id: 'flatten', label: 'Flatten' },
    { id: 'ramp', label: 'Ramp' }, { id: 'pit', label: 'Pit' },
    { id: 'coin', label: 'Coin' }, { id: 'start', label: 'Start' }, { id: 'finish', label: 'Finish' },
  ];

  const st = {
    samples: null, spacing: SPACING, length: 4000,
    coins: [], startX: 120, finishX: 3800,
    name: 'My Track', biome: 'Custom', id: null,
    tool: 'raise', brush: 60, strength: 18,
    canvas: null, ctx: null, raf: 0, last: 0, pointer: null, draftTimer: 0,
  };

  // Fresh flat track.
  function blank(length) {
    const n = Math.ceil(length / SPACING) + 1;
    const arr = new Array(n);
    for (let i = 0; i < n; i++) arr[i] = 0;
    return arr;
  }

  // Build a live terrain sampler from the current samples (so preview/render
  // use the exact same data the player is editing).
  function sampler() {
    const obj = HCR.Terrain.makeSampleSampler(st.samples, st.spacing, st.length, {
      coins: st.coins.map((c) => ({ x: c.x, y: c.y, taken: false, spin: 0 })),
      length: st.length, startX: st.startX, finishX: st.finishX,
    });
    return obj;
  }

  // Rebuild the toolbar buttons.
  function buildTools() {
    const host = el('editorTools'); host.innerHTML = '';
    for (const t of TOOLS) {
      const b = document.createElement('button'); b.className = 'tool' + (t.id === st.tool ? ' active' : '');
      b.textContent = t.label; b.dataset.tool = t.id;
      b.addEventListener('click', () => { st.tool = t.id; HCR.Audio.sfxClick(); buildTools(); });
      host.appendChild(b);
    }
    const br = document.createElement('label'); br.style.cssText = 'font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px';
    br.innerHTML = 'Brush <input type="range" id="eBrush" min="20" max="160" step="5" value="' + st.brush + '" style="width:90px;accent-color:var(--accent)">';
    host.appendChild(br);
    const sr = document.createElement('label'); sr.style.cssText = 'font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px';
    sr.innerHTML = 'Power <input type="range" id="eStr" min="4" max="50" step="1" value="' + st.strength + '" style="width:90px;accent-color:var(--accent)">';
    host.appendChild(sr);
    el('eBrush').addEventListener('input', (e) => { st.brush = +e.target.value; });
    el('eStr').addEventListener('input', (e) => { st.strength = +e.target.value; });
  }

  // Convert a pointer event into a world x (using the current fit).
  function worldFromEvent(e) {
    const rect = st.canvas.getBoundingClientRect();
    const sx = (e.clientX - rect.left), sy = (e.clientY - rect.top);
    const fit = computeFit(rect.width, rect.height);
    const wx = (sx - fit.anchorX) / fit.scale + fit.camX;
    return { wx, sx, sy, fit };
  }

  // Fit the whole track into the canvas (compute camera/scale for both axes).
  function computeFit(W, H) {
    let minH = 1e9, maxH = -1e9;
    for (let i = 0; i < st.samples.length; i++) { if (st.samples[i] < minH) minH = st.samples[i]; if (st.samples[i] > maxH) maxH = st.samples[i]; }
    maxH += 140; minH -= 20;
    const range = Math.max(50, maxH - minH);
    const scale = Math.min(W / st.length, (H - 60) / range);
    const mid = (minH + maxH) / 2;
    return { scale, camX: 0, camY: mid, anchorX: 0, anchorY: H / 2, W, H };
  }

  // Apply the active tool at a world x. Continuous tools run while dragging;
  // ramp/pit/coin/start/finish are single-click placements.
  function applyTool(wx, isClick) {
    const s = sampler();
    if (st.tool === 'coin') {
      if (!isClick) return;
      st.coins.push({ x: Math.max(0, Math.min(st.length, wx)), y: s.height(wx) - 60 });
      HCR.Audio.sfxClick(); return;
    }
    if (st.tool === 'start') { st.startX = Math.max(0, Math.min(st.length - 100, wx)); HCR.Audio.sfxClick(); return; }
    if (st.tool === 'finish') { st.finishX = Math.max(100, Math.min(st.length, wx)); HCR.Audio.sfxClick(); return; }
    if (st.tool === 'ramp' || st.tool === 'pit') {
      if (!isClick) return;
      const amp = (st.tool === 'ramp' ? 1 : -1) * st.strength * 5;
      const sig = st.brush;
      const ci = Math.round(wx / st.spacing);
      const r = Math.ceil(sig / st.spacing) * 2;
      for (let i = ci - r; i <= ci + r; i++) {
        if (i < 0 || i >= st.samples.length) continue;
        const dx = (i - ci) * st.spacing;
        st.samples[i] += amp * Math.exp(-(dx * dx) / (2 * sig * sig));
      }
      HCR.Audio.sfxClick(); return;
    }
    // Continuous brushes (raise/lower/smooth/flatten).
    const ci = Math.round(wx / st.spacing);
    const r = Math.max(0, Math.round(st.brush / st.spacing));
    const target = s.height(wx);
    for (let i = ci - r; i <= ci + r; i++) {
      if (i < 0 || i >= st.samples.length) continue;
      const fall = 1 - Math.abs(i - ci) / (r + 1);
      const dxw = i * st.spacing;
      if (st.tool === 'raise') st.samples[i] += st.strength * fall;
      else if (st.tool === 'lower') st.samples[i] -= st.strength * fall;
      else if (st.tool === 'smooth') {
        const a = st.samples[Math.max(0, i - 1)], b = st.samples[Math.min(st.samples.length - 1, i + 1)];
        st.samples[i] = st.samples[i] + ((a + b) / 2 - st.samples[i]) * 0.5 * fall;
      } else if (st.tool === 'flatten') {
        st.samples[i] = st.samples[i] + (target - st.samples[i]) * fall;
      }
    }
  }

  // Editor render loop.
  function loop() {
    const now = performance.now(); let dt = (now - st.last) / 1000; st.last = now;
    if (st.pointer && st.pointer.down) applyTool(st.pointer.wx, false);
    draw();
    // Auto-save draft every ~2 s.
    st.draftTimer += dt;
    if (st.draftTimer > 2) { st.draftTimer = 0; saveDraft(); }
    st.raf = requestAnimationFrame(loop);
  }

  function draw() {
    const ctx = st.ctx, canvas = st.canvas;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const fit = computeFit(W, H);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0e1733'; ctx.fillRect(0, 0, W, H);
    const s = sampler();
    HCR.Render.drawTerrain(ctx, s, fit.camX, fit.camY, fit.scale, W, H, fit.anchorX, fit.anchorY);
    HCR.Render.drawCoins(ctx, s, fit.camX, fit.camY, fit.scale, W, H, fit.anchorX, fit.anchorY);
    // Start / finish markers.
    const sx0 = fit.anchorX + (st.startX - fit.camX) * fit.scale;
    const sx1 = fit.anchorX + (st.finishX - fit.camX) * fit.scale;
    ctx.fillStyle = '#34c759'; ctx.fillRect(sx0 - 2, 0, 4, H);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.fillText('START', sx0 + 6, 16);
    ctx.fillStyle = '#ff5a5a'; ctx.fillRect(sx1 - 2, 0, 4, H);
    ctx.fillStyle = '#fff'; ctx.fillText('FINISH', sx1 + 6, 16);
    // Brush cursor ring.
    if (st.pointer) {
      const br = st.brush * fit.scale;
      ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(st.pointer.sx, st.pointer.sy, Math.max(4, br), 0, 7); ctx.stroke();
    }
  }

  function saveDraft() {
    HCR.Storage.setDraft({
      samples: st.samples, spacing: st.spacing, length: st.length,
      coins: st.coins, startX: st.startX, finishX: st.finishX,
      name: st.name, biome: st.biome, id: st.id,
    });
  }

  // Collect the current track into a storable record (reads the name field).
  function getData() {
    return {
      samples: st.samples, spacing: st.spacing, length: st.length,
      coins: st.coins, startX: st.startX, finishX: st.finishX,
      name: (el('editorName') ? el('editorName').value : st.name) || 'My Track',
      biome: st.biome, sky: '#cfe0ff', difficulty: 3,
    };
  }

  // ---- public API -----------------------------------------------------------
  function open(existingId, opts) {
    opts = opts || {};
    const S = HCR.Storage;
    st.id = null;
    if (existingId) {
      // Edit an existing custom track.
      const t = S.getCustomTerrain(existingId);
      if (t) {
        st.samples = t.samples.slice(); st.spacing = t.spacing || SPACING; st.length = t.length;
        st.coins = (t.coins || []).map((c) => ({ x: c.x, y: c.y }));
        st.startX = t.startX != null ? t.startX : 120; st.finishX = t.finishX != null ? t.finishX : t.length - 200;
        st.name = t.name; st.biome = t.biome || 'Custom'; st.id = existingId;
      }
    } else if (!opts.fresh) {
      // Resume the last auto-saved draft, if any.
      const d = S.getDraft();
      if (d && d.samples) {
        st.samples = d.samples.slice(); st.spacing = d.spacing || SPACING; st.length = d.length;
        st.coins = (d.coins || []).map((c) => ({ x: c.x, y: c.y }));
        st.startX = d.startX != null ? d.startX : 120; st.finishX = d.finishX != null ? d.finishX : d.length - 200;
        st.name = d.name || 'My Track'; st.biome = d.biome || 'Custom'; st.id = d.id || null;
      }
    }
    if (!st.samples) { st.samples = blank(st.length); st.coins = []; st.startX = 120; st.finishX = st.length - 200; }

    // Name input injected next to the title (only once).
    const title = el('editorTitle');
    if (!el('editorName')) {
      const inp = document.createElement('input'); inp.type = 'text'; inp.id = 'editorName'; inp.value = st.name;
      inp.style.cssText = 'background:#0e1733;color:#fff;border:1px solid var(--line);border-radius:8px;padding:6px;width:160px';
      title.insertAdjacentElement('afterend', inp);
    } else el('editorName').value = st.name;

    buildTools();
    st.canvas = el('editorCanvas'); st.ctx = st.canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => { st.canvas.width = st.canvas.clientWidth * dpr; st.canvas.height = st.canvas.clientHeight * dpr; st.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    resize(); st._resize = resize; window.addEventListener('resize', resize);

    // Pointer interaction on the canvas.
    st.canvas.onpointerdown = (e) => {
      st.canvas.setPointerCapture(e.pointerId);
      const p = worldFromEvent(e); st.pointer = { down: true, wx: p.wx, sx: p.sx, sy: p.sy };
      applyTool(p.wx, true);
    };
    st.canvas.onpointermove = (e) => {
      const p = worldFromEvent(e);
      if (st.pointer) { st.pointer.wx = p.wx; st.pointer.sx = p.sx; st.pointer.sy = p.sy; }
      else st.pointer = { down: false, wx: p.wx, sx: p.sx, sy: p.sy };
    };
    st.canvas.onpointerup = () => { if (st.pointer) st.pointer.down = false; };
    st.canvas.onpointerleave = () => { if (st.pointer && !st.pointer.down) st.pointer = null; };

    st.last = performance.now(); st.draftTimer = 0;
    st.raf = requestAnimationFrame(loop);
  }

  function close() {
    if (st.raf) cancelAnimationFrame(st.raf); st.raf = 0;
    if (st._resize) window.removeEventListener('resize', st._resize);
    saveDraft();
  }

  function save() {
    const data = getData();
    const id = HCR.Storage.addCustomTerrain(data, st.id || undefined);
    st.id = id;
    HCR.Audio.sfxClick(); flash('Saved!');
  }
  function saveAs() {
    const data = getData(); data.name = data.name + ' copy';
    const id = HCR.Storage.addCustomTerrain(data);
    st.id = id; HCR.Audio.sfxClick(); flash('Saved as new');
  }
  function del() {
    if (st.id) { HCR.Storage.deleteCustomTerrain(st.id); HCR.Audio.sfxClick(); flash('Deleted'); }
  }
  function testDrive() {
    const data = getData();
    const terr = HCR.Terrain.makeCustom(data);
    close();
    // Launch a real game on the custom track with the player's active car.
    HCR.Main.testDrive(null, terr);
  }

  let flashTimer = 0;
  function flash(msg) {
    let t = el('editorFlash');
    if (!t) { t = document.createElement('div'); t.id = 'editorFlash'; t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#34c759;color:#06210f;padding:10px 18px;border-radius:20px;font-weight:800;z-index:50;transition:opacity .3s'; document.body.appendChild(t); }
    t.textContent = msg; t.style.opacity = '1';
    clearTimeout(flashTimer); flashTimer = setTimeout(() => { t.style.opacity = '0'; }, 1100);
  }

  HCR.Editor = { open, close, save, saveAs, del, testDrive };
})();
