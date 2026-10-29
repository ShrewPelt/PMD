const WORLD_COLS = 1024;
const WORLD_ROWS = 1024;
const CHUNK = 32;
const TOOL_CHARS = { floor: ".", wall: "#", barrier: "x", void: " " };
const TOOL_PREVIEW = { floor: 0x5a5a88, wall: 0x8a6a4a, barrier: 0xc0392b, void: 0x000000, tile: 0x4a9a4a, tileclear: 0x888888, object: 0xd8a840, objerase: 0xc0392b, passable: 0x3ec13e, passableclear: 0x999999 };
const worldArtPool = {};
const worldObjectPool = {};
const worldAssetState = {};
let worldAssetsDirty = false;
let worldLastView = null;
let worldViewOverGfx = null;
let worldAssetList = { tiles: [], objects: [], blocking: [] };
let wgTileCategory = "Default";
const worldEntityMeta = {};
const worldEntityLabels = {};

function entityUpsert(scene, e) {
  worldEntityMeta[e.id] = { kind: e.kind, name: e.name, state: e.state, dex: e.dex, fainted: !!e.fainted };
  const sprite = otherPlayers[e.id];
  if (!sprite) {
    addOtherPlayer(scene, { id: e.id, dex: e.dex, col: e.col, row: e.row, direction: e.direction });
    return;
  }
  if (sprite === "loading") return;
  sprite.direction = e.direction;
  const tx = tilePixelX(e.col);
  const ty = tilePixelY(e.row);
  if (sprite.x !== tx || sprite.y !== ty) {
    sprite.play(sprite.dex + "_walk_" + e.direction);
    scene.tweens.add({ targets: sprite, x: tx, y: ty, duration: 110, onComplete: () => { if (sprite.active) sprite.play(sprite.dex + "_idle_" + sprite.direction); } });
  } else {
    sprite.play(sprite.dex + "_idle_" + e.direction);
  }
}

function entityRemove(id) {
  removeOtherPlayer(id);
  delete worldEntityMeta[id];
  if (worldEntityLabels[id]) {
    worldEntityLabels[id].destroy();
    delete worldEntityLabels[id];
  }
}

function entitiesReconcile(scene, list) {
  const wanted = {};
  for (const e of list) wanted[e.id] = true;
  for (const id of Object.keys(otherPlayers)) {
    if (id.charAt(0) === "e" && !wanted[id] && !combatHolds(id)) entityRemove(id);
  }
  for (const e of list) entityUpsert(scene, e);
}

function entityClearAll() {
  for (const id of Object.keys(otherPlayers)) {
    if (id.charAt(0) === "e") entityRemove(id);
  }
}

function entityLabelsFrame(scene) {
  for (const id of Object.keys(worldEntityMeta)) {
    const sp = otherPlayers[id];
    if (!sp) {
      delete worldEntityMeta[id];
      if (worldEntityLabels[id]) {
        worldEntityLabels[id].destroy();
        delete worldEntityLabels[id];
      }
      continue;
    }
    if (sp === "loading") continue;
    const meta = worldEntityMeta[id];
    let label = worldEntityLabels[id];
    if (!label) {
      label = scene.add.text(0, 0, "", { fontFamily: "sans-serif", fontSize: "12px", stroke: "#000000", strokeThickness: 3 });
      label.setOrigin(0.5, 0);
      label.setDepth(200);
      worldEntityLabels[id] = label;
    }
    if (meta.kind === "corpse") {
      label.setText(meta.name + " (fainted) T: loot");
      label.setColor("#d9c27a");
      if (!COMBAT.active || !COMBAT.actors[id]) sp.setAlpha(0.45);
    } else if (meta.fainted) {
      label.setText(meta.name + " (fainted)");
      label.setColor("#d9c27a");
      if (!COMBAT.active || !COMBAT.actors[id]) sp.setAlpha(0.45);
    } else {
      if (sp.alpha < 1 && (!COMBAT.active || !COMBAT.actors[id])) sp.setAlpha(1);
      label.setText((meta.state === "alert" ? "! " : "") + meta.name);
      label.setColor(meta.state === "alert" ? "#ff5050" : (meta.kind === "enemy" ? "#ffb0b0" : (meta.kind === "companion" ? "#8fd0ff" : "#9fe89f")));
    }
    const off = (sp.feetOff !== undefined ? sp.feetOff : TILE / 2 - 2) + 12;
    label.setRotation(-viewRot);
    label.setPosition(sp.x + off * Math.sin(viewRot), sp.y + off * Math.cos(viewRot));
  }
  for (const id of Object.keys(worldEntityLabels)) {
    if (!worldEntityMeta[id]) {
      worldEntityLabels[id].destroy();
      delete worldEntityLabels[id];
    }
  }
}

function worldInteract() {
  if (worldPlayerMode) gmSend({ type: "interact" });
}

let worldPlayerMode = false;
let worldGmMode = false;
let worldViewGfx = null;
let gmSpaceDown = false;

const WG = {
  layer: 0,
  name: "",
  rows: [],
  portals: {},
  spawn: null,
  spawns: [],
  spawnMoveId: null,
  spawnLabels: {},
  layers: [],
  players: {},
  tool: "floor",
  shape: "pencil",
  portalSource: null,
  tpTarget: null,
  selPlayer: null,
  playerDrag: null,
  drawRange: null,
  undo: [],
  strokeUndo: null,
  stroke: null,
  pan: null,
  chunks: {},
  overlays: {},
  art: [],
  palette: {},
  objects: {},
  passable: {},
  entities: {},
  selectedEntity: null,
  notice: "",
  noticeUntil: 0,
  tileName: "",
  tileRot: 0,
  tileFlip: false,
  objRot: 0,
  objFlip: false,
  hoverObjSprite: null,
  hoverSprite: null,
  objName: "",
  viewKey: "",
  artDirty: true,
  gridGfx: null,
  markerGfx: null,
  previewGfx: null,
  hoverCol: 0,
  hoverRow: 0,
  panel: null
};

function blankRows() {
  const rows = [];
  const blank = " ".repeat(WORLD_COLS);
  for (let r = 0; r < WORLD_ROWS; r++) rows.push(blank);
  return rows;
}

function worldDrawBase(g, c, r, ch) {
  if (ch === " " || ch === "#") return;
  g.fillStyle(0x3a3a55, 1);
  g.fillRect(c * TILE, r * TILE, TILE - 2, TILE - 2);
}

function worldDrawOverlay(g, c, r, ch, forPlayers) {
  const x = c * TILE;
  const y = r * TILE;
  if (ch === "#") {
    g.fillStyle(0x6b4f3a, 1);
    g.fillRect(x, y, TILE - 2, TILE - 2);
    g.lineStyle(2, 0x8a6a4a, 1);
    g.strokeRect(x + 1, y + 1, TILE - 4, TILE - 4);
    return;
  }
  if (ch === "x" && !forPlayers) {
    g.fillStyle(0xc0392b, 0.45);
    g.fillRect(x, y, TILE - 2, TILE - 2);
    g.lineStyle(2, 0xff6b5b, 1);
    g.lineBetween(x + 6, y + 6, x + TILE - 8, y + TILE - 8);
    g.lineBetween(x + TILE - 8, y + 6, x + 6, y + TILE - 8);
    return;
  }
  if (ch === "P") {
    g.fillStyle(0x9b59b6, 1);
    g.fillCircle(x + TILE / 2 - 1, y + TILE / 2 - 1, 15);
    g.fillStyle(0xd7b8ee, 1);
    g.fillCircle(x + TILE / 2 - 1, y + TILE / 2 - 1, 7);
  }
}

function worldAssetUrl(kind, name) {
  return "assets/" + (kind === "tile" ? "tilemap" : "objects") + "/" + encodeURIComponent(name) + ".png";
}

function worldEnsureAsset(scene, kind, name) {
  const key = kind + "_" + name;
  if (scene.textures.exists(key)) return key;
  if (worldAssetState[key]) return null;
  worldAssetState[key] = "loading";
  scene.load.once("filecomplete-image-" + key, () => {
    worldAssetState[key] = "ready";
    worldAssetsDirty = true;
  });
  scene.load.image(key, worldAssetUrl(kind, name));
  if (!scene.load.isLoading()) scene.load.start();
  return null;
}

function worldSyncPool(scene, pool, wanted, kind) {
  for (const key in pool) {
    if (!wanted[key]) {
      pool[key].destroy();
      delete pool[key];
    }
  }
  for (const key in wanted) {
    const w = wanted[key];
    const parsed = kind === "tile" ? worldParseTileName(w.name) : { base: w.name, rot: 0, flip: false };
    const tex = worldEnsureAsset(scene, kind, parsed.base);
    if (!tex) continue;
    let sp = pool[key];
    if (sp && sp.texKey !== tex) {
      sp.destroy();
      sp = null;
      delete pool[key];
    }
    if (!sp) {
      if (kind === "tile") {
        sp = scene.add.image(w.c * TILE + TILE / 2, w.r * TILE + TILE / 2, tex);
        sp.setOrigin(0.5, 0.5);
        sp.setDisplaySize(TILE + 1, TILE + 1);
        sp.setDepth(1);
      } else {
        sp = scene.add.image(w.c * TILE + TILE / 2 - 1, w.r * TILE + TILE / 2 - 1, tex);
        const scale = (TILE - 2) / Math.max(sp.width, sp.height);
        sp.setScale(scale);
        sp.baseScale = scale;
        sp.setDepth(w.walk ? 11 : 3);
      }
      sp.texKey = tex;
      pool[key] = sp;
    }
    if (kind === "tile" || !w.walk) sp.setAlpha(w.alpha === undefined ? 1 : w.alpha);
    if (kind === "tile") {
      sp.setFlipX(parsed.flip);
      sp.setAngle(parsed.rot);
    } else {
      sp.cellC = w.c;
      sp.cellR = w.r;
      sp.walkObj = !!w.walk;
      sp.setDepth(w.walk ? 11 : 3);
      sp.objDef = visDefForName(w.name);
      sp.setFlipX(!!w.flip);
      sp.objRotRad = (w.rot || 0) * Math.PI / 180;
      sp.setRotation(sp.objRotRad ? sp.objRotRad : -viewRot);
    }
  }
}

function worldParseTileName(full) {
  const text = String(full || "");
  const at = text.lastIndexOf("@");
  if (at > 0) {
    const m = text.substring(at + 1).match(/^(90|180|270)?(f)?$/);
    if (m && (m[1] || m[2])) return { base: text.substring(0, at), rot: m[1] ? parseInt(m[1], 10) : 0, flip: !!m[2] };
  }
  return { base: text, rot: 0, flip: false };
}

function gmTileStoredName() {
  if (!WG.tileRot && !WG.tileFlip) return WG.tileName;
  return WG.tileName + "@" + (WG.tileRot ? WG.tileRot : "") + (WG.tileFlip ? "f" : "");
}

function worldSyncItems(scene, items) {
  floorItems = items || [];
  const wanted = {};
  for (const it of floorItems) wanted[it.col + "," + it.row] = true;
  for (const key in floorItemSprites) {
    if (!wanted[key]) {
      floorItemSprites[key].destroy();
      delete floorItemSprites[key];
    }
  }
  renderAllFloorItems(scene);
  updatePlayerLift();
}

const MUSIC = { tracks: [], queue: [], current: null, audio: null, state: "stopped", volume: 0.4, unlocked: false, el: null, label: null, playBtn: null, period: null, fading: [], lastFrame: 0 };
const MUSIC_FADE_MS = 3000;

function musicCurrentPeriod() {
  return visDarknessFor(visHourNow()) > 0.02 ? "night" : "day";
}

function musicPool() {
  const wantNight = MUSIC.period === "night";
  const pool = MUSIC.tracks.filter((t) => (t.group === "night") === wantNight);
  return pool.length > 0 ? pool : MUSIC.tracks;
}

function musicShuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function musicNextTrack() {
  if (MUSIC.tracks.length === 0) return null;
  if (MUSIC.queue.length === 0) {
    MUSIC.queue = musicShuffle(musicPool());
    if (MUSIC.queue.length > 1 && MUSIC.current && MUSIC.queue[0].url === MUSIC.current.url) {
      const first = MUSIC.queue.shift();
      MUSIC.queue.push(first);
    }
  }
  return MUSIC.queue.shift();
}

function musicRefreshUi() {
  if (!MUSIC.el) return;
  MUSIC.playBtn.textContent = MUSIC.state === "playing" ? "Pause" : (MUSIC.state === "paused" ? "Resume" : "Play");
  if (MUSIC.tracks.length === 0) MUSIC.label.textContent = "No music found";
  else if (MUSIC.state === "stopped") MUSIC.label.textContent = "Music stopped";
  else if (MUSIC.state === "blocked") MUSIC.label.textContent = "Click anywhere to start the music";
  else MUSIC.label.textContent = (MUSIC.state === "paused" ? "Paused: " : "Now playing: ") + (MUSIC.current ? MUSIC.current.name : "");
}

function musicStartTrack(crossfade) {
  if (MUSIC.period === null) MUSIC.period = musicCurrentPeriod();
  const track = musicNextTrack();
  if (!track) {
    musicRefreshUi();
    return;
  }
  if (MUSIC.audio) {
    MUSIC.audio.onended = null;
    if (crossfade === true && !MUSIC.audio.paused) MUSIC.fading.push(MUSIC.audio);
    else MUSIC.audio.pause();
  }
  MUSIC.current = track;
  const audio = new Audio(track.url);
  audio.volume = crossfade === true ? 0 : MUSIC.volume;
  audio.fadeIn = crossfade === true;
  audio.onended = () => {
    if (MUSIC.state === "playing") musicStartTrack();
  };
  audio.onerror = () => {
    if (MUSIC.state === "playing") setTimeout(musicStartTrack, 500);
  };
  MUSIC.audio = audio;
  MUSIC.state = "playing";
  musicRefreshUi();
  const attempt = audio.play();
  if (attempt && attempt.catch) {
    attempt.catch(() => {
      if (MUSIC.audio === audio && MUSIC.state === "playing") MUSIC.state = "blocked";
      musicRefreshUi();
    });
  }
}

function musicFrame() {
  const now = performance.now();
  const dt = Math.min(500, MUSIC.lastFrame ? now - MUSIC.lastFrame : 16);
  MUSIC.lastFrame = now;
  if (MUSIC.tracks.length === 0) return;
  const period = musicCurrentPeriod();
  if (MUSIC.period !== null && period !== MUSIC.period) {
    MUSIC.period = period;
    MUSIC.queue = [];
    if (MUSIC.state === "playing") musicStartTrack(true);
    else if (MUSIC.state === "blocked") musicStartTrack(false);
  }
  const step = dt / MUSIC_FADE_MS * MUSIC.volume;
  for (let i = MUSIC.fading.length - 1; i >= 0; i--) {
    const old = MUSIC.fading[i];
    old.volume = Math.max(0, old.volume - step);
    if (old.volume <= 0.001) {
      old.pause();
      MUSIC.fading.splice(i, 1);
    }
  }
  if (MUSIC.audio && MUSIC.audio.fadeIn) {
    MUSIC.audio.volume = Math.min(MUSIC.volume, MUSIC.audio.volume + step);
    if (MUSIC.audio.volume >= MUSIC.volume) MUSIC.audio.fadeIn = false;
  }
}

function musicPlayPause() {
  if (MUSIC.state === "playing") {
    MUSIC.audio.pause();
    MUSIC.state = "paused";
  } else if (MUSIC.state === "paused" && MUSIC.audio) {
    MUSIC.state = "playing";
    const attempt = MUSIC.audio.play();
    if (attempt && attempt.catch) attempt.catch(() => {});
  } else {
    musicStartTrack();
    return;
  }
  musicRefreshUi();
}

function musicStop() {
  if (MUSIC.audio) {
    MUSIC.audio.onended = null;
    MUSIC.audio.pause();
    MUSIC.audio = null;
  }
  MUSIC.state = "stopped";
  musicRefreshUi();
}

function musicBuildUi() {
  const style = document.createElement("style");
  style.textContent = "#worldMusic{position:fixed;left:50%;bottom:6px;transform:translateX(-50%);z-index:40;display:flex;align-items:center;gap:6px;background:rgba(20,20,36,0.88);border:1px solid #4a4a70;border-radius:16px;padding:4px 10px;color:#dde;font-size:12px;font-family:sans-serif}"
    + "#worldMusic button{background:#2d2d44;color:#fff;border:1px solid #55557a;border-radius:10px;padding:2px 9px;cursor:pointer;font-size:12px}"
    + "#worldMusic button:hover{background:#4a6cff}"
    + "#worldMusic .mLabel{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
    + "#worldMusic input[type=range]{width:70px}";
  document.head.appendChild(style);
  const el = document.createElement("div");
  el.id = "worldMusic";
  const label = document.createElement("span");
  label.className = "mLabel";
  const playBtn = document.createElement("button");
  const nextBtn = document.createElement("button");
  nextBtn.textContent = "Next";
  const stopBtn = document.createElement("button");
  stopBtn.textContent = "Stop";
  const vol = document.createElement("input");
  vol.type = "range";
  vol.min = "0";
  vol.max = "100";
  vol.value = String(Math.round(MUSIC.volume * 100));
  playBtn.addEventListener("click", musicPlayPause);
  nextBtn.addEventListener("click", () => {
    if (MUSIC.tracks.length === 0) return;
    musicStartTrack();
  });
  stopBtn.addEventListener("click", musicStop);
  vol.addEventListener("input", () => {
    MUSIC.volume = Number(vol.value) / 100;
    if (MUSIC.audio && !MUSIC.audio.fadeIn) MUSIC.audio.volume = MUSIC.volume;
    try { localStorage.setItem("pmdMusicVolume", String(MUSIC.volume)); } catch (e) {}
  });
  for (const node of [label, playBtn, nextBtn, stopBtn, vol]) el.appendChild(node);
  for (const evName of ["keydown", "keyup"]) vol.addEventListener(evName, (ev) => ev.stopPropagation());
  document.body.appendChild(el);
  MUSIC.el = el;
  MUSIC.label = label;
  MUSIC.playBtn = playBtn;
}

function musicInit() {
  if (MUSIC.el) return;
  try {
    const saved = parseFloat(localStorage.getItem("pmdMusicVolume"));
    if (!isNaN(saved) && saved >= 0 && saved <= 1) MUSIC.volume = saved;
  } catch (e) {}
  musicBuildUi();
  musicRefreshUi();
  fetch("/api/world/music").then((r) => r.json()).then((data) => {
    MUSIC.tracks = Array.isArray(data.tracks) ? data.tracks : [];
    musicRefreshUi();
    if (MUSIC.tracks.length > 0) musicStartTrack();
  }).catch(() => {});
  const unlock = (ev) => {
    if (ev && ev.target && ev.target.closest && ev.target.closest("#worldMusic")) return;
    document.removeEventListener("pointerdown", unlock);
    document.removeEventListener("keydown", unlock);
    if (MUSIC.state === "blocked" && MUSIC.audio) {
      MUSIC.state = "playing";
      const attempt = MUSIC.audio.play();
      if (attempt && attempt.catch) attempt.catch(() => {});
      musicRefreshUi();
    }
  };
  document.addEventListener("pointerdown", unlock);
  document.addEventListener("keydown", unlock);
}

function enterPlayerWorld(scene) {
  worldPlayerMode = true;
  if (typeof chatLogShow === "function") chatLogShow();
  musicInit();
  if (mapGraphics) mapGraphics.clear();
  scene.cameras.main.removeBounds();
  const exitBtn = document.getElementById("exitWorld");
  exitBtn.classList.remove("hidden");
  exitBtn.addEventListener("click", () => {
    if (!window.confirm("Exit the world? Your character will be saved and logged out.")) return;
    gmSend({ type: "exit" });
  });
  if (!worldViewGfx) {
    worldViewGfx = scene.add.graphics();
    worldViewGfx.setDepth(0);
  }
  scene.input.on("pointerdown", (pointer) => atkPointer(scene, pointer));
  scene.input.on("pointerdown", (pointer) => visLookDown(pointer));
  if (!VIS.lookBound) {
    VIS.lookBound = true;
    scene.game.canvas.addEventListener("contextmenu", (ev) => {
      if (worldPlayerMode) ev.preventDefault();
    });
  }
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && atkTarget) atkClose();
  });
}

function drawPlayerView(scene, data) {
  if (!worldViewGfx) {
    worldViewGfx = scene.add.graphics();
    worldViewGfx.setDepth(0);
  }
  if (!worldViewOverGfx) {
    worldViewOverGfx = scene.add.graphics();
    worldViewOverGfx.setDepth(2);
  }
  worldLastView = data;
  VIS.layerMode = data.lm || "outdoor";
  VIS.nv = !!data.nv;
  VIS.selfR = data.sl || 0;
  VIS.selfC = data.slc || "#ffb347";
  VIS.block = {};
  worldViewGfx.clear();
  worldViewOverGfx.clear();
  const wantedArt = {};
  const wantedObjs = {};
  for (let r = 0; r < data.rows.length; r++) {
    const line = data.rows[r];
    const artLine = data.art && data.art[r] ? data.art[r] : "";
    for (let c = 0; c < line.length; c++) {
      const col = data.c0 + c;
      const row = data.r0 + r;
      if (line[c] === "#") VIS.block[col + "," + row] = true;
      worldDrawBase(worldViewGfx, col, row, line[c]);
      worldDrawOverlay(worldViewOverGfx, col, row, line[c], true);
      const artChar = artLine[c];
      if (artChar && artChar !== " " && line[c] !== " " && line[c] !== "#" && data.palette && data.palette[artChar]) {
        wantedArt[col + "," + row] = { name: data.palette[artChar], c: col, r: row };
      }
    }
  }
  for (const o of data.objects || []) {
    if (o.b) VIS.block[o.col + "," + o.row] = true;
    wantedObjs[o.col + "," + o.row] = { name: o.name, c: o.col, r: o.row, rot: o.rot || 0, flip: !!o.flip, walk: !!o.w };
  }
  worldSyncPool(scene, worldArtPool, wantedArt, "tile");
  worldSyncPool(scene, worldObjectPool, wantedObjs, "object");
  worldSyncItems(scene, data.items);
}

function gmRedrawChunk(scene, cx, cy) {
  const key = cx + "," + cy;
  let g = WG.chunks[key];
  let over = WG.overlays[key];
  if (!g) {
    const dr = WG.drawRange;
    if (dr && (cx < dr.cx0 || cx > dr.cx1 || cy < dr.cy0 || cy > dr.cy1)) return;
    let hasContent = false;
    const rLimit = Math.min(WORLD_ROWS, (cy + 1) * CHUNK);
    for (let rr = cy * CHUNK; rr < rLimit && !hasContent; rr++) {
      const lineCheck = WG.rows[rr];
      for (let cc = cx * CHUNK; cc < Math.min(WORLD_COLS, (cx + 1) * CHUNK); cc++) {
        if (lineCheck[cc] !== " ") {
          hasContent = true;
          break;
        }
      }
    }
    if (!hasContent) return;
    g = scene.add.graphics();
    g.setDepth(0);
    WG.chunks[key] = g;
    over = scene.add.graphics();
    over.setDepth(2);
    WG.overlays[key] = over;
  }
  g.clear();
  over.clear();
  const rMax = Math.min(WORLD_ROWS, (cy + 1) * CHUNK);
  const cMax = Math.min(WORLD_COLS, (cx + 1) * CHUNK);
  for (let r = cy * CHUNK; r < rMax; r++) {
    const line = WG.rows[r];
    for (let c = cx * CHUNK; c < cMax; c++) {
      worldDrawBase(g, c, r, line[c]);
      worldDrawOverlay(over, c, r, line[c], false);
    }
  }
}

function gmChunkRange(scene, extra) {
  const wv = scene.cameras.main.worldView;
  const span = CHUNK * TILE;
  return {
    cx0: Math.max(0, Math.floor(wv.x / span) - extra),
    cx1: Math.min(WORLD_COLS / CHUNK - 1, Math.floor((wv.x + wv.width) / span) + extra),
    cy0: Math.max(0, Math.floor(wv.y / span) - extra),
    cy1: Math.min(WORLD_ROWS / CHUNK - 1, Math.floor((wv.y + wv.height) / span) + extra)
  };
}

function gmCullChunks(scene) {
  const keep = gmChunkRange(scene, 2);
  for (const key in WG.chunks) {
    const parts = key.split(",");
    const cx = parseInt(parts[0], 10);
    const cy = parseInt(parts[1], 10);
    if (cx < keep.cx0 || cx > keep.cx1 || cy < keep.cy0 || cy > keep.cy1) {
      WG.chunks[key].destroy();
      delete WG.chunks[key];
      if (WG.overlays[key]) {
        WG.overlays[key].destroy();
        delete WG.overlays[key];
      }
    }
  }
}

function gmRedrawAll(scene) {
  for (const key in WG.chunks) {
    WG.chunks[key].destroy();
    delete WG.chunks[key];
  }
  for (const key in WG.overlays) {
    WG.overlays[key].destroy();
    delete WG.overlays[key];
  }
  const draw = gmChunkRange(scene, 1);
  WG.drawRange = draw;
  for (let cy = draw.cy0; cy <= draw.cy1; cy++) {
    for (let cx = draw.cx0; cx <= draw.cx1; cx++) {
      gmRedrawChunk(scene, cx, cy);
    }
  }
}

