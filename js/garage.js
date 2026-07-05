/* ============================================================================
 * garage.js  —  Car Builder (the "Build Your Own Car" screen)
 * ----------------------------------------------------------------------------
 * Lets the player tweak every physics parameter of a car with sliders/selects/
 * colours, see a LIVE physics preview (a real mini world running the same
 * simulation), watch derived STATS bars, and Save / Save-As / Delete / Set
 * Active. The params object produced here is exactly what Physics.makeCar
 * consumes, so "what you tune is what you drive".
 * ==========================================================================*/

(function () {
  'use strict';
  const HCR = (window.HCR = window.HCR || {});

  // The schema drives the whole UI: each entry becomes a labelled control and
  // reads/writes a dotted key path inside the car params (e.g. 'drive.engineForce').
  const SCHEMA = [
    { group: 'Chassis', items: [
      { key: 'chassis.width', label: 'Width', min: 60, max: 140, step: 1, unit: 'px' },
      { key: 'chassis.height', label: 'Height', min: 14, max: 60, step: 1, unit: 'px' },
      { key: 'chassis.mass', label: 'Mass', min: 3, max: 16, step: 0.5 },
      { key: 'chassis.comX', label: 'Balance', min: -20, max: 20, step: 1, hint: '+ front heavy' },
    ]},
    { group: 'Drivetrain', items: [
      { key: 'drive.engineForce', label: 'Engine', min: 3000, max: 14000, step: 250 },
      { key: 'drive.brakeForce', label: 'Brake', min: 2000, max: 12000, step: 250 },
      { key: 'drive.rollResist', label: 'Grip', min: 2, max: 12, step: 0.5 },
      { key: 'drive.airTorque', label: 'Air Control', min: 2, max: 14, step: 0.5 },
      { key: 'drive.mode', label: 'Drive', type: 'select', options: ['rwd', 'fwd', 'awd'] },
    ]},
    { group: 'Suspension', items: [
      { key: 'suspension.stiffness', label: 'Stiffness', min: 800, max: 5000, step: 50 },
      { key: 'suspension.damping', label: 'Damping', min: 20, max: 300, step: 5 },
      { key: 'suspension.restLength', label: 'Ride Height', min: 18, max: 44, step: 1 },
    ]},
    { group: 'Wheels', items: [
      { key: 'wheels.count', label: 'Axles', type: 'select', options: [2, 4] },
      { key: 'wheels.radius', label: 'Wheel Size', min: 14, max: 34, step: 1 },
      { key: 'wheels.mass', label: 'Wheel Mass', min: 0.6, max: 3, step: 0.1 },
    ]},
    { group: 'Colors', items: [
      { key: 'colors.chassis', label: 'Body', type: 'color' },
      { key: 'colors.cabin', label: 'Cabin', type: 'color' },
      { key: 'colors.wheel', label: 'Tire', type: 'color' },
      { key: 'colors.rim', label: 'Rim', type: 'color' },
      { key: 'colors.helmet', label: 'Helmet', type: 'color' },
    ]},
  ];

  // Read/write a nested value by its dotted key path.
  function getVal(p, key) { const ks = key.split('.'); let o = p; for (const k of ks) o = o[k]; return o; }
  function setVal(p, key, v) { const ks = key.split('.'); let o = p; for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]]; o[ks[ks.length - 1]] = v; }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  const el = (id) => document.getElementById(id);
  // Local state for the builder screen.
  const state = { params: null, car: null, editingId: null };
  // Preview runs its own little world on a flat ground.
  const preview = { car: null, terrain: null, gas: false, raf: 0, canvas: null, ctx: null, last: 0, t: 0, _resize: null, _world: null, _carRef: null };

  // Build all the slider/select/color controls from SCHEMA, wiring each to
  // live-update the preview car + stats.
  function buildControls(params) {
    const host = el('builderControls');
    host.innerHTML = '';
    const nameRow = document.createElement('div'); nameRow.className = 'row';
    nameRow.innerHTML = '<input type="text" id="carName" value="' + escapeHtml(params.name) + '">';
    host.appendChild(nameRow);

    for (const grp of SCHEMA) {
      const g = document.createElement('div'); g.className = 'group';
      const h = document.createElement('h3'); h.textContent = grp.group; g.appendChild(h);
      for (const it of grp.items) {
        const f = document.createElement('div'); f.className = 'field';
        const lab = document.createElement('label'); lab.textContent = it.label; f.appendChild(lab);
        if (it.type === 'select') {
          const sel = document.createElement('select');
          for (const o of it.options) { const opt = document.createElement('option'); opt.value = o; opt.textContent = o; if (String(getVal(params, it.key)) === String(o)) opt.selected = true; sel.appendChild(opt); }
          sel.addEventListener('change', () => { setVal(params, it.key, (it.options[0] === 2 || it.options[0] === 4) ? parseInt(sel.value, 10) : sel.value); refresh(); });
          f.appendChild(sel);
        } else if (it.type === 'color') {
          const inp = document.createElement('input'); inp.type = 'color'; inp.value = getVal(params, it.key);
          inp.addEventListener('input', () => { setVal(params, it.key, inp.value); refresh(); });
          f.appendChild(inp);
        } else {
          const inp = document.createElement('input'); inp.type = 'range';
          inp.min = it.min; inp.max = it.max; inp.step = it.step; inp.value = getVal(params, it.key);
          const val = document.createElement('span'); val.className = 'val';
          const show = () => val.textContent = (+inp.value).toFixed(it.step < 1 ? 1 : 0) + (it.unit || '');
          show();
          inp.addEventListener('input', () => { setVal(params, it.key, parseFloat(inp.value)); show(); refresh(); });
          f.appendChild(inp); f.appendChild(val);
        }
        g.appendChild(f);
      }
      host.appendChild(g);
    }
  }

  // Rebuild the preview car from current params + redraw the stats bars.
  function refresh() {
    const p = state.params;
    state.car = HCR.Physics.makeCar(p);
    HCR.Physics.spawn(state.car, preview.terrain);
    renderStats(p);
  }

  function renderStats(p) {
    const st = HCR.Physics.computeStats(p);
    const host = el('builderStats'); host.innerHTML = '';
    const labels = { topSpeed: 'Top Speed', acceleration: 'Acceleration', grip: 'Grip', stability: 'Stability', airControl: 'Air Control' };
    for (const k in labels) {
      const row = document.createElement('div'); row.className = 'stat-row';
      row.innerHTML = '<span>' + labels[k] + '</span><div class="stat-track"><div class="stat-fill"></div></div>';
      host.appendChild(row);
      // Animate the bar width on the next frame.
      requestAnimationFrame(() => { row.querySelector('.stat-fill').style.width = Math.round(st[k]) + '%'; });
    }
  }

  // Start the preview's own render/step loop on a flat ground.
  function startPreview() {
    const canvas = el('builderPreview');
    preview.canvas = canvas; preview.ctx = canvas.getContext('2d');
    preview.terrain = { height: (x) => 0, normal: (x) => ({ x: 0, y: 1 }), coins: [], length: 2000, startX: 200 };
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => { canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr; preview.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    resize(); window.addEventListener('resize', resize); preview._resize = resize;
    // Tap/hold the preview to "press gas" and watch the suspension react.
    canvas.addEventListener('pointerdown', () => { preview.gas = true; });
    window.addEventListener('pointerup', () => { preview.gas = false; });

    preview.last = performance.now();
    const loop = () => {
      const now = performance.now(); let dt = (now - preview.last) / 1000; preview.last = now;
      if (dt > 0.05) dt = 0.05;
      preview.t += dt;
      if (state.car && state.car.pos.x > 900) { HCR.Physics.spawn(state.car, preview.terrain); } // keep it on-screen
      HCR.Physics.step(previewWorld(), dt, { gas: preview.gas, brake: false });
      drawPreview();
      preview.raf = requestAnimationFrame(loop);
    };
    preview.raf = requestAnimationFrame(loop);
  }

  // Cache one world per preview car so we don't recreate it every frame.
  function previewWorld() {
    if (!preview._world || preview._carRef !== state.car) {
      preview._world = HCR.Physics.createWorld(state.car, preview.terrain);
      preview._carRef = state.car;
    }
    return preview._world;
  }

  function drawPreview() {
    const ctx = preview.ctx, canvas = preview.canvas;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);
    HCR.Render.drawBackground(ctx, W, H, 0, false, '#bfe8ff');
    ctx.strokeStyle = '#3fa34d'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(0, H * 0.72); ctx.lineTo(W, H * 0.72); ctx.stroke();
    HCR.Render.drawCar(ctx, state.car, state.car.pos.x, state.car.pos.y - 10, 0.62, W, H, W * 0.4, H * 0.72);
    if (preview.gas) { ctx.fillStyle = '#34c759'; ctx.font = 'bold 13px sans-serif'; ctx.fillText('GAS', 10, 20); }
  }

  function stopPreview() {
    if (preview.raf) cancelAnimationFrame(preview.raf);
    preview.raf = 0;
    if (preview._resize) window.removeEventListener('resize', preview._resize);
  }

  // ---- public API (called by main.js) --------------------------------------
  function open(carId) {
    const S = HCR.Storage;
    if (carId) {
      const car = S.getCar(carId);
      state.editingId = carId; state.params = JSON.parse(JSON.stringify(car.params));
    } else {
      state.editingId = null;
      state.params = HCR.Storage.defaultCarParams('classic');
    }
    el('builderTitle').textContent = carId ? 'Edit Car' : 'New Car';
    preview.terrain = { height: (x) => 0, normal: (x) => ({ x: 0, y: 1 }), coins: [], length: 2000, startX: 200 };
    buildControls(state.params);
    refresh();
    startPreview();
  }
  function close() { stopPreview(); }

  // Read the (possibly renamed) params from the controls.
  function currentParams() {
    const p = JSON.parse(JSON.stringify(state.params));
    p.name = (el('carName').value || 'My Car').trim() || 'My Car';
    return p;
  }
  function save() {
    const p = currentParams();
    const S = HCR.Storage;
    if (state.editingId) S.updateCar(state.editingId, p);
    else { const c = S.addCar(p); state.editingId = c.id; }
    HCR.Audio.sfxClick(); flash('Saved!');
  }
  function saveAs() {
    const p = currentParams(); p.name = p.name + ' copy';
    const c = HCR.Storage.addCar(p);
    state.editingId = c.id; refresh();
    HCR.Audio.sfxClick(); flash('Saved as new');
  }
  function del() {
    if (!state.editingId) { flash('Nothing to delete'); return; }
    if (HCR.Storage.deleteCar(state.editingId)) { HCR.Audio.sfxClick(); state.editingId = null; flash('Deleted'); }
    else flash('Keep at least 1 car');
  }
  function setActive() {
    if (state.editingId) { HCR.Storage.setSelectedCar(state.editingId); HCR.Audio.sfxClick(); flash('Active car set'); }
  }
  function testDrive() {
    stopPreview();
    // Hand the current build to main.js, which launches a real game with it.
    HCR.Main.testDrive(currentParams());
  }

  // Tiny toast message.
  let flashTimer = 0;
  function flash(msg) {
    let t = el('builderFlash');
    if (!t) { t = document.createElement('div'); t.id = 'builderFlash'; t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#34c759;color:#06210f;padding:10px 18px;border-radius:20px;font-weight:800;z-index:50;transition:opacity .3s'; document.body.appendChild(t); }
    t.textContent = msg; t.style.opacity = '1';
    clearTimeout(flashTimer); flashTimer = setTimeout(() => { t.style.opacity = '0'; }, 1100);
  }

  HCR.Garage = { open, close, save, saveAs, del, setActive, testDrive };
})();
