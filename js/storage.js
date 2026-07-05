/* ============================================================================
 * storage.js  —  All persistence via localStorage (one versioned JSON blob)
 * ----------------------------------------------------------------------------
 * One key holds EVERYTHING so saving/loading is trivial and atomic:
 *   • settings      — volumes, controls, graphics quality, etc.
 *   • cars          — the player's saved/built vehicles (presets + custom)
 *   • terrains      — custom tracks made in the Editor
 *   • progress      — best distance / coins per track, total coins
 *   • editorDraft   — the in-progress Editor track (auto-saved)
 *
 * Everything is keyed under `hcr_save_v2`. We defensively migrate/repair on
 * load so an older or partial save never crashes the game.
 * ==========================================================================*/

(function () {
  'use strict';
  const HCR = (window.HCR = window.HCR || {});
  const KEY = 'hcr_save_v2';

  // ---- car presets ----------------------------------------------------------
  // Deep-merge a base car with a patch object (used to make themed presets).
  function merge(base, patch) {
    const out = JSON.parse(JSON.stringify(base));
    for (const k in patch) {
      if (typeof patch[k] === 'object' && !Array.isArray(patch[k])) Object.assign(out[k], patch[k]);
      else out[k] = patch[k];
    }
    return out;
  }
  function defaultCarParams(style) {
    const base = {
      name: 'Classic',
      chassis: { width: 84, height: 28, mass: 7, comX: 0 },
      drive: { engineForce: 7500, brakeForce: 7000, rollResist: 5, airTorque: 7, mode: 'awd' },
      suspension: { stiffness: 2200, damping: 90, restLength: 30 },
      wheels: { count: 2, radius: 22, mass: 1.2 },
      colors: { chassis: '#e23b3b', cabin: '#c62f2f', wheel: '#1c1c1c', rim: '#9a9a9a', helmet: '#2b6cff' },
    };
    if (style === 'hauler') return merge(base, {
      name: 'Heavy Hauler', chassis: { width: 120, height: 40, mass: 13, comX: 6 },
      drive: { engineForce: 11000, brakeForce: 9000, rollResist: 7, airTorque: 5, mode: 'awd' },
      suspension: { stiffness: 3400, damping: 160, restLength: 34 },
      wheels: { count: 4, radius: 26, mass: 2 },
      colors: { chassis: '#f0a500', cabin: '#c97e00', wheel: '#222', rim: '#bbb', helmet: '#222' },
    });
    if (style === 'buggy') return merge(base, {
      name: 'Dune Buggy', chassis: { width: 70, height: 20, mass: 5, comX: -6 },
      drive: { engineForce: 9000, brakeForce: 6000, rollResist: 4, airTorque: 10, mode: 'rwd' },
      suspension: { stiffness: 1600, damping: 70, restLength: 34 },
      wheels: { count: 2, radius: 28, mass: 1 },
      colors: { chassis: '#22c1c3', cabin: '#14898b', wheel: '#111', rim: '#ddd', helmet: '#ffd24d' },
    });
    if (style === 'moon') return merge(base, {
      name: 'Moon Rover', chassis: { width: 96, height: 30, mass: 9, comX: 0 },
      drive: { engineForce: 6500, brakeForce: 5000, rollResist: 3, airTorque: 9, mode: 'awd' },
      suspension: { stiffness: 1300, damping: 60, restLength: 38 },
      wheels: { count: 4, radius: 30, mass: 1.4 },
      colors: { chassis: '#e8e8f0', cabin: '#b9b9d6', wheel: '#333', rim: '#fff', helmet: '#2b6cff' },
    });
    return JSON.parse(JSON.stringify(base));
  }

  let data = null;

  // Build the default save the very first time (or after a reset).
  function seedDefaults() {
    const cars = [
      defaultCarParams('classic'),
      defaultCarParams('hauler'),
      defaultCarParams('buggy'),
      defaultCarParams('moon'),
    ].map((p, i) => ({ id: 'car' + i, params: p, created: Date.now() }));

    return {
      version: 2,
      settings: { musicVol: 0.5, sfxVol: 0.7, muted: false, invert: false, layout: 'arrows', showTouch: true, quality: 'high', reduceMotion: false },
      cars,
      selectedCarId: 'car0',
      terrains: [],
      progress: { terrainBest: {}, terrainCoins: {}, totalCoins: 0, unlocked: [] },
      editorDraft: null,
      meta: { created: Date.now(), lastPlayed: 0 },
    };
  }

  // ---- load / save ----------------------------------------------------------
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) { data = JSON.parse(raw); migrate(); }
      else { data = seedDefaults(); save(); }
    } catch (e) { data = seedDefaults(); }
    return data;
  }
  // Backfill any missing fields so old/partial saves still work.
  function migrate() {
    const d = seedDefaults();
    data.settings = Object.assign(d.settings, data.settings || {});
    if (!Array.isArray(data.cars) || !data.cars.length) data.cars = d.cars;
    if (!data.selectedCarId || !data.cars.find((c) => c.id === data.selectedCarId)) data.selectedCarId = data.cars[0].id;
    data.terrains = data.terrains || [];
    data.progress = Object.assign(d.progress, data.progress || {});
    data.progress.terrainBest = data.progress.terrainBest || {};
    data.editorDraft = data.editorDraft || null;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { console.warn('save failed', e); }
  }
  function get() { return data; }

  // ---- cars ------------------------------------------------------------------
  function getCars() { return data.cars; }
  function getCar(id) { return data.cars.find((c) => c.id === id); }
  function getSelectedCar() { return getCar(data.selectedCarId) || data.cars[0]; }
  function setSelectedCar(id) { data.selectedCarId = id; save(); }
  function addCar(params, id) {
    id = id || ('car' + Date.now() + Math.floor(Math.random() * 1000));
    const car = { id, params, created: Date.now() };
    data.cars.push(car); save(); return car;
  }
  function updateCar(id, params) { const c = getCar(id); if (c) { c.params = params; save(); } }
  // Never delete the last car so the game always has something to drive.
  function deleteCar(id) {
    if (data.cars.length <= 1) return false;
    data.cars = data.cars.filter((c) => c.id !== id);
    if (data.selectedCarId === id) data.selectedCarId = data.cars[0].id;
    save(); return true;
  }

  // ---- custom terrains -------------------------------------------------------
  function getCustomTerrains() { return data.terrains; }
  function getCustomTerrain(id) { return data.terrains.find((t) => t.id === id); }
  function addCustomTerrain(t, id) {
    id = id || ('terr' + Date.now());
    t.id = id; t.created = Date.now();
    const existing = getCustomTerrain(id);
    if (existing) Object.assign(existing, t);
    else data.terrains.push(t);
    save(); return id;
  }
  function deleteCustomTerrain(id) { data.terrains = data.terrains.filter((t) => t.id !== id); save(); }

  // ---- progress --------------------------------------------------------------
  function recordResult(terrainKey, dist, coins) {
    const best = data.progress.terrainBest[terrainKey] || 0;
    if (dist > best) data.progress.terrainBest[terrainKey] = dist;
    const old = data.progress.terrainCoins[terrainKey] || 0;
    if (coins > old) data.progress.terrainCoins[terrainKey] = coins;
    // totalCoins = sum of the player's best coin count on each track.
    data.progress.totalCoins = Object.values(data.progress.terrainCoins).reduce((a, b) => a + b, 0);
    save();
  }
  function getBest(terrainKey) { return data.progress.terrainBest[terrainKey] || 0; }

  // ---- editor draft (auto-saved in-progress track) --------------------------
  function setDraft(d) { data.editorDraft = d; save(); }
  function getDraft() { return data.editorDraft; }
  function clearDraft() { data.editorDraft = null; save(); }

  // ---- settings --------------------------------------------------------------
  function setSetting(k, v) { data.settings[k] = v; save(); }

  // ---- export / import / reset ----------------------------------------------
  function exportSave() { return JSON.stringify(data, null, 2); }
  function importSave(json) {
    try { const d = JSON.parse(json); if (!d || !d.cars) return false; data = d; migrate(); save(); return true; }
    catch (e) { return false; }
  }
  function reset() { data = seedDefaults(); save(); }

  HCR.Storage = {
    load, save, get, getCars, getCar, getSelectedCar, setSelectedCar,
    addCar, updateCar, deleteCar,
    getCustomTerrains, getCustomTerrain, addCustomTerrain, deleteCustomTerrain,
    recordResult, getBest,
    setDraft, getDraft, clearDraft,
    setSetting, exportSave, importSave, reset, defaultCarParams,
  };
})();
