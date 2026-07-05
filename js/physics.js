/* ============================================================================
 * physics.js  —  Data-driven 2D vehicle + heightfield simulation
 * ----------------------------------------------------------------------------
 * This is the "engine" of the whole game. It contains NO DOM / browser code so
 * it can be unit-tested in plain Node. The car, terrain and world are all plain
 * data objects; the functions here only read/write numbers on them.
 *
 * Core ideas (these mirror the original Hill Climb Racing feel):
 *   • The CHASSIS is a rigid body: position, velocity, angle, angular velocity,
 *     mass, and rotational inertia.
 *   • Each WHEEL is a separate point-mass connected to the chassis by a
 *     spring-damper "suspension" along the body's down-axis, plus a stiff
 *     constraint in the tangential (sideways) axis so the wheel stays under its
 *     anchor. This gives bouncy, believable suspension for free.
 *   • The world is a HEIGHTFIELD: for any x there is exactly one ground height
 *     y = terrain.height(x). Wheel/ground contact is resolved with a penalty
 *     (soft) normal force + a friction cone.
 *   • GAS applies a forward force at the wheel contact point. Because the
 *     contact is below the centre of mass, that force naturally creates a
 *     "wheelie" torque. In the air, gas/brake apply a pure rotation torque.
 * ==========================================================================*/

