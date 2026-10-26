const express = require("express");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use("/items", express.static(path.join(__dirname, "StorageData", "Items")));
app.use("/assets", express.static(path.join(__dirname, "assets")));

app.use(express.json());

const API_SECRET = process.env.API_SECRET || "";

function checkSecret(req, res) {
  if (!API_SECRET || req.headers["x-api-key"] !== API_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

const runs = {};
const passcodes = {};

function makeToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

app.post("/api/session", (req, res) => {
  if (!checkSecret(req, res)) return;
  const dungeon = req.body && req.body.dungeon ? req.body.dungeon : "Unknown";
  const roster = req.body && Array.isArray(req.body.roster) ? req.body.roster : [];
  const gm = req.body && req.body.gm ? String(req.body.gm) : null;
  const token = makeToken();

  const participants = [];
  const passes = {};

  if (gm) {
    const gmPass = makeToken();
    const info = { token: token, userId: gm, name: "GM", dex: null, role: "gm" };
    passcodes[gmPass] = info;
    passes[gmPass] = info;
    participants.push({ userId: gm, name: "GM", role: "gm", pass: gmPass, link: "/?session=" + token + "&pass=" + gmPass });
  }

  for (const entry of roster) {
    const pass = makeToken();
    const info = { token: token, userId: String(entry.userId), name: entry.name || "", dex: entry.dex || "0004", role: "player" };
    passcodes[pass] = info;
    passes[pass] = info;
    participants.push({ userId: info.userId, name: info.name, role: "player", pass: pass, link: "/?session=" + token + "&pass=" + pass });
  }

  runs[token] = { token: token, dungeon: dungeon, roster: roster, gm: gm, status: "active", results: null, created: Date.now(), passes: passes };
  res.json({ token: token, participants: participants });
});

app.get("/api/session/:token", (req, res) => {
  const run = runs[req.params.token];
  if (!run) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ token: run.token, dungeon: run.dungeon, roster: run.roster, status: run.status });
});

app.get("/api/redeem/:pass", (req, res) => {
  const info = passcodes[req.params.pass];
  if (!info) {
    res.status(404).json({ error: "invalid" });
    return;
  }
  const run = runs[info.token];
  res.json({ token: info.token, userId: info.userId, name: info.name, dex: info.dex, role: info.role, dungeon: run ? run.dungeon : null });
});

app.post("/api/session/:token/finish", (req, res) => {
  const run = runs[req.params.token];
  if (!run) {
    res.status(404).json({ error: "not found" });
    return;
  }
  run.status = "finished";
  run.results = req.body && req.body.results ? req.body.results : [];
  res.json({ ok: true });
});

app.get("/api/results", (req, res) => {
  if (!checkSecret(req, res)) return;
  const finished = [];
  for (const token in runs) {
    if (runs[token].status === "finished") {
      finished.push({ token: token, dungeon: runs[token].dungeon, results: runs[token].results });
    }
  }
  res.json({ runs: finished });
});

app.post("/api/session/:token/claim", (req, res) => {
  if (!checkSecret(req, res)) return;
  const run = runs[req.params.token];
  if (!run) {
    res.status(404).json({ error: "not found" });
    return;
  }
  for (const pass in run.passes) {
    delete passcodes[pass];
  }
  delete runs[req.params.token];
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MAP = [
  "############################",
  "############################",
  "##.......#########........##",
  "##.......#########........##",
  "##........................##",
  "##.......####..###........##",
  "##.......####..###........##",
  "#############..#############",
  "###########......###########",
  "###########......###########",
  "###########......###########",
  "###########......###########",
  "#############..#############",
  "##........###..###........##",
  "##........###..###........##",
  "##........................##",
  "##........########........##",
  "##........########........##",
  "############################",
  "############################"
];

const DELTAS = {
  up: { dc: 0, dr: -1 },
  down: { dc: 0, dr: 1 },
  left: { dc: -1, dr: 0 },
  right: { dc: 1, dr: 0 },
  upleft: { dc: -1, dr: -1 },
  upright: { dc: 1, dr: -1 },
  downleft: { dc: -1, dr: 1 },
  downright: { dc: 1, dr: 1 }
};

const SPAWNS = [
  { col: 13, row: 9 },
  { col: 14, row: 9 },
  { col: 12, row: 9 },
  { col: 13, row: 10 }
];

const DEXES = ["0004", "0133", "0495", "0025"];
const TURN_TIMEOUT = 30000;

const sessions = {};

function getSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = { players: {}, intents: {}, turnNumber: 1, turnTimer: null, nextId: 1, characters: {}, floorItems: [ { col: 11, row: 9, name: "Oran Berry" }, { col: 16, row: 9, name: "Apple" } ] };
  }
  return sessions[sessionId];
}

function num(v, d) {
  return (typeof v === "number" && !isNaN(v)) ? v : d;
}

function isFloorIn(map, col, row) {
  if (row < 0 || row >= map.length) return false;
  if (col < 0 || col >= map[row].length) return false;
  return map[row][col] === ".";
}

function isFloor(col, row) {
  return isFloorIn(MAP, col, row);
}

function broadcast(sessionId, data, exceptId) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.sessionId === sessionId && client.playerId !== exceptId) {
      client.send(msg);
    }
  });
}

function allSubmitted(session) {
  const ids = Object.keys(session.players);
  if (ids.length === 0) return false;
  for (const id of ids) {
    if (!session.intents[id]) return false;
  }
  return true;
}

function onIntent(sessionId, playerId, dir) {
  const session = sessions[sessionId];
  if (!session || !session.players[playerId]) return;
  session.intents[playerId] = { dir: dir };
  if (dir) session.players[playerId].direction = dir;
  if (session.turnTimer === null) {
    session.turnTimer = setTimeout(() => resolveTurn(sessionId), TURN_TIMEOUT);
  }
  if (allSubmitted(session)) {
    resolveTurn(sessionId);
  }
}