function gmSyncArt(scene) {
  const cam = scene.cameras.main;
  const wv = cam.worldView;
  const c0 = Math.max(0, Math.floor(wv.x / TILE) - 1);
  const c1 = Math.min(WORLD_COLS - 1, Math.floor((wv.x + wv.width) / TILE) + 1);
  const r0 = Math.max(0, Math.floor(wv.y / TILE) - 1);
  const r1 = Math.min(WORLD_ROWS - 1, Math.floor((wv.y + wv.height) / TILE) + 1);
  const key = c0 + "," + c1 + "," + r0 + "," + r1;
  if (key === WG.viewKey && !WG.artDirty && !worldAssetsDirty) return;
  WG.viewKey = key;
  WG.artDirty = false;
  worldAssetsDirty = false;
  const drawRange = gmChunkRange(scene, 1);
  WG.drawRange = drawRange;
  gmCullChunks(scene);
  for (let cy = drawRange.cy0; cy <= drawRange.cy1; cy++) {
    for (let cx = drawRange.cx0; cx <= drawRange.cx1; cx++) {
      if (!WG.chunks[cx + "," + cy]) gmRedrawChunk(scene, cx, cy);
    }
  }
  const wantedArt = {};
  const wantedObjs = {};
  for (let r = r0; r <= r1; r++) {
    const artLine = WG.art[r];
    const logicLine = WG.rows[r];
    for (let c = c0; c <= c1; c++) {
      const ch = artLine[c];
      if (ch !== " " && logicLine[c] !== " " && logicLine[c] !== "#" && WG.palette[ch]) {
        wantedArt[c + "," + r] = { name: WG.palette[ch], c: c, r: r };
      }
      const obj = WG.objects[c + "," + r];
      if (obj) wantedObjs[c + "," + r] = { name: obj.name, c: c, r: r, rot: obj.rot || 0, flip: !!obj.flip, alpha: obj.solid && !WG.passable[c + "," + r] ? 1 : 0.7 };
    }
  }
  worldSyncPool(scene, worldArtPool, wantedArt, "tile");
  worldSyncPool(scene, worldObjectPool, wantedObjs, "object");
}

function gmUpdateHoverTile(scene) {
  const show = WG.tool === "tile" && !!WG.tileName && !WG.pan && gmInBounds(WG.hoverCol, WG.hoverRow);
  if (!show) {
    if (WG.hoverSprite) WG.hoverSprite.setVisible(false);
    return;
  }
  const tex = worldEnsureAsset(scene, "tile", WG.tileName);
  if (!tex) {
    if (WG.hoverSprite) WG.hoverSprite.setVisible(false);
    return;
  }
  if (!WG.hoverSprite) {
    WG.hoverSprite = scene.add.image(0, 0, tex);
    WG.hoverSprite.setOrigin(0.5, 0.5);
    WG.hoverSprite.setDepth(57);
  }
  const sp = WG.hoverSprite;
  if (sp.texture.key !== tex) sp.setTexture(tex);
  sp.setDisplaySize(TILE, TILE);
  sp.setAlpha(0.5);
  sp.setFlipX(WG.tileFlip);
  sp.setAngle(WG.tileRot);
  sp.setPosition(WG.hoverCol * TILE + TILE / 2, WG.hoverRow * TILE + TILE / 2);
  sp.setVisible(true);
}

function gmUpdateHoverObject(scene) {
  const show = WG.tool === "object" && !!WG.objName && !WG.pan && gmInBounds(WG.hoverCol, WG.hoverRow);
  if (!show) {
    if (WG.hoverObjSprite) WG.hoverObjSprite.setVisible(false);
    return;
  }
  const tex = worldEnsureAsset(scene, "object", WG.objName);
  if (!tex) {
    if (WG.hoverObjSprite) WG.hoverObjSprite.setVisible(false);
    return;
  }
  if (!WG.hoverObjSprite) {
    WG.hoverObjSprite = scene.add.image(0, 0, tex);
    WG.hoverObjSprite.setOrigin(0.5, 0.5);
    WG.hoverObjSprite.setDepth(58);
  }
  const sp = WG.hoverObjSprite;
  if (sp.texture.key !== tex) sp.setTexture(tex);
  sp.setScale((TILE - 2) / Math.max(sp.width, sp.height));
  sp.setAlpha(0.5);
  sp.setFlipX(WG.objFlip);
  sp.setRotation(WG.objRot ? WG.objRot * Math.PI / 180 : (typeof viewRot === "number" ? -viewRot : 0));
  sp.setPosition(WG.hoverCol * TILE + TILE / 2 - 1, WG.hoverRow * TILE + TILE / 2 - 1);
  sp.setVisible(true);
}

function gmFlipTile() {
  WG.tileFlip = !WG.tileFlip;
  gmUpdateHoverStatus();
}

function gmRotateTile() {
  WG.tileRot = (WG.tileRot + 90) % 360;
  gmUpdateHoverStatus();
}

document.addEventListener("keydown", (ev) => {
  if (ev.repeat || !worldGmMode || chatActive) return;
  const isRotate = ev.key === "r" || ev.key === "R";
  const isFlip = ev.key === "f" || ev.key === "F";
  if (!isRotate && !isFlip) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (WG.tool === "tile") {
    if (isRotate) gmRotateTile();
    else gmFlipTile();
  } else if (WG.tool === "object") {
    if (isRotate) WG.objRot = (WG.objRot + 90) % 360;
    else WG.objFlip = !WG.objFlip;
    gmUpdateHoverStatus();
  }
});

let worldFrameErrors = 0;

function worldGuard(fn, scene) {
  try {
    fn(scene);
  } catch (e) {
    worldFrameErrors++;
    if (worldFrameErrors <= 5) console.error("world frame error", e);
  }
}

function worldFrame(scene) {
  worldGuard(musicFrame, scene);
  worldGuard(entityLabelsFrame, scene);
  worldGuard(visFrame, scene);
  if (worldGmMode) {
    gmSyncArt(scene);
    gmUpdateHoverTile(scene);
    gmUpdateHoverObject(scene);
    return;
  }
  if (worldPlayerMode && worldAssetsDirty && worldLastView) {
    worldAssetsDirty = false;
    drawPlayerView(scene, worldLastView);
  }
}

function gmDrawGrid(scene) {
  if (WG.gridGfx) return;
  const g = scene.add.graphics();
  g.setDepth(-1);
  g.lineStyle(1, 0xffffff, 0.06);
  for (let c = 0; c <= WORLD_COLS; c++) {
    g.lineBetween(c * TILE, 0, c * TILE, WORLD_ROWS * TILE);
  }
  for (let r = 0; r <= WORLD_ROWS; r++) {
    g.lineBetween(0, r * TILE, WORLD_COLS * TILE, r * TILE);
  }
  g.lineStyle(3, 0x6666aa, 0.8);
  g.strokeRect(0, 0, WORLD_COLS * TILE, WORLD_ROWS * TILE);
  WG.gridGfx = g;
}

function gmDrawMarkers() {
  if (!WG.markerGfx) return;
  const g = WG.markerGfx;
  g.clear();
  const liveLabels = {};
  for (const sp of WG.spawns) {
    if (sp.layer !== WG.layer) continue;
    const moving = WG.spawnMoveId === sp.id;
    g.lineStyle(4, moving ? 0xffd23f : 0x3ec13e, 1);
    g.strokeCircle(sp.col * TILE + TILE / 2 - 1, sp.row * TILE + TILE / 2 - 1, 19);
    let label = WG.spawnLabels[sp.id];
    if (!label) {
      label = WG.markerGfx.scene.add.text(0, 0, "", { fontFamily: "sans-serif", fontSize: "12px", color: "#9fe89f", stroke: "#000000", strokeThickness: 3 });
      label.setOrigin(0.5, 1);
      label.setDepth(56);
      WG.spawnLabels[sp.id] = label;
    }
    if (label) {
      label.setText(sp.name);
      label.setPosition(sp.col * TILE + TILE / 2, sp.row * TILE - 2);
      liveLabels[sp.id] = true;
    }
  }
  for (const sid in WG.spawnLabels) {
    if (!liveLabels[sid]) {
      WG.spawnLabels[sid].destroy();
      delete WG.spawnLabels[sid];
    }
  }
  g.fillStyle(0x3ec13e, 0.22);
  g.lineStyle(2, 0x3ec13e, 0.9);
  for (const key in WG.passable) {
    const parts = key.split(",");
    const pc = parseInt(parts[0], 10);
    const pr = parseInt(parts[1], 10);
    g.fillRect(pc * TILE + 1, pr * TILE + 1, TILE - 2, TILE - 2);
    g.strokeRect(pc * TILE + 4, pr * TILE + 4, TILE - 8, TILE - 8);
  }
  const picked = WG.selectedEntity ? WG.entities[WG.selectedEntity] : null;
  if (picked) {
    g.lineStyle(3, 0xff9f1c, 1);
    g.strokeCircle(picked.col * TILE + TILE / 2 - 1, picked.row * TILE + TILE / 2 - 1, 22);
  }
  if (WG.portalSource && WG.portalSource.layer === WG.layer) {
    g.lineStyle(4, 0xffd23f, 1);
    g.strokeCircle(WG.portalSource.c * TILE + TILE / 2 - 1, WG.portalSource.r * TILE + TILE / 2 - 1, 21);
  }
}

function gmCellFromPointer(scene, pointer) {
  const wp = scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
  return { c: Math.floor(wp.x / TILE), r: Math.floor(wp.y / TILE) };
}

function gmInBounds(c, r) {
  return c >= 0 && c < WORLD_COLS && r >= 0 && r < WORLD_ROWS;
}

function lineCells(c0, r0, c1, r1) {
  const cells = [];
  let x = c0;
  let y = r0;
  const dx = Math.abs(c1 - c0);
  const dy = Math.abs(r1 - r0);
  const sx = c0 < c1 ? 1 : -1;
  const sy = r0 < r1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    cells.push([x, y]);
    if (x === c1 && y === r1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return cells;
}

function snapLineEnd(sc, sr, ec, er, free) {
  if (free) return { c: ec, r: er };
  const dx = Math.abs(ec - sc);
  const dy = Math.abs(er - sr);
  if (dx >= 2 * dy) return { c: ec, r: sr };
  if (dy >= 2 * dx) return { c: sc, r: er };
  const m = Math.max(dx, dy);
  return { c: sc + (ec >= sc ? 1 : -1) * m, r: sr + (er >= sr ? 1 : -1) * m };
}

function rectCells(c0, r0, c1, r1, outline) {
  const cells = [];
  const cMin = Math.min(c0, c1);
  const cMax = Math.max(c0, c1);
  const rMin = Math.min(r0, r1);
  const rMax = Math.max(r0, r1);
  for (let r = rMin; r <= rMax; r++) {
    for (let c = cMin; c <= cMax; c++) {
      if (outline && c !== cMin && c !== cMax && r !== rMin && r !== rMax) continue;
      cells.push([c, r]);
    }
  }
  return cells;
}

function gmShapeCells(stroke, endC, endR, shiftKey) {
  if (WG.shape === "line") {
    const end = snapLineEnd(stroke.c0, stroke.r0, endC, endR, shiftKey);
    return lineCells(stroke.c0, stroke.r0, end.c, end.r);
  }
  if (WG.shape === "rect") return rectCells(stroke.c0, stroke.r0, endC, endR, false);
  if (WG.shape === "outline") return rectCells(stroke.c0, stroke.r0, endC, endR, true);
  return lineCells(stroke.lastC, stroke.lastR, endC, endR);
}

function gmSend(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
  }
}

function gmSnapshotCell(c, r) {
  const key = c + "," + r;
  if (!WG.strokeUndo || WG.strokeUndo.cells[key]) return;
  const artChar = WG.art[r][c];
  const obj = WG.objects[key];
  WG.strokeUndo.cells[key] = {
    c: c,
    r: r,
    logic: WG.rows[r][c],
    art: artChar === " " ? "" : (WG.palette[artChar] || ""),
    obj: obj ? obj.name : "",
    solid: obj ? obj.solid : true,
    rot: obj ? obj.rot || 0 : 0,
    flip: obj && obj.flip ? 1 : 0,
    pass: WG.passable[key] ? 1 : 0
  };
}

function gmSendEdit(cells) {
  const tool = WG.tool;
  const logicOps = [];
  const artOps = [];
  const objOps = [];
  const passOps = [];
  const solid = document.getElementById("wgSolid").checked ? 1 : 0;
  for (const cell of cells) {
    const c = cell[0];
    const r = cell[1];
    if (!gmInBounds(c, r)) continue;
    gmSnapshotCell(c, r);
    if (TOOL_CHARS[tool] !== undefined) logicOps.push([c, r, TOOL_CHARS[tool]]);
    else if (tool === "tile") artOps.push([c, r, gmTileStoredName()]);
    else if (tool === "tileclear") artOps.push([c, r, ""]);
    else if (tool === "object") objOps.push([c, r, WG.objName, solid, WG.objRot, WG.objFlip ? 1 : 0]);
    else if (tool === "objerase") objOps.push([c, r, "", 0]);
    else if (tool === "passable") passOps.push([c, r, 1]);
    else if (tool === "passableclear") passOps.push([c, r, 0]);
  }
  if (logicOps.length > 0) gmSend({ type: "gm_edit", layer: WG.layer, ops: logicOps });
  if (artOps.length > 0 && (tool !== "tile" || WG.tileName)) gmSend({ type: "gm_art", layer: WG.layer, ops: artOps });
  if (objOps.length > 0 && (tool !== "object" || WG.objName)) gmSend({ type: "gm_obj", layer: WG.layer, ops: objOps });
  if (passOps.length > 0) gmSend({ type: "gm_pass", layer: WG.layer, ops: passOps });
}

function gmApplyTiles(scene, cells) {
  const touched = {};
  for (const cell of cells) {
    const c = cell[0];
    const r = cell[1];
    if (!gmInBounds(c, r)) continue;
    WG.rows[r] = WG.rows[r].substring(0, c) + cell[2] + WG.rows[r].substring(c + 1);
    touched[Math.floor(c / CHUNK) + "," + Math.floor(r / CHUNK)] = [Math.floor(c / CHUNK), Math.floor(r / CHUNK)];
  }
  for (const key in touched) gmRedrawChunk(scene, touched[key][0], touched[key][1]);
}

const GM_PALETTE_CHARS = (() => {
  let chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let code = 0x00c0; code <= 0x024f; code++) {
    if (code === 0x00d7 || code === 0x00f7) continue;
    chars += String.fromCharCode(code);
  }
  return chars;
})();

function gmApplyArt(scene, cells, palette) {
  if (palette && typeof palette === "object") WG.palette = palette;
  for (const cell of cells) {
    const c = cell[0];
    const r = cell[1];
    if (!gmInBounds(c, r)) continue;
    let ch = " ";
    if (cell[2]) {
      for (const k in WG.palette) {
        if (WG.palette[k] === cell[2]) { ch = k; break; }
      }
      if (ch === " ") {
        for (let i = 0; i < GM_PALETTE_CHARS.length; i++) {
          const cand = GM_PALETTE_CHARS[i];
          if (!WG.palette[cand]) { WG.palette[cand] = cell[2]; ch = cand; break; }
        }
      }
    }
    WG.art[r] = WG.art[r].substring(0, c) + ch + WG.art[r].substring(c + 1);
  }
  WG.artDirty = true;
}

function gmApplyObjs(scene, cells) {
  for (const cell of cells) {
    const key = cell[0] + "," + cell[1];
    if (cell[2]) WG.objects[key] = { name: cell[2], solid: cell[3] !== 0, rot: cell[4] || 0, flip: cell[5] === 1 };
    else delete WG.objects[key];
  }
  WG.artDirty = true;
}

function gmDrawPreview(scene, cells, color) {
  if (!WG.previewGfx) return;
  const g = WG.previewGfx;
  g.clear();
  if (cells) {
    g.fillStyle(color, 0.55);
    for (const cell of cells) {
      g.fillRect(cell[0] * TILE, cell[1] * TILE, TILE - 2, TILE - 2);
    }
  }
  g.lineStyle(2, 0xffffff, 0.9);
  g.strokeRect(WG.hoverCol * TILE, WG.hoverRow * TILE, TILE - 2, TILE - 2);
}

function gmStatus(text) {
  const el = document.getElementById("wgStatus");
  if (el) el.textContent = text;
}

function gmPlaceCoords() {
  const coords = document.getElementById("wgCoords");
  const box = document.getElementById("wgCreative");
  if (!coords) return;
  if (!box || box.style.display === "none") {
    coords.style.left = "8px";
    coords.style.top = "";
    coords.style.bottom = "8px";
    return;
  }
  const rect = box.getBoundingClientRect();
  coords.style.bottom = "";
  coords.style.left = rect.left + "px";
  coords.style.top = Math.max(0, rect.top - 34) + "px";
}

function gmClampWindow(el) {
  const rect = el.getBoundingClientRect();
  let left = rect.left;
  let top = rect.top;
  const maxLeft = Math.max(0, window.innerWidth - rect.width);
  const maxTop = Math.max(0, window.innerHeight - rect.height);
  if (left > maxLeft) left = maxLeft;
  if (top > maxTop) top = maxTop;
  if (left < 0) left = 0;
  if (top < 0) top = 0;
  el.style.left = left + "px";
  el.style.top = top + "px";
  el.style.bottom = "auto";
}

function gmMakeDraggable(el, handle, storeKey, onMove, filter) {
  if (!filter) handle.style.cursor = "move";
  handle.style.touchAction = "none";
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey) || "null");
    if (saved && typeof saved.left === "number" && typeof saved.top === "number") {
      el.style.left = saved.left + "px";
      el.style.top = saved.top + "px";
      el.style.bottom = "auto";
      gmClampWindow(el);
    }
  } catch (e) {}
  let drag = null;
  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    if (filter && !filter(ev.target)) return;
    if (ev.target && ev.target.closest && ev.target.closest("button,input,select,textarea,a")) return;
    const rect = el.getBoundingClientRect();
    drag = { id: ev.pointerId, dx: ev.clientX - rect.left, dy: ev.clientY - rect.top };
    try { handle.setPointerCapture(ev.pointerId); } catch (e) {}
    ev.preventDefault();
  });
  handle.addEventListener("pointermove", (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    el.style.left = (ev.clientX - drag.dx) + "px";
    el.style.top = (ev.clientY - drag.dy) + "px";
    el.style.bottom = "auto";
    gmClampWindow(el);
    if (onMove) onMove();
  });
  const finish = (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    drag = null;
    const rect = el.getBoundingClientRect();
    try { localStorage.setItem(storeKey, JSON.stringify({ left: rect.left, top: rect.top })); } catch (e) {}
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  window.addEventListener("resize", () => {
    if (el.style.top && el.style.top !== "auto") {
      gmClampWindow(el);
      if (onMove) onMove();
    }
  });
}

function gmNotice(text) {
  WG.notice = text;
  WG.noticeUntil = Date.now() + 4000;
  gmUpdateHoverStatus();
}

function gmUpdateCoords(c, r) {
  const el = document.getElementById("wgCoords");
  if (!el) return;
  el.textContent = gmInBounds(c, r) ? "X: " + c + "   Y: " + r : "X: -   Y: -";
}

function gmCellFromClient(scene, ev) {
  const canvas = scene.game.canvas;
  const rect = canvas.getBoundingClientRect();
  const gx = (ev.clientX - rect.left) * scene.scale.width / rect.width;
  const gy = (ev.clientY - rect.top) * scene.scale.height / rect.height;
  const wp = scene.cameras.main.getWorldPoint(gx, gy);
  return { c: Math.floor(wp.x / TILE), r: Math.floor(wp.y / TILE) };
}

function gmPlayerDragCancel() {
  if (!WG.playerDrag) return;
  if (WG.playerDrag.ghost) WG.playerDrag.ghost.remove();
  window.removeEventListener("mousemove", gmPlayerDragMove);
  window.removeEventListener("mouseup", gmPlayerDragEnd);
  WG.playerDrag = null;
}

function gmPlayerDragMove(ev) {
  if (!WG.playerDrag) return;
  WG.playerDrag.ghost.style.left = (ev.clientX - 20) + "px";
  WG.playerDrag.ghost.style.top = (ev.clientY - 20) + "px";
  const cell = gmCellFromClient(sceneRef, ev);
  gmUpdateCoords(cell.c, cell.r);
}

function gmPlayerDragEnd(ev) {
  const drag = WG.playerDrag;
  if (!drag) return;
  gmPlayerDragCancel();
  const over = document.elementFromPoint(ev.clientX, ev.clientY);
  if (!over || over !== sceneRef.game.canvas) return;
  const cell = gmCellFromClient(sceneRef, ev);
  if (!gmInBounds(cell.c, cell.r)) return;
  if (cell.c === drag.col && cell.r === drag.row) {
    gmHandleClickTool(sceneRef, cell.c, cell.r);
    return;
  }
  gmSend({ type: "gm_tp", playerId: drag.id, layer: WG.layer, col: cell.c, row: cell.r });
}

function gmTryPlayerDrag(pointer, cell) {
  if (WG.tool !== "select" && WG.tool !== "item" && WG.tool !== "targettile") return false;
  const id = WG.selPlayer;
  const p = id ? WG.players[id] : null;
  if (!p || p.layer !== WG.layer || p.col !== cell.c || p.row !== cell.r) return false;
  const ghost = document.createElement("div");
  ghost.style.cssText = "position:fixed;z-index:90;pointer-events:none;background:rgba(74,108,255,0.85);color:#fff;border:2px solid #fff;border-radius:8px;padding:4px 8px;font-size:12px;font-family:sans-serif";
  ghost.textContent = p.name;
  document.body.appendChild(ghost);
  WG.playerDrag = { id: id, col: p.col, row: p.row, ghost: ghost };
  ghost.style.left = (pointer.event.clientX - 20) + "px";
  ghost.style.top = (pointer.event.clientY - 20) + "px";
  window.addEventListener("mousemove", gmPlayerDragMove);
  window.addEventListener("mouseup", gmPlayerDragEnd);
  return true;
}

function gmUpdateHoverStatus() {
  if (!gmInBounds(WG.hoverCol, WG.hoverRow)) {
    gmStatus("Layer " + WG.layer + " | outside the editable area");
    return;
  }
  const ch = WG.rows[WG.hoverRow][WG.hoverCol];
  const names = { " ": "empty", ".": "floor", "#": "wall", "x": "barrier", "P": "portal" };
  let text = "Layer " + WG.layer + " | " + WG.hoverCol + ", " + WG.hoverRow + " | " + names[ch];
  for (const eid in WG.entities) {
    const he = WG.entities[eid];
    if (he.col === WG.hoverCol && he.row === WG.hoverRow) text += " | " + he.kind + " " + he.name + " lv" + he.level;
  }
  const hoverArt = WG.art[WG.hoverRow][WG.hoverCol];
  if (hoverArt !== " " && WG.palette[hoverArt]) text += " | tile " + WG.palette[hoverArt];
  const hoverObj = WG.objects[WG.hoverCol + "," + WG.hoverRow];
  if (hoverObj) text += " | " + hoverObj.name + (hoverObj.solid ? " (solid)" : " (walk-through)");
  const portal = WG.portals[WG.hoverCol + "," + WG.hoverRow];
  if (portal) text += " to layer " + portal.layer + " (" + portal.col + ", " + portal.row + ")";
  if (WG.portalSource) text += "\nPortal start set on layer " + WG.portalSource.layer + ". Pick the destination.";
  if (WG.tool === "targettile") text += WG.selPlayer && WG.players[WG.selPlayer] ? "\nTarget tile: click to teleport " + WG.players[WG.selPlayer].name + " here." : "\nTarget tile: select a player first.";
  if (WG.selPlayer && WG.players[WG.selPlayer]) text += "\nSelected player: " + WG.players[WG.selPlayer].name + " (drag them to a tile to move them)";
  if (WG.tool === "object" && WG.objName) text += "\nObject " + WG.objName + " | rotated " + WG.objRot + " degrees" + (WG.objFlip ? " | flipped" : "") + ". R rotates, F flips.";
  if (WG.tool === "tile" && WG.tileName) text += "\nTile " + WG.tileName + " | rotated " + WG.tileRot + " degrees" + (WG.tileFlip ? " | flipped" : "") + ". R rotates, F flips.";
  if (WG.notice && Date.now() < WG.noticeUntil) text = WG.notice + "\n" + text;
  gmStatus(text);
}

function gmHandleClickTool(scene, c, r) {
  if (!gmInBounds(c, r)) return;
  if (WG.tool === "portal") {
    if (!WG.portalSource) {
      WG.portalSource = { layer: WG.layer, c: c, r: r };
      gmDrawMarkers();
      gmUpdateHoverStatus();
      return;
    }
    const twoWay = document.getElementById("wgTwoWay").checked;
    gmSend({ type: "gm_portal", layer: WG.portalSource.layer, col: WG.portalSource.c, row: WG.portalSource.r, toLayer: WG.layer, toCol: c, toRow: r, twoWay: twoWay });
    WG.portalSource = null;
    gmDrawMarkers();
    return;
  }
  if (WG.tool === "spawn") {
    if (WG.spawnMoveId) {
      gmSend({ type: "gm_spawn_edit", id: WG.spawnMoveId, layer: WG.layer, col: c, row: r });
      WG.spawnMoveId = null;
      gmRenderSpawns();
      gmDrawMarkers();
      return;
    }
    const nameInput = document.getElementById("wgSpawnName");
    gmSend({ type: "gm_spawn_add", name: nameInput ? nameInput.value : "", layer: WG.layer, col: c, row: r });
    if (nameInput) nameInput.value = "";
    return;
  }
  if (WG.tool === "item") return;
  if (WG.tool === "creature") {
    gmSend({ type: "gm_entity_set", entity: gmReadCreatureForm(null, c, r) });
    return;
  }
  if (WG.tool === "select") {
    let found = null;
    for (const eid in WG.entities) {
      const he = WG.entities[eid];
      if (he.col === c && he.row === r) found = he;
    }
    WG.selectedEntity = found ? found.id : null;
    gmShowSelection();
    gmDrawMarkers();
    if (found) {
      if (found.kind === "npc" || found.kind === "enemy") gmInspect({ type: "entity", id: found.id });
      else gmInspectClose();
      return;
    }
    let foundPlayer = null;
    for (const pid in WG.players) {
      const hp = WG.players[pid];
      if (hp.layer === WG.layer && hp.col === c && hp.row === r) foundPlayer = hp;
    }
    if (foundPlayer) {
      WG.selPlayer = foundPlayer.id;
      gmRenderPlayers();
      gmInspect({ type: "player", id: foundPlayer.id });
    } else {
      gmInspectClose();
    }
    return;
  }
  if (WG.tool === "movecreature") {
    const picked = WG.selectedEntity ? WG.entities[WG.selectedEntity] : null;
    if (picked) gmSend({ type: "gm_entity_set", entity: gmReadCreatureForm(picked, c, r) });
    return;
  }
  if (WG.tool === "targettile") {
    if (WG.selPlayer && WG.players[WG.selPlayer]) {
      gmSend({ type: "gm_tp", playerId: WG.selPlayer, layer: WG.layer, col: c, row: r });
    } else {
      gmNotice("Select a player first (Select tool or the Players list), then click a tile.");
    }
  }
}