(function () {
  'use strict';
  // Attach everything to a single global namespace so the other files
  // (terrain, storage, garage, editor, main) can use HCR.Physics.* .
  const HCR = (window.HCR = window.HCR || {});

  // ---- tiny math helpers -----------------------------------------------------
  function clamp(v, m) { return v > m ? m : v < -m ? -m : v; }

  // Smooth 0→1 ramp used to flatten the ground near the spawn so the car
  // doesn't start on a slope. t in [a,b] → 0 before a, 1 after b, smooth between.
  function smoothstep(a, b, x) {
    if (x <= a) return 0; if (x >= b) return 1;
    const t = (x - a) / (b - a); return t * t * (3 - 2 * t);
  }

  // ===========================================================================
  //  WHEEL LAYOUT  — turns the user's "axles" + "drive mode" choices into a
  //  concrete list of wheel anchor points and which ones are powered.
  // ===========================================================================
  function wheelConfigs(p) {
    const w = p.wheels;
    let anchors;
    if (w.count <= 2) {
      // 2-wheel "buggy": one wheel front (+x), one rear (−x).
      anchors = [
        { x: -34, y: -10, axle: 'rear' },
        { x: 34, y: -10, axle: 'front' },
      ];
    } else {
      // 4-wheel "truck": a pair at each end → more stable, wider contact.
      anchors = [
        { x: -46, y: -10, axle: 'rear' },
        { x: -28, y: -10, axle: 'rear' },
        { x: 28, y: -10, axle: 'front' },
        { x: 46, y: -10, axle: 'front' },
      ];
    }
    const mode = p.drive.mode; // 'awd' | 'rwd' | 'fwd'
    // Decide powered wheels from the drive mode and each wheel's axle.
    return anchors.map((a) => ({
      ax: a.x, ay: a.y,
      powered: mode === 'awd' ? true : mode === 'rwd' ? a.axle === 'rear' : a.axle === 'front',
    }));
  }

  // ===========================================================================
  //  makeCar  — build a car rigid-body + wheels from a PARAMS object.
  //  `params` comes straight from the Garage builder (or a saved preset), so
  //  every slider the player touches ends up here.
  // ===========================================================================
  function makeCar(p) {
    const W = p.chassis.width, Hh = p.chassis.height;
    const M = p.chassis.mass;
    // Rotational inertia of a rectangle about its centre: I = (1/12) m (w² + h²).
    const I = (1 / 12) * M * (W * W + Hh * Hh);

    const car = {
      pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, angle: 0, angVel: 0,
      mass: M, invMass: 1 / M, inertia: I, invI: 1 / I,
      // Drivetrain / handling values copied from params for fast access:
      driveForce: p.drive.engineForce, brakeForce: p.drive.brakeForce,
      rollResist: p.drive.rollResist, airTorque: p.drive.airTorque,
      suspK: p.suspension.stiffness, suspC: p.suspension.damping,
      colors: p.colors, params: p, wheels: [],
    };

    const cfgs = wheelConfigs(p);
    const L0 = p.suspension.restLength, r = p.wheels.radius, wm = p.wheels.mass;
    // Balance slider shifts the wheels relative to the centre of mass:
    //  +comX = nose-heavy (stable), −comX = tail-heavy (wheelie-prone).
    const comX = p.chassis.comX || 0;
    for (const c of cfgs) {
      const ax = c.ax - comX, ay = c.ay;
      car.wheels.push({
        anchor: { x: ax, y: ay }, L0, r, powered: c.powered,
        // Initial wheel position sits L0 below its anchor (rest pose).
        pos: { x: ax, y: ay - L0 }, vel: { x: 0, y: 0 },
        mass: wm, invMass: 1 / wm, spin: 0, contact: false,
      });
    }
    return car;
  }

  // Place the car on the terrain at its start x and let gravity settle it.
  function spawn(car, terrain) {
    const sx0 = terrain.startX != null ? terrain.startX : 120;
    car.pos.x = sx0;
    car.pos.y = terrain.height(sx0) + 62; // ~ wheel radius + ride height above ground
    for (const w of car.wheels) {
      w.pos.x = car.pos.x + w.anchor.x;
      w.pos.y = car.pos.y + w.anchor.y - w.L0;
      w.vel.x = 0; w.vel.y = 0; w.spin = 0; w.contact = false;
    }
  }

  // Create a fresh world (car + terrain + run state) and spawn the car.
  function createWorld(car, terrain) {
    spawn(car, terrain);
    return {
      car, terrain,
      gravity: 2400, time: 0,
      fuel: 100, maxFuel: 100, crashed: false,
      coinsTotal: 0, startX: car.pos.x, maxX: car.pos.x, score: 0,
    };
  }

  // ===========================================================================
  //  substep  — one fixed physics sub-step (the heart of the simulation).
  //  Called `sub` times per frame for stability with stiff springs.
  // ===========================================================================
  function substep(w, h, input) {
    const car = w.car, g = w.gravity;
    const a = car.angle, c = Math.cos(a), s = Math.sin(a);
    const k_s = car.suspK, c_s = car.suspC;
    // Tangential (sideways) suspension is a bit stiffer than the vertical one
    // so wheels don't slide sideways off their anchors.
    const k_t = k_s * 1.15, c_t = c_s * 1.3;
    const k_g = 9000, c_g = 350, mu = 1.1; // ground penalty + friction coefficient
    const terrain = w.terrain;
    let anyContact = false;

    for (let i = 0; i < car.wheels.length; i++) {
      const wheel = car.wheels[i];

      // --- suspension attachment math ---
      // World position & velocity of the chassis point the wheel hangs from.
      const rx = wheel.anchor.x * c - wheel.anchor.y * s;
      const ry = wheel.anchor.x * s + wheel.anchor.y * c;
      const awx = car.pos.x + rx, awy = car.pos.y + ry;
      // Velocity of that point = body velocity + ω × r  (2D cross product).
      const avx = car.vel.x - car.angVel * ry;
      const avy = car.vel.y + car.angVel * rx;

      // Body axes (unit vectors) in world space:
      const nx = s, ny = -c;   // body-DOWN   = rotate (0,-1)
      const tx = c, ty = s;   // body-FORWARD = rotate (1, 0)

      // Vector from anchor to wheel, split into "along suspension" and
      // "tangential" components.
      const dx = wheel.pos.x - awx, dy = wheel.pos.y - awy;
      const along = dx * nx + dy * ny;
      const tang = dx * tx + dy * ty;
      const relvx = wheel.vel.x - avx, relvy = wheel.vel.y - avy;
      const vAlong = relvx * nx + relvy * ny;
      const vTang = relvx * tx + relvy * ty;

      // Spring-damper forces (Hooke's law + damping):
      const Fs = -k_s * (along - wheel.L0) - c_s * vAlong; // vertical suspension
      const Ft = -k_t * tang - c_t * vTang;                // sideways alignment
      const fx = nx * Fs + tx * Ft;
      const fy = ny * Fs + ty * Ft;

      // Apply force to the wheel...
      wheel.vel.x += fx * wheel.invMass * h;
      wheel.vel.y += fy * wheel.invMass * h;
      // ...and the equal/opposite reaction to the chassis at the anchor
      // (this is what lets a wheel push the body around → wheelies, etc.).
      car.vel.x -= fx * car.invMass * h;
      car.vel.y -= fy * car.invMass * h;
      car.angVel -= (rx * fy - ry * fx) * car.invI * h; // torque = r × F

      // Gravity on the wheel itself.
      wheel.vel.y -= g * h;

      // --- ground collision (penalty method) ---
      const gy = terrain.height(wheel.pos.x);
      const pen = gy - (wheel.pos.y - wheel.r); // how far the wheel bottom is underground
      let contact = false;
      if (pen > 0) {
        contact = true; anyContact = true;
        const n = terrain.normal(wheel.pos.x);
        const vn = wheel.vel.x * n.x + wheel.vel.y * n.y;
        // Soft normal force: pushes the wheel out, scaled by penetration and
        // incoming speed (this is what supports the car's weight).
        let Fn = k_g * pen - c_g * Math.min(vn, 0);
        if (Fn < 0) Fn = 0;
        wheel.vel.x += n.x * Fn * wheel.invMass * h;
        wheel.vel.y += n.y * Fn * wheel.invMass * h;

        // Tangential (grip) handling:
        const vn2 = wheel.vel.x * n.x + wheel.vel.y * n.y;
        const vtx = wheel.vel.x - vn2 * n.x, vty = wheel.vel.y - vn2 * n.y; // slip velocity
        let drive = 0;
        if (input.gas && w.fuel > 0 && wheel.powered) drive += car.driveForce;
        if (input.brake) drive -= car.brakeForce; // brake/reverse on every wheel
        // Total tangential force = engine drive − rolling resistance (viscous).
        let fx2 = tx * drive - vtx * car.rollResist;
        let fy2 = ty * drive - vty * car.rollResist;
        // Friction cone: tangential force can't exceed μ·N, or the wheel slips.
        const maxF = mu * Fn;
        const mag = Math.hypot(fx2, fy2);
        if (mag > maxF && mag > 0) { const k = maxF / mag; fx2 *= k; fy2 *= k; }
        wheel.vel.x += fx2 * wheel.invMass * h;
        wheel.vel.y += fy2 * wheel.invMass * h;
      }
      wheel.contact = contact;
    }

    // Gravity on the chassis.
    car.vel.y -= g * h;
    // In the air, gas/brake rotate the car (engine torque felt mid-flight).
    if (!anyContact) {
      if (input.gas && w.fuel > 0) car.angVel += car.airTorque * h;
      if (input.brake) car.angVel -= car.airTorque * h;
    }

    // Integrate (semi-implicit Euler): update positions from velocities.
    car.pos.x += car.vel.x * h;
    car.pos.y += car.vel.y * h;
    car.angle += car.angVel * h;
    for (let i = 0; i < car.wheels.length; i++) {
      const wheel = car.wheels[i];
      wheel.pos.x += wheel.vel.x * h;
      wheel.pos.y += wheel.vel.y * h;
    }

    // Safety clamps so nothing can ever explode to infinity.
    car.vel.x = clamp(car.vel.x, 3000);
    car.vel.y = clamp(car.vel.y, 3000);
    car.angVel = clamp(car.angVel, 14);
  }

  // Crash test: if any chassis/roof/driver-head point pokes below the terrain,
  // the car has flipped onto its body → game over. (0.6 s grace at spawn.)
  function checkCrash(w) {
    if (w.time < 0.6) return;
    const car = w.car, a = car.angle, c = Math.cos(a), s = Math.sin(a);
    const pts = [[-42, -14], [42, -14], [-42, 14], [42, 14],
      [0, 30], [-18, 22], [18, 22], [0, -14], [0, 18]];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const wx = car.pos.x + (p[0] * c - p[1] * s);
      const wy = car.pos.y + (p[0] * s + p[1] * c);
      if (wy < w.terrain.height(wx) - 3) { w.crashed = true; return; }
    }
  }

  // Advance the world by dt seconds. Runs `sub` sub-steps for stability.
  function step(w, dt, input) {
    if (w.crashed) return;
    const sub = 8, h = dt / sub;
    for (let i = 0; i < sub; i++) substep(w, h, input);
    w.time += dt;

    // Fuel burns while accelerating/braking.
    if (input.gas && w.fuel > 0) w.fuel = Math.max(0, w.fuel - 6 * dt);
    if (input.brake) w.fuel = Math.max(0, w.fuel - 3 * dt);

    // Spin the wheels visually based on forward road speed.
    const a = w.car.angle, c = Math.cos(a), s = Math.sin(a);
    for (let i = 0; i < w.car.wheels.length; i++) {
      const wheel = w.car.wheels[i];
      const tspeed = wheel.vel.x * c + wheel.vel.y * s;
      wheel.spin -= (tspeed / wheel.r) * dt;
    }

    // Coin pickups (distance check against the car centre).
    const coins = w.terrain.coins;
    for (let i = 0; i < coins.length; i++) {
      const coin = coins[i];
      if (coin.taken) continue;
      const dx = coin.x - w.car.pos.x, dy = coin.y - w.car.pos.y;
      if (dx * dx + dy * dy < 55 * 55) { coin.taken = true; w.coinsTotal++; }
      coin.spin += dt * 4;
    }

    // Score = how far right the car has travelled, in "metres".
    if (w.car.pos.x > w.maxX) w.maxX = w.car.pos.x;
    w.score = Math.max(0, Math.floor((w.maxX - w.startX) / 12));

    checkCrash(w);
    return w.crashed;
  }

  // ===========================================================================
  //  computeStats  — turn raw params into 0..100 bars for the Garage UI so the
  //  player understands trade-offs (these are display-only, not physics).
  // ===========================================================================
  function computeStats(p) {
    const wm = p.wheels.count > 2 ? p.wheels.mass * 2 : p.wheels.mass;
    const total = p.chassis.mass + wm;
    const topSpeed = p.drive.engineForce / p.drive.rollResist;     // terminal velocity
    const accel = p.drive.engineForce / total;                     // F = ma
    const wheelbase = p.wheels.count > 2 ? 92 : 68;
    const stability = (wheelbase / 10) * (p.chassis.mass / 7) * (1 - Math.min(1, Math.abs(p.chassis.comX) / 40));
    const norm = (v, a, b) => Math.max(0, Math.min(100, ((v - a) / (b - a)) * 100));
    return {
      topSpeed: norm(topSpeed, 300, 3000),
      acceleration: norm(accel, 300, 2000),
      grip: norm(p.drive.rollResist, 2, 12),
      stability: norm(stability, 2, 12),
      airControl: norm(p.drive.airTorque, 2, 14),
    };
  }

  // Public API used by the rest of the game.
  HCR.Physics = { makeCar, spawn, createWorld, step, checkCrash, computeStats, wheelConfigs, smoothstep };
})();