function resolveTurn(sessionId) {
  const session = sessions[sessionId];
  if (!session) return;

  if (session.turnTimer !== null) {
    clearTimeout(session.turnTimer);
    session.turnTimer = null;
  }

  const players = session.players;
  const ids = Object.keys(players);
  const desired = {};

  for (const id of ids) {
    const p = players[id];
    const it = session.intents[id];
    if (it && it.dir) {
      const d = DELTAS[it.dir];
      const nc = p.col + d.dc;
      const nr = p.row + d.dr;
      if (isFloor(nc, nr)) {
        desired[id] = { col: nc, row: nr };
      } else {
        desired[id] = { col: p.col, row: p.row };
      }
    } else {
      desired[id] = { col: p.col, row: p.row };
    }
  }

  let changed = true;
  let guard = 0;
  while (changed && guard < 50) {
    changed = false;
    guard = guard + 1;

    const byTile = {};
    for (const id of ids) {
      const k = desired[id].col + "," + desired[id].row;
      if (!byTile[k]) byTile[k] = [];
      byTile[k].push(id);
    }

    for (const k in byTile) {
      const claimants = byTile[k];
      if (claimants.length > 1) {
        let winner = null;
        for (const id of claimants) {
          if (desired[id].col === players[id].col && desired[id].row === players[id].row) {
            winner = id;
            break;
          }
        }
        if (winner === null) {
          winner = claimants[Math.floor(Math.random() * claimants.length)];
        }
        for (const id of claimants) {
          if (id !== winner) {
            const p = players[id];
            if (desired[id].col !== p.col || desired[id].row !== p.row) {
              desired[id] = { col: p.col, row: p.row };
              changed = true;
            }
          }
        }
      }
    }

    for (const id of ids) {
      const p = players[id];
      for (const other of ids) {
        if (other === id) continue;
        const op = players[other];
        if (desired[id].col === op.col && desired[id].row === op.row &&
            desired[other].col === p.col && desired[other].row === p.row) {
          if (desired[id].col !== p.col || desired[id].row !== p.row) {
            desired[id] = { col: p.col, row: p.row };
            changed = true;
          }
          if (desired[other].col !== op.col || desired[other].row !== op.row) {
            desired[other] = { col: op.col, row: op.row };
            changed = true;
          }
        }
      }
    }
  }

  const result = [];
  for (const id of ids) {
    players[id].col = desired[id].col;
    players[id].row = desired[id].row;
    result.push({ id: players[id].id, col: players[id].col, row: players[id].row, direction: players[id].direction });
  }

  session.turnNumber = session.turnNumber + 1;
  session.intents = {};
  broadcast(sessionId, { type: "resolve", turn: session.turnNumber, players: result });
}

function sessionHasSockets(sessionId) {
  let found = false;
  wss.clients.forEach((client) => {
    if (client.sessionId === sessionId && client.readyState === WebSocket.OPEN) {
      found = true;
    }
  });
  return found;
}

function sendToPlayer(sessionId, pid, data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN && c.sessionId === sessionId && c.playerId === pid) {
      c.send(msg);
    }
  });
}

function handleMove(sessionId, pid, dir) {
  const s = sessions[sessionId];
  if (!s) return;
  const p = s.players[pid];
  if (!p) return;
  if (dir) p.direction = dir;

  const blocked = () => {
    broadcast(sessionId, { type: "face", id: pid, direction: p.direction }, pid);
    sendToPlayer(sessionId, pid, { type: "moveblocked", direction: p.direction });
  };

  const d = DELTAS[dir];
  if (!d) { blocked(); return; }
  const nc = p.col + d.dc;
  const nr = p.row + d.dr;
  if (!isFloorIn(s.map || MAP, nc, nr)) { blocked(); return; }
  for (const oid in s.players) {
    if (String(oid) !== String(pid) && s.players[oid].col === nc && s.players[oid].row === nr) {
      blocked();
      return;
    }
  }
  p.col = nc;
  p.row = nr;
  broadcast(sessionId, { type: "moved", id: pid, col: nc, row: nr, direction: p.direction });
}

const WORLD_DIR = path.join(__dirname, "StorageData", "World");
const WORLD_FILE = path.join(WORLD_DIR, "world.json");
const LAYERS_FILE = path.join(WORLD_DIR, "layers.json");
const PASSES_FILE = path.join(WORLD_DIR, "passes.json");
const PENDING_FILE = path.join(WORLD_DIR, "pending.json");
const WORLD_SESSION = "world";
const WORLD_GM_SESSION = "worldgm";
const WORLD_SAVE_INTERVAL = 30000;
const WORLD_CHECKPOINT_INTERVAL = 60000;
const LAYER_SAVE_DELAY = 1500;
const LAYER_W = 256;
const LAYER_H = 256;
const MAX_LAYER = 999;
const MIN_LAYER = -999;
const VIEW_HALF_W = 8;
const VIEW_HALF_H = 6;
const TILE_CHARS = " .#xP";
const MAX_EDIT_OPS = 6000;
const TILE_ASSET_DIR = path.join(__dirname, "assets", "tilemap");
const OBJECT_ASSET_DIR = path.join(__dirname, "assets", "objects");
const PALETTE_FILE = path.join(WORLD_DIR, "palette.json");
const PALETTE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const BLOCKING_TILES = ["Water"];

function listAssetNames(dir) {
  try {
    const names = [];
    for (const file of fs.readdirSync(dir)) {
      if (/\.png$/i.test(file)) names.push(file.replace(/\.png$/i, ""));
    }
    names.sort();
    return names;
  } catch (e) {
    return [];
  }
}

function isBlockingTile(name) {
  const lower = String(name).toLowerCase();
  for (const blocked of BLOCKING_TILES) {
    if (blocked.toLowerCase() === lower) return true;
  }
  return false;
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function writeJsonFile(file, data) {
  try {
    fs.mkdirSync(WORLD_DIR, { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error("Could not write " + file + ": " + e.message);
  }
}

let tilePalette = {};

function loadPalette() {
  const data = readJsonFile(PALETTE_FILE, {});
  tilePalette = data && typeof data === "object" ? data : {};
}

function savePalette() {
  writeJsonFile(PALETTE_FILE, tilePalette);
}

function paletteChar(name) {
  for (const ch of Object.keys(tilePalette)) {
    if (tilePalette[ch] === name) return ch;
  }
  for (let i = 0; i < PALETTE_CHARS.length; i++) {
    const ch = PALETTE_CHARS[i];
    if (!tilePalette[ch]) {
      tilePalette[ch] = name;
      savePalette();
      return ch;
    }
  }
  return null;
}

function buildSeedMap() {
  const W = 64;
  const H = 44;
  const grid = [];
  for (let r = 0; r < H; r++) {
    const row = [];
    for (let c = 0; c < W; c++) {
      row.push(r === 0 || c === 0 || r === H - 1 || c === W - 1 ? "#" : ".");
    }
    grid.push(row);
  }

  const blocks = [
    [6, 5, 8, 5], [20, 5, 6, 4], [38, 4, 10, 5], [52, 6, 6, 5],
    [6, 18, 5, 8], [14, 30, 9, 5], [28, 32, 7, 6], [44, 28, 8, 6],
    [54, 18, 5, 6], [20, 16, 4, 4], [40, 16, 4, 4]
  ];
  for (const b of blocks) {
    for (let r = b[1]; r < b[1] + b[3]; r++) {
      for (let c = b[0]; c < b[0] + b[2]; c++) {
        grid[r][c] = "#";
      }
    }
  }

  for (let r = 36; r < 41; r++) {
    for (let c = 4; c < 11; c++) {
      grid[r][c] = "#";
    }
  }

  let seed = 12345;
  function next() {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  }
  for (let r = 2; r < H - 2; r++) {
    for (let c = 2; c < W - 2; c++) {
      if (grid[r][c] !== ".") continue;
      if (Math.abs(c - 32) < 6 && Math.abs(r - 22) < 5) continue;
      if (next() > 0.035) continue;
      let lonely = true;
      for (let dr = -2; dr <= 2 && lonely; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          if (dr === 0 && dc === 0) continue;
          if (grid[r + dr] && grid[r + dr][c + dc] === "#") { lonely = false; break; }
        }
      }
      if (lonely) grid[r][c] = "#";
    }
  }

  return grid.map((row) => row.join(""));
}

function makeLayer(name) {
  const rows = [];
  const blank = " ".repeat(LAYER_W);
  for (let r = 0; r < LAYER_H; r++) rows.push(blank);
  return { name: name || "", rows: rows, art: rows.slice(), objects: {}, portals: {}, spawn: null };
}

function layerHasContent(L) {
  if (L.name || L.spawn || Object.keys(L.portals).length > 0 || Object.keys(L.objects).length > 0) return true;
  for (const row of L.rows) {
    if (row.trim().length > 0) return true;
  }
  return false;
}

let layers = {};

function loadLayers() {
  const data = readJsonFile(LAYERS_FILE, null);
  if (data && typeof data === "object") {
    for (const key of Object.keys(data)) {
      const n = parseInt(key, 10);
      if (isNaN(n) || n < MIN_LAYER || n > MAX_LAYER) continue;
      const saved = data[key];
      const L = makeLayer(saved.name || "");
      const rows = Array.isArray(saved.rows) ? saved.rows : [];
      for (let r = 0; r < LAYER_H && r < rows.length; r++) {
        L.rows[r] = String(rows[r]).padEnd(LAYER_W, " ").slice(0, LAYER_W);
      }
      const art = Array.isArray(saved.art) ? saved.art : [];
      for (let r = 0; r < LAYER_H && r < art.length; r++) {
        L.art[r] = String(art[r]).padEnd(LAYER_W, " ").slice(0, LAYER_W);
      }
      const objList = Array.isArray(saved.objects) ? saved.objects : [];
      for (const o of objList) {
        if (Array.isArray(o) && o.length >= 3) L.objects[o[0] + "," + o[1]] = { name: String(o[2]), solid: o[3] !== 0 };
      }
      L.portals = saved.portals && typeof saved.portals === "object" ? saved.portals : {};
      L.spawn = saved.spawn || null;
      layers[n] = L;
    }
    return;
  }
  const L = makeLayer("Ground");
  const seedMap = buildSeedMap();
  for (let r = 0; r < seedMap.length; r++) {
    L.rows[r] = seedMap[r].padEnd(LAYER_W, " ");
  }
  L.spawn = { col: 32, row: 22 };
  layers[0] = L;
}

loadPalette();
loadLayers();

let layersDirty = false;
let layerSaveTimer = null;

function saveLayersNow() {
  if (layerSaveTimer) {
    clearTimeout(layerSaveTimer);
    layerSaveTimer = null;
  }
  const out = {};
  for (const key of Object.keys(layers)) {
    const L = layers[key];
    if (!layerHasContent(L)) continue;
    const objList = [];
    for (const k of Object.keys(L.objects)) {
      const parts = k.split(",");
      objList.push([parseInt(parts[0], 10), parseInt(parts[1], 10), L.objects[k].name, L.objects[k].solid ? 1 : 0]);
    }
    out[key] = { name: L.name, rows: L.rows.map((row) => row.replace(/ +$/, "")), art: L.art.map((row) => row.replace(/ +$/, "")), objects: objList, portals: L.portals, spawn: L.spawn };
  }
  writeJsonFile(LAYERS_FILE, out);
  layersDirty = false;
}

function scheduleLayerSave() {
  layersDirty = true;
  if (layerSaveTimer) return;
  layerSaveTimer = setTimeout(saveLayersNow, LAYER_SAVE_DELAY);
}

function ensureLayer(n) {
  if (!layers[n]) layers[n] = makeLayer("");
  return layers[n];
}

function validLayerNumber(n) {
  return Number.isInteger(n) && n >= MIN_LAYER && n <= MAX_LAYER;
}

function tileAt(layer, col, row) {
  const L = layers[layer];
  if (!L) return " ";
  if (row < 0 || row >= LAYER_H || col < 0 || col >= LAYER_W) return " ";
  return L.rows[row][col];
}

function isWalkable(layer, col, row) {
  const ch = tileAt(layer, col, row);
  if (ch !== "." && ch !== "P") return false;
  const L = layers[layer];
  const obj = L ? L.objects[col + "," + row] : null;
  if (obj && obj.solid) return false;
  return true;
}

function layerSpawn(layer) {
  const L = layers[layer];
  if (L && L.spawn) return { col: L.spawn.col, row: L.spawn.row };
  if (L) {
    for (let r = 0; r < LAYER_H; r++) {
      const c = L.rows[r].search(/[.P]/);
      if (c !== -1) return { col: c, row: r };
    }
  }
  return { col: 0, row: 0 };
}

let worldState = readJsonFile(WORLD_FILE, null);
if (!worldState || typeof worldState !== "object") {
  worldState = { positions: {}, floorItems: [ { layer: 0, col: 30, row: 22, name: "Oran Berry" }, { layer: 0, col: 34, row: 22, name: "Apple" } ] };
}
if (!worldState.positions) worldState.positions = {};
if (!Array.isArray(worldState.floorItems)) worldState.floorItems = [];
for (const it of worldState.floorItems) {
  if (!Number.isInteger(it.layer)) it.layer = 0;
}

let worldPasses = readJsonFile(PASSES_FILE, {});
let pendingSaves = readJsonFile(PENDING_FILE, []);
if (!Array.isArray(pendingSaves)) pendingSaves = [];
const worldByUser = {};
const worldGmByUser = {};
for (const pass in worldPasses) {
  if (worldPasses[pass].role === "gm") {
    worldGmByUser[worldPasses[pass].userId] = pass;
  } else {
    worldByUser[worldPasses[pass].userId] = pass;
  }
}

const worldSession = { players: {}, intents: {}, turnNumber: 1, turnTimer: null, nextId: 1, characters: {}, floorItems: worldState.floorItems };
sessions[WORLD_SESSION] = worldSession;
const worldGms = [];

function saveWorldState() {
  for (const id in worldSession.players) {
    const p = worldSession.players[id];
    worldState.positions[p._key] = { layer: p.layer, col: p.col, row: p.row, direction: p.direction };
  }
  worldState.floorItems = worldSession.floorItems;
  writeJsonFile(WORLD_FILE, worldState);
}

function countInventory(list) {
  const counts = {};
  for (const entry of list) {
    if (!entry || !entry.name) continue;
    counts[entry.name] = (counts[entry.name] || 0) + (entry.count || 1);
  }
  return counts;
}

function publicPlayer(p) {
  return { id: p.id, layer: p.layer, col: p.col, row: p.row, direction: p.direction, dex: p.dex, name: p.name, userId: p.userId, hp: p.hp, maxHp: p.maxHp, mp: p.mp, maxMp: p.maxMp };
}

function sendSocket(socket, data) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}

function sendPlayer(p, data) {
  sendSocket(p._socket, data);
}

function sendGms(layer, data) {
  for (const gm of worldGms) {
    if (layer === null || gm.layer === layer) sendSocket(gm.socket, data);
  }
}

function inView(a, b) {
  return a.layer === b.layer && Math.abs(a.col - b.col) <= VIEW_HALF_W && Math.abs(a.row - b.row) <= VIEW_HALF_H;
}

function cellInView(p, layer, col, row) {
  return p.layer === layer && Math.abs(p.col - col) <= VIEW_HALF_W && Math.abs(p.row - row) <= VIEW_HALF_H;
}

function updatePair(p, q) {
  const visible = inView(p, q);
  const had = !!p._seen[q.id];
  if (visible && !had) {
    p._seen[q.id] = true;
    q._seen[p.id] = true;
    sendPlayer(p, { type: "join", player: publicPlayer(q) });
    sendPlayer(q, { type: "join", player: publicPlayer(p) });
  } else if (!visible && had) {
    delete p._seen[q.id];
    delete q._seen[p.id];
    sendPlayer(p, { type: "leave", id: q.id });
    sendPlayer(q, { type: "leave", id: p.id });
  }
}

function refreshVisibility(p) {
  for (const id in worldSession.players) {
    const q = worldSession.players[id];
    if (q !== p) updatePair(p, q);
  }
}

function visiblePlayersOf(p) {
  const list = [];
  for (const id in p._seen) {
    const q = worldSession.players[id];
    if (q) list.push(publicPlayer(q));
  }
  return list;
}

function itemsInWindow(layer, c0, r0, w, h) {
  const out = [];
  for (const it of worldSession.floorItems) {
    if (it.layer === layer && it.col >= c0 && it.col < c0 + w && it.row >= r0 && it.row < r0 + h) {
      out.push({ col: it.col, row: it.row, name: it.name });
    }
  }
  return out;
}

function objectsInWindow(layer, c0, r0, w, h) {
  const out = [];
  const L = layers[layer];
  if (!L) return out;
  for (let r = r0; r < r0 + h; r++) {
    for (let c = c0; c < c0 + w; c++) {
      const obj = L.objects[c + "," + r];
      if (obj) out.push({ col: c, row: r, name: obj.name });
    }
  }
  return out;
}

function artAt(layer, col, row) {
  const L = layers[layer];
  if (!L) return " ";
  if (row < 0 || row >= LAYER_H || col < 0 || col >= LAYER_W) return " ";
  return L.art[row][col];
}

function sendView(p) {
  const w = VIEW_HALF_W * 2 + 1;
  const h = VIEW_HALF_H * 2 + 1;
  const c0 = p.col - VIEW_HALF_W;
  const r0 = p.row - VIEW_HALF_H;
  const rows = [];
  const artRows = [];
  for (let r = r0; r < r0 + h; r++) {
    let line = "";
    let artLine = "";
    for (let c = c0; c < c0 + w; c++) {
      const ch = tileAt(p.layer, c, r);
      line += ch === "x" ? "." : ch;
      artLine += ch === " " ? " " : artAt(p.layer, c, r);
    }
    rows.push(line);
    artRows.push(artLine);
  }
  sendPlayer(p, { type: "view", layer: p.layer, c0: c0, r0: r0, rows: rows, art: artRows, palette: tilePalette, objects: objectsInWindow(p.layer, c0, r0, w, h), items: itemsInWindow(p.layer, c0, r0, w, h) });
}

function notifyItem(layer, col, row, data) {
  for (const id in worldSession.players) {
    const q = worldSession.players[id];
    if (cellInView(q, layer, col, row)) sendPlayer(q, data);
  }
  sendGms(layer, data);
}

function queueWorldSave(p, final) {
  const current = countInventory(p._inv);
  const delta = {};
  const names = {};
  for (const n in current) names[n] = true;
  for (const n in p._reported) names[n] = true;
  for (const n in names) {
    const d = (current[n] || 0) - (p._reported[n] || 0);
    if (d !== 0) delta[n] = d;
  }
  if (!final && Object.keys(delta).length === 0) return;
  pendingSaves.push({ id: makeToken(), userId: p.userId, name: p.name, slot: p._slot, pass: p._pass, delta: delta, hp: p.hp, mp: p.mp, layer: p.layer, col: p.col, row: p.row, final: final, ts: Date.now() });
  p._reported = current;
  writeJsonFile(PENDING_FILE, pendingSaves);
}

function leaveWorldPlayer(id) {
  const p = worldSession.players[id];
  if (!p) return false;
  queueWorldSave(p, true);
  worldState.positions[p._key] = { layer: p.layer, col: p.col, row: p.row, direction: p.direction };
  for (const otherId in p._seen) {
    const q = worldSession.players[otherId];
    if (q) {
      delete q._seen[id];
      sendPlayer(q, { type: "leave", id: id });
    }
  }
  delete worldSession.players[id];
  sendGms(null, { type: "gm_player_leave", id: id });
  saveWorldState();
  return true;
}

function forceLeaveUser(userId, reason) {
  let left = false;
  for (const id of Object.keys(worldSession.players)) {
    const p = worldSession.players[id];
    if (String(p.userId) !== String(userId)) continue;
    const socket = p._socket;
    leaveWorldPlayer(p.id);
    left = true;
    if (socket) {
      try { socket.send(JSON.stringify({ type: "ended", reason: reason })); } catch (e) {}
      socket.playerId = null;
      try { socket.close(); } catch (e) {}
    }
  }
  return left;
}

app.post("/api/world/join", (req, res) => {
  if (!checkSecret(req, res)) return;
  const body = req.body || {};
  if (!body.userId || !body.name) {
    res.status(400).json({ error: "userId and name are required" });
    return;
  }
  const userId = String(body.userId);
  forceLeaveUser(userId, "You joined the world with another character.");
  const oldPass = worldByUser[userId];
  if (oldPass) delete worldPasses[oldPass];
  const pass = makeToken();
  const sheet = body.character || {};
  worldPasses[pass] = {
    userId: userId,
    role: "player",
    name: String(body.name),
    slot: num(body.slot, 1),
    dex: body.dex ? String(body.dex) : "0004",
    hp: num(sheet.hp, 30),
    maxHp: num(sheet.maxHp, num(sheet.hp, 30)),
    mp: num(sheet.mp, 10),
    maxMp: num(sheet.maxMp, num(sheet.mp, 10)),
    inventory: Array.isArray(sheet.inventory) ? sheet.inventory.filter((e) => e && e.name).map((e) => ({ name: String(e.name), count: num(e.count, 1) })) : []
  };
  worldByUser[userId] = pass;
  writeJsonFile(PASSES_FILE, worldPasses);
  res.json({ pass: pass, link: "/?session=" + WORLD_SESSION + "&pass=" + pass });
});

app.get("/api/world/assets", (req, res) => {
  res.json({ tiles: listAssetNames(TILE_ASSET_DIR), objects: listAssetNames(OBJECT_ASSET_DIR), blocking: BLOCKING_TILES });
});

app.post("/api/world/gm", (req, res) => {
  if (!checkSecret(req, res)) return;
  const userId = req.body && req.body.userId ? String(req.body.userId) : "";
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  const oldPass = worldGmByUser[userId];
  if (oldPass) delete worldPasses[oldPass];
  const pass = makeToken();
  worldPasses[pass] = { userId: userId, role: "gm" };
  worldGmByUser[userId] = pass;
  writeJsonFile(PASSES_FILE, worldPasses);
  res.json({ pass: pass, link: "/?session=" + WORLD_SESSION + "&pass=" + pass });
});

app.post("/api/world/leave", (req, res) => {
  if (!checkSecret(req, res)) return;
  const userId = req.body && req.body.userId ? String(req.body.userId) : "";
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  const left = forceLeaveUser(userId, "You were removed from the world.");
  const oldPass = worldByUser[userId];
  if (oldPass) {
    delete worldPasses[oldPass];
    delete worldByUser[userId];
    writeJsonFile(PASSES_FILE, worldPasses);
  }
  res.json({ ok: true, left: left });
});

app.get("/api/world/saves", (req, res) => {
  if (!checkSecret(req, res)) return;
  res.json({ saves: pendingSaves });
});

app.post("/api/world/ack", (req, res) => {
  if (!checkSecret(req, res)) return;
  const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids : [];
  const gone = {};
  for (const id of ids) gone[id] = true;
  pendingSaves = pendingSaves.filter((entry) => !gone[entry.id]);
  writeJsonFile(PENDING_FILE, pendingSaves);
  res.json({ ok: true, remaining: pendingSaves.length });
});

app.get("/api/world/online", (req, res) => {
  if (!checkSecret(req, res)) return;
  const list = [];
  for (const id in worldSession.players) {
    const p = worldSession.players[id];
    list.push({ userId: p.userId, name: p.name, layer: p.layer, col: p.col, row: p.row });
  }
  res.json({ online: list });
});

function worldFreeSpot(layer, col, row, ignoreId) {
  function free(c, r) {
    if (!isWalkable(layer, c, r)) return false;
    for (const id in worldSession.players) {
      const o = worldSession.players[id];
      if (o.id !== ignoreId && o.layer === layer && o.col === c && o.row === r) return false;
    }
    return true;
  }
  if (free(col, row)) return { col: col, row: row };
  for (let radius = 1; radius < 12; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (free(col + dc, row + dr)) return { col: col + dc, row: row + dr };
      }
    }
  }
  const spawn = layerSpawn(layer);
  return { col: spawn.col, row: spawn.row };
}

function teleportPlayer(p, layer, col, row) {
  for (const otherId of Object.keys(p._seen)) {
    const q = worldSession.players[otherId];
    if (q) {
      delete q._seen[p.id];
      sendPlayer(q, { type: "leave", id: p.id });
    }
  }
  p._seen = {};
  const spot = worldFreeSpot(layer, col, row, p.id);
  p.layer = layer;
  p.col = spot.col;
  p.row = spot.row;
  refreshVisibility(p);
  sendPlayer(p, { type: "teleport", layer: p.layer, col: p.col, row: p.row, direction: p.direction, players: visiblePlayersOf(p) });
  sendView(p);
  sendGms(null, { type: "gm_player", player: publicPlayer(p) });
}

function handleWorldMove(p, dir) {
  const d = DELTAS[dir];
  if (d) p.direction = dir;
  const nc = d ? p.col + d.dc : p.col;
  const nr = d ? p.row + d.dr : p.row;
  let blocked = !d || !isWalkable(p.layer, nc, nr);
  if (!blocked) {
    for (const id in worldSession.players) {
      const o = worldSession.players[id];
      if (o !== p && o.layer === p.layer && o.col === nc && o.row === nr) { blocked = true; break; }
    }
  }
  if (blocked) {
    for (const id in p._seen) {
      const q = worldSession.players[id];
      if (q) sendPlayer(q, { type: "face", id: p.id, direction: p.direction });
    }
    sendPlayer(p, { type: "moveblocked", direction: p.direction });
    return;
  }

  const L = layers[p.layer];
  const portal = tileAt(p.layer, nc, nr) === "P" && L ? L.portals[nc + "," + nr] : null;
  if (portal && validLayerNumber(portal.layer)) {
    teleportPlayer(p, portal.layer, portal.col, portal.row);
    return;
  }

  p.col = nc;
  p.row = nr;
  refreshVisibility(p);
  const moved = { type: "moved", id: p.id, col: nc, row: nr, direction: p.direction };
  sendPlayer(p, moved);
  for (const id in p._seen) {
    const q = worldSession.players[id];
    if (q) sendPlayer(q, moved);
  }
  sendGms(null, { type: "gm_player", player: publicPlayer(p) });
  sendView(p);
}

function refreshViewsForCells(layer, cells) {
  for (const id in worldSession.players) {
    const q = worldSession.players[id];
    if (q.layer !== layer) continue;
    for (const cell of cells) {
      if (cellInView(q, layer, cell[0], cell[1])) {
        sendView(q);
        break;
      }
    }
  }
}

function applyCells(layer, cells) {
  const L = ensureLayer(layer);
  const changed = [];
  const artCleared = [];
  const objectsCleared = [];
  for (const cell of cells) {
    const c = cell[0];
    const r = cell[1];
    const ch = cell[2];
    if (!Number.isInteger(c) || !Number.isInteger(r)) continue;
    if (c < 0 || c >= LAYER_W || r < 0 || r >= LAYER_H) continue;
    if (typeof ch !== "string" || ch.length !== 1 || TILE_CHARS.indexOf(ch) === -1) continue;
    const old = L.rows[r][c];
    if (old === ch) continue;
    L.rows[r] = L.rows[r].substring(0, c) + ch + L.rows[r].substring(c + 1);
    if (old === "P" && ch !== "P") delete L.portals[c + "," + r];
    if (ch === " ") {
      if (L.art[r][c] !== " ") {
        L.art[r] = L.art[r].substring(0, c) + " " + L.art[r].substring(c + 1);
        artCleared.push([c, r, ""]);
      }
      if (L.objects[c + "," + r]) {
        delete L.objects[c + "," + r];
        objectsCleared.push([c, r, "", 0]);
      }
    }
    changed.push([c, r, ch]);
  }
  if (changed.length > 0) {
    scheduleLayerSave();
    sendGms(layer, { type: "gm_tiles", layer: layer, cells: changed });
    if (artCleared.length > 0) sendGms(layer, { type: "gm_art", layer: layer, cells: artCleared });
    if (objectsCleared.length > 0) sendGms(layer, { type: "gm_objs", layer: layer, cells: objectsCleared });
    refreshViewsForCells(layer, changed);
  }
  return changed;
}

function applyArt(layer, ops) {
  const L = ensureLayer(layer);
  const names = listAssetNames(TILE_ASSET_DIR);
  const changedArt = [];
  const logicCells = [];
  for (const op of ops) {
    const c = op[0];
    const r = op[1];
    const name = typeof op[2] === "string" ? op[2] : "";
    if (!Number.isInteger(c) || !Number.isInteger(r)) continue;
    if (c < 0 || c >= LAYER_W || r < 0 || r >= LAYER_H) continue;
    const oldCh = L.art[r][c];
    const oldName = oldCh === " " ? "" : (tilePalette[oldCh] || "");
    const logic = L.rows[r][c];
    if (name === "") {
      if (oldCh === " ") continue;
      L.art[r] = L.art[r].substring(0, c) + " " + L.art[r].substring(c + 1);
      if (logic === "x" && isBlockingTile(oldName)) logicCells.push([c, r, "."]);
      changedArt.push([c, r, ""]);
      continue;
    }
    if (names.indexOf(name) === -1) continue;
    const ch = paletteChar(name);
    if (!ch) continue;
    if (oldCh === ch) continue;
    L.art[r] = L.art[r].substring(0, c) + ch + L.art[r].substring(c + 1);
    changedArt.push([c, r, name]);
    if (logic === "P") continue;
    if (isBlockingTile(name)) {
      if (logic !== "x") logicCells.push([c, r, "x"]);
    } else if (logic === " ") {
      logicCells.push([c, r, "."]);
    } else if (logic === "x" && isBlockingTile(oldName)) {
      logicCells.push([c, r, "."]);
    }
  }
  if (logicCells.length > 0) applyCells(layer, logicCells);
  if (changedArt.length > 0) {
    scheduleLayerSave();
    sendGms(layer, { type: "gm_art", layer: layer, cells: changedArt });
    refreshViewsForCells(layer, changedArt);
  }
}

function applyObjects(layer, ops) {
  const L = ensureLayer(layer);
  const names = listAssetNames(OBJECT_ASSET_DIR);
  const changedObjs = [];
  for (const op of ops) {
    const c = op[0];
    const r = op[1];
    const name = typeof op[2] === "string" ? op[2] : "";
    const solid = op[3] === 0 || op[3] === false ? false : true;
    if (!Number.isInteger(c) || !Number.isInteger(r)) continue;
    if (c < 0 || c >= LAYER_W || r < 0 || r >= LAYER_H) continue;
    const key = c + "," + r;
    const old = L.objects[key];
    if (name === "") {
      if (!old) continue;
      delete L.objects[key];
      changedObjs.push([c, r, "", 0]);
      continue;
    }
    if (names.indexOf(name) === -1) continue;
    if (old && old.name === name && old.solid === solid) continue;
    L.objects[key] = { name: name, solid: solid };
    changedObjs.push([c, r, name, solid ? 1 : 0]);
  }
  if (changedObjs.length > 0) {
    scheduleLayerSave();
    sendGms(layer, { type: "gm_objs", layer: layer, cells: changedObjs });
    refreshViewsForCells(layer, changedObjs);
  }
}

function layerSummaries() {
  const counts = {};
  for (const id in worldSession.players) {
    const lay = worldSession.players[id].layer;
    counts[lay] = (counts[lay] || 0) + 1;
  }
  const out = [];
  const seen = {};
  for (const key of Object.keys(layers)) {
    const n = parseInt(key, 10);
    if (layerHasContent(layers[key]) || counts[n]) {
      out.push({ layer: n, name: layers[key].name, players: counts[n] || 0 });
      seen[n] = true;
    }
  }
  for (const key of Object.keys(counts)) {
    const n = parseInt(key, 10);
    if (!seen[n]) out.push({ layer: n, name: "", players: counts[n] });
  }
  out.sort((a, b) => a.layer - b.layer);
  return out;
}

function sendLayerSummaries() {
  sendGms(null, { type: "gm_layers", layers: layerSummaries() });
}

function sendGmLayer(gm) {
  const L = layers[gm.layer] || makeLayer("");
  const items = [];
  for (const it of worldSession.floorItems) {
    if (it.layer === gm.layer) items.push({ col: it.col, row: it.row, name: it.name });
  }
  const objList = [];
  for (const k of Object.keys(L.objects)) {
    const parts = k.split(",");
    objList.push([parseInt(parts[0], 10), parseInt(parts[1], 10), L.objects[k].name, L.objects[k].solid ? 1 : 0]);
  }
  sendSocket(gm.socket, { type: "gm_layer", layer: gm.layer, name: L.name, rows: L.rows.map((row) => row.replace(/ +$/, "")), art: L.art.map((row) => row.replace(/ +$/, "")), palette: tilePalette, objects: objList, portals: L.portals, spawn: L.spawn, floorItems: items, layers: layerSummaries() });
}

function handleGmMessage(gm, data) {
  if (data.type === "gm_layer") {
    const n = parseInt(data.layer, 10);
    if (!validLayerNumber(n)) return;
    gm.layer = n;
    sendGmLayer(gm);
    return;
  }

  if (data.type === "gm_edit") {
    const n = parseInt(data.layer, 10);
    if (!validLayerNumber(n) || !Array.isArray(data.ops)) return;
    applyCells(n, data.ops.slice(0, MAX_EDIT_OPS));
    sendLayerSummaries();
    return;
  }

  if (data.type === "gm_art") {
    const n = parseInt(data.layer, 10);
    if (!validLayerNumber(n) || !Array.isArray(data.ops)) return;
    applyArt(n, data.ops.slice(0, MAX_EDIT_OPS));
    sendLayerSummaries();
    return;
  }

  if (data.type === "gm_obj") {
    const n = parseInt(data.layer, 10);
    if (!validLayerNumber(n) || !Array.isArray(data.ops)) return;
    applyObjects(n, data.ops.slice(0, MAX_EDIT_OPS));
    sendLayerSummaries();
    return;
  }

  if (data.type === "gm_portal") {
    const n = parseInt(data.layer, 10);
    const c = parseInt(data.col, 10);
    const r = parseInt(data.row, 10);
    const tl = parseInt(data.toLayer, 10);
    const tc = parseInt(data.toCol, 10);
    const tr = parseInt(data.toRow, 10);
    if (!validLayerNumber(n) || !validLayerNumber(tl)) return;
    if (![c, r, tc, tr].every((v) => Number.isInteger(v) && v >= 0 && v < LAYER_W)) return;
    applyCells(n, [[c, r, "P"]]);
    ensureLayer(n).portals[c + "," + r] = { layer: tl, col: tc, row: tr };
    if (data.twoWay) {
      applyCells(tl, [[tc, tr, "P"]]);
      ensureLayer(tl).portals[tc + "," + tr] = { layer: n, col: c, row: r };
    }
    scheduleLayerSave();
    for (const gmEntry of worldGms) {
      if (gmEntry.layer === n || gmEntry.layer === tl) sendGmLayer(gmEntry);
    }
    sendLayerSummaries();
    return;
  }

  if (data.type === "gm_spawn") {
    const n = parseInt(data.layer, 10);
    const c = parseInt(data.col, 10);
    const r = parseInt(data.row, 10);
    if (!validLayerNumber(n) || !Number.isInteger(c) || !Number.isInteger(r)) return;
    if (c < 0 || c >= LAYER_W || r < 0 || r >= LAYER_H) return;
    ensureLayer(n).spawn = { col: c, row: r };
    scheduleLayerSave();
    for (const gmEntry of worldGms) {
      if (gmEntry.layer === n) sendGmLayer(gmEntry);
    }
    return;
  }

  if (data.type === "gm_layername") {
    const n = parseInt(data.layer, 10);
    if (!validLayerNumber(n)) return;
    ensureLayer(n).name = String(data.name || "").slice(0, 40);
    scheduleLayerSave();
    sendLayerSummaries();
    return;
  }

  if (data.type === "gm_item") {
    const n = parseInt(data.layer, 10);
    const c = parseInt(data.col, 10);
    const r = parseInt(data.row, 10);
    if (!validLayerNumber(n) || !Number.isInteger(c) || !Number.isInteger(r)) return;
    const name = String(data.name || "").slice(0, 60);
    let idx = -1;
    for (let i = 0; i < worldSession.floorItems.length; i++) {
      const it = worldSession.floorItems[i];
      if (it.layer === n && it.col === c && it.row === r) { idx = i; break; }
    }
    if (idx !== -1) {
      worldSession.floorItems.splice(idx, 1);
      notifyItem(n, c, r, { type: "itemremoved", col: c, row: r });
    }
    if (name) {
      worldSession.floorItems.push({ layer: n, col: c, row: r, name: name });
      notifyItem(n, c, r, { type: "itemadded", col: c, row: r, name: name });
    }
    return;
  }

  if (data.type === "gm_tp") {
    const p = worldSession.players[data.playerId];
    const n = parseInt(data.layer, 10);
    const c = parseInt(data.col, 10);
    const r = parseInt(data.row, 10);
    if (!p || !validLayerNumber(n) || !Number.isInteger(c) || !Number.isInteger(r)) return;
    teleportPlayer(p, n, c, r);
    sendLayerSummaries();
    return;
  }

  if (data.type === "gmchat") {
    const text = String(data.text || "").slice(0, 300);
    for (const id in worldSession.players) {
      sendPlayer(worldSession.players[id], { type: "gmchat", text: text, ts: Date.now() });
    }
    return;
  }
}

function handleWorldGmConnection(socket, info) {
  const gm = { socket: socket, userId: info.userId, layer: 0 };
  socket.sessionId = WORLD_GM_SESSION;
  socket.role = "gm";
  socket.playerId = null;
  worldGms.push(gm);

  sendSocket(socket, { type: "init", id: null, role: "gm", world: true, turn: 1, players: {}, floorItems: [] });
  const list = [];
  for (const id in worldSession.players) list.push(publicPlayer(worldSession.players[id]));
  sendSocket(socket, { type: "gm_players", players: list });
  sendGmLayer(gm);

  socket.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return;
    }
    handleGmMessage(gm, data);
  });

  socket.on("close", () => {
    const idx = worldGms.indexOf(gm);
    if (idx !== -1) worldGms.splice(idx, 1);
  });
}

function handleWorldConnection(socket, pass) {
  const info = pass ? worldPasses[pass] : null;
  if (!info) {
    socket.send(JSON.stringify({ type: "denied", reason: "This world link is invalid or expired. Use /joinworld in Discord to get a new one." }));
    socket.close();
    return;
  }

  if (info.role === "gm") {
    handleWorldGmConnection(socket, info);
    return;
  }

  forceLeaveUser(info.userId, "You opened the world in another window.");

  const id = worldSession.nextId;
  worldSession.nextId = worldSession.nextId + 1;
  socket.sessionId = WORLD_SESSION;
  socket.role = "player";
  socket.playerId = id;
  socket.userId = info.userId;

  const key = info.userId + "|" + info.name;
  const saved = worldState.positions[key];
  let layer = 0;
  let startCol = layerSpawn(0).col;
  let startRow = layerSpawn(0).row;
  if (saved && Number.isInteger(saved.col) && Number.isInteger(saved.row)) {
    const savedLayer = Number.isInteger(saved.layer) ? saved.layer : 0;
    if (layers[savedLayer]) {
      layer = savedLayer;
      startCol = saved.col;
      startRow = saved.row;
    }
  }
  const start = worldFreeSpot(layer, startCol, startRow, id);
  const inventory = info.inventory.map((e) => ({ name: e.name, count: e.count }));

  const p = {
    id: id,
    layer: layer,
    col: start.col,
    row: start.row,
    direction: saved && saved.direction ? saved.direction : "down",
    dex: info.dex,
    name: info.name,
    userId: info.userId,
    hp: info.hp,
    maxHp: info.maxHp,
    mp: info.mp,
    maxMp: info.maxMp,
    _key: key,
    _slot: info.slot,
    _pass: pass,
    _inv: inventory,
    _reported: countInventory(inventory),
    _seen: {},
    _socket: socket
  };
  worldSession.players[id] = p;
  refreshVisibility(p);

  const w = VIEW_HALF_W * 2 + 1;
  const h = VIEW_HALF_H * 2 + 1;
  const players = {};
  for (const seenId in p._seen) {
    const q = worldSession.players[seenId];
    if (q) players[seenId] = publicPlayer(q);
  }
  players[id] = publicPlayer(p);
  sendPlayer(p, { type: "init", id: id, role: "player", world: true, layer: p.layer, turn: 1, players: players, floorItems: itemsInWindow(p.layer, p.col - VIEW_HALF_W, p.row - VIEW_HALF_H, w, h), inventory: inventory });
  sendView(p);
  sendGms(null, { type: "gm_player", player: publicPlayer(p) });
  sendLayerSummaries();

  socket.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return;
    }
    const me = worldSession.players[socket.playerId];
    if (!me || socket.playerId === null) return;

    if (data.type === "face") {
      if (DELTAS[data.direction]) me.direction = data.direction;
      for (const seenId in me._seen) {
        const q = worldSession.players[seenId];
        if (q) sendPlayer(q, { type: "face", id: me.id, direction: me.direction });
      }
    } else if (data.type === "exit") {
      const exitUser = me.userId;
      forceLeaveUser(exitUser, "You left the world. Your character is saved.");
      sendLayerSummaries();
    } else if (data.type === "move") {
      handleWorldMove(me, data.dir);
    } else if (data.type === "pickup") {
      let idx = -1;
      for (let i = 0; i < worldSession.floorItems.length; i++) {
        const it = worldSession.floorItems[i];
        if (it.layer === me.layer && it.col === me.col && it.row === me.row) { idx = i; break; }
      }
      if (idx !== -1) {
        const it = worldSession.floorItems[idx];
        worldSession.floorItems.splice(idx, 1);
        let stack = null;
        for (const entry of me._inv) {
          if (entry.name === it.name) { stack = entry; break; }
        }
        if (stack) {
          stack.count = stack.count + 1;
        } else {
          me._inv.push({ name: it.name, count: 1 });
        }
        notifyItem(me.layer, it.col, it.row, { type: "itemremoved", col: it.col, row: it.row });
        sendPlayer(me, { type: "pickedup", name: it.name });
      }
    } else if (data.type === "drop") {
      const name = String(data.name || "");
      let stackIndex = -1;
      for (let i = 0; i < me._inv.length; i++) {
        if (me._inv[i].name === name) { stackIndex = i; break; }
      }
      if (!name || stackIndex === -1) {
        sendPlayer(me, { type: "dropfail" });
        return;
      }
      let occupied = false;
      for (const fi of worldSession.floorItems) {
        if (fi.layer === me.layer && fi.col === me.col && fi.row === me.row) { occupied = true; break; }
      }
      if (occupied) {
        sendPlayer(me, { type: "dropfail" });
        return;
      }
      me._inv[stackIndex].count = me._inv[stackIndex].count - 1;
      if (me._inv[stackIndex].count <= 0) me._inv.splice(stackIndex, 1);
      worldSession.floorItems.push({ layer: me.layer, col: me.col, row: me.row, name: name });
      notifyItem(me.layer, me.col, me.row, { type: "itemadded", col: me.col, row: me.row, name: name });
      sendPlayer(me, { type: "dropok", name: name });
    } else if (data.type === "chat") {
      const text = String(data.text || "").slice(0, 200);
      const message = { type: "chat", id: me.id, dex: me.dex, name: me.name, text: text };
      for (const seenId in me._seen) {
        const q = worldSession.players[seenId];
        if (q) sendPlayer(q, message);
      }
      sendGms(me.layer, message);
    }
  });

  socket.on("close", () => {
    if (socket.playerId === null || socket.playerId === undefined) return;
    leaveWorldPlayer(socket.playerId);
    sendLayerSummaries();
  });
}

setInterval(saveWorldState, WORLD_SAVE_INTERVAL);

setInterval(() => {
  for (const id in worldSession.players) {
    queueWorldSave(worldSession.players[id], false);
  }
}, WORLD_CHECKPOINT_INTERVAL);

function shutdownWorld() {
  for (const id of Object.keys(worldSession.players)) {
    leaveWorldPlayer(worldSession.players[id].id);
  }
  saveWorldState();
  saveLayersNow();
  process.exit(0);
}

process.on("SIGINT", shutdownWorld);
process.on("SIGTERM", shutdownWorld);

wss.on("connection", (socket, req) => {
  let sessionId = "default";
  let pass = null;
  try {
    const parsed = new URL(req.url, "http://localhost");
    sessionId = parsed.searchParams.get("session") || "default";
    pass = parsed.searchParams.get("pass");
  } catch (e) {
    sessionId = "default";
  }

  if (sessionId === WORLD_SESSION) {
    handleWorldConnection(socket, pass);
    return;
  }

  const passInfo = pass ? passcodes[pass] : null;
  const role = passInfo ? passInfo.role : "player";

  const session = getSession(sessionId);
  socket.sessionId = sessionId;
  socket.role = role;

  if (role === "gm") {
    socket.playerId = null;
    socket.send(JSON.stringify({ type: "init", id: null, role: "gm", turn: session.turnNumber, map: MAP, players: session.players, floorItems: session.floorItems }));
  } else {
    const id = session.nextId;
    session.nextId = session.nextId + 1;
    socket.playerId = id;
    socket.userId = passInfo ? passInfo.userId : null;

    let dex = DEXES[(id - 1) % DEXES.length];
    let displayName = "";
    let sheet = null;
    const run = runs[sessionId];
    if (passInfo && run && Array.isArray(run.roster)) {
      for (const entry of run.roster) {
        if (String(entry.userId) === String(passInfo.userId)) {
          if (entry.dex) dex = String(entry.dex);
          displayName = entry.name || "";
          sheet = entry.character || entry;
          break;
        }
      }
    }
    if (!displayName && passInfo) displayName = passInfo.name || "";

    let maxHp = 30, hp = 30, maxMp = 10, mp = 10;
    if (sheet) {
      const st = sheet.stats || {};
      maxHp = num(sheet.maxHp, num(st.hp, num(sheet.hp, 30)));
      hp = num(sheet.hp, maxHp);
      maxMp = num(sheet.maxMp, num(st.mp, num(sheet.mp, 10)));
      mp = num(sheet.mp, maxMp);
    }

    const spawn = SPAWNS[(id - 1) % SPAWNS.length];
    session.players[id] = { id: id, col: spawn.col, row: spawn.row, direction: "down", dex: dex, name: displayName, userId: socket.userId, hp: hp, maxHp: maxHp, mp: mp, maxMp: maxMp };
    if (sheet) session.characters[id] = sheet;
    socket.send(JSON.stringify({ type: "init", id: id, role: "player", turn: session.turnNumber, map: MAP, players: session.players, floorItems: session.floorItems }));
    broadcast(sessionId, { type: "join", player: session.players[id] }, id);
  }

  socket.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return;
    }
    const s = sessions[sessionId];
    if (!s) return;

    if (data.type === "endSession") {
      if (socket.role !== "gm") return;
      const run = runs[sessionId];
      if (run) {
        run.status = "finished";
        if (!run.results) run.results = [];
      }
      broadcast(sessionId, { type: "ended" });
      return;
    }

    if (data.type === "gmchat") {
      if (socket.role !== "gm") return;
      const text = String(data.text || "").slice(0, 300);
      broadcast(sessionId, { type: "gmchat", text: text, ts: Date.now() }, socket.playerId);
      return;
    }

    const pid = socket.playerId;
    if (pid === null || !s.players[pid]) return;

    if (data.type === "face") {
      s.players[pid].direction = data.direction;
      broadcast(sessionId, { type: "face", id: pid, direction: s.players[pid].direction }, pid);
    } else if (data.type === "move") {
      handleMove(sessionId, pid, data.dir);
    } else if (data.type === "pickup") {
      const p = s.players[pid];
      let idx = -1;
      for (let i = 0; i < s.floorItems.length; i++) {
        if (s.floorItems[i].col === p.col && s.floorItems[i].row === p.row) { idx = i; break; }
      }
      if (idx !== -1) {
        const it = s.floorItems[idx];
        s.floorItems.splice(idx, 1);
        broadcast(sessionId, { type: "itemremoved", col: it.col, row: it.row });
        sendToPlayer(sessionId, pid, { type: "pickedup", name: it.name });
      }
    } else if (data.type === "drop") {
      const p = s.players[pid];
      const name = String(data.name || "");
      if (name) {
        let occupied = false;
        for (const fi of s.floorItems) {
          if (fi.col === p.col && fi.row === p.row) { occupied = true; break; }
        }
        if (occupied) {
          sendToPlayer(sessionId, pid, { type: "dropfail" });
        } else {
          s.floorItems.push({ col: p.col, row: p.row, name: name });
          broadcast(sessionId, { type: "itemadded", col: p.col, row: p.row, name: name });
          sendToPlayer(sessionId, pid, { type: "dropok", name: name });
        }
      }
    } else if (data.type === "intent") {
      onIntent(sessionId, pid, data.dir);
    } else if (data.type === "chat") {
      const text = String(data.text || "").slice(0, 200);
      broadcast(sessionId, { type: "chat", id: pid, dex: s.players[pid].dex, text: text }, pid);
    }
  });

  socket.on("close", () => {
    const s = sessions[sessionId];
    if (!s) return;
    const pid = socket.playerId;
    if (pid !== null) {
      delete s.players[pid];
      delete s.intents[pid];
      delete s.characters[pid];
      broadcast(sessionId, { type: "leave", id: pid }, pid);
    }
    if (!sessionHasSockets(sessionId)) {
      if (s.turnTimer !== null) clearTimeout(s.turnTimer);
      delete sessions[sessionId];
    } else if (s.turnTimer !== null && allSubmitted(s)) {
      resolveTurn(sessionId);
    }
  });
});

server.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});