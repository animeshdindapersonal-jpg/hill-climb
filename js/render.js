/* ============================================================================
 * render.js  —  Shared canvas drawing (used by the game AND the Garage preview)
 * ----------------------------------------------------------------------------
 * All drawing functions are "camera-agnostic": you pass camX/camY/scale and the
 * screen anchor, so the exact same code renders the full game and the little
 * car preview in the builder. Coordinates: world is y-UP; the screen is y-DOWN,
 * so screenY = anchorY - (worldY - camY) * scale.
 * ==========================================================================*/

(function () {
  'use strict';
  const HCR = (window.HCR = window.HCR || {});

  // Sky gradient + sun + two parallax hill layers that scroll slower than the
  // world (fake depth). parallax=false skips the hills (used in small previews).
  function drawBackground(ctx, W, H, camX, parallax, skyColor) {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, skyColor || '#bfe8ff');
    sky.addColorStop(0.6, '#dff1ff');
    sky.addColorStop(1, '#eef8ff');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,243,190,0.95)';
    ctx.beginPath(); ctx.arc(W * 0.82, H * 0.16, 42, 0, 7); ctx.fill();
    if (!parallax) return;
    const layers = [
      { off: 0.25, amp: 70, base: H * 0.62, col: 'rgba(120,170,210,0.45)', freq: 0.0016 },
      { off: 0.45, amp: 110, base: H * 0.70, col: 'rgba(95,150,190,0.55)', freq: 0.0022 },
    ];
    for (const L of layers) {
      ctx.fillStyle = L.col;
      ctx.beginPath(); ctx.moveTo(0, H);
      const camShift = camX * L.off;
      for (let x = 0; x <= W; x += 8) {
        const wx = x + camShift;
        const y = L.base - (Math.sin(wx * L.freq) * L.amp + Math.sin(wx * L.freq * 2.3 + 1) * L.amp * 0.4);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    }
  }

  // Draw the terrain fill + grass top line by sampling height() across the view.
  function drawTerrain(ctx, terrain, camX, camY, scale, W, H, anchorX, anchorY) {
    anchorX = anchorX == null ? W * 0.32 : anchorX;
    anchorY = anchorY == null ? H * 0.58 : anchorY;
    const step = 4;
    const pts = [];
    for (let x = -20; x <= W + 20; x += step) {
      const wx = camX + (x - anchorX) / scale;
      const wy = terrain.height(wx);
      pts.push([x, anchorY - (wy - camY) * scale]);
    }
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.lineTo(W + 20, H + 20); ctx.lineTo(-20, H + 20); ctx.closePath();
    const g = ctx.createLinearGradient(0, H * 0.4, 0, H);
    g.addColorStop(0, '#7a4a25'); g.addColorStop(1, '#3c2412');
    ctx.fillStyle = g; ctx.fill();
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.strokeStyle = '#3fa34d'; ctx.lineWidth = 6; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.strokeStyle = '#5cc36a'; ctx.lineWidth = 2; ctx.stroke();
  }

  function drawCoins(ctx, terrain, camX, camY, scale, W, H, anchorX, anchorY) {
    anchorX = anchorX == null ? W * 0.32 : anchorX;
    anchorY = anchorY == null ? H * 0.58 : anchorY;
    const coins = terrain.coins || [];
    for (let i = 0; i < coins.length; i++) {
      const coin = coins[i];
      if (coin.taken) continue;
      if (Math.abs(coin.x - camX) > W / scale / 2 + 120) continue; // off-screen cull
      const cx = anchorX + (coin.x - camX) * scale;
      const cy = anchorY - (coin.y - camY) * scale;
      const rw = 13 * scale, rh = 13 * scale * Math.abs(Math.cos(coin.spin)); // spin = squash
      ctx.fillStyle = '#ffcf33';
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(3, rw * (0.4 + 0.6 * Math.abs(Math.cos(coin.spin)))), rh, 0, 0, 7);
      ctx.fill();
      ctx.strokeStyle = '#e0a800'; ctx.lineWidth = 2; ctx.stroke();
    }
  }

  // Draw the car body, cabin, windshield, wheels (with spinning spokes) and the
  // little driver. Everything is transformed by the car's angle + the camera.
  function drawCar(ctx, car, camX, camY, scale, W, H, anchorX, anchorY) {
    anchorX = anchorX == null ? W * 0.32 : anchorX;
    anchorY = anchorY == null ? H * 0.58 : anchorY;
    const C = car.colors || { chassis: '#e23b3b', cabin: '#c62f2f', wheel: '#1c1c1c', rim: '#9a9a9a', helmet: '#2b6cff' };
    const a = car.angle, c = Math.cos(a), s = Math.sin(a);
    // Rotate a local point into world space.
    const R = (px, py) => [car.pos.x + (px * c - py * s), car.pos.y + (px * s + py * c)];
    const sx = (wx) => anchorX + (wx - camX) * scale;
    const sy = (wy) => anchorY - (wy - camY) * scale;

    // Suspension struts (chassis anchor → wheel).
    for (let i = 0; i < car.wheels.length; i++) {
      const wheel = car.wheels[i];
      const aw = R(wheel.anchor.x, wheel.anchor.y);
      ctx.strokeStyle = '#2b2b2b'; ctx.lineWidth = Math.max(2, 5 * scale);
      ctx.beginPath(); ctx.moveTo(sx(aw[0]), sy(aw[1])); ctx.lineTo(sx(wheel.pos.x), sy(wheel.pos.y)); ctx.stroke();
    }
    // Wheels with hub + spokes.
    for (let i = 0; i < car.wheels.length; i++) {
      const wheel = car.wheels[i];
      const wx = sx(wheel.pos.x), wy = sy(wheel.pos.y), rr = wheel.r * scale;
      ctx.fillStyle = C.wheel; ctx.beginPath(); ctx.arc(wx, wy, rr, 0, 7); ctx.fill();
      ctx.fillStyle = C.rim; ctx.beginPath(); ctx.arc(wx, wy, rr * 0.45, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = Math.max(1.5, 3 * scale);
      for (let k = 0; k < 4; k++) {
        const ang = wheel.spin + k * Math.PI / 2;
        ctx.beginPath(); ctx.moveTo(wx, wy);
        ctx.lineTo(wx + Math.cos(ang) * rr * 0.9, wy + Math.sin(ang) * rr * 0.9); ctx.stroke();
      }
    }
    // Chassis polygon (size comes from params).
    const hw = car.params ? car.params.chassis.width / 2 : 42;
    const hh = car.params ? car.params.chassis.height / 2 : 14;
    const body = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
      .map((p) => { const w = R(p[0], p[1]); return [sx(w[0]), sy(w[1])]; });
    ctx.fillStyle = C.chassis;
    ctx.beginPath(); ctx.moveTo(body[0][0], body[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(body[i][0], body[i][1]); ctx.closePath(); ctx.fill();

    // Cabin.
    const cab = [[-hw * 0.5, -hh], [hw * 0.5, -hh], [hw * 0.35, -hh * 2.6], [-hw * 0.35, -hh * 2.6]]
      .map((p) => { const w = R(p[0], p[1]); return [sx(w[0]), sy(w[1])]; });
    ctx.fillStyle = C.cabin;
    ctx.beginPath(); ctx.moveTo(cab[0][0], cab[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(cab[i][0], cab[i][1]); ctx.closePath(); ctx.fill();

    // Windshield.
    ctx.fillStyle = 'rgba(180,230,255,0.85)';
    const ws = [R(hw * 0.2, -hh * 1.1), R(hw * 0.4, -hh * 2.4), R(hw * 0.05, -hh * 2.4), R(-hw * 0.1, -hh * 1.1)]
      .map((w) => [sx(w[0]), sy(w[1])]);
    ctx.beginPath(); ctx.moveTo(ws[0][0], ws[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(ws[i][0], ws[i][1]); ctx.closePath(); ctx.fill();

    // Driver head + helmet.
    const hpt = R(0, hh * 2.1);
    const hx = sx(hpt[0]), hy = sy(hpt[1]);
    ctx.fillStyle = '#ffd9a8'; ctx.beginPath(); ctx.arc(hx, hy, 10 * scale, 0, 7); ctx.fill();
    ctx.fillStyle = C.helmet;
    ctx.beginPath(); ctx.arc(hx, hy - 2 * scale, 11 * scale, Math.PI, 2 * Math.PI); ctx.fill();
  }

  HCR.Render = { drawBackground, drawTerrain, drawCoins, drawCar };
})();