function gmPointerDown(scene, pointer) {
  const cell = gmCellFromPointer(scene, pointer);
  WG.hoverCol = cell.c;
  WG.hoverRow = cell.r;
  if (pointer.rightButtonDown() || pointer.middleButtonDown() || WG.tool === "pan" || gmSpaceDown) {
    const cam = scene.cameras.main;
    WG.pan = { x: pointer.x, y: pointer.y, sx: cam.scrollX, sy: cam.scrollY };
    return;
  }
  if (!pointer.leftButtonDown()) return;
  if (gmTryPlayerDrag(pointer, cell)) return;
  if (gmTryFloorDrag(pointer, cell)) return;
  const paintTool = TOOL_PREVIEW[WG.tool] !== undefined;
  if (!paintTool) {
    gmHandleClickTool(scene, cell.c, cell.r);
    return;
  }
  WG.strokeUndo = { layer: WG.layer, cells: {} };
  WG.stroke = { c0: cell.c, r0: cell.r, lastC: cell.c, lastR: cell.r };
  if (WG.shape === "pencil") {
    gmSendEdit([[cell.c, cell.r]]);
  } else {
    gmDrawPreview(scene, gmShapeCells(WG.stroke, cell.c, cell.r, pointer.event.shiftKey), TOOL_PREVIEW[WG.tool]);
  }
}

function gmPointerMove(scene, pointer) {
  const cell = gmCellFromPointer(scene, pointer);
  WG.hoverCol = cell.c;
  WG.hoverRow = cell.r;
  gmUpdateCoords(cell.c, cell.r);
  if (WG.pan) {
    const cam = scene.cameras.main;
    cam.scrollX = WG.pan.sx - (pointer.x - WG.pan.x) / cam.zoom;
    cam.scrollY = WG.pan.sy - (pointer.y - WG.pan.y) / cam.zoom;
    return;
  }
  if (WG.stroke && pointer.leftButtonDown()) {
    if (WG.shape === "pencil") {
      if (cell.c !== WG.stroke.lastC || cell.r !== WG.stroke.lastR) {
        gmSendEdit(lineCells(WG.stroke.lastC, WG.stroke.lastR, cell.c, cell.r));
        WG.stroke.lastC = cell.c;
        WG.stroke.lastR = cell.r;
      }
      gmDrawPreview(scene, null, 0);
    } else {
      gmDrawPreview(scene, gmShapeCells(WG.stroke, cell.c, cell.r, pointer.event.shiftKey), TOOL_PREVIEW[WG.tool]);
    }
  } else {
    gmDrawPreview(scene, null, 0);
  }
  gmUpdateHoverStatus();
}

function gmPointerUp(scene, pointer) {
  if (WG.pan) {
    WG.pan = null;
    return;
  }
  if (!WG.stroke) return;
  const cell = gmCellFromPointer(scene, pointer);
  if (WG.shape !== "pencil") {
    gmSendEdit(gmShapeCells(WG.stroke, cell.c, cell.r, pointer.event.shiftKey));
  }
  if (WG.strokeUndo && Object.keys(WG.strokeUndo.cells).length > 0) {
    WG.undo.push(WG.strokeUndo);
    if (WG.undo.length > 60) WG.undo.shift();
  }
  WG.strokeUndo = null;
  WG.stroke = null;
  gmDrawPreview(scene, null, 0);
}

function gmUndo() {
  const entry = WG.undo.pop();
  if (!entry) return;
  const logicOps = [];
  const artOps = [];
  const objOps = [];
  const passOps = [];
  for (const key in entry.cells) {
    const cell = entry.cells[key];
    passOps.push([cell.c, cell.r, cell.pass ? 1 : 0]);
    logicOps.push([cell.c, cell.r, cell.logic]);
    artOps.push([cell.c, cell.r, cell.art]);
    objOps.push([cell.c, cell.r, cell.obj, cell.solid ? 1 : 0, cell.rot || 0, cell.flip ? 1 : 0]);
  }
  gmSend({ type: "gm_edit", layer: entry.layer, ops: logicOps });
  gmSend({ type: "gm_art", layer: entry.layer, ops: artOps });
  gmSend({ type: "gm_obj", layer: entry.layer, ops: objOps });
  gmSend({ type: "gm_pass", layer: entry.layer, ops: passOps });
}

function gmGoLayer(n) {
  const layer = parseInt(n, 10);
  if (isNaN(layer) || layer < -999 || layer > 999) {
    gmStatus("Layers go from -999 to 999.");
    return;
  }
  gmSend({ type: "gm_layer", layer: layer });
}

function gmRenderLayers() {
  const box = document.getElementById("wgLayerList");
  if (!box) return;
  box.innerHTML = "";
  for (const entry of WG.layers) {
    const btn = document.createElement("button");
    btn.className = "wgBtn" + (entry.layer === WG.layer ? " on" : "");
    btn.textContent = "L" + entry.layer + (entry.name ? " " + entry.name : "") + (entry.players ? " (" + entry.players + ")" : "");
    btn.addEventListener("click", () => gmGoLayer(entry.layer));
    box.appendChild(btn);
  }
}

function gmRenderSpawns() {
  const box = document.getElementById("wgSpawnList");
  if (!box) return;
  box.innerHTML = "";
  if (WG.spawns.length === 0) {
    box.textContent = "No spawnpoints yet. Players spawn at the top-left floor tile.";
    return;
  }
  for (const sp of WG.spawns) {
    const row = document.createElement("div");
    row.style.cssText = "margin-bottom:5px;padding:4px;background:#1a1a2a;border-radius:5px";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = sp.name;
    nameInput.style.width = "130px";
    nameInput.addEventListener("focus", () => { chatActive = true; });
    nameInput.addEventListener("blur", () => { chatActive = false; });
    nameInput.addEventListener("change", () => gmSend({ type: "gm_spawn_edit", id: sp.id, name: nameInput.value }));
    const info = document.createElement("span");
    info.style.cssText = "color:#99a;font-size:11px;margin-left:4px";
    info.textContent = "L" + sp.layer + " (" + sp.col + ", " + sp.row + ")";
    const go = document.createElement("button");
    go.className = "wgBtn";
    go.textContent = "Go";
    go.addEventListener("click", () => {
      if (sp.layer !== WG.layer) gmGoLayer(sp.layer);
      WG.markerGfx.scene.cameras.main.centerOn(sp.col * TILE + TILE / 2, sp.row * TILE + TILE / 2);
    });
    const move = document.createElement("button");
    move.className = "wgBtn" + (WG.spawnMoveId === sp.id ? " on" : "");
    move.textContent = "Move";
    move.addEventListener("click", () => {
      WG.spawnMoveId = WG.spawnMoveId === sp.id ? null : sp.id;
      if (WG.spawnMoveId) gmSetTool("spawn");
      gmRenderSpawns();
      gmDrawMarkers();
    });
    const del = document.createElement("button");
    del.className = "wgBtn";
    del.textContent = "Delete";
    del.addEventListener("click", () => {
      if (window.confirm("Delete spawnpoint " + sp.name + "?")) gmSend({ type: "gm_spawn_del", id: sp.id });
    });
    row.appendChild(nameInput);
    row.appendChild(info);
    row.appendChild(document.createElement("br"));
    row.appendChild(go);
    row.appendChild(move);
    row.appendChild(del);
    box.appendChild(row);
  }
}

function gmRenderPlayers() {
  const box = document.getElementById("wgPlayers");
  if (!box) return;
  box.innerHTML = "";
  const ids = Object.keys(WG.players);
  if (ids.length === 0) {
    box.textContent = "Nobody is in the world.";
    return;
  }
  for (const id of ids) {
    const p = WG.players[id];
    const row = document.createElement("div");
    row.className = "wgPlayer";
    if (WG.selPlayer === id) row.style.cssText = "background:#2a2a52;border-radius:5px";
    const label = document.createElement("span");
    label.textContent = p.name + " | L" + p.layer + " (" + p.col + ", " + p.row + ")";
    const view = document.createElement("button");
    view.className = "wgBtn";
    view.textContent = "View";
    view.addEventListener("click", () => {
      if (p.layer !== WG.layer) gmGoLayer(p.layer);
      WG.markerGfx.scene.cameras.main.centerOn(p.col * TILE + TILE / 2, p.row * TILE + TILE / 2);
    });
    const move = document.createElement("button");
    move.className = "wgBtn" + (WG.selPlayer === p.id ? " on" : "");
    move.textContent = WG.selPlayer === p.id ? "Selected" : "Select";
    move.addEventListener("click", () => {
      WG.selPlayer = WG.selPlayer === p.id ? null : p.id;
      gmRenderPlayers();
      gmUpdateHoverStatus();
    });
    const itemsBtn = document.createElement("button");
    itemsBtn.className = "wgBtn";
    itemsBtn.textContent = "Items";
    itemsBtn.addEventListener("click", () => gmInspect({ type: "player", id: p.id }));
    row.appendChild(label);
    row.appendChild(view);
    row.appendChild(move);
    row.appendChild(itemsBtn);
    box.appendChild(row);
  }
}

function gmSyncPlayerSprites(scene) {
  for (const id in otherPlayers) {
    if (id.charAt(0) === "e") continue;
    const p = WG.players[id];
    if (!p || p.layer !== WG.layer) removeOtherPlayer(id);
  }
  for (const id in WG.players) {
    const p = WG.players[id];
    if (p.layer === WG.layer && !otherPlayers[id]) addOtherPlayer(scene, p);
  }
}

function gmUpdatePlayer(scene, p) {
  WG.players[p.id] = p;
  gmRenderPlayers();
  const sprite = otherPlayers[p.id];
  if (p.layer !== WG.layer) {
    if (sprite) removeOtherPlayer(p.id);
    return;
  }
  if (!sprite) {
    addOtherPlayer(scene, p);
    return;
  }
  if (sprite === "loading") return;
  sprite.direction = p.direction;
  sprite.play(sprite.dex + "_walk_" + p.direction);
  scene.tweens.add({ targets: sprite, x: tilePixelX(p.col), y: tilePixelY(p.row), duration: 110, onComplete: () => { if (sprite.active) sprite.play(sprite.dex + "_idle_" + sprite.direction); } });
  sprite.hp = p.hp;
  sprite.maxHp = p.maxHp;
  sprite.mp = p.mp;
  sprite.maxMp = p.maxMp;
}

function gmRefreshAssetHighlight() {
  document.querySelectorAll("[data-wgasset]").forEach((b) => {
    const parts = b.getAttribute("data-wgasset").split(":");
    const on = (parts[0] === "tile" && WG.tool === "tile" && WG.tileName === parts[1]) || (parts[0] === "object" && WG.tool === "object" && WG.objName === parts[1]);
    b.classList.toggle("on", on);
  });
}

function gmSetTool(tool) {
  WG.tool = tool;
  const buttons = document.querySelectorAll("[data-wgtool]");
  buttons.forEach((b) => b.classList.toggle("on", b.getAttribute("data-wgtool") === tool));
  gmRefreshAssetHighlight();
  if (tool !== "portal") {
    WG.portalSource = null;
    gmDrawMarkers();
  }
}

function gmSetShape(shape) {
  WG.shape = shape;
  const buttons = document.querySelectorAll("[data-wgshape]");
  buttons.forEach((b) => b.classList.toggle("on", b.getAttribute("data-wgshape") === shape));
}

function gmBuildPanel() {
  const style = document.createElement("style");
  style.textContent = "#wgPanel{position:fixed;top:8px;right:8px;width:280px;max-height:96vh;overflow-y:auto;background:rgba(20,20,34,0.94);border:1px solid #3a3a55;border-radius:8px;padding:10px;color:#fff;font-size:13px;z-index:20}"
    + "#wgPanel h4{margin:10px 0 6px 0;color:#ffd23f;font-size:13px}"
    + "#wgPanel h4:first-child{margin-top:0}"
    + ".wgBtn{background:#2d2d44;color:#fff;border:1px solid #55557a;border-radius:5px;padding:5px 8px;margin:2px;cursor:pointer;font-size:12px}"
    + ".wgBtn.on{background:#4a6cff;border-color:#fff}"
    + "#wgPanel input[type=text],#wgPanel input[type=number]{background:#2d2d44;color:#fff;border:1px solid #55557a;border-radius:5px;padding:5px;width:70px}"
    + "#wgPanel input#wgName,#wgPanel input#wgItem{width:150px}"
    + ".wgAsset{display:inline-flex;flex-direction:column;align-items:center;width:62px;margin:2px;padding:4px 2px;background:#2d2d44;border:1px solid #55557a;border-radius:5px;color:#fff;font-size:10px;cursor:pointer}"
    + ".wgCatTabs{display:flex;flex-wrap:wrap;gap:3px;margin-bottom:4px}"
    + ".wgCatTab{padding:3px 7px;background:#2d2d44;border:1px solid #55557a;border-radius:5px;color:#fff;font-size:10px;cursor:pointer}"
    + ".wgCatTab.on{background:#4a6cff;border-color:#fff}"
    + ".wgPager{display:flex;align-items:center;gap:4px;margin-bottom:4px}"
    + ".wgPager button{padding:3px 9px;background:#2d2d44;border:1px solid #55557a;border-radius:5px;color:#fff;font-size:12px;cursor:pointer}"
    + ".wgPager button:hover{border-color:#fff}"
    + ".wgPager .wgPageTitle{flex:1;text-align:center;font-size:11px;color:#ffd23f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
    + ".wgPageBody{max-height:300px;overflow-y:auto}"
    + ".wgCatEmpty{padding:8px 4px;color:#aab;font-size:11px}"
    + ".wgAsset.on{background:#4a6cff;border-color:#fff}"
    + ".wgAsset img{width:36px;height:36px;object-fit:contain;image-rendering:pixelated;margin-bottom:2px}"
    + ".wgSecHead{cursor:pointer;color:#ffd23f;font-weight:bold;font-size:13px;margin:8px 0 4px 0;padding:6px 8px;background:#252540;border:1px solid #3a3a55;border-radius:6px;user-select:none}"
    + ".wgSecHead:hover{background:#2f2f55}"
    + ".wgSecHead .wgArrow::before{content:'\\25BE  '}"
    + ".wgSecHead.closed .wgArrow::before{content:'\\25B8  '}"
    + ".wgSecBody{padding:2px 2px 4px 2px}"
    + ".wgSecBody.closed{display:none}"
    + ".wgPlayer{display:flex;gap:4px;align-items:center;margin:3px 0}.wgPlayer span{flex:1}"
    + "#wgStatus{white-space:pre-wrap;font-family:monospace;font-size:12px;color:#c8c8ff;margin-top:6px}"
    + "#wgHelp{color:#8888aa;font-size:11px;margin-top:6px;line-height:1.4}";
  document.head.appendChild(style);

  const panel = document.createElement("div");
  panel.id = "wgPanel";
  panel.innerHTML = ""
    + "<div class='wgSecHead' data-wgsec='layer'><span class='wgArrow'></span>Layer</div><div class='wgSecBody' data-wgbody='layer'>"
    + "<div><button class='wgBtn' id='wgPrev'>&lt;</button><input type='number' id='wgLayerNum' min='-999' max='999' value='0'><button class='wgBtn' id='wgGo'>Go</button><button class='wgBtn' id='wgNext'>&gt;</button></div>"
    + "<div style='margin-top:6px'><input type='text' id='wgName' placeholder='Layer name'><button class='wgBtn' id='wgSetName'>Set</button></div>"
    + "<div id='wgLayerList' style='margin-top:6px'></div>"
    + "</div>"
    + "<div class='wgSecHead' data-wgsec='build'><span class='wgArrow'></span>Build tools</div><div class='wgSecBody' data-wgbody='build'>"
    + "<div id='wgTools'>"
    + "<button class='wgBtn on' data-wgtool='floor'>Floor</button>"
    + "<button class='wgBtn' data-wgtool='wall'>Wall</button>"
    + "<button class='wgBtn' data-wgtool='barrier'>Barrier</button>"
    + "<button class='wgBtn' data-wgtool='void'>Erase</button>"
    + "<button class='wgBtn' data-wgtool='portal'>Portal</button>"
    + "<button class='wgBtn' data-wgtool='tileclear'>Clear tile art</button>"
    + "<button class='wgBtn' data-wgtool='objerase'>Remove object</button>"
    + "<button class='wgBtn' data-wgtool='passable'>Passable</button>"
    + "<button class='wgBtn' data-wgtool='passableclear'>Clear passable</button>"
    + "<button class='wgBtn' data-wgtool='pan'>Pan</button>"
    + "</div>"
    + "<h4>Shape</h4>"
    + "<div>"
    + "<button class='wgBtn on' data-wgshape='pencil'>Pencil</button>"
    + "<button class='wgBtn' data-wgshape='line'>Straight line</button>"
    + "<button class='wgBtn' data-wgshape='rect'>Filled box</button>"
    + "<button class='wgBtn' data-wgshape='outline'>Box outline</button>"
    + "</div>"
    + "<div style='margin-top:6px'><label><input type='checkbox' id='wgTwoWay' checked> Portals work both ways</label></div>"
    + "<div style='margin-top:6px'><button class='wgBtn' id='wgUndo'>Undo (Ctrl+Z)</button></div>"
    + "</div>"
    + "<div class='wgSecHead' data-wgsec='spawn'><span class='wgArrow'></span>Spawnpoints</div><div class='wgSecBody' data-wgbody='spawn'>"
    + "<div><button class='wgBtn' data-wgtool='spawn'>Spawn tool</button></div>"
    + "<div><input type='text' id='wgSpawnName' placeholder='New spawn name' style='width:150px'> then use the Spawn tool and click a tile</div>"
    + "<div id='wgSpawnList' style='margin-top:4px'></div>"
    + "</div>"
    + "<div class='wgSecHead' data-wgsec='tiles'><span class='wgArrow'></span>Tile art</div><div class='wgSecBody' data-wgbody='tiles'>"
    + "<div id='wgTileList'>Loading...</div>"
    + "</div>"
    + "<div class='wgSecHead' data-wgsec='objects'><span class='wgArrow'></span>Objects</div><div class='wgSecBody' data-wgbody='objects'>"
    + "<div id='wgObjList'>Loading...</div>"
    + "<div style='margin-top:6px'><label><input type='checkbox' id='wgSolid' checked> Objects block movement</label></div>"
    + "</div>"
    + "<div class='wgSecHead' data-wgsec='creatures'><span class='wgArrow'></span>Creatures</div><div class='wgSecBody' data-wgbody='creatures'>"
    + "<div>Type <select id='wgEKind'><option value='enemy'>Enemy</option><option value='npc'>NPC</option></select></div>"
    + "<div style='margin-top:4px'>Species <input type='text' id='wgESpecies' list='wgSpeciesList' placeholder='e.g. Pikachu'><datalist id='wgSpeciesList'></datalist></div>"
    + "<div style='margin-top:4px'>Name <input type='text' id='wgEName' placeholder='optional'></div>"
    + "<div style='margin-top:4px'>Level <input type='number' id='wgELevel' value='5' min='1' max='100'> Wander <input type='number' id='wgEWander' value='4' min='0' max='30'></div>"
    + "<div style='margin-top:4px'>Sensor range <input type='number' id='wgESensor' value='5' min='1' max='5'> (enemies, max 5)</div>"
    + "<div id='wgEEnemyBox' style='margin-top:6px;padding:6px;border:1px solid #55557a;border-radius:6px'>"
    + "<div><b>Enemy build</b></div>"
    + "<div style='margin-top:4px'><label><input type='checkbox' id='wgEBoss'> Boss (no body left behind, items are only for its own use)</label></div>"
    + "<div style='margin-top:4px'>IVs 0-31 (blank = 15):<br>"
    + "HP <input type='number' class='wgIv' id='wgEIvHp' min='0' max='31' style='width:44px'> "
    + "Atk <input type='number' class='wgIv' id='wgEIvAtk' min='0' max='31' style='width:44px'> "
    + "Def <input type='number' class='wgIv' id='wgEIvDef' min='0' max='31' style='width:44px'><br>"
    + "SpA <input type='number' class='wgIv' id='wgEIvSpa' min='0' max='31' style='width:44px'> "
    + "SpD <input type='number' class='wgIv' id='wgEIvSpd' min='0' max='31' style='width:44px'> "
    + "Spe <input type='number' class='wgIv' id='wgEIvSpe' min='0' max='31' style='width:44px'></div>"
    + "<div style='margin-top:4px'>Equipped:<br>Head <input type='text' id='wgEAccHead' list='wgItemNames' style='width:120px'> Neck <input type='text' id='wgEAccNeck' list='wgItemNames' style='width:120px'><br>Back <input type='text' id='wgEAccBack' list='wgItemNames' style='width:120px'></div>"
    + "<div style='margin-top:4px'>Items carried, one per line (Name or Name x3). Non-boss enemies drop these as loot when they faint:<br><textarea id='wgEItems' rows='3' list='wgItemNames' style='width:96%;background:#2d2d44;color:#fff;border:1px solid #55557a;border-radius:5px'></textarea><datalist id='wgItemNames'></datalist></div>"
    + "<div style='margin-top:4px'>Moves, comma separated, up to 4 (blank = default for species and level):<br><input type='text' id='wgEMoves' style='width:96%'></div>"
    + "</div>"
    + "<div style='margin-top:4px'>NPC lines, one per line:<br><textarea id='wgELines' rows='4' style='width:96%;background:#2d2d44;color:#fff;border:1px solid #55557a;border-radius:5px'></textarea></div>"
    + "<div style='margin-top:4px'>"
    + "<button class='wgBtn' data-wgtool='creature'>Place</button>"
    + "<button class='wgBtn' data-wgtool='select'>Select</button>"
    + "<button class='wgBtn' data-wgtool='movecreature'>Move selected</button>"
    + "<button class='wgBtn' id='wgEUpdate'>Update selected</button>"
    + "<button class='wgBtn' id='wgEDelete'>Delete selected</button>"
    + "</div>"
    + "<div id='wgESel' style='margin-top:4px;color:#c8c8ff'>Nothing selected.</div>"
    + "</div>"
    + "<div class='wgSecHead' data-wgsec='items'><span class='wgArrow'></span>Items</div><div class='wgSecBody' data-wgbody='items'>"
    + "<div>Drag items from the Creative items window (bottom left) onto a tile, creature or player. Drag them back into the window to delete them.</div>"
    + "<div style='margin-top:6px'><button class='wgBtn' data-wgtool='item'>Move items</button><button class='wgBtn' id='wgToggleCreative'>Hide creative window</button></div>"
    + "</div>"
    + "<div class='wgSecHead' data-wgsec='moderation'><span class='wgArrow'></span>Moderation</div><div class='wgSecBody' data-wgbody='moderation'>"
    + "<div style='margin-bottom:4px'>Select a player below, then drag them on the map, use the Target tile tool, or type coordinates.</div>"
    + "<div><button class='wgBtn' data-wgtool='select'>Select tool</button><button class='wgBtn' data-wgtool='targettile'>Target tile</button></div>"
    + "<div style='margin-top:6px;color:#c8c8ff'><b>Players</b></div><div id='wgPlayers'></div>"
    + "<div class='wgTpBox'>Teleport selected player | X <input type='number' id='wgTpX' step='1' style='width:60px'> Y <input type='number' id='wgTpY' step='1' style='width:60px'> <button class='wgBtn' id='wgTpGo'>Teleport</button> <button class='wgBtn' id='wgTpSpawn'>Send to spawn</button></div>"
    + "</div>"
    + "<div class='wgSecHead' data-wgsec='time'><span class='wgArrow'></span>Time and light</div><div class='wgSecBody' data-wgbody='time'>"
    + "<div id='wgTimeLabel' style='color:#c8c8ff;margin-bottom:4px'>World time: --:--</div>"
    + "<div><input type='range' id='wgTimeSlider' min='0' max='23.75' step='0.25' value='12' style='width:150px;vertical-align:middle'> <span id='wgTimeSliderLabel'>12:00</span> <button class='wgBtn' id='wgTimeSet'>Set time</button></div>"
    + "<div><button class='wgBtn' data-wgtime='6'>Dawn</button><button class='wgBtn' data-wgtime='12'>Noon</button><button class='wgBtn' data-wgtime='19'>Dusk</button><button class='wgBtn' data-wgtime='0'>Midnight</button></div>"
    + "<div style='margin-top:4px'><button class='wgBtn' id='wgTimeFreeze'>Freeze time</button> Day length (min) <input type='number' id='wgDayMin' min='1' max='1440' step='1' style='width:55px'> <button class='wgBtn' id='wgDayMinSet'>Set</button></div>"
    + "<div style='margin-top:6px'>This layer's lighting:<br><select id='wgLightMode' style='background:#2d2d44;color:#fff;border:1px solid #55557a;border-radius:5px;padding:4px;width:96%'><option value='outdoor'>Outdoor (follows world time)</option><option value='indoor'>Indoor (always bright)</option><option value='dark'>Dark (always pitch dark)</option></select></div>"
    + "</div>"
    + "<div id='wgStatus'></div>"
    + "<div id='wgHelp'>Right-drag, middle-drag or hold Space to pan. Mouse wheel zooms. Lines snap straight; hold Shift for any angle. Portal: click the start tile, switch layer if needed, then click the destination. The green ring is the layer's spawn point. Red crossed tiles are invisible barriers that players cannot see.</div>";
  document.body.appendChild(panel);
  WG.panel = panel;

  const secDefaults = { layer: true, build: true, tiles: true, objects: true, spawn: false, creatures: false, items: false, moderation: false, time: false };
  let secState = {};
  try {
    secState = JSON.parse(localStorage.getItem("pmdGmSections") || "{}") || {};
  } catch (e) {
    secState = {};
  }
  panel.querySelectorAll("[data-wgsec]").forEach((headEl) => {
    const id = headEl.getAttribute("data-wgsec");
    const bodyEl = panel.querySelector("[data-wgbody='" + id + "']");
    const apply = () => {
      const open = secState[id] === undefined ? secDefaults[id] !== false : !!secState[id];
      headEl.classList.toggle("closed", !open);
      bodyEl.classList.toggle("closed", !open);
    };
    apply();
    headEl.addEventListener("click", () => {
      const open = !headEl.classList.contains("closed");
      secState[id] = !open;
      apply();
      try { localStorage.setItem("pmdGmSections", JSON.stringify(secState)); } catch (e) {}
    });
  });
  visGmBindUi();
  document.getElementById("wgToggleCreative").addEventListener("click", () => {
    const creative = document.getElementById("wgCreative");
    const coords = document.getElementById("wgCoords");
    if (!creative) return;
    const hide = creative.style.display !== "none";
    creative.style.display = hide ? "none" : "flex";
    gmPlaceCoords();
    document.getElementById("wgToggleCreative").textContent = hide ? "Show creative window" : "Hide creative window";
  });
  document.getElementById("wgTpSpawn").addEventListener("click", () => {
    if (!WG.selPlayer || !WG.players[WG.selPlayer]) {
      gmNotice("Select a player first.");
      return;
    }
    const sp = WG.spawns[0];
    if (!sp) {
      gmNotice("There are no spawnpoints yet.");
      return;
    }
    gmSend({ type: "gm_tp", playerId: WG.selPlayer, layer: sp.layer, col: sp.col, row: sp.row });
  });
  document.getElementById("wgGo").addEventListener("click", () => gmGoLayer(document.getElementById("wgLayerNum").value));
  document.getElementById("wgPrev").addEventListener("click", () => gmGoLayer(WG.layer - 1));
  document.getElementById("wgNext").addEventListener("click", () => gmGoLayer(WG.layer + 1));
  document.getElementById("wgSetName").addEventListener("click", () => gmSend({ type: "gm_layername", layer: WG.layer, name: document.getElementById("wgName").value }));
  document.getElementById("wgUndo").addEventListener("click", gmUndo);
  document.getElementById("wgEUpdate").addEventListener("click", () => {
    const picked = WG.selectedEntity ? WG.entities[WG.selectedEntity] : null;
    if (picked) gmSend({ type: "gm_entity_set", entity: gmReadCreatureForm(picked, picked.col, picked.row) });
  });
  document.getElementById("wgEDelete").addEventListener("click", () => {
    const picked = WG.selectedEntity ? WG.entities[WG.selectedEntity] : null;
    if (picked) gmSend({ type: "gm_entity_del", id: picked.id });
  });
  document.querySelectorAll("[data-wgtool]").forEach((b) => b.addEventListener("click", () => gmSetTool(b.getAttribute("data-wgtool"))));
  for (const tpId of ["wgTpX", "wgTpY"]) {
    const tpInput = document.getElementById(tpId);
    tpInput.addEventListener("focus", () => { chatActive = true; });
    tpInput.addEventListener("blur", () => { chatActive = false; });
  }
  document.getElementById("wgTpGo").addEventListener("click", () => {
    if (!WG.selPlayer || !WG.players[WG.selPlayer]) {
      gmNotice("Select a player first.");
      return;
    }
    const tx = parseInt(document.getElementById("wgTpX").value, 10);
    const ty = parseInt(document.getElementById("wgTpY").value, 10);
    if (!Number.isInteger(tx) || !Number.isInteger(ty) || tx < 0 || ty < 0 || tx >= WORLD_COLS || ty >= WORLD_ROWS) {
      gmNotice("Enter whole numbers for X and Y between 0 and " + (WORLD_COLS - 1) + ".");
      return;
    }
    gmSend({ type: "gm_tp", playerId: WG.selPlayer, layer: WG.layer, col: tx, row: ty });
  });
  document.querySelectorAll("[data-wgshape]").forEach((b) => b.addEventListener("click", () => gmSetShape(b.getAttribute("data-wgshape"))));
  panel.querySelectorAll("input[type=text],input[type=number],textarea,select").forEach((input) => {
    input.addEventListener("focus", () => { chatActive = true; gmFillItemNames(); });
    input.addEventListener("blur", () => { chatActive = false; });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.id === "wgLayerNum") gmGoLayer(input.value);
    });
  });
}

const GM_IV_FIELDS = [["hp", "wgEIvHp"], ["attack", "wgEIvAtk"], ["defense", "wgEIvDef"], ["spAtk", "wgEIvSpa"], ["spDef", "wgEIvSpd"], ["speed", "wgEIvSpe"]];

function gmReadIvs() {
  const out = {};
  for (const pair of GM_IV_FIELDS) {
    const raw = document.getElementById(pair[1]).value;
    if (raw !== "") out[pair[0]] = raw;
  }
  return out;
}

function gmParseLoot(text) {
  const out = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let name = line;
    let count = 1;
    const lead = line.match(/^(\d+)\s*[x\u00d7]\s*(.+)$/i);
    const tail = line.match(/^(.+?)\s*[x\u00d7]\s*(\d+)$/i);
    if (lead) {
      count = parseInt(lead[1], 10);
      name = lead[2].trim();
    } else if (tail) {
      count = parseInt(tail[2], 10);
      name = tail[1].trim();
    }
    out.push({ name: name, count: count });
  }
  return out;
}

function gmFormatLoot(list) {
  return (list || []).map((s) => s.name + (s.count > 1 ? " x" + s.count : "")).join("\n");
}

function gmFillItemNames() {
  const list = document.getElementById("wgItemNames");
  if (!list || list.children.length > 0 || typeof itemIndex !== "object") return;
  for (const name of Object.keys(itemIndex).sort()) {
    const opt = document.createElement("option");
    opt.value = name;
    list.appendChild(opt);
  }
}

function gmReadCreatureForm(existing, col, row) {
  return {
    id: existing ? existing.id : undefined,
    kind: document.getElementById("wgEKind").value,
    species: document.getElementById("wgESpecies").value,
    name: document.getElementById("wgEName").value,
    level: document.getElementById("wgELevel").value,
    wander: document.getElementById("wgEWander").value,
    sensor: document.getElementById("wgESensor").value,
    lines: document.getElementById("wgELines").value.split("\n"),
    boss: document.getElementById("wgEBoss").checked,
    ivs: gmReadIvs(),
    accessories: { head: document.getElementById("wgEAccHead").value, neck: document.getElementById("wgEAccNeck").value, back: document.getElementById("wgEAccBack").value },
    loot: gmParseLoot(document.getElementById("wgEItems").value),
    moves: document.getElementById("wgEMoves").value.split(",").map((m) => m.trim()).filter((m) => m.length > 0),
    layer: WG.layer,
    col: col,
    row: row
  };
}

function gmShowSelection() {
  const box = document.getElementById("wgESel");
  const picked = WG.selectedEntity ? WG.entities[WG.selectedEntity] : null;
  if (!picked) {
    box.textContent = "Nothing selected.";
    return;
  }
  box.textContent = "Selected: " + picked.name + " (" + picked.kind + ", " + picked.species + ")";
  document.getElementById("wgEKind").value = picked.kind;
  document.getElementById("wgESpecies").value = picked.species;
  document.getElementById("wgEName").value = picked.name === picked.species ? "" : picked.name;
  document.getElementById("wgELevel").value = picked.level;
  document.getElementById("wgEWander").value = picked.wander;
  document.getElementById("wgESensor").value = picked.sensor;
  document.getElementById("wgELines").value = (picked.lines || []).join("\n");
  document.getElementById("wgEBoss").checked = !!picked.boss;
  for (const pair of GM_IV_FIELDS) {
    document.getElementById(pair[1]).value = picked.ivs && typeof picked.ivs[pair[0]] === "number" ? picked.ivs[pair[0]] : "";
  }
  const acc = picked.accessories || {};
  document.getElementById("wgEAccHead").value = acc.head || "";
  document.getElementById("wgEAccNeck").value = acc.neck || "";
  document.getElementById("wgEAccBack").value = acc.back || "";
  document.getElementById("wgEItems").value = gmFormatLoot(picked.loot);
  document.getElementById("wgEMoves").value = (picked.moves || []).join(", ");
}

let wgObjPageTitle = "";

function gmMakePager(titles, getIndex, setIndex) {
  const bar = document.createElement("div");
  bar.className = "wgPager";
  const left = document.createElement("button");
  left.textContent = "<";
  const right = document.createElement("button");
  right.textContent = ">";
  const label = document.createElement("div");
  label.className = "wgPageTitle";
  bar.appendChild(left);
  bar.appendChild(label);
  bar.appendChild(right);
  const refresh = () => {
    const i = getIndex();
    label.textContent = titles.length === 0 ? "No pages" : titles[i] + "  (" + (i + 1) + "/" + titles.length + ")";
    label.title = titles[i] || "";
  };
  left.addEventListener("click", () => {
    if (titles.length === 0) return;
    setIndex((getIndex() - 1 + titles.length) % titles.length);
    refresh();
  });
  right.addEventListener("click", () => {
    if (titles.length === 0) return;
    setIndex((getIndex() + 1) % titles.length);
    refresh();
  });
  refresh();
  return { bar: bar, refresh: refresh };
}

function buildObjectPicker(objBox, list, addButtons) {
  const cats = (Array.isArray(list.objectCategories) ? list.objectCategories : []).filter((c) => c.groups.some((g) => g.objects.length > 0));
  if (cats.length === 0) {
    if ((list.objects || []).length === 0) objBox.textContent = "No pictures found in assets/objects.";
    else addButtons(objBox, "object", list.objects);
    return;
  }
  const pages = [];
  for (const cat of cats) {
    for (const group of cat.groups) {
      if (group.objects.length === 0) continue;
      pages.push({ title: cat.name + (group.name ? " > " + group.name : ""), objects: group.objects });
    }
  }
  let index = pages.findIndex((p) => p.title === wgObjPageTitle);
  if (index < 0) index = 0;
  const grid = document.createElement("div");
  grid.className = "wgPageBody";
  const fill = () => {
    grid.innerHTML = "";
    grid.scrollTop = 0;
    const page = pages[index];
    if (!page) return;
    wgObjPageTitle = page.title;
    addButtons(grid, "object", page.objects);
    gmRefreshAssetHighlight();
  };
  const pager = gmMakePager(pages.map((p) => p.title), () => index, (i) => {
    index = i;
    fill();
  });
  objBox.appendChild(pager.bar);
  objBox.appendChild(grid);
  fill();
}

function gmBuildAssetButtons(list) {
  worldAssetList = list;
  const tileBox = document.getElementById("wgTileList");
  const objBox = document.getElementById("wgObjList");
  tileBox.innerHTML = "";
  objBox.innerHTML = "";
  const addButtons = (box, kind, names) => {
    for (const name of names) {
      const btn = document.createElement("button");
      btn.className = "wgAsset";
      btn.setAttribute("data-wgasset", kind + ":" + name);
      const img = document.createElement("img");
      img.src = worldAssetUrl(kind, name);
      const label = document.createElement("span");
      label.textContent = name;
      btn.appendChild(img);
      btn.appendChild(label);
      btn.addEventListener("click", () => {
        if (kind === "tile") WG.tileName = name;
        else WG.objName = name;
        gmSetTool(kind);
      });
      box.appendChild(btn);
    }
  };
  const categories = Array.isArray(list.tileCategories) ? list.tileCategories : [{ name: "Default", tiles: list.tiles || [] }];
  if (!categories.some((c) => c.name === wgTileCategory)) wgTileCategory = categories.length ? categories[0].name : "Default";
  const tabs = document.createElement("div");
  tabs.className = "wgCatTabs";
  const grid = document.createElement("div");
  const fillGrid = () => {
    grid.innerHTML = "";
    const cat = categories.find((c) => c.name === wgTileCategory);
    if (!cat || cat.tiles.length === 0) {
      const empty = document.createElement("div");
      empty.className = "wgCatEmpty";
      empty.textContent = "No tiles available in this category";
      grid.appendChild(empty);
    } else {
      addButtons(grid, "tile", cat.tiles);
    }
    gmRefreshAssetHighlight();
  };
  for (const cat of categories) {
    const tab = document.createElement("button");
    tab.className = "wgCatTab" + (cat.name === wgTileCategory ? " on" : "");
    tab.textContent = cat.name;
    tab.addEventListener("click", () => {
      wgTileCategory = cat.name;
      for (const t of tabs.children) t.classList.toggle("on", t === tab);
      fillGrid();
    });
    tabs.appendChild(tab);
  }
  tileBox.appendChild(tabs);
  tileBox.appendChild(grid);
  fillGrid();
  buildObjectPicker(objBox, list, addButtons);
  gmRefreshAssetHighlight();
}

function enterGmWorld(scene) {
  worldGmMode = true;
  musicInit();
  isGM = true;
  window.worldGmActive = true;
  player.setVisible(false);
  const cam = scene.cameras.main;
  cam.stopFollow();
  cam.removeBounds();
  cam.setZoom(0.5);
  if (mapGraphics) mapGraphics.clear();
  WG.rows = blankRows();
  WG.art = blankRows();
  WG.previewGfx = scene.add.graphics();
  WG.previewGfx.setDepth(60);
  WG.markerGfx = scene.add.graphics();
  WG.markerGfx.setDepth(55);
  gmDrawGrid(scene);
  gmBuildPanel();
  gmBuildCreative();
  fetch("/api/world/assets").then((r) => r.json()).then(gmBuildAssetButtons).catch(() => {
    document.getElementById("wgTileList").textContent = "Could not load the picture list.";
    document.getElementById("wgObjList").textContent = "";
  });
  fetch("/api/world/species").then((r) => r.json()).then((data) => {
    const list = document.getElementById("wgSpeciesList");
    for (const name of data.species || []) {
      const opt = document.createElement("option");
      opt.value = name;
      list.appendChild(opt);
    }
  }).catch(() => {});
  scene.input.mouse.disableContextMenu();
  scene.input.on("pointerdown", (pointer) => gmPointerDown(scene, pointer));
  scene.input.on("pointermove", (pointer) => gmPointerMove(scene, pointer));
  scene.input.on("pointerup", (pointer) => gmPointerUp(scene, pointer));
  scene.input.on("wheel", (pointer, over, dx, dy) => {
    let z = cam.zoom * (dy > 0 ? 0.9 : 1.1);
    if (z < 0.2) z = 0.2;
    if (z > 2.5) z = 2.5;
    cam.setZoom(z);
  });
  window.addEventListener("keydown", (e) => {
    if (chatActive) return;
    if (e.code === "Space") { gmSpaceDown = true; e.preventDefault(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { gmUndo(); e.preventDefault(); }
    if (e.key === "Escape") {
      WG.portalSource = null;
      WG.tpTarget = null;
      gmPlayerDragCancel();
      gmDrawMarkers();
      gmRenderPlayers();
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") gmSpaceDown = false;
  });
  updateReadout("World editor");
}

function gmLoadLayer(scene, data) {
  const firstLoad = !WG.loaded;
  WG.loaded = true;
  WG.layer = data.layer;
  WG.name = data.name || "";
  WG.rows = blankRows();
  for (let r = 0; r < WORLD_ROWS && r < data.rows.length; r++) {
    WG.rows[r] = String(data.rows[r]).padEnd(WORLD_COLS, " ").slice(0, WORLD_COLS);
  }
  WG.art = blankRows();
  for (let r = 0; r < WORLD_ROWS && data.art && r < data.art.length; r++) {
    WG.art[r] = String(data.art[r]).padEnd(WORLD_COLS, " ").slice(0, WORLD_COLS);
  }
  WG.palette = data.palette || {};
  VIS.layerMode = data.light || "outdoor";
  const lightSelect = document.getElementById("wgLightMode");
  if (lightSelect) lightSelect.value = VIS.layerMode;
  WG.objects = {};
  for (const o of data.objects || []) {
    WG.objects[o[0] + "," + o[1]] = { name: o[2], solid: o[3] !== 0, rot: o[4] || 0, flip: o[5] === 1 };
  }
  WG.passable = {};
  for (const pc of data.passable || []) {
    WG.passable[pc[0] + "," + pc[1]] = 1;
  }
  WG.artDirty = true;
  entityClearAll();
  WG.entities = {};
  for (const e of data.entities || []) {
    WG.entities[e.id] = e;
    entityUpsert(scene, e);
  }
  WG.selectedEntity = null;
  gmShowSelection();
  WG.portals = data.portals || {};
  WG.spawn = null;
  if (Array.isArray(data.spawns)) WG.spawns = data.spawns;
  WG.layers = data.layers || WG.layers;
  gmRedrawAll(scene);
  gmDrawMarkers();
  worldSyncItems(scene, data.floorItems);
  gmSyncPlayerSprites(scene);
  document.getElementById("wgLayerNum").value = WG.layer;
  document.getElementById("wgName").value = WG.name;
  gmRenderLayers();
  gmRenderPlayers();
  gmRenderSpawns();
  if (firstLoad) {
    const firstSpawn = WG.spawns.find((sp) => sp.layer === WG.layer) || WG.spawns[0];
    const target = firstSpawn || { col: 32, row: 22 };
    scene.cameras.main.centerOn(target.col * TILE + TILE / 2, target.row * TILE + TILE / 2);
  }
  gmUpdateHoverStatus();
}

const COMBAT = { active: false, id: null, actors: {}, order: [], turn: null, steps: 0, moves: [], myTurn: false, pending: -1, mp: 0, maxMp: 0, turnEndsAt: 0, timerHandle: null, hideHandle: null };
const COMBAT_TYPE_COLORS = { Normal: 0xc8c8b0, Fire: 0xff7a2a, Water: 0x4a90ff, Electric: 0xffe030, Grass: 0x4ec24e, Ice: 0x9be8ff, Fighting: 0xc03028, Poison: 0xa040c0, Ground: 0xd8b860, Flying: 0xa8b8ff, Psychic: 0xff5a9a, Bug: 0xa8c020, Rock: 0xb8a038, Ghost: 0x7058a0, Dragon: 0x7038f8, Dark: 0x604838, Steel: 0xb8b8d0, Fairy: 0xffaadd };
const COMBAT_PREFETCH = ["Attack", "Shoot", "Strike"];
const combatXml = {};
const combatAnimState = {};
let combatRangeGfx = null;

function combatIsFoe(a) {
  const me = COMBAT.actors[myId];
  if (me && me.side && a.side) return a.side !== me.side;
  return a.kind === "enemy";
}

function combatEl(id) {
  return document.getElementById(id);
}

function combatSprite(id) {
  if (String(id) === String(myId)) return player;
  return otherPlayers[id];
}

function combatHolds(id) {
  const a = COMBAT.actors[id];
  return COMBAT.active && !!a && !a.dead;
}

function combatBlocksMove() {
  if (!COMBAT.active || worldGmMode) return false;
  return !(COMBAT.myTurn && COMBAT.steps > 0);
}

function combatAddLog(lines) {
  const body = combatEl("cbLog");
  if (!body) return;
  const list = Array.isArray(lines) ? lines : [lines];
  for (const line of list) {
    if (typeof line !== "string") continue;
    for (const part of line.split("\n")) {
      if (!part.trim()) continue;
      const div = document.createElement("div");
      div.textContent = part;
      body.appendChild(div);
    }
  }
  while (body.childNodes.length > 60) body.removeChild(body.firstChild);
  body.scrollTop = body.scrollHeight;
}

function combatShowPanel(show) {
  const panel = combatEl("combat");
  const order = combatEl("cbOrder");
  if (!panel || !order) return;
  if (show) {
    panel.classList.remove("hidden");
    order.classList.remove("hidden");
  } else {
    panel.classList.add("hidden");
    order.classList.add("hidden");
  }
}

function combatRenderOrder() {
  const el = combatEl("cbOrder");
  if (!el) return;
  el.innerHTML = "";
  const head = document.createElement("span");
  head.className = "cbohead";
  head.textContent = "Turn order";
  el.appendChild(head);
  const ids = [];
  if (COMBAT.turn !== null && COMBAT.turn !== undefined) ids.push(COMBAT.turn);
  for (const id of COMBAT.order) ids.push(id);
  let shown = 0;
  for (let i = 0; i < ids.length && shown < 9; i++) {
    const a = COMBAT.actors[ids[i]];
    if (!a || a.dead) continue;
    const chip = document.createElement("span");
    chip.className = "cbo " + (combatIsFoe(a) ? "foe" : "ally") + (i === 0 && COMBAT.turn !== null ? " cur" : "");
    chip.textContent = a.name;
    el.appendChild(chip);
    shown++;
  }
}

function combatRenderBanner() {
  const el = combatEl("cbTurn");
  if (!el) return;
  const a = COMBAT.turn !== null ? COMBAT.actors[COMBAT.turn] : null;
  if (!a) {
    el.textContent = "Battle";
    return;
  }
  if (COMBAT.myTurn) {
    const left = Math.max(0, Math.ceil((COMBAT.turnEndsAt - Date.now()) / 1000));
    el.textContent = "Your turn | steps " + COMBAT.steps + " | " + left + "s";
  } else {
    el.textContent = a.name + "'s turn";
  }
}

function combatSetMenu(show) {
  combatEl("cbMenu").classList.toggle("hidden", !show);
  if (!show) {
    combatEl("cbTargets").classList.add("hidden");
    COMBAT.pending = -1;
    combatClearRange();
  }
}

function combatRenderMoves() {
  const box = combatEl("cbMoves");
  box.innerHTML = "";
  for (let i = 0; i < COMBAT.moves.length; i++) {
    const m = COMBAT.moves[i];
    const btn = document.createElement("button");
    btn.className = "cbmove";
    const name = document.createElement("div");
    name.className = "cbmname";
    name.textContent = (i + 1) + ". " + m.name;
    const info = document.createElement("div");
    info.className = "cbminfo";
    const power = m.power > 0 ? " P" + m.power : "";
    info.textContent = m.type + " " + m.category + power + " | MP " + m.mpCost + " | R" + m.range;
    btn.appendChild(name);
    btn.appendChild(info);
    if (m.unsupported || COMBAT.mp < m.mpCost) btn.disabled = true;
    btn.style.borderColor = "#" + (COMBAT_TYPE_COLORS[m.type] || 0x888888).toString(16).padStart(6, "0");
    btn.addEventListener("click", () => combatSelectMove(i));
    box.appendChild(btn);
  }
}

function combatMe() {
  return COMBAT.actors[myId];
}

function combatDistance(a, b) {
  return Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));
}

function combatClearRange() {
  if (combatRangeGfx) combatRangeGfx.clear();
}

function combatShowRange(range) {
  if (!sceneRef) return;
  if (!combatRangeGfx) {
    combatRangeGfx = sceneRef.add.graphics();
    combatRangeGfx.setDepth(5);
  }
  combatRangeGfx.clear();
  const me = combatMe();
  if (!me || range <= 0) return;
  const mine = { col: player.col, row: player.row };
  combatRangeGfx.fillStyle(0xffd23f, 0.16);
  for (let dc = -range; dc <= range; dc++) {
    for (let dr = -range; dr <= range; dr++) {
      if (dc === 0 && dr === 0) continue;
      combatRangeGfx.fillRect((mine.col + dc) * TILE + 1, (mine.row + dr) * TILE + 1, TILE - 2, TILE - 2);
    }
  }
  combatRangeGfx.lineStyle(2, 0xff5050, 0.9);
  for (const id in COMBAT.actors) {
    const a = COMBAT.actors[id];
    if (a.dead || !combatIsFoe(a)) continue;
    const spr = combatSprite(a.id);
    if (!spr || spr === "loading") continue;
    const c = Math.floor(spr.x / TILE);
    const r = Math.floor(spr.y / TILE);
    if (combatDistance({ col: c, row: r }, mine) <= range) combatRangeGfx.strokeRect(c * TILE + 2, r * TILE + 2, TILE - 4, TILE - 4);
  }
}

function combatSendAttack(index, targetId) {
  gmSend({ type: "c_attack", move: index, target: targetId });
  COMBAT.myTurn = false;
  combatSetMenu(false);
  combatRenderBanner();
}

function combatSelectMove(index) {
  if (!COMBAT.myTurn) return;
  const m = COMBAT.moves[index];
  if (!m || m.unsupported || COMBAT.mp < m.mpCost) return;
  if (m.target === "self" || m.target === "all-allies") {
    combatSendAttack(index, null);
    return;
  }
  const wantEnemy = m.target !== "ally";
  const mine = { col: player.col, row: player.row };
  const cands = [];
  for (const id in COMBAT.actors) {
    const a = COMBAT.actors[id];
    if (a.dead) continue;
    if (wantEnemy && !combatIsFoe(a)) continue;
    if (!wantEnemy && (combatIsFoe(a) || (a.kind !== "player" && a.kind !== "ally"))) continue;
    const spr = combatSprite(a.id);
    const pos = spr && spr !== "loading" ? { col: Math.floor(spr.x / TILE), row: Math.floor(spr.y / TILE) } : { col: a.col, row: a.row };
    cands.push({ a: a, dist: combatDistance(pos, mine) });
  }
  if (cands.length === 0) return;
  if (cands.length === 1) {
    combatSendAttack(index, cands[0].a.id);
    return;
  }
  COMBAT.pending = index;
  cands.sort((x, y) => x.dist - y.dist);
  const box = combatEl("cbTargets");
  box.innerHTML = "";
  const label = document.createElement("div");
  label.className = "cbtlabel";
  label.textContent = "Target for " + m.name + " (range " + m.range + ")";
  box.appendChild(label);
  for (const c of cands) {
    const btn = document.createElement("button");
    btn.className = "cbtarget";
    const inRange = c.dist <= m.range;
    btn.textContent = c.a.name + " Lv" + c.a.level + " | " + c.a.hp + "/" + c.a.maxHp + " | " + c.dist + " tiles" + (inRange ? "" : " (too far)");
    if (!inRange) btn.disabled = true;
    btn.addEventListener("click", () => combatSendAttack(index, c.a.id));
    box.appendChild(btn);
  }
  box.classList.remove("hidden");
  combatShowRange(m.range);
}

function combatApplyActor(a) {
  const spr = combatSprite(a.id);
  if (!spr || spr === "loading") return;
  spr.hp = a.hp;
  spr.maxHp = a.maxHp;
  spr.mp = a.mp;
  spr.maxMp = a.maxMp;
  spr.setAlpha(a.dead ? 0.35 : 1);
  spr.stages = a.dead ? {} : (a.stages || {});
  if (spr === player) {
    playerHp = a.hp;
    playerMaxHp = a.maxHp;
  }
}

function combatEnsureSprite(scene, a) {
  if (String(a.id) === String(myId)) return;
  if (otherPlayers[a.id]) return;
  if (a.kind === "enemy") {
    worldEntityMeta[a.id] = { kind: "enemy", name: a.name, state: "alert", dex: a.dex };
  } else if (a.kind === "ally") {
    worldEntityMeta[a.id] = { kind: "companion", name: a.name, state: "idle", dex: a.dex };
  }
  addOtherPlayer(scene, { id: a.id, dex: a.dex, col: a.col, row: a.row, direction: a.direction || "down", hp: a.hp, maxHp: a.maxHp, mp: a.mp, maxMp: a.maxMp });
}

function combatFetchXml(dex, cb) {
  const cached = combatXml[dex];
  if (cached && cached.done) { cb(cached.info); return; }
  if (cached) { cached.cbs.push(cb); return; }
  combatXml[dex] = { done: false, info: null, cbs: [cb] };
  const finish = (info) => {
    const entry = combatXml[dex];
    entry.done = true;
    entry.info = info;
    const list = entry.cbs;
    entry.cbs = [];
    for (const fn of list) fn(info);
  };
  fetch(SPECIES_BASE + dex + "/AnimData.xml").then((r) => {
    if (!r.ok) throw new Error("no anim data");
    return r.text();
  }).then((xml) => {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const anims = doc.getElementsByTagName("Anim");
    const info = {};
    for (let i = 0; i < anims.length; i++) {
      const nameEl = anims[i].getElementsByTagName("Name")[0];
      const fwEl = anims[i].getElementsByTagName("FrameWidth")[0];
      const fhEl = anims[i].getElementsByTagName("FrameHeight")[0];
      const durEls = anims[i].getElementsByTagName("Duration");
      if (!nameEl || !fwEl || !fhEl || durEls.length === 0) continue;
      const durs = [];
      let total = 0;
      for (let k = 0; k < durEls.length; k++) {
        const v = parseInt(durEls[k].textContent, 10) || 2;
        durs.push(v);
        total += v;
      }
      const readIndex = (tag) => {
        const el = anims[i].getElementsByTagName(tag)[0];
        return el ? parseInt(el.textContent, 10) : -1;
      };
      let hitTicks = total * 0.5;
      const hitIdx = readIndex("HitFrame");
      if (hitIdx >= 0) {
        hitTicks = 0;
        for (let k = 0; k < Math.min(hitIdx, durs.length); k++) hitTicks += durs[k];
      }
      info[nameEl.textContent] = { fw: parseInt(fwEl.textContent, 10), fh: parseInt(fhEl.textContent, 10), cols: durs.length, totalTicks: total, hitTicks: hitTicks };
    }
    finish(info);
  }).catch(() => finish(null));
}

function combatAnimKey(dex, name) {
  return dex + "_a_" + name;
}

function combatAnimReady(dex, name) {
  const st = combatAnimState[combatAnimKey(dex, name)];
  return !!st && st.ready === true;
}

function combatPrefetch(scene, dex, name) {
  const key = combatAnimKey(dex, name);
  if (combatAnimState[key]) return;
  const st = { ready: false, failed: false };
  combatAnimState[key] = st;
  combatFetchXml(dex, (info) => {
    const a = info ? info[name] : null;
    if (!a) {
      st.failed = true;
      return;
    }
    st.info = a;
    scene.load.spritesheet(key, SPECIES_BASE + dex + "/" + name + "-Anim.png", { frameWidth: a.fw, frameHeight: a.fh });
    scene.load.once("complete", () => {
      if (!scene.textures.exists(key)) {
        st.failed = true;
        return;
      }
      const totalMs = Math.max(250, Math.round(a.totalTicks * 1000 / 60));
      for (let d = 0; d < 8; d++) {
        const dir = DIR_ORDER[d];
        const animKey = key + "_" + dir;
        if (scene.anims.exists(animKey)) continue;
        scene.anims.create({ key: animKey, frames: scene.anims.generateFrameNumbers(key, { start: d * a.cols, end: d * a.cols + a.cols - 1 }), duration: totalMs, repeat: 0 });
      }
      st.totalMs = totalMs;
      st.hitMs = Math.round(a.hitTicks * 1000 / 60);
      st.ready = true;
    });
    scene.load.start();
  });
}

function combatAnimName(d) {
  const n = String(d.move || "").toLowerCase();
  if (d.anim === "self" || d.kind === "item") return null;
  if (d.anim === "ranged") return "Shoot";
  if (/kick|stomp|stamp|trample/.test(n)) return "Kick";
  if (/scratch|slash|cut|claw|bite|crunch|peck|fang|slice|fury/.test(n)) return "Strike";
  return "Attack";
}

function combatDirTo(from, to) {
  const dx = Math.sign(Math.round((to.x - from.x) / (TILE / 2)));
  const dy = Math.sign(Math.round((to.y - from.y) / (TILE / 2)));
  for (const name in VIEW_VEC) {
    const v = VIEW_VEC[name];
    if (v[0] === dx && v[1] === dy) return name;
  }
  return null;
}

function combatFloat(scene, spr, text, color) {
  const t = scene.add.text(spr.x, spr.y, text, { fontFamily: "sans-serif", fontSize: "18px", fontStyle: "bold", color: color, stroke: "#000000", strokeThickness: 4 });
  t.setOrigin(0.5, 1);
  t.setDepth(300);
  t.setRotation(-viewRot);
  const up = 46;
  scene.tweens.add({ targets: t, x: spr.x - up * Math.sin(viewRot), y: spr.y - up * Math.cos(viewRot), alpha: 0, duration: 900, delay: 150, onComplete: () => t.destroy() });
}

function combatFlash(scene, spr) {
  if (!spr || spr === "loading" || !spr.active) return;
  spr.setTintFill(0xffffff);
  scene.time.delayedCall(90, () => { if (spr.active) spr.clearTint(); });
  scene.time.delayedCall(180, () => { if (spr.active) spr.setTintFill(0xff6060); });
  scene.time.delayedCall(300, () => { if (spr.active) spr.clearTint(); });
}

function combatConeFlash(scene, tiles, fire) {
  const color = fire ? 0xff7a1a : 0xb06aff;
  for (const t of tiles) {
    const rect = scene.add.rectangle(t.col * TILE + TILE / 2, t.row * TILE + TILE / 2, TILE - 2, TILE - 2, color, 0.55);
    rect.setDepth(60);
    scene.tweens.add({ targets: rect, alpha: 0, duration: 750, onComplete: () => rect.destroy() });
  }
}

function combatImpact(scene, d) {
  if (Array.isArray(d.cone)) combatConeFlash(scene, d.cone, d.moveType === "Fire");
  for (const ch of d.changes || []) {
    const spr = combatSprite(ch.id);
    const a = COMBAT.actors[ch.id];
    if (a) {
      a.hp = ch.hp;
      a.mp = ch.mp;
      combatApplyActor(a);
    }
    if (!spr || spr === "loading") continue;
    if (ch.dhp < 0) {
      combatFlash(scene, spr);
      combatFloat(scene, spr, String(ch.dhp), "#ff6a6a");
    } else if (ch.dhp > 0) {
      combatFloat(scene, spr, "+" + ch.dhp, "#7dff7d");
    }
  }
  combatAddLog(d.lines || []);
}

function combatBackToIdle(spr) {
  if (!spr || !spr.active) return;
  spr.atkAnim = false;
  const dex = spr === player ? DEX : spr.dex;
  spr.setTexture(dex + "_idle");
  spr.play(dex + "_idle_" + worldToScreenDir(spr.direction), true);
}

function combatAct(scene, d) {
  const actor = combatSprite(d.actor);
  const target = combatSprite(d.target);
  const ready = actor && actor !== "loading" && actor.active;
  if (!ready) {
    combatImpact(scene, d);
    return;
  }
  const tReady = target && target !== "loading" && target.active && target !== actor;
  if (tReady) {
    const dir = combatDirTo(actor, target);
    if (dir) actor.direction = dir;
  }
  const dex = actor === player ? DEX : actor.dex;
  const animName = combatAnimName(d);
  const isSelf = d.anim === "self" || !tReady;
  let impactAt = 250;
  let usedAnim = false;

  if (animName && !isSelf) {
    if (combatAnimReady(dex, animName)) {
      const st = combatAnimState[combatAnimKey(dex, animName)];
      actor.atkAnim = true;
      actor.setTexture(combatAnimKey(dex, animName));
      actor.play(combatAnimKey(dex, animName) + "_" + worldToScreenDir(actor.direction), true);
      actor.once("animationcomplete", () => combatBackToIdle(actor));
      scene.time.delayedCall(st.totalMs + 120, () => { if (actor.atkAnim) combatBackToIdle(actor); });
      impactAt = Math.max(120, st.hitMs);
      usedAnim = true;
    } else {
      combatPrefetch(scene, dex, animName);
    }
  }

  const ox = actor.x;
  const oy = actor.y;
  if (!isSelf && !usedAnim) {
    const dx = target.x - actor.x;
    const dy = target.y - actor.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const lunge = d.anim === "ranged" ? 12 : Math.max(10, Math.min(len - TILE * 0.55, TILE * 0.7));
    scene.tweens.add({ targets: actor, x: ox + dx / len * lunge, y: oy + dy / len * lunge, duration: 140, yoyo: true, ease: "Quad.easeOut" });
    impactAt = 150;
  } else if (!isSelf && usedAnim && d.anim === "melee") {
    const dx = target.x - actor.x;
    const dy = target.y - actor.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    scene.tweens.add({ targets: actor, x: ox + dx / len * 10, y: oy + dy / len * 10, duration: Math.max(80, impactAt * 0.7), yoyo: true, ease: "Quad.easeOut" });
  } else if (isSelf) {
    const sx = actor.scaleX;
    const sy = actor.scaleY;
    scene.tweens.add({ targets: actor, scaleX: sx * 1.18, scaleY: sy * 1.18, duration: 160, yoyo: true });
    impactAt = 260;
  }

  if (!isSelf && d.anim === "ranged") {
    const color = COMBAT_TYPE_COLORS[d.moveType] || 0xffffff;
    scene.time.delayedCall(impactAt, () => {
      if (!actor.active || !target.active) {
        combatImpact(scene, d);
        return;
      }
      const orb = scene.add.circle(actor.x, actor.y - 12, 7, color, 1);
      orb.setStrokeStyle(2, 0xffffff, 0.9);
      orb.setDepth(250);
      scene.tweens.add({ targets: orb, x: target.x, y: target.y - 12, duration: 260, onComplete: () => {
        orb.destroy();
        combatImpact(scene, d);
      } });
    });
  } else {
    scene.time.delayedCall(impactAt, () => combatImpact(scene, d));
  }
}

function combatEnd(scene, d) {
  COMBAT.active = false;
  COMBAT.myTurn = false;
  COMBAT.turn = null;
  combatSetMenu(false);
  if (COMBAT.timerHandle) {
    clearInterval(COMBAT.timerHandle);
    COMBAT.timerHandle = null;
  }
  const label = { win: "Victory!", over: "The battle ended.", fled: "You got away.", defeat: "You were defeated... you wake up back at the spawn point." }[d.result] || "The battle ended.";
  combatAddLog(label);
  if (d.result === "win" && d.exp) combatAddLog("The team earned " + d.exp + " EXP" + (d.coins ? " and " + d.coins + " coins" : "") + " (counted on the bot).");
  for (const id of Object.keys(COMBAT.actors)) {
    const sp = String(id) === String(myId) ? player : otherPlayers[id];
    if (sp && sp !== "loading") sp.stages = {};
  }
  if (typeof d.hp === "number") {
    player.hp = d.hp;
    playerHp = d.hp;
  }
  if (typeof d.mp === "number") player.mp = d.mp;
  state = "input";
  const mine = { col: player.col, row: player.row };
  for (const id of Object.keys(COMBAT.actors)) {
    if (String(id) === String(myId)) continue;
    const a = COMBAT.actors[id];
    const spr = otherPlayers[id];
    if (!spr) continue;
    const far = spr !== "loading" && (Math.abs(Math.floor(spr.x / TILE) - mine.col) > 8 || Math.abs(Math.floor(spr.y / TILE) - mine.row) > 6);
    const keepNpc = worldEntityMeta[id] && worldEntityMeta[id].kind === "npc";
    if (a.kind === "enemy" && !keepNpc && (a.dead || far)) entityRemove(id);
    else if (a.kind === "player" && far) removeOtherPlayer(id);
    else if (a.kind === "ally" && spr !== "loading") spr.maxHp = 0;
  }
  COMBAT.actors = {};
  COMBAT.order = [];
  if (COMBAT.hideHandle) clearTimeout(COMBAT.hideHandle);
  COMBAT.hideHandle = setTimeout(() => {
    if (!COMBAT.active) combatShowPanel(false);
  }, 3500);
}

function combatMessage(scene, d) {
  if (worldGmMode) {
    if (d.type === "c_act") combatAct(scene, d);
    else if (d.type === "c_log") for (const line of d.lines) addGmLine(line, Date.now());
    return true;
  }
  if (!worldPlayerMode) return true;

  if (d.type === "c_start") {
    if (COMBAT.hideHandle) clearTimeout(COMBAT.hideHandle);
    COMBAT.active = true;
    COMBAT.id = d.fight;
    COMBAT.actors = {};
    COMBAT.order = [];
    COMBAT.turn = null;
    COMBAT.myTurn = false;
    combatEl("cbLog").innerHTML = "";
    combatAddLog(d.log || []);
    combatShowPanel(true);
    combatSetMenu(false);
    combatRenderBanner();
    if (!COMBAT.timerHandle) COMBAT.timerHandle = setInterval(combatRenderBanner, 250);
    updateReadout("battle!");
  } else if (d.type === "c_state") {
    if (!COMBAT.active) return true;
    const next = {};
    for (const a of d.actors) {
      next[a.id] = a;
      combatEnsureSprite(scene, a);
      combatApplyActor(a);
      if (a.kind === "enemy" || String(a.id) !== String(myId)) {
        for (const nm of COMBAT_PREFETCH) combatPrefetch(scene, a.dex || "0004", nm);
      } else {
        for (const nm of COMBAT_PREFETCH) combatPrefetch(scene, DEX, nm);
      }
    }
    COMBAT.actors = next;
    COMBAT.order = d.order || [];
    COMBAT.turn = d.turn;
    if (String(d.turn) === String(myId)) COMBAT.steps = d.steps;
    else {
      COMBAT.myTurn = false;
      combatSetMenu(false);
    }
    combatRenderOrder();
    combatRenderBanner();
  } else if (d.type === "c_turn") {
    if (!d.moves) return true;
    COMBAT.myTurn = true;
    COMBAT.steps = d.steps;
    COMBAT.moves = d.moves;
    COMBAT.mp = d.mp;
    COMBAT.maxMp = d.maxMp;
    COMBAT.turnEndsAt = Date.now() + d.ms;
    combatRenderMoves();
    combatSetMenu(true);
    combatRenderBanner();
    updateReadout("your turn");
  } else if (d.type === "c_steps") {
    if (String(d.actor) === String(myId)) {
      COMBAT.steps = d.steps;
      combatRenderBanner();
    }
  } else if (d.type === "c_pos") {
    if (String(d.id) === String(myId)) return true;
    const a = COMBAT.actors[d.id];
    if (a) {
      a.col = d.col;
      a.row = d.row;
      combatEnsureSprite(scene, a);
    }
    const spr = otherPlayers[d.id];
    if (spr && spr !== "loading") {
      spr.direction = d.direction;
      const dex = spr.dex;
      spr.play(dex + "_walk_" + worldToScreenDir(d.direction), true);
      scene.tweens.add({ targets: spr, x: tilePixelX(d.col), y: tilePixelY(d.row), duration: 160, onComplete: () => { if (spr.active && !spr.atkAnim) spr.play(dex + "_idle_" + worldToScreenDir(spr.direction), true); } });
    }
  } else if (d.type === "c_act") {
    combatAct(scene, d);
  } else if (d.type === "c_log") {
    combatAddLog(d.lines);
  } else if (d.type === "c_notice") {
    combatAddLog("! " + d.text);
    updateReadout(d.text);
    state = "input";
  } else if (d.type === "c_end") {
    combatEnd(scene, d);
  }
  return true;
}

function combatInitUi() {
  combatEl("cbRest").addEventListener("click", () => {
    if (!COMBAT.myTurn) return;
    gmSend({ type: "c_rest" });
    COMBAT.myTurn = false;
    combatSetMenu(false);
  });
  combatEl("cbWait").addEventListener("click", () => {
    if (!COMBAT.myTurn) return;
    gmSend({ type: "c_end" });
    COMBAT.myTurn = false;
    combatSetMenu(false);
  });
  combatEl("cbFlee").addEventListener("click", () => {
    if (!COMBAT.active) return;
    gmSend({ type: "c_flee" });
  });
  window.addEventListener("keydown", (e) => {
    if (!COMBAT.active || !COMBAT.myTurn || chatActive) return;
    if (e.key >= "1" && e.key <= "4") combatSelectMove(parseInt(e.key, 10) - 1);
    else if (e.key === "Escape") {
      combatEl("cbTargets").classList.add("hidden");
      COMBAT.pending = -1;
      combatClearRange();
    }
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", combatInitUi);
else combatInitUi();


let itemFx = {};
let lootState = null;

function lootClose() {
  lootState = null;
  const el = document.getElementById("lootPanel");
  if (el) el.classList.add("hidden");
}

function lootRender() {
  const el = document.getElementById("lootPanel");
  if (!el || !lootState) return;
  el.innerHTML = "";
  const title = document.createElement("div");
  title.className = "imtitle";
  title.textContent = lootState.name + " dropped:";
  el.appendChild(title);
  for (const stack of lootState.items) {
    const row = document.createElement("button");
    row.className = "imbtn use";
    row.textContent = "Take " + stack.name + (stack.count > 1 ? " x" + stack.count : "");
    row.addEventListener("click", () => gmSend({ type: "loot_take", id: lootState.id, name: stack.name }));
    el.appendChild(row);
  }
  const all = document.createElement("button");
  all.className = "imbtn ally";
  all.textContent = "Take all";
  all.addEventListener("click", () => gmSend({ type: "loot_take", id: lootState.id, all: true }));
  el.appendChild(all);
  const close = document.createElement("button");
  close.className = "imbtn cancel";
  close.textContent = "Close";
  close.addEventListener("click", lootClose);
  el.appendChild(close);
  el.classList.remove("hidden");
}
const ITEM_RANGE = 3;

function itemEl() {
  return document.getElementById("itemMenu");
}

function itemToast(text) {
  let el = document.getElementById("itemToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "itemToast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add("show");
  if (el._timer) clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), 4200);
}

function itemMenuClose() {
  const el = itemEl();
  if (el) el.classList.add("hidden");
}

function itemMenuOpenNow() {
  const el = itemEl();
  return !!el && !el.classList.contains("hidden");
}

function itemSpriteCell(spr) {
  return { col: Math.floor(spr.x / TILE), row: Math.floor(spr.y / TILE) };
}

function itemCandidates(fx) {
  const mine = { col: player.col, row: player.row };
  const list = [];
  if (COMBAT.active) {
    for (const id in COMBAT.actors) {
      const a = COMBAT.actors[id];
      if (a.dead || String(a.id) === String(myId)) continue;
      const isFoe = combatIsFoe(a);
      if (fx.rule === "enemy" && !isFoe) continue;
      if ((fx.rule === "ally" || fx.rule === "self") && isFoe) continue;
      const spr = combatSprite(a.id);
      const pos = spr && spr !== "loading" ? itemSpriteCell(spr) : { col: a.col, row: a.row };
      list.push({ id: a.id, name: a.name, dist: combatDistance(pos, mine), foe: isFoe });
    }
  } else {
    for (const id in otherPlayers) {
      const spr = otherPlayers[id];
      if (!spr || spr === "loading") continue;
      const meta = worldEntityMeta[id];
      if (meta && meta.kind !== "companion") continue;
      const name = meta ? meta.name : "Player " + id;
      list.push({ id: id, name: name, dist: combatDistance(itemSpriteCell(spr), mine), foe: false });
    }
  }
  return list.filter((c) => c.dist <= ITEM_RANGE).sort((a, b) => a.dist - b.dist);
}

function itemConeCells(col, row, dir) {
  const vec = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir] || [0, 1];
  const pc = Math.abs(vec[1]);
  const pr = Math.abs(vec[0]);
  const cells = {};
  for (let d = 1; d <= 3; d++) {
    for (let l = -(d - 1); l <= d - 1; l++) cells[(col + vec[0] * d + pc * l) + "," + (row + vec[1] * d + pr * l)] = true;
  }
  return cells;
}

function itemConeOptions() {
  const mine = { col: player.col, row: player.row };
  const foes = [];
  if (COMBAT.active) {
    for (const id in COMBAT.actors) {
      const a = COMBAT.actors[id];
      if (a.dead || !combatIsFoe(a)) continue;
      const spr = combatSprite(a.id);
      const pos = spr && spr !== "loading" ? itemSpriteCell(spr) : { col: a.col, row: a.row };
      foes.push({ name: a.name, pos: pos, dist: combatDistance(pos, mine) });
    }
  }
  const options = [];
  for (const f of foes) {
    if (f.dist > 3) continue;
    const dc = f.pos.col - mine.col;
    const dr = f.pos.row - mine.row;
    const dir = Math.abs(dc) >= Math.abs(dr) ? (dc > 0 ? "right" : "left") : (dr > 0 ? "down" : "up");
    const cells = itemConeCells(mine.col, mine.row, dir);
    let caught = 0;
    for (const g of foes) {
      if (cells[g.pos.col + "," + g.pos.row]) caught++;
    }
    options.push({ label: "Use: cone toward " + f.name + " (" + caught + " foe" + (caught === 1 ? "" : "s") + " in the cone)", dir: dir });
  }
  return options;
}

function itemSend(name, mode, target, dir) {
  if (COMBAT.active) {
    gmSend({ type: "c_item", name: name, mode: mode, target: target, dir: dir || null });
    COMBAT.myTurn = false;
    combatSetMenu(false);
    combatRenderBanner();
  } else {
    gmSend({ type: "item_use", name: name, mode: mode, target: target });
  }
  itemMenuClose();
}

function stickStructureLabel(name) {
  return String(name).replace(/^Lit[_ ]/i, "").replace(/[_ ]?\d+$/, "").replace(/_/g, " ");
}

function stickMenuTry(name) {
  const cfg = VIS.cfg && VIS.cfg.torchStick ? VIS.cfg.torchStick : null;
  if (!cfg || String(name).toLowerCase() !== String(cfg.item).toLowerCase()) return false;
  if (COMBAT.active) {
    itemToast("You can't light a " + cfg.item + " during battle.");
    return true;
  }
  const sheet = typeof invSheet === "object" && invSheet ? invSheet : null;
  const infos = sheet && Array.isArray(sheet.moveInfo) ? sheet.moveInfo : [];
  const el = itemEl();
  el.innerHTML = "";
  const title = document.createElement("div");
  title.className = "imtitle";
  title.textContent = name;
  el.appendChild(title);
  let count = 0;
  const addButton = (label, cls, fn) => {
    const b = document.createElement("button");
    b.className = "imbtn " + cls;
    b.textContent = label;
    b.addEventListener("click", fn);
    el.appendChild(b);
  };
  const send = (payload) => {
    gmSend(Object.assign({ type: "light_stick" }, payload));
    itemMenuClose();
  };
  for (const m of infos) {
    if (String(m.type).toLowerCase() !== "fire" || String(m.category).toLowerCase() === "status") continue;
    count++;
    addButton("Light " + name + " with " + m.name, "use", () => send({ via: "move", name: m.name }));
  }
  const igniters = Array.isArray(VIS.cfg.igniterItems) ? VIS.cfg.igniterItems : [];
  for (const igniter of igniters) {
    if (String(igniter).toLowerCase() === String(cfg.item).toLowerCase()) continue;
    for (const stack of inventoryItems) {
      if (stack && String(stack.name).toLowerCase() === String(igniter).toLowerCase()) {
        count++;
        addButton("Light " + name + " with " + stack.name, "use", () => send({ via: "item", name: stack.name }));
        break;
      }
    }
  }
  const range = Number(cfg.range) || 2;
  const structures = Array.isArray(cfg.structures) ? cfg.structures : [];
  const seen = {};
  for (const o of (worldLastView && worldLastView.objects) || []) {
    if (Math.max(Math.abs(player.col - o.col), Math.abs(player.row - o.row)) > range) continue;
    let matched = false;
    for (const part of structures) {
      if (new RegExp("(^|[^A-Za-z])" + visEscape(part), "i").test(String(o.name))) matched = true;
    }
    if (!matched) continue;
    const label = stickStructureLabel(o.name);
    count++;
    seen[label] = true;
    addButton("Light " + name + " with " + label, "use", () => send({ via: "structure", col: o.col, row: o.row }));
  }
  if (count === 0) {
    const none = document.createElement("div");
    none.className = "imnone";
    none.textContent = "You need a Fire-type move, Flint and Steel, or a nearby fire to light this.";
    el.appendChild(none);
  }
  addButton("Cancel", "cancel", itemMenuClose);
  el.classList.remove("hidden");
  return true;
}

function itemMenuTry() {
  if (!worldPlayerMode) return false;
  if (itemMenuOpenNow()) {
    itemMenuClose();
    return true;
  }
  if (!inventoryOpen || selectedSlot < 0 || !inventoryItems[selectedSlot]) return false;
  const name = inventoryItems[selectedSlot].name;
  if (stickMenuTry(name)) return true;
  const fx = itemFx[name];
  if (!fx) {
    itemToast(name + " has no use right now.");
    return true;
  }
  if (fx.bad) {
    itemToast(fx.bad);
    return true;
  }
  if (COMBAT.active && !COMBAT.myTurn) {
    itemToast("Wait for your turn to use items.");
    return true;
  }
  if (!COMBAT.active && !fx.x) {
    itemToast(name + " can only be used in battle.");
    return true;
  }
  const el = itemEl();
  el.innerHTML = "";
  const title = document.createElement("div");
  title.className = "imtitle";
  title.textContent = name + (fx.r ? " (relic: not used up)" : "");
  el.appendChild(title);
  const addButton = (label, cls, fn) => {
    const b = document.createElement("button");
    b.className = "imbtn " + cls;
    b.textContent = label;
    b.addEventListener("click", fn);
    el.appendChild(b);
  };
  if (fx.u && fx.k) {
    const opts = itemConeOptions();
    for (const o of opts) addButton(o.label, "use", () => itemSend(name, "use", null, o.dir));
    if (opts.length === 0) addButton("Use: unleash a cone in front of you", "use", () => itemSend(name, "use", null, null));
  } else if (fx.u) {
    addButton("Use on yourself", "use", () => itemSend(name, "use", null, null));
  }
  if (fx.t) {
    const cands = itemCandidates(fx);
    if (cands.length === 0) {
      const none = document.createElement("div");
      none.className = "imnone";
      none.textContent = "Nobody within " + ITEM_RANGE + " tiles to throw it at.";
      el.appendChild(none);
    }
    for (const c of cands) {
      addButton("Throw at " + c.name + " (" + c.dist + " tile" + (c.dist === 1 ? "" : "s") + ")", c.foe ? "foe" : "ally", () => itemSend(name, "throw", c.id));
    }
  }
  addButton("Cancel", "cancel", itemMenuClose);
  el.classList.remove("hidden");
  return true;
}

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && itemMenuOpenNow()) itemMenuClose();
  if (ev.key === "Escape" && lootState) lootClose();
});

const worldPlayerNames = {};
let atkTarget = null;
let atkMenuEl = null;
let atkRingGfx = null;

function atkInject() {
  if (atkMenuEl) return;
  const style = document.createElement("style");
  style.textContent = "#atkMenu{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);width:340px;max-width:94vw;background:rgba(20,20,34,0.96);border:2px solid #c0392b;border-radius:10px;padding:10px;color:#fff;font-size:13px;z-index:40}"
    + "#atkMenu.hidden{display:none}"
    + "#atkMenu .atkTitle{font-weight:bold;color:#ff9a8a;margin-bottom:6px}"
    + "#atkMenu button{display:block;width:100%;text-align:left;background:#2d2d44;color:#fff;border:1px solid #55557a;border-radius:6px;padding:6px 8px;margin:3px 0;cursor:pointer;font-size:12px}"
    + "#atkMenu button:disabled{opacity:0.45;cursor:not-allowed}"
    + "#atkMenu button.atkCancel{text-align:center;border-color:#888}";
  document.head.appendChild(style);
  atkMenuEl = document.createElement("div");
  atkMenuEl.id = "atkMenu";
  atkMenuEl.className = "hidden";
  document.body.appendChild(atkMenuEl);
}

function atkClose() {
  atkTarget = null;
  if (atkMenuEl) atkMenuEl.classList.add("hidden");
  if (atkRingGfx) atkRingGfx.clear();
}

function atkFindTarget(c, r) {
  for (const id in otherPlayers) {
    const spr = otherPlayers[id];
    if (!spr || spr === "loading") continue;
    const pos = itemSpriteCell(spr);
    if (pos.col !== c || pos.row !== r) continue;
    const meta = worldEntityMeta[id];
    if (meta) {
      if (meta.kind !== "npc" || meta.fainted) continue;
      return { id: id, type: "entity", name: meta.name, col: c, row: r };
    }
    return { id: id, type: "player", name: worldPlayerNames[id] || "Player", col: c, row: r };
  }
  return null;
}

function atkOpen(target) {
  atkInject();
  atkTarget = target;
  const sheet = typeof invSheet === "object" && invSheet ? invSheet : null;
  const infos = sheet && Array.isArray(sheet.moveInfo) ? sheet.moveInfo : [];
  const dist = Math.max(Math.abs(player.col - target.col), Math.abs(player.row - target.row));
  atkMenuEl.innerHTML = "";
  const title = document.createElement("div");
  title.className = "atkTitle";
  title.textContent = (target.type === "player" ? "Challenge " : "Attack ") + target.name + " (" + dist + " tile" + (dist === 1 ? "" : "s") + " away). Pick a move:";
  atkMenuEl.appendChild(title);
  if (infos.length === 0) {
    const none = document.createElement("div");
    none.textContent = "You have no moves to use.";
    atkMenuEl.appendChild(none);
  }
  for (let i = 0; i < infos.length; i++) {
    const m = infos[i];
    const btn = document.createElement("button");
    let note = "";
    let blocked = false;
    if (m.unsupported) { note = " | not usable here"; blocked = true; }
    else if (m.target === "self" || m.target === "all-allies" || m.target === "ally") { note = " | not an attack"; blocked = true; }
    else if (typeof player.mp === "number" && player.mp < m.mpCost) { note = " | not enough MP"; blocked = true; }
    else if (dist > m.range) { note = " | too far"; blocked = true; }
    btn.textContent = (i + 1) + ". " + m.name + " | " + m.type + " " + m.category + (m.power > 0 ? " P" + m.power : "") + " | MP " + m.mpCost + " | R" + m.range + note;
    btn.disabled = blocked;
    btn.addEventListener("click", () => {
      gmSend({ type: "attack_start", targetType: target.type, id: target.id, move: i });
      atkClose();
    });
    atkMenuEl.appendChild(btn);
  }
  const cancel = document.createElement("button");
  cancel.className = "atkCancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", atkClose);
  atkMenuEl.appendChild(cancel);
  atkMenuEl.classList.remove("hidden");
  if (sceneRef) {
    if (!atkRingGfx) {
      atkRingGfx = sceneRef.add.graphics();
      atkRingGfx.setDepth(150);
    }
    atkRingGfx.clear();
    atkRingGfx.lineStyle(3, 0xff5050, 1);
    atkRingGfx.strokeRect(target.col * TILE + 2, target.row * TILE + 2, TILE - 4, TILE - 4);
  }
}

function atkPointer(scene, pointer) {
  if (!worldPlayerMode || worldGmMode) return;
  if (!pointer.leftButtonDown()) return;
  if (COMBAT.active || chatActive) return;
  if (typeof itemMenuOpenNow === "function" && itemMenuOpenNow()) return;
  if (lootState) return;
  const wp = scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
  const clickCol = Math.floor(wp.x / TILE);
  const clickRow = Math.floor(wp.y / TILE);
  const target = atkFindTarget(clickCol, clickRow);
  if (!target) {
    const lightable = atkFindLightable(clickCol, clickRow);
    if (lightable) {
      atkOpenLight(lightable);
      return;
    }
    atkClose();
    return;
  }
  atkOpen(target);
}

function atkFindLightable(c, r) {
  if (!worldLastView || !VIS.cfg || !Array.isArray(VIS.cfg.lightable)) return null;
  for (const o of worldLastView.objects || []) {
    if (o.col !== c || o.row !== r) continue;
    for (const pair of VIS.cfg.lightable) {
      if (String(o.name).toLowerCase().indexOf(String(pair.unlit).toLowerCase()) !== -1) return { col: c, row: r, label: pair.label || "fire" };
    }
  }
  return null;
}

function atkOpenLight(target) {
  atkInject();
  atkTarget = null;
  const sheet = typeof invSheet === "object" && invSheet ? invSheet : null;
  const infos = sheet && Array.isArray(sheet.moveInfo) ? sheet.moveInfo : [];
  const types = sheet && Array.isArray(sheet.types) ? sheet.types : [];
  const dist = Math.max(Math.abs(player.col - target.col), Math.abs(player.row - target.row));
  const tooFar = dist > 2;
  atkMenuEl.innerHTML = "";
  const title = document.createElement("div");
  title.className = "atkTitle";
  title.textContent = "Unlit " + target.label + (tooFar ? " (too far, move closer)" : "");
  atkMenuEl.appendChild(title);
  let options = 0;
  let fireTyped = false;
  for (const t of types) {
    if (String(t).toLowerCase() === "fire") fireTyped = true;
  }
  const needsFireType = false;
  let blockedByType = false;
  if (!needsFireType || fireTyped) {
    for (const m of infos) {
      if (String(m.type).toLowerCase() !== "fire" || String(m.category).toLowerCase() === "status") continue;
      options++;
      const btn = document.createElement("button");
      btn.textContent = "Light " + target.label + " with " + m.name;
      btn.disabled = tooFar;
      btn.addEventListener("click", () => {
        gmSend({ type: "light_move", col: target.col, row: target.row, move: m.name });
        atkClose();
      });
      atkMenuEl.appendChild(btn);
    }
  }
  const igniters = VIS.cfg && Array.isArray(VIS.cfg.igniterItems) ? VIS.cfg.igniterItems : [];
  for (const igniter of igniters) {
    let has = false;
    for (const stack of inventoryItems) {
      if (String(stack.name).toLowerCase() === String(igniter).toLowerCase()) has = true;
    }
    if (!has) continue;
    options++;
    const btn = document.createElement("button");
    btn.textContent = "Light " + target.label + " with " + igniter;
    btn.disabled = tooFar;
    btn.addEventListener("click", () => {
      gmSend({ type: "light_move", col: target.col, row: target.row, move: "" });
      atkClose();
    });
    atkMenuEl.appendChild(btn);
  }
  if (needsFireType && !fireTyped) {
    for (const m of infos) {
      if (String(m.type).toLowerCase() === "fire" && String(m.category).toLowerCase() !== "status") blockedByType = true;
    }
  }
  if (options === 0) {
    const none = document.createElement("div");
    none.textContent = blockedByType ? "Only Fire-type Pokemon can light this with a move." : "You need a Fire-type move or a lit torch to light this.";
    atkMenuEl.appendChild(none);
  }
  const cancel = document.createElement("button");
  cancel.className = "atkCancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", atkClose);
  atkMenuEl.appendChild(cancel);
  atkMenuEl.classList.remove("hidden");
  if (sceneRef) {
    if (!atkRingGfx) {
      atkRingGfx = sceneRef.add.graphics();
      atkRingGfx.setDepth(150);
    }
    atkRingGfx.clear();
    atkRingGfx.lineStyle(3, 0xffa040, 1);
    atkRingGfx.strokeRect(target.col * TILE + 2, target.row * TILE + 2, TILE - 4, TILE - 4);
  }
}

const WGD = { drag: null, ghost: null, inspect: null, inspEl: null, creativeEl: null, searchEl: null, gridEl: null };

function wgIconUrl(name) {
  const path = typeof itemIndex === "object" && itemIndex ? itemIndex[name] : null;
  return path ? encodeURI(path) : null;
}

function wgMakeIcon(name) {
  const box = document.createElement("div");
  box.className = "wgIcon";
  const url = wgIconUrl(name);
  if (url) {
    const img = document.createElement("img");
    img.src = url;
    img.draggable = false;
    box.appendChild(img);
  } else {
    box.textContent = String(name).charAt(0).toUpperCase();
  }
  return box;
}

function gmBuildCreative() {
  if (WGD.creativeEl) return;
  const style = document.createElement("style");
  style.textContent = "#wgCreative{position:fixed;left:8px;bottom:8px;width:340px;height:230px;background:rgba(20,20,34,0.95);border:1px solid #3a3a55;border-radius:8px;padding:8px;color:#fff;font-size:12px;z-index:25;display:flex;flex-direction:column;user-select:none}"
    + "#wgCreative.wgDel{border-color:#ff5050;box-shadow:0 0 12px #ff5050}"
    + "#wgCreative .wgCrHead{font-weight:bold;color:#ffd23f;margin-bottom:4px;padding:2px 0;user-select:none}"
    + "#wgCreative input{background:#2d2d44;color:#fff;border:1px solid #55557a;border-radius:5px;padding:4px;width:96%;margin-bottom:4px;user-select:text}"
    + "#wgCreGrid{flex:1;overflow-y:auto;display:flex;flex-wrap:wrap;align-content:flex-start}"
    + ".wgCreItem{width:52px;margin:2px;padding:3px 1px;background:#2d2d44;border:1px solid #55557a;border-radius:5px;text-align:center;cursor:grab;font-size:9px;overflow:hidden}"
    + ".wgCreItem:hover{border-color:#fff}"
    + ".wgCreItem span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
    + ".wgIcon{width:32px;height:32px;margin:0 auto 2px auto;display:flex;align-items:center;justify-content:center;background:#1a1a2a;border-radius:4px;font-weight:bold}"
    + ".wgIcon img{max-width:32px;max-height:32px;image-rendering:pixelated;pointer-events:none}"
    + "#wgGhost{position:fixed;z-index:80;pointer-events:none;opacity:0.85;width:44px;text-align:center;font-size:9px;color:#fff;text-shadow:0 0 3px #000}"
    + "#wgInspector{position:fixed;left:356px;bottom:8px;width:300px;max-height:60vh;overflow-y:auto;background:rgba(20,20,34,0.95);border:1px solid #3a3a55;border-radius:8px;padding:8px;color:#fff;font-size:12px;z-index:25;user-select:none}"
    + "#wgInspector.hidden{display:none}"
    + "#wgInspector .wgInHead{cursor:move;display:flex;justify-content:space-between;font-weight:bold;color:#ffd23f;margin-bottom:6px}"
    + "#wgInspector h5{margin:8px 0 4px 0;color:#c8c8ff;font-size:12px}"
    + ".wgSlots{display:flex;gap:6px}"
    + ".wgSlot{flex:1;min-height:58px;background:#1a1a2a;border:1px dashed #55557a;border-radius:6px;padding:3px;text-align:center;font-size:10px}"
    + ".wgSlot.wgOver,.wgInvBox.wgOver{border-color:#4a6cff;background:#232344}"
    + ".wgInvBox{min-height:64px;background:#1a1a2a;border:1px dashed #55557a;border-radius:6px;padding:3px;display:flex;flex-wrap:wrap;align-content:flex-start}"
    + ".wgStack{position:relative;width:54px;margin:2px;padding:3px 1px;background:#2d2d44;border:1px solid #55557a;border-radius:5px;text-align:center;cursor:grab;font-size:9px}"
    + ".wgStack span.n{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
    + ".wgStack .cnt{position:absolute;right:2px;top:1px;background:#000;border-radius:6px;padding:0 4px;font-size:9px}"
    + ".wgStack .pm{display:flex;justify-content:center;gap:4px;margin-top:2px}"
    + ".wgStack .pm b{cursor:pointer;background:#444466;border-radius:3px;padding:0 5px}";
  document.head.appendChild(style);

  const box = document.createElement("div");
  box.id = "wgCreative";
  box.innerHTML = "<div class='wgCrHead'>Creative items | drag out to place or give, drag anything back here to delete</div><input type='text' id='wgCreSearch' placeholder='Search items'><div id='wgCrePager'></div><div id='wgCreGrid'></div>";
  document.body.appendChild(box);
  const coords = document.createElement("div");
  coords.id = "wgCoords";
  coords.style.cssText = "position:fixed;left:8px;bottom:246px;background:rgba(20,20,34,0.95);border:1px solid #3a3a55;border-radius:8px;padding:4px 10px;color:#ffd23f;font-size:13px;font-family:monospace;z-index:25;pointer-events:none";
  coords.textContent = "X: -   Y: -";
  document.body.appendChild(coords);
  WGD.creativeEl = box;
  gmMakeDraggable(box, box.querySelector(".wgCrHead"), "pmdCreativePos", gmPlaceCoords);
  gmPlaceCoords();
  window.addEventListener("resize", gmPlaceCoords);
  WGD.searchEl = box.querySelector("#wgCreSearch");
  WGD.gridEl = box.querySelector("#wgCreGrid");
  WGD.searchEl.addEventListener("focus", () => { chatActive = true; });
  WGD.searchEl.addEventListener("blur", () => { chatActive = false; });
  WGD.searchEl.addEventListener("input", gmCreativeFill);

  const insp = document.createElement("div");
  insp.id = "wgInspector";
  insp.className = "hidden";
  document.body.appendChild(insp);
  WGD.inspEl = insp;
  gmMakeDraggable(insp, insp, "pmdInspectorPos", null, (target) => !!(target && target.closest && target.closest(".wgInHead")));

  fetch("items-index.json").then((r) => r.json()).then((data) => {
    itemIndex = data;
    gmCreativeFill();
    if (WGD.inspect && WGD.lastInspect) gmRenderInspector(WGD.lastInspect);
  }).catch(() => {});
  gmCreativeFill();
}

let wgCrePage = 0;
let wgCrePagerBuilt = "";

function gmItemFolder(path) {
  const text = String(path || "").replace(/^\/?items\//i, "");
  const cut = text.lastIndexOf("/");
  return cut > 0 ? text.substring(0, cut).split("/").join(" > ") : "Other";
}

function gmCreativeFill() {
  if (!WGD.gridEl) return;
  const query = WGD.searchEl.value.trim().toLowerCase();
  const names = typeof itemIndex === "object" && itemIndex ? Object.keys(itemIndex).sort() : [];
  WGD.gridEl.innerHTML = "";
  const pagerBox = document.getElementById("wgCrePager");
  if (names.length === 0) {
    WGD.gridEl.textContent = "Loading items...";
    return;
  }
  const folders = {};
  for (const name of names) {
    const folder = gmItemFolder(itemIndex[name]);
    if (!folders[folder]) folders[folder] = [];
    folders[folder].push(name);
  }
  const titles = Object.keys(folders).sort();
  if (wgCrePage >= titles.length) wgCrePage = 0;
  const key = titles.join("|");
  if (pagerBox && wgCrePagerBuilt !== key) {
    wgCrePagerBuilt = key;
    pagerBox.innerHTML = "";
    const pager = gmMakePager(titles, () => wgCrePage, (i) => {
      wgCrePage = i;
      gmCreativeFill();
    });
    WGD.pager = pager;
    pagerBox.appendChild(pager.bar);
  }
  if (pagerBox) pagerBox.style.display = query ? "none" : "block";
  if (WGD.pager) WGD.pager.refresh();
  const pool = query ? names : (folders[titles[wgCrePage]] || []);
  let shown = 0;
  for (const name of pool) {
    if (query && name.toLowerCase().indexOf(query) === -1) continue;
    const cell = document.createElement("div");
    cell.className = "wgCreItem";
    cell.title = name;
    cell.appendChild(wgMakeIcon(name));
    const label = document.createElement("span");
    label.textContent = name;
    cell.appendChild(label);
    cell.addEventListener("mousedown", (ev) => gmDragStart(ev, { src: "new", name: name, count: 1 }));
    WGD.gridEl.appendChild(cell);
    shown++;
  }
  WGD.gridEl.scrollTop = 0;
  if (shown === 0) WGD.gridEl.textContent = "No items match that search.";
}

function gmDragStart(ev, info) {
  if (ev.button !== 0) return;
  if (ev.preventDefault) ev.preventDefault();
  gmDragCancel();
  WGD.drag = info;
  const ghost = document.createElement("div");
  ghost.id = "wgGhost";
  ghost.appendChild(wgMakeIcon(info.name));
  const label = document.createElement("div");
  label.textContent = info.name;
  ghost.appendChild(label);
  document.body.appendChild(ghost);
  WGD.ghost = ghost;
  gmDragPlaceGhost(ev);
  if (WGD.creativeEl) WGD.creativeEl.classList.toggle("wgDel", info.src !== "new");
  window.addEventListener("mousemove", gmDragMove);
  window.addEventListener("mouseup", gmDragEnd);
}

function gmDragPlaceGhost(ev) {
  if (!WGD.ghost) return;
  WGD.ghost.style.left = (ev.clientX - 22) + "px";
  WGD.ghost.style.top = (ev.clientY - 22) + "px";
}

function gmDragMove(ev) {
  gmDragPlaceGhost(ev);
  document.querySelectorAll(".wgOver").forEach((el) => el.classList.remove("wgOver"));
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const zone = el && el.closest ? el.closest("[data-wgdrop]") : null;
  if (zone) zone.classList.add("wgOver");
}

function gmDragCancel() {
  window.removeEventListener("mousemove", gmDragMove);
  window.removeEventListener("mouseup", gmDragEnd);
  if (WGD.ghost) {
    WGD.ghost.remove();
    WGD.ghost = null;
  }
  WGD.drag = null;
  document.querySelectorAll(".wgOver").forEach((el) => el.classList.remove("wgOver"));
  if (WGD.creativeEl) WGD.creativeEl.classList.remove("wgDel");
}

function gmDragEnd(ev) {
  const info = WGD.drag;
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  gmDragCancel();
  if (!info || !el) return;
  if (el.closest("#wgCreative")) {
    gmDeleteSource(info);
    return;
  }
  const zone = el.closest("[data-wgdrop]");
  if (zone) {
    gmDropZone(info, zone.getAttribute("data-wgdrop"));
    return;
  }
  if (el.tagName === "CANVAS") gmDropWorld(info, ev);
}

function gmSameTarget(a, b) {
  return !!a && !!b && a.type === b.type && String(a.id) === String(b.id);
}

function gmTakeFromSource(info, wholeStack) {
  if (info.src === "floor") {
    gmSend({ type: "gm_item", layer: WG.layer, col: info.col, row: info.row, name: "" });
  } else if (info.src === "inv") {
    gmSend({ type: "gm_inv", target: info.target, op: "remove", name: info.name, count: wholeStack ? info.count : 1 });
  } else if (info.src === "slot") {
    gmSend({ type: "gm_inv", target: info.target, op: "unequip", slot: info.slot });
  }
}

function gmDeleteSource(info) {
  if (info.src === "new") return;
  gmTakeFromSource(info, true);
}

function gmGiveTo(info, target, mode, slot) {
  if (mode === "inv" && info.src === "inv" && gmSameTarget(info.target, target)) return;
  if (mode === "slot" && info.src === "slot" && gmSameTarget(info.target, target) && info.slot === slot) return;
  gmTakeFromSource(info, false);
  if (mode === "slot") gmSend({ type: "gm_inv", target: target, op: "equip", name: info.name, slot: slot });
  else gmSend({ type: "gm_inv", target: target, op: "add", name: info.name, count: 1 });
}

function gmDropZone(info, zone) {
  const target = WGD.inspect;
  if (!target) return;
  if (zone === "inv") gmGiveTo(info, target, "inv", null);
  else if (zone.indexOf("slot:") === 0) gmGiveTo(info, target, "slot", zone.substring(5));
}

function gmDropWorld(info, ev) {
  if (!sceneRef) return;
  const canvas = sceneRef.game.canvas;
  const rect = canvas.getBoundingClientRect();
  const gx = (ev.clientX - rect.left) * (sceneRef.scale.width / rect.width);
  const gy = (ev.clientY - rect.top) * (sceneRef.scale.height / rect.height);
  const wp = sceneRef.cameras.main.getWorldPoint(gx, gy);
  const c = Math.floor(wp.x / TILE);
  const r = Math.floor(wp.y / TILE);
  if (!gmInBounds(c, r)) return;
  let target = null;
  for (const eid in WG.entities) {
    const he = WG.entities[eid];
    if (he.col === c && he.row === r && (he.kind === "npc" || he.kind === "enemy")) target = { type: "entity", id: he.id };
  }
  for (const pid in WG.players) {
    const hp = WG.players[pid];
    if (hp.layer === WG.layer && hp.col === c && hp.row === r) target = { type: "player", id: hp.id };
  }
  if (target) {
    gmGiveTo(info, target, "inv", null);
    return;
  }
  if (info.src === "floor" && info.col === c && info.row === r) return;
  gmTakeFromSource(info, false);
  gmSend({ type: "gm_item", layer: WG.layer, col: c, row: r, name: info.name });
}

function gmTryFloorDrag(pointer, cell) {
  if (WG.tool !== "item" && WG.tool !== "select") return false;
  if (WG.tool === "select") {
    for (const eid in WG.entities) {
      if (WG.entities[eid].col === cell.c && WG.entities[eid].row === cell.r) return false;
    }
    for (const pid in WG.players) {
      const hp = WG.players[pid];
      if (hp.layer === WG.layer && hp.col === cell.c && hp.row === cell.r) return false;
    }
  }
  for (const it of floorItems) {
    if (it.col === cell.c && it.row === cell.r) {
      gmDragStart(pointer.event, { src: "floor", name: it.name, col: it.col, row: it.row, count: 1 });
      return true;
    }
  }
  return false;
}

function gmInspect(target) {
  WGD.inspect = target;
  WGD.lastInspect = null;
  if (WGD.inspEl) {
    WGD.inspEl.classList.remove("hidden");
    WGD.inspEl.textContent = "Loading...";
  }
  gmSend({ type: "gm_inspect", target: target });
}

function gmInspectClose() {
  WGD.inspect = null;
  WGD.lastInspect = null;
  if (WGD.inspEl) WGD.inspEl.classList.add("hidden");
}

function gmSyncFormFromInspect(data) {
  if (data.target.type !== "entity" || WG.selectedEntity !== data.target.id) return;
  document.getElementById("wgEItems").value = gmFormatLoot(data.inv);
  document.getElementById("wgEAccHead").value = data.accessories.head || "";
  document.getElementById("wgEAccNeck").value = data.accessories.neck || "";
  document.getElementById("wgEAccBack").value = data.accessories.back || "";
}

function gmRenderPlayerStats(el, data) {
  const st = data.stats;
  const box = document.createElement("div");
  box.style.cssText = "border:1px solid #3a3a55;border-radius:6px;padding:6px;margin-bottom:6px;background:#1a1a2a";
  const top = document.createElement("div");
  top.style.cssText = "display:flex;gap:8px;align-items:center";
  const icon = document.createElement("div");
  icon.style.cssText = "width:56px;height:56px;flex:none;background:#101018;border:1px solid #55557a;border-radius:4px;display:flex;align-items:center;justify-content:center;overflow:hidden";
  const img = document.createElement("img");
  img.style.cssText = "width:100%;height:100%;object-fit:contain;image-rendering:pixelated";
  img.src = "https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master/portrait/" + (st.dex || "0004") + "/Normal.png";
  img.addEventListener("error", () => {
    img.remove();
    icon.textContent = String(st.species || "?").charAt(0).toUpperCase();
  });
  icon.appendChild(img);
  const info = document.createElement("div");
  info.style.cssText = "flex:1;line-height:1.5";
  const line1 = document.createElement("div");
  line1.style.cssText = "font-weight:bold;color:#ffd23f";
  line1.textContent = (st.species || "Unknown") + (st.types && st.types.length ? " (" + st.types.join("/") + ")" : "");
  const line2 = document.createElement("div");
  line2.textContent = "Level " + st.level;
  const line3 = document.createElement("div");
  line3.textContent = "EXP " + st.exp + (st.expGained > 0 ? " (+" + st.expGained + " this session)" : "");
  info.appendChild(line1);
  info.appendChild(line2);
  info.appendChild(line3);
  top.appendChild(icon);
  top.appendChild(info);
  box.appendChild(top);
  const makeRow = (label, curVal, maxVal, idPrefix) => {
    const row = document.createElement("div");
    row.style.cssText = "margin-top:6px;display:flex;align-items:center;gap:4px";
    const lab = document.createElement("span");
    lab.style.cssText = "width:26px;color:#c8c8ff";
    lab.textContent = label;
    const cur = document.createElement("input");
    cur.type = "number";
    cur.value = curVal;
    cur.style.cssText = "width:62px;background:#2d2d44;color:#fff;border:1px solid #55557a;border-radius:5px;padding:3px";
    const slash = document.createElement("span");
    slash.textContent = "/";
    const max = document.createElement("input");
    max.type = "number";
    max.value = maxVal;
    max.style.cssText = "width:62px;background:#2d2d44;color:#fff;border:1px solid #55557a;border-radius:5px;padding:3px";
    row.appendChild(lab);
    row.appendChild(cur);
    row.appendChild(slash);
    row.appendChild(max);
    box.appendChild(row);
    return { cur: cur, max: max };
  };
  const hp = makeRow("HP", st.hp, st.maxHp);
  const mp = makeRow("MP", st.mp, st.maxMp);
  for (const input of [hp.cur, hp.max, mp.cur, mp.max]) {
    input.addEventListener("focus", () => { chatActive = true; });
    input.addEventListener("blur", () => { chatActive = false; });
  }
  const actions = document.createElement("div");
  actions.style.cssText = "margin-top:6px;display:flex;gap:6px";
  const set = document.createElement("button");
  set.className = "wgBtn";
  set.textContent = "Set HP and MP";
  set.addEventListener("click", () => {
    gmSend({ type: "gm_vitals", target: data.target, hp: hp.cur.value, maxHp: hp.max.value, mp: mp.cur.value, maxMp: mp.max.value });
  });
  const full = document.createElement("button");
  full.className = "wgBtn";
  full.textContent = "Full heal";
  full.addEventListener("click", () => {
    gmSend({ type: "gm_vitals", target: data.target, hp: hp.max.value, maxHp: hp.max.value, mp: mp.max.value, maxMp: mp.max.value });
  });
  const refresh = document.createElement("button");
  refresh.className = "wgBtn";
  refresh.textContent = "Refresh";
  refresh.addEventListener("click", () => gmSend({ type: "gm_inspect", target: data.target }));
  actions.appendChild(set);
  actions.appendChild(full);
  actions.appendChild(refresh);
  box.appendChild(actions);
  const movesTitle = document.createElement("div");
  movesTitle.style.cssText = "margin-top:8px;color:#c8c8ff;font-weight:bold";
  movesTitle.textContent = "Moves";
  box.appendChild(movesTitle);
  if (!st.moves || st.moves.length === 0) {
    const none = document.createElement("div");
    none.style.cssText = "color:#99a";
    none.textContent = "No moves";
    box.appendChild(none);
  }
  for (const m of st.moves || []) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:space-between;gap:6px;margin-top:3px;padding:3px 5px;background:#2d2d44;border-radius:4px;font-size:11px";
    const nm = document.createElement("span");
    nm.textContent = m.name;
    const meta = document.createElement("span");
    meta.style.color = "#aab";
    meta.textContent = m.type + " | " + m.category + " | Pow " + m.power + " | Acc " + m.accuracy + " | MP " + m.mpCost;
    row.appendChild(nm);
    row.appendChild(meta);
    box.appendChild(row);
  }
  el.appendChild(box);
}

function gmRenderInspector(data) {
  if (!WGD.inspect || !gmSameTarget(WGD.inspect, data.target)) return;
  WGD.lastInspect = data;
  gmSyncFormFromInspect(data);
  const el = WGD.inspEl;
  el.innerHTML = "";
  el.classList.remove("hidden");
  const head = document.createElement("div");
  head.className = "wgInHead";
  const title = document.createElement("span");
  title.textContent = data.name + (data.target.type === "player" ? " (player)" : "");
  const close = document.createElement("button");
  close.className = "wgBtn";
  close.textContent = "Close";
  close.addEventListener("click", gmInspectClose);
  head.appendChild(title);
  head.appendChild(close);
  el.appendChild(head);

  if (data.target.type === "player" && data.stats) gmRenderPlayerStats(el, data);

  const eqTitle = document.createElement("h5");
  eqTitle.textContent = "Equipped (drop an item on a slot)";
  el.appendChild(eqTitle);
  const slots = document.createElement("div");
  slots.className = "wgSlots";
  for (const slot of ["head", "neck", "back"]) {
    const slotEl = document.createElement("div");
    slotEl.className = "wgSlot";
    slotEl.setAttribute("data-wgdrop", "slot:" + slot);
    const name = data.accessories[slot];
    const label = document.createElement("div");
    label.textContent = slot.charAt(0).toUpperCase() + slot.slice(1);
    slotEl.appendChild(label);
    if (name) {
      const held = document.createElement("div");
      held.style.cursor = "grab";
      held.title = name + " (drag out to unequip or delete)";
      held.appendChild(wgMakeIcon(name));
      const nm = document.createElement("div");
      nm.textContent = name;
      held.appendChild(nm);
      held.addEventListener("mousedown", (ev) => gmDragStart(ev, { src: "slot", name: name, slot: slot, target: data.target, count: 1 }));
      slotEl.appendChild(held);
    }
    slots.appendChild(slotEl);
  }
  el.appendChild(slots);

  const invTitle = document.createElement("h5");
  invTitle.textContent = "Inventory " + data.inv.length + "/" + data.capacity + " (drop items here)";
  el.appendChild(invTitle);
  const inv = document.createElement("div");
  inv.className = "wgInvBox";
  inv.setAttribute("data-wgdrop", "inv");
  if (data.inv.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "color:#99a;padding:6px";
    empty.textContent = "Empty";
    inv.appendChild(empty);
  }
  for (const stack of data.inv) {
    const cell = document.createElement("div");
    cell.className = "wgStack";
    cell.title = stack.name + " (drag onto a slot or the world, or back to the creative window to delete)";
    cell.appendChild(wgMakeIcon(stack.name));
    const nm = document.createElement("span");
    nm.className = "n";
    nm.textContent = stack.name;
    cell.appendChild(nm);
    const cnt = document.createElement("span");
    cnt.className = "cnt";
    cnt.textContent = "x" + stack.count;
    cell.appendChild(cnt);
    const pm = document.createElement("div");
    pm.className = "pm";
    const minus = document.createElement("b");
    minus.textContent = "-";
    minus.addEventListener("mousedown", (ev) => ev.stopPropagation());
    minus.addEventListener("click", () => gmSend({ type: "gm_inv", target: data.target, op: "remove", name: stack.name, count: 1 }));
    const plus = document.createElement("b");
    plus.textContent = "+";
    plus.addEventListener("mousedown", (ev) => ev.stopPropagation());
    plus.addEventListener("click", () => gmSend({ type: "gm_inv", target: data.target, op: "add", name: stack.name, count: 1 }));
    pm.appendChild(minus);
    pm.appendChild(plus);
    cell.appendChild(pm);
    cell.addEventListener("mousedown", (ev) => {
      if (ev.target.tagName === "B") return;
      gmDragStart(ev, { src: "inv", name: stack.name, count: stack.count, target: data.target });
    });
    inv.appendChild(cell);
  }
  el.appendChild(inv);
}

let spawnSelectEl = null;

function spawnSelectShow(data) {
  if (!spawnSelectEl) {
    const style = document.createElement("style");
    style.textContent = "#spawnSelect{position:fixed;inset:0;background:rgba(10,10,20,0.92);z-index:90;display:flex;align-items:center;justify-content:center}"
      + "#spawnSelect .box{background:#1b1b2e;border:2px solid #4a6cff;border-radius:12px;padding:18px;width:360px;max-width:92vw;max-height:80vh;overflow-y:auto;color:#fff;font-size:14px}"
      + "#spawnSelect h3{margin:0 0 4px 0;color:#ffd23f}"
      + "#spawnSelect p{margin:0 0 10px 0;color:#c8c8ff;font-size:12px}"
      + "#spawnSelect button{display:block;width:100%;text-align:left;background:#2d2d44;color:#fff;border:1px solid #55557a;border-radius:8px;padding:10px;margin:6px 0;cursor:pointer;font-size:14px}"
      + "#spawnSelect button:hover{background:#4a6cff;border-color:#fff}"
      + "#spawnSelect button small{display:block;color:#aab;font-size:11px;margin-top:2px}";
    document.head.appendChild(style);
    spawnSelectEl = document.createElement("div");
    spawnSelectEl.id = "spawnSelect";
    document.body.appendChild(spawnSelectEl);
  }
  spawnSelectEl.innerHTML = "";
  const box = document.createElement("div");
  box.className = "box";
  const title = document.createElement("h3");
  title.textContent = "Where should " + (data.name || "your character") + " appear?";
  const sub = document.createElement("p");
  sub.textContent = "Pick a spawnpoint. Next time you join, you'll return to where you left off.";
  box.appendChild(title);
  box.appendChild(sub);
  for (const sp of data.spawns || []) {
    const btn = document.createElement("button");
    btn.textContent = sp.name;
    const small = document.createElement("small");
    small.textContent = "Layer " + sp.layer + (sp.layerName ? " | " + sp.layerName : "");
    btn.appendChild(small);
    btn.addEventListener("click", () => {
      gmSend({ type: "spawn_pick", id: sp.id });
      spawnSelectEl.style.display = "none";
    });
    box.appendChild(btn);
  }
  spawnSelectEl.appendChild(box);
  spawnSelectEl.style.display = "flex";
}

setInterval(() => {
  if (!worldPlayerMode || worldGmMode) return;
  const busy = (typeof lootState !== "undefined" && lootState) || (typeof itemMenuOpenNow === "function" && itemMenuOpenNow()) || inventoryOpen || atkTarget || COMBAT.active || chatActive;
  if (busy) gmSend({ type: "active" });
}, 20000);

const bushAudioCache = {};

function bushPlaySound(file, volume) {
  try {
    let base = bushAudioCache[file];
    if (!base) {
      base = new Audio("assets/music/" + file.split("/").map(encodeURIComponent).join("/"));
      base.preload = "auto";
      bushAudioCache[file] = base;
    }
    const a = base.cloneNode();
    a.volume = volume;
    const p = a.play();
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}

function bushWobble(scene, data) {
  const sp = worldObjectPool[data.col + "," + data.row];
  if (data.sound) bushPlaySound(data.sound, typeof data.volume === "number" ? data.volume : 0.5);
  if (!sp || sp.wobbling) return;
  sp.wobbling = true;
  const baseX = sp.x;
  const baseScaleX = sp.scaleX;
  const baseScaleY = sp.scaleY;
  const ms = data.ms || 1000;
  scene.tweens.addCounter({
    from: 0,
    to: 1,
    duration: ms,
    onUpdate: (tween) => {
      const t = tween.getValue();
      const fade = 1 - t;
      const wave = Math.sin(t * Math.PI * 10);
      sp.x = baseX + wave * 3 * fade;
      sp.scaleX = baseScaleX * (1 + wave * 0.08 * fade);
      sp.scaleY = baseScaleY * (1 - wave * 0.06 * fade);
    },
    onComplete: () => {
      sp.x = baseX;
      sp.scaleX = baseScaleX;
      sp.scaleY = baseScaleY;
      sp.wobbling = false;
    }
  });
}

window.worldHook = function (scene, data) {
  if (data.type === "time") {
    visSetTime(data);
    return true;
  }
  if (data.type === "p_vitals") {
    const sp = otherPlayers[data.id];
    if (sp && sp !== "loading") {
      sp.hp = data.hp;
      sp.maxHp = data.maxHp;
      sp.mp = data.mp;
      sp.maxMp = data.maxMp;
    }
    return true;
  }

  if (data.type === "p_light") {
    visSetOwner(data.id, data.light, data.lc);
    return true;
  }
  if (data.type === "gm_light_mode") {
    if (worldGmMode && data.layer === WG.layer) {
      VIS.layerMode = data.mode;
      const lightSel = document.getElementById("wgLightMode");
      if (lightSel) lightSel.value = data.mode;
    }
    return true;
  }
  if (data.type === "obj_wobble") {
    bushWobble(scene, data);
    return true;
  }
  if (data.type === "spawn_select") {
    spawnSelectShow(data);
    return true;
  }
  if (data.type === "idle_warn") {
    itemToast("You will be logged out in " + data.seconds + " seconds for standing still. Move to stay.");
    return true;
  }
  if (data.type === "init" && data.world) {
    if (data.itemFx) itemFx = data.itemFx;
    if (data.vision) visSetConfig(data.vision);
    if (data.role === "gm") {
      enterGmWorld(scene);
      return true;
    }
    enterPlayerWorld(scene);
    if (data.players) {
      for (const pid in data.players) {
        if (data.players[pid] && data.players[pid].name) worldPlayerNames[pid] = data.players[pid].name;
        if (data.players[pid]) visSetOwner(pid, data.players[pid].light, data.players[pid].lc);
      }
    }
    return false;
  }

  if (data.type === "join" && data.player && data.player.name) {
    worldPlayerNames[data.player.id] = data.player.name;
    visSetOwner(data.player.id, data.player.light, data.player.lc);
    return false;
  }

  if (data.type === "inv_sync") {
    if (data.sheet) {
      invSheet = data.sheet;
      invSheet.accessories = invSheet.accessories || { back: null, neck: null, head: null };
      invCapacity = Math.max(1, data.sheet.capacity || BASE_SLOTS);
    }
    if (Array.isArray(data.inventory)) {
      inventoryItems.length = 0;
      for (const entry of data.inventory) inventoryItems.push({ name: entry.name, count: entry.count });
      selectedSlot = -1;
    }
    if (inventoryOpen) refreshInventoryPanel();
    return true;
  }

  if (data.type === "gm_inspect" && worldGmMode) {
    gmRenderInspector(data);
    return true;
  }

  if (typeof data.type === "string" && data.type.indexOf("c_") === 0) {
    return combatMessage(scene, data);
  }

  if (data.type === "loot_open") {
    lootState = { id: data.id, name: data.name, items: data.items };
    lootRender();
    return true;
  }
  if (data.type === "loot_close") {
    lootClose();
    return true;
  }
  if (data.type === "itemused") {
    if (data.consumed) removeFromInventory(data.name);
    else if (inventoryOpen) refreshInventoryPanel();
    return true;
  }
  if (data.type === "item_result") {
    itemToast(data.text);
    if (COMBAT.active) combatAddLog(data.text);
    updateReadout(data.text);
    return true;
  }
  if (data.type === "vitals") {
    player.hp = data.hp;
    player.mp = data.mp;
    player.maxHp = data.maxHp;
    player.maxMp = data.maxMp;
    playerHp = data.hp;
    playerMaxHp = data.maxHp;
    if (inventoryOpen) refreshInventoryPanel();
    return true;
  }

  if (worldPlayerMode) {
    if (data.type === "view") {
      drawPlayerView(scene, data);
      for (const ent of data.entities || []) visSetOwner(ent.id, ent.light, ent.lc);
      entitiesReconcile(scene, data.entities || []);
      return true;
    }
    if (data.type === "e_move") {
      visSetOwner(data.entity.id, data.entity.light, data.entity.lc);
      entityUpsert(scene, data.entity);
      return true;
    }
    if (data.type === "e_del") {
      if (!combatHolds(data.id)) entityRemove(data.id);
      return true;
    }
    if (data.type === "npc_say") {
      const sprite = otherPlayers[data.id];
      if (sprite && sprite !== "loading") showBubbleFor(scene, "p" + data.id, sprite, data.dex || "0004", data.text);
      return true;
    }
    if (data.type === "interact_none") {
      updateReadout("nobody to talk to");
      return true;
    }
    if (data.type === "teleport") {
      player.col = data.col;
      player.row = data.row;
      player.direction = data.direction || player.direction;
      player.x = tilePixelX(player.col);
      player.y = playerRestingY(player.col, player.row);
      player.play(DEX + "_idle_" + player.direction);
      for (const id of Object.keys(otherPlayers)) removeOtherPlayer(id);
      for (const p of data.players) {
        if (p.id !== myId) addOtherPlayer(scene, p);
        visSetOwner(p.id, p.light, p.lc);
      }
      state = "input";
      updateReadout("layer " + data.layer);
      return true;
    }
    return false;
  }

  if (worldGmMode) {
    if (data.type === "gm_layer") {
      gmLoadLayer(scene, data);
      return true;
    }
    if (data.type === "gm_tiles") {
      if (data.layer === WG.layer) {
        gmApplyTiles(scene, data.cells);
        gmUpdateHoverStatus();
      }
      return true;
    }
    if (data.type === "gm_entity") {
      WG.entities[data.entity.id] = data.entity;
      entityUpsert(scene, data.entity);
      gmDrawMarkers();
      return true;
    }
    if (data.type === "gm_entity_del") {
      delete WG.entities[data.id];
      entityRemove(data.id);
      if (WG.selectedEntity === data.id) {
        WG.selectedEntity = null;
        gmShowSelection();
      }
      if (WGD.inspect && WGD.inspect.type === "entity" && WGD.inspect.id === data.id) gmInspectClose();
      gmDrawMarkers();
      return true;
    }
    if (data.type === "npc_say") {
      const sprite = otherPlayers[data.id];
      if (sprite && sprite !== "loading") showBubbleFor(scene, "p" + data.id, sprite, data.dex || "0004", data.text);
      return true;
    }
    if (data.type === "gm_notice") {
      WG.notice = data.text;
      WG.noticeUntil = Date.now() + 5000;
      gmUpdateHoverStatus();
      return true;
    }
    if (data.type === "gm_spawns") {
      WG.spawns = data.spawns || [];
      if (WG.spawnMoveId && !WG.spawns.some((sp) => sp.id === WG.spawnMoveId)) WG.spawnMoveId = null;
      gmRenderSpawns();
      gmDrawMarkers();
      return true;
    }
    if (data.type === "gm_pass") {
      if (data.layer === WG.layer) {
        for (const cell of data.cells) {
          const key = cell[0] + "," + cell[1];
          if (cell[2]) WG.passable[key] = 1;
          else delete WG.passable[key];
        }
        WG.artDirty = true;
        gmDrawMarkers();
      }
      return true;
    }
    if (data.type === "gm_art") {
      if (data.layer === WG.layer) {
        gmApplyArt(scene, data.cells, data.palette);
        gmUpdateHoverStatus();
      }
      return true;
    }
    if (data.type === "gm_objs") {
      if (data.layer === WG.layer) {
        gmApplyObjs(scene, data.cells);
        gmUpdateHoverStatus();
      }
      return true;
    }
    if (data.type === "gm_layers") {
      WG.layers = data.layers;
      gmRenderLayers();
      return true;
    }
    if (data.type === "gm_players") {
      WG.players = {};
      for (const p of data.players) WG.players[p.id] = p;
      gmRenderPlayers();
      gmSyncPlayerSprites(scene);
      return true;
    }
    if (data.type === "gm_player") {
      gmUpdatePlayer(scene, data.player);
      return true;
    }
    if (data.type === "gm_player_leave") {
      delete WG.players[data.id];
      if (String(WG.selPlayer) === String(data.id)) WG.selPlayer = null;
      if (WGD.inspect && WGD.inspect.type === "player" && String(WGD.inspect.id) === String(data.id)) gmInspectClose();
      removeOtherPlayer(data.id);
      gmRenderPlayers();
      return true;
    }
    return false;
  }

  return false;
};

const VIS_RES = 0.5;
const VIS_RT_TILES = 25;
const VIS_DIR_ANGLE = { right: 0, downright: Math.PI / 4, down: Math.PI / 2, downleft: 3 * Math.PI / 4, left: Math.PI, upleft: -3 * Math.PI / 4, up: -Math.PI / 2, upright: -Math.PI / 4 };
const VIS_DEFAULT_CFG = { coneDegrees: 110, dayRange: 10, nearRadius: 1.5, nightReach: 0, nightVisionReach: 8, darknessMax: 1, lightObjects: [] };
const VIS = { cfg: null, objDefs: [], hour: 12, hourAt: Date.now(), dayMs: 1440000, frozen: false, layerMode: "outdoor", nv: false, selfR: 0, selfC: "#ffb347", block: {}, ang: 0, angReady: false, fogRT: null, darkRT: null, lightImg: null, polyGfx: null, glows: [], look: null, lookMouse: false, touch: null, flames: {}, glowRT: null, glowPx: 0, glowStamp: null, cm: null, owners: {}, audio: {}, lights: [], lastUi: 0, texReady: false };

function visCfg(key) {
  if (VIS.cfg && VIS.cfg[key] !== undefined) return VIS.cfg[key];
  return VIS_DEFAULT_CFG[key];
}

function visEscape(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function visSetConfig(cfg) {
  VIS.cfg = cfg;
  VIS.objDefs = [];
  const list = cfg && Array.isArray(cfg.lightObjects) ? cfg.lightObjects : [];
  for (const def of list) {
    if (!def || !def.match) continue;
    VIS.objDefs.push({ def: def, re: new RegExp("(^|[^A-Za-z])" + visEscape(def.match), "i") });
  }
}

function visDefForName(name) {
  const text = String(name || "");
  for (const entry of VIS.objDefs) {
    if (entry.re.test(text)) return entry.def;
  }
  return null;
}

function visSetOwner(id, radius, color) {
  if (id === undefined || id === null) return;
  if (radius > 0) VIS.owners[String(id)] = { r: radius, c: color || "#ff8a3c" };
  else delete VIS.owners[String(id)];
}

function visSetTime(data) {
  VIS.hour = Number(data.hour) || 0;
  VIS.hourAt = Date.now();
  if (data.dayMs) VIS.dayMs = data.dayMs;
  VIS.frozen = !!data.frozen;
  visGmUpdateUi(true);
}

function visHourNow() {
  if (VIS.frozen) return VIS.hour;
  return (((VIS.hour + (Date.now() - VIS.hourAt) / VIS.dayMs * 24) % 24) + 24) % 24;
}

function visSmooth(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function visDarknessFor(h) {
  if (h >= 7 && h < 18) return 0;
  if (h >= 18 && h < 21) return visSmooth((h - 18) / 3);
  if (h >= 21 || h < 5) return 1;
  return 1 - visSmooth((h - 5) / 2);
}

function visBump(h, a, peak, b) {
  if (h <= a || h >= b) return 0;
  if (h < peak) return visSmooth((h - a) / (peak - a));
  return 1 - visSmooth((h - peak) / (b - peak));
}

function visWarmth() {
  if (VIS.layerMode !== "outdoor") return 0;
  const h = visHourNow();
  return Math.max(visBump(h, 4.5, 6.3, 8.5), visBump(h, 16, 18.5, 21));
}

function visDarkness() {
  if (VIS.layerMode === "indoor") return 0;
  if (VIS.layerMode === "dark") return 1;
  return visDarknessFor(visHourNow());
}

function visColorInt(text, fallback) {
  const v = parseInt(String(text || "").replace("#", ""), 16);
  return isNaN(v) ? fallback : v;
}

function visLerpColor(a, b, t) {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}

function visAngleDiff(a, b) {
  let d = a - b;
  if (!isFinite(d)) return 0;
  d = d % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function visEnsureTexture(scene) {
  if (VIS.texReady && scene.textures.exists("pmdLightGrad")) return;
  if (!scene.textures.exists("pmdLightGrad")) {
    const tex = scene.textures.createCanvas("pmdLightGrad", 256, 256);
    const ctx = tex.getContext();
    const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.35, "rgba(255,255,255,0.95)");
    grad.addColorStop(0.65, "rgba(255,255,255,0.6)");
    grad.addColorStop(0.85, "rgba(255,255,255,0.25)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
    tex.refresh();
  }
  VIS.texReady = true;
}

function visEnsureOverlays(scene) {
  visEnsureTexture(scene);
  if (VIS.fogRT) return;
  const px = Math.ceil(VIS_RT_TILES * TILE * VIS_RES);
  VIS.fogRT = scene.add.renderTexture(0, 0, px, px);
  VIS.fogRT.setOrigin(0, 0);
  VIS.fogRT.setScale(1 / VIS_RES);
  VIS.fogRT.setDepth(20);
  VIS.darkRT = scene.add.renderTexture(0, 0, px, px);
  VIS.darkRT.setOrigin(0, 0);
  VIS.darkRT.setScale(1 / VIS_RES);
  VIS.darkRT.setDepth(21);
  VIS.lightImg = scene.add.image(0, 0, "pmdLightGrad");
  VIS.lightImg.setVisible(false);
  VIS.polyGfx = scene.add.graphics();
  VIS.polyGfx.setVisible(false);
  VIS.tint = scene.add.rectangle(0, 0, VIS_RT_TILES * TILE, VIS_RT_TILES * TILE, 0xff8a3a);
  VIS.tint.setDepth(19);
  VIS.tint.setVisible(false);
}

function visRayDist(ox, oy, ang, maxDist) {
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  let col = Math.floor(ox / TILE);
  let row = Math.floor(oy / TILE);
  const stepC = dx > 0 ? 1 : -1;
  const stepR = dy > 0 ? 1 : -1;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const tDeltaC = adx < 1e-9 ? Infinity : TILE / adx;
  const tDeltaR = ady < 1e-9 ? Infinity : TILE / ady;
  let tMaxC = adx < 1e-9 ? Infinity : ((dx > 0 ? (col + 1) * TILE - ox : ox - col * TILE) / adx);
  let tMaxR = ady < 1e-9 ? Infinity : ((dy > 0 ? (row + 1) * TILE - oy : oy - row * TILE) / ady);
  let t = 0;
  let guard = 0;
  while (t < maxDist && guard < 64) {
    guard++;
    if (tMaxC < tMaxR) {
      t = tMaxC;
      tMaxC += tDeltaC;
      col += stepC;
    } else {
      t = tMaxR;
      tMaxR += tDeltaR;
      row += stepR;
    }
    if (t >= maxDist) return maxDist;
    if (VIS.block[col + "," + row]) return Math.min(maxDist, t + TILE * 0.4);
  }
  return maxDist;
}

function visFan(g, ox, oy, rx, ry, angA, angB, stepRad, range) {
  const count = Math.max(1, Math.ceil(Math.abs(angB - angA) / stepRad));
  let prevX = 0;
  let prevY = 0;
  const cx = (ox - rx) * VIS_RES;
  const cy = (oy - ry) * VIS_RES;
  for (let i = 0; i <= count; i++) {
    const a = angA + (angB - angA) * i / count;
    const d = visRayDist(ox, oy, a, range);
    const px = (ox + Math.cos(a) * d - rx) * VIS_RES;
    const py = (oy + Math.sin(a) * d - ry) * VIS_RES;
    if (i > 0) g.fillTriangle(cx, cy, prevX, prevY, px, py);
    prevX = px;
    prevY = py;
  }
}

function visLit(x, y) {
  for (const light of VIS.lights) {
    const d = Math.hypot(x - light.x, y - light.y) / TILE;
    if (d <= light.vis) return true;
  }
  return false;
}

function visCanSee(ox, oy, tx, ty, half) {
  const dist = Math.hypot(tx - ox, ty - oy);
  const tiles = dist / TILE;
  if (tiles <= visCfg("nearRadius")) return visLit(tx, ty);
  if (tiles > visCfg("dayRange") + 0.6) return false;
  const ang = Math.atan2(ty - oy, tx - ox);
  if (Math.abs(visAngleDiff(ang, VIS.ang)) > half) return false;
  if (!visLit(tx, ty)) return false;
  return visRayDist(ox, oy, ang, dist) >= dist - 0.5;
}

function visCollectLights(t, ox, oy, D, reach) {
  const lights = [];
  const selfR = Math.max(reach, VIS.selfR);
  lights.push({ x: ox, y: oy, r: selfR, vis: D < 0.001 ? selfR : selfR * 0.85, color: VIS.selfR > 0 ? VIS.selfC : null, self: true });
  for (const key in worldObjectPool) {
    const sp = worldObjectPool[key];
    if (!sp || !sp.active || !sp.objDef) continue;
    const def = sp.objDef;
    const ph = (sp.cellC || 0) * 7.3 + (sp.cellR || 0) * 3.1;
    const flick = 1 + (def.flicker || 0.12) * (Math.sin(t * 0.017 + ph) * 0.6 + Math.sin(t * 0.0043 + ph * 1.7) * 0.4);
    const r = (def.radius || 5) * flick;
    lights.push({ x: sp.x, y: sp.y, r: r, vis: r * 0.85, color: def.color || "#ff9a3c" });
  }
  const itemDefs = VIS.cfg && Array.isArray(VIS.cfg.lightItems) ? VIS.cfg.lightItems : [];
  if (itemDefs.length > 0 && Array.isArray(floorItems)) {
    for (const it of floorItems) {
      let found = null;
      for (const def of itemDefs) {
        if (def.onGround && String(def.item).toLowerCase() === String(it.name).toLowerCase()) found = def;
      }
      if (!found) continue;
      const r = found.radius || 5;
      lights.push({ x: it.col * TILE + TILE / 2, y: it.row * TILE + TILE / 2, r: r, vis: r * 0.85, color: found.color || "#ffd27a" });
    }
  }
  for (const id in VIS.owners) {
    const sp = otherPlayers[id];
    if (!sp || sp === "loading" || !sp.active) continue;
    const o = VIS.owners[id];
    const flick = 1 + 0.1 * Math.sin(t * 0.015 + sp.x * 0.01);
    const r = o.r * flick;
    lights.push({ x: sp.x, y: sp.y, r: r, vis: r * 0.85, color: o.c });
  }
  return lights;
}

function visUpdateGlows(scene, lights, D) {
  for (const img of VIS.glows) img.setVisible(false);
  const cam = scene.cameras.main;
  const wv = cam.worldView;
  const side = Math.hypot(wv.width, wv.height) + TILE * 4;
  const need = Math.min(2048, Math.ceil(side * VIS_RES / 64) * 64);
  if (!VIS.glowRT || VIS.glowPx < need || VIS.glowPx > need * 1.5) {
    if (VIS.glowRT) VIS.glowRT.destroy();
    VIS.glowPx = need;
    VIS.glowRT = scene.add.renderTexture(0, 0, need, need);
    VIS.glowRT.setOrigin(0, 0);
    VIS.glowRT.setScale(1 / VIS_RES);
    VIS.glowRT.setDepth(12);
    VIS.glowRT.setBlendMode(Phaser.BlendModes.ADD);
  }
  if (!VIS.glowStamp) {
    VIS.glowStamp = scene.add.image(0, 0, "pmdLightGrad");
    VIS.glowStamp.setVisible(false);
  }
  const rt = VIS.glowRT;
  const half = VIS.glowPx / VIS_RES / 2;
  const rx = wv.centerX - half;
  const ry = wv.centerY - half;
  rt.setPosition(rx, ry);
  rt.clear();
  const stamp = VIS.glowStamp;
  for (const light of lights) {
    if (!light.color) continue;
    stamp.setScale(light.r * TILE * 2 * 0.8 * VIS_RES / 256);
    stamp.setTint(visColorInt(light.color, 0xff9a3c));
    rt.draw(stamp, (light.x - rx) * VIS_RES, (light.y - ry) * VIS_RES);
  }
  rt.setAlpha(0.1 + 0.2 * D);
}

function visApplyGray(scene, amount) {
  const cam = scene.cameras.main;
  if (!cam.postFX) return;
  if (amount <= 0.01) {
    if (VIS.cm) {
      cam.postFX.remove(VIS.cm);
      VIS.cm = null;
    }
    return;
  }
  if (!VIS.cm) VIS.cm = cam.postFX.addColorMatrix();
  VIS.cm.reset();
  VIS.cm.grayscale(amount);
}

function visFlameDrop(key) {
  const f = VIS.flames[key];
  if (!f) return;
  if (f.img) f.img.destroy();
  if (f.sp && f.sp.active) f.sp.setCrop();
  delete VIS.flames[key];
}

function visFlameUpdate(scene, key, sp, flame, t) {
  const size = Math.max(0.1, Math.min(0.9, Number(flame.size) || 0.45));
  const bottom = flame.part === "bottom";
  let f = VIS.flames[key];
  if (f && (f.sp !== sp || f.size !== size || f.bottom !== bottom)) {
    visFlameDrop(key);
    f = null;
  }
  const W = sp.width;
  const H = sp.height;
  if (!f) {
    const img = scene.add.image(sp.x, sp.y, sp.texture.key);
    if (bottom) {
      sp.setCrop(0, 0, W, H * (1 - size));
      img.setCrop(0, H * (1 - size), W, H * size);
      img.setOrigin(0.5, 1 - size);
    } else {
      sp.setCrop(0, H * size, W, H * (1 - size));
      img.setCrop(0, 0, W, H * size);
      img.setOrigin(0.5, size);
    }
    f = { sp: sp, img: img, size: size, bottom: bottom };
    VIS.flames[key] = f;
  }
  const ph = (sp.cellC || 0) * 5.1 + (sp.cellR || 0) * 2.3;
  const bs = sp.baseScale || Math.abs(sp.scaleX);
  const rot = sp.rotation;
  const off = ((bottom ? 1 - size : size) - 0.5) * H * bs;
  const img = f.img;
  img.setPosition(sp.x - off * Math.sin(rot), sp.y + off * Math.cos(rot));
  img.setScale(bs * (1 + 0.04 * Math.sin(t * 0.009 + ph)), bs * (1 + 0.07 * Math.sin(t * 0.0073 + ph * 1.3)));
  img.setRotation(rot + 0.045 * Math.sin(t * 0.006 + ph));
  img.setFlipX(sp.flipX);
  img.setDepth(sp.depth + 0.01);
  img.setAlpha(sp.alpha);
  img.setVisible(sp.visible);
}

function visWobble(t, scene) {
  for (const key in worldObjectPool) {
    const sp = worldObjectPool[key];
    if (!sp || !sp.active || !sp.objDef) continue;
    const def = sp.objDef;
    if (def.flame && scene) {
      visFlameUpdate(scene, key, sp, def.flame, t);
      continue;
    }
    if (!def.wobble) continue;
    const ph = (sp.cellC || 0) * 5.1 + (sp.cellR || 0) * 2.3;
    const bs = sp.baseScale || sp.scaleX;
    sp.setScale(bs * (1 + 0.045 * Math.sin(t * 0.009 + ph)), bs * (1 + 0.075 * Math.sin(t * 0.0073 + ph * 1.3)));
    const baseRot = sp.objRotRad ? sp.objRotRad : -viewRot;
    sp.setRotation(baseRot + 0.05 * Math.sin(t * 0.006 + ph));
  }
  for (const key in VIS.flames) {
    const f = VIS.flames[key];
    const sp = worldObjectPool[key];
    if (!sp || !sp.active || sp !== f.sp || !sp.objDef || !sp.objDef.flame) visFlameDrop(key);
  }
}

function visSoundFrame(px, py) {
  const wanted = {};
  for (const key in worldObjectPool) {
    const sp = worldObjectPool[key];
    if (!sp || !sp.active || !sp.objDef || !sp.objDef.sound) continue;
    const def = sp.objDef;
    const d = Math.hypot(sp.x - px, sp.y - py) / TILE;
    const radius = def.soundRadius || 8;
    if (d >= radius) continue;
    const vol = Math.pow(1 - d / radius, 1.5) * (def.soundVolume !== undefined ? def.soundVolume : 0.6);
    if (!wanted[def.sound] || vol > wanted[def.sound]) wanted[def.sound] = vol;
  }
  for (const file in wanted) {
    let a = VIS.audio[file];
    if (!a) {
      a = new Audio("assets/music/" + file.split("/").map(encodeURIComponent).join("/"));
      a.loop = true;
      VIS.audio[file] = a;
    }
    a.volume = Math.max(0, Math.min(1, wanted[file]));
    if (a.paused) {
      const p = a.play();
      if (p && p.catch) p.catch(() => {});
    }
  }
  for (const file in VIS.audio) {
    if (wanted[file] === undefined && !VIS.audio[file].paused) VIS.audio[file].pause();
  }
}

function visWalkFade(occupied, k) {
  for (const key in worldObjectPool) {
    const sp = worldObjectPool[key];
    if (!sp || !sp.active || !sp.walkObj) continue;
    const c = sp.cellC;
    const r = sp.cellR;
    let target = 1;
    if (occupied[c + "," + r]) {
      target = 0.3;
    } else {
      for (let dr = -1; dr <= 1 && target === 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (occupied[(c + dc) + "," + (r + dr)]) {
            target = 0.65;
            break;
          }
        }
      }
    }
    sp.setAlpha(sp.alpha + (target - sp.alpha) * k);
  }
}

function visUpdateGhost(scene, D) {
  if (!scene.cameras.main.postFX) return;
  if (!VIS.ghost) {
    VIS.ghost = scene.add.sprite(0, 0, player.texture.key, player.frame.name);
    VIS.ghost.setDepth(22);
    VIS.ghost.postFX.addGlow(0x808080, 2, 0, true, 0.1, 6);
  }
  const g = VIS.ghost;
  const alpha = Math.min(0.65, D * D * 0.8);
  if (alpha <= 0.02) {
    g.setVisible(false);
    return;
  }
  g.setVisible(true);
  g.setTexture(player.texture.key, player.frame.name);
  g.setOrigin(player.originX, player.originY);
  g.setScale(player.scaleX, player.scaleY);
  g.setFlipX(player.flipX);
  g.setPosition(player.x, player.y);
  g.setRotation(player.rotation);
  g.setAlpha(alpha);
}

function visWrapBars() {
  if (VIS.barsWrapped || typeof window.drawEntityBars !== "function") return;
  VIS.barsWrapped = true;
  const original = window.drawEntityBars;
  window.drawEntityBars = function (s) {
    if (s && s.visible === false) return;
    original(s);
  };
}

function visLookDown(pointer) {
  if (!worldPlayerMode || worldGmMode) return;
  if (pointer.wasTouch) {
    VIS.touch = { ptr: pointer, x0: pointer.x, y0: pointer.y, t0: Date.now(), active: false };
  } else if (pointer.rightButtonDown()) {
    VIS.lookMouse = true;
    atkClose();
  }
}

function visLookBlocked() {
  if (COMBAT.active || chatActive || lootState) return true;
  if (typeof itemMenuOpenNow === "function" && itemMenuOpenNow()) return true;
  return false;
}

function visFaceAngle(ang) {
  let best = null;
  let bestDiff = 99;
  for (const name in VIS_DIR_ANGLE) {
    const diff = Math.abs(visAngleDiff(ang, VIS_DIR_ANGLE[name]));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = name;
    }
  }
  if (best && state === "input" && player.direction !== best) {
    player.direction = best;
    player.play(DEX + "_idle_" + best);
    sendFace();
  }
}

function visLookFrame(scene) {
  const cam = scene.cameras.main;
  const ptr = scene.input.activePointer;
  const blocked = visLookBlocked();
  let ang = null;
  if (VIS.lookMouse) {
    if (blocked || ptr.wasTouch || !ptr.rightButtonDown()) {
      VIS.lookMouse = false;
    } else {
      const wp = cam.getWorldPoint(ptr.x, ptr.y);
      if (Math.hypot(wp.x - player.x, wp.y - player.y) > 6) ang = Math.atan2(wp.y - player.y, wp.x - player.x);
    }
  }
  const t = VIS.touch;
  if (t) {
    if (!t.ptr.isDown || blocked) {
      VIS.touch = null;
    } else {
      if (!t.active) {
        if (Math.hypot(t.ptr.x - t.x0, t.ptr.y - t.y0) > 14) {
          VIS.touch = null;
        } else if (Date.now() - t.t0 >= 250) {
          t.active = true;
          t.x0 = t.ptr.x;
          t.y0 = t.ptr.y;
          atkClose();
        }
      }
      if (VIS.touch && t.active && Math.hypot(t.ptr.x - t.x0, t.ptr.y - t.y0) > 14) {
        const a = cam.getWorldPoint(t.x0, t.y0);
        const b = cam.getWorldPoint(t.ptr.x, t.ptr.y);
        ang = Math.atan2(b.y - a.y, b.x - a.x);
      }
    }
  }
  if (ang !== null) {
    VIS.look = { ang: ang, dir: player.direction, col: player.col, row: player.row };
    visFaceAngle(ang);
    VIS.look.dir = player.direction;
    return;
  }
  if (VIS.look && !VIS.lookMouse && !(VIS.touch && VIS.touch.active)) {
    if (player.direction !== VIS.look.dir || player.col !== VIS.look.col || player.row !== VIS.look.row) VIS.look = null;
  }
}

function visFrame(scene) {
  visWrapBars();
  const t = scene.time.now;
  if (worldGmMode) {
    visEnsureTexture(scene);
    const D = visDarkness();
    const lights = visCollectLights(t, 0, 0, D, 0).slice(1);
    visUpdateGlows(scene, lights, D);
    visWobble(t, scene);
    visGmUpdateUi(false);
    return;
  }
  if (!worldPlayerMode || !player || !worldLastView) return;
  const dt = Math.min(100, scene.game.loop.delta || 16);
  visEnsureOverlays(scene);
  const D = visDarkness();
  const half = visCfg("coneDegrees") * Math.PI / 360;
  const dayRange = visCfg("dayRange");
  visLookFrame(scene);
  const target = VIS.look ? VIS.look.ang : VIS_DIR_ANGLE[player.direction];
  if (target !== undefined) {
    if (!VIS.angReady) {
      VIS.ang = target;
      VIS.angReady = true;
    } else {
      const diff = visAngleDiff(target, VIS.ang);
      VIS.ang = Math.abs(diff) < 0.01 ? target : VIS.ang + diff * (1 - Math.exp(-dt / 45));
    }
  }
  const reachBase = VIS.nv ? visCfg("nightVisionReach") : visCfg("nightReach");
  const reach = dayRange + (reachBase - dayRange) * D;
  const ox = player.x;
  const oy = player.y;
  const lights = visCollectLights(t, ox, oy, D, reach);
  VIS.lights = lights;
  const rx = ox - VIS_RT_TILES * TILE / 2;
  const ry = oy - VIS_RT_TILES * TILE / 2;
  VIS.fogRT.setPosition(rx, ry);
  VIS.darkRT.setPosition(rx, ry);
  const warmth = visWarmth();
  if (warmth > 0.01) {
    VIS.tint.setVisible(true);
    VIS.tint.setPosition(ox, oy);
    VIS.tint.setAlpha(warmth * 0.36);
  } else {
    VIS.tint.setVisible(false);
  }
  VIS.fogRT.clear();
  VIS.fogRT.fill(0x666b78, 0.2);
  const g = VIS.polyGfx;
  g.clear();
  const step = 2 * Math.PI / 180;
  const spreads = [0.14, 0.07, 0];
  const alphas = [0.35, 0.65, 1];
  for (let i = 0; i < spreads.length; i++) {
    g.fillStyle(0xffffff, alphas[i]);
    visFan(g, ox, oy, rx, ry, VIS.ang - half - spreads[i], VIS.ang + half + spreads[i], step, dayRange * TILE);
  }
  const near = visCfg("nearRadius");
  g.fillStyle(0xffffff, 0.45);
  visFan(g, ox, oy, rx, ry, 0, Math.PI * 2, 15 * Math.PI / 180, (near + 0.4) * TILE);
  g.fillStyle(0xffffff, 1);
  visFan(g, ox, oy, rx, ry, 0, Math.PI * 2, 15 * Math.PI / 180, near * TILE);
  VIS.fogRT.erase(g, 0, 0);
  if (D > 0.004) {
    VIS.darkRT.setVisible(true);
    VIS.darkRT.clear();
    const dusk = 0x4a1c10;
    const night = 0x000000;
    VIS.darkRT.fill(visLerpColor(dusk, night, Math.pow(D, 1.4)), D * visCfg("darknessMax"));
    for (const light of lights) {
      VIS.lightImg.setScale(light.r * TILE * 2 * VIS_RES / 256);
      VIS.darkRT.erase(VIS.lightImg, (light.x - rx) * VIS_RES, (light.y - ry) * VIS_RES);
    }
  } else {
    VIS.darkRT.setVisible(false);
  }
  visUpdateGlows(scene, lights, D);
  visUpdateGhost(scene, D);
  visApplyGray(scene, VIS.nv ? Math.min(1, D * 1.4) : 0);
  const occupied = {};
  occupied[Math.floor(ox / TILE) + "," + Math.floor(oy / TILE)] = true;
  for (const id in otherPlayers) {
    const sp = otherPlayers[id];
    if (!sp || sp === "loading" || !sp.active) continue;
    const exempt = (typeof combatHolds === "function" && combatHolds(id)) || (COMBAT.active && COMBAT.actors[id]);
    const seen = exempt || visCanSee(ox, oy, sp.x, sp.y, half);
    if (sp.visible !== seen) sp.setVisible(seen);
    const label = worldEntityLabels[id];
    if (label) label.setVisible(seen);
    if (seen) occupied[Math.floor(sp.x / TILE) + "," + Math.floor(sp.y / TILE)] = true;
  }
  for (const key in floorItemSprites) {
    const isp = floorItemSprites[key];
    if (!isp || !isp.active) continue;
    const seenItem = visCanSee(ox, oy, isp.x, isp.y, half);
    if (isp.visible !== seenItem) isp.setVisible(seenItem);
  }
  visWalkFade(occupied, 1 - Math.exp(-dt / 90));
  visWobble(t, scene);
  visSoundFrame(ox, oy);
}

function visHourLabel(h) {
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;
}

function visGmUpdateUi(force) {
  const label = document.getElementById("wgTimeLabel");
  if (!label) return;
  const now = Date.now();
  if (!force && now - VIS.lastUi < 400) return;
  VIS.lastUi = now;
  const h = visHourNow();
  const dark = visDarknessFor(h);
  const phase = dark > 0.6 ? "Night" : (dark > 0.02 ? (h < 12 ? "Dawn" : "Dusk") : "Day");
  label.textContent = "World time: " + visHourLabel(h) + " | " + phase + (VIS.frozen ? " | frozen" : "");
  const freeze = document.getElementById("wgTimeFreeze");
  if (freeze) freeze.textContent = VIS.frozen ? "Resume time" : "Freeze time";
  const dayMin = document.getElementById("wgDayMin");
  if (dayMin && document.activeElement !== dayMin) dayMin.value = Math.round(VIS.dayMs / 600) / 100;
}

function visGmBindUi() {
  const slider = document.getElementById("wgTimeSlider");
  const sliderLabel = document.getElementById("wgTimeSliderLabel");
  if (!slider) return;
  slider.addEventListener("input", () => {
    sliderLabel.textContent = visHourLabel(parseFloat(slider.value));
  });
  document.getElementById("wgTimeSet").addEventListener("click", () => {
    gmSend({ type: "gm_time", hour: parseFloat(slider.value) });
  });
  document.querySelectorAll("[data-wgtime]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const h = parseFloat(btn.getAttribute("data-wgtime"));
      slider.value = h;
      sliderLabel.textContent = visHourLabel(h);
      gmSend({ type: "gm_time", hour: h });
    });
  });
  document.getElementById("wgTimeFreeze").addEventListener("click", () => {
    gmSend({ type: "gm_time", frozen: !VIS.frozen });
  });
  document.getElementById("wgDayMinSet").addEventListener("click", () => {
    const v = parseFloat(document.getElementById("wgDayMin").value);
    if (isFinite(v) && v >= 1) gmSend({ type: "gm_time", dayMinutes: v });
  });
  document.getElementById("wgLightMode").addEventListener("change", (ev) => {
    VIS.layerMode = ev.target.value;
    gmSend({ type: "gm_light_mode", mode: ev.target.value });
  });
}