const express = require("express");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const worldCombat = require("./worldCombat");
const worldItems = require("./worldItems");
const ITEM_FX = worldItems.allInfo();
const { getMoveData } = require("./Utils/Combat/moveData");

const app = express();
const PORT = process.env.PORT || 3000;

const ITEMS_DIR = path.join(__dirname, "StorageData", "Items");
let itemIndexCache = { at: 0, data: null };

function scanItemIcons(dir, root, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanItemIcons(full, root, out);
    } else if (entry.name.toLowerCase().endsWith(".png")) {
      const rel = path.relative(root, full).split(path.sep).join("/");
      out[entry.name.slice(0, -4)] = "/items/" + rel;
    }
  }
}

function currentItemIndex() {
  const now = Date.now();
  if (!itemIndexCache.data || now - itemIndexCache.at > 10000) {
    const fresh = {};
    try {
      const old = JSON.parse(fs.readFileSync(path.join(__dirname, "public", "items-index.json"), "utf8"));
      for (const k of Object.keys(old)) fresh[k] = old[k];
    } catch (e) {}
    scanItemIcons(ITEMS_DIR, ITEMS_DIR, fresh);
    itemIndexCache = { at: now, data: fresh, lower: null };
  }
  return itemIndexCache.data;
}

function canonItemName(raw) {
  const wanted = String(raw || "").trim();
  if (!wanted) return null;
  const index = currentItemIndex();
  if (!itemIndexCache.lower) {
    const lower = {};
    for (const k of Object.keys(index)) lower[k.toLowerCase()] = k;
    const effectNames = Object.keys(require("./Utils/battleItems").allEffects());
    for (const k of effectNames) {
      if (!lower[k.toLowerCase()]) lower[k.toLowerCase()] = k;
    }
    itemIndexCache.lower = lower;
  }
  return itemIndexCache.lower[wanted.toLowerCase()] || wanted.slice(0, 80);
}

app.get("/items-index.json", (req, res) => {
  res.set("Cache-Control", "no-cache");
  res.json(currentItemIndex());
});

app.use(express.static(path.join(__dirname, "public")));
app.use("/items", express.static(path.join(__dirname, "StorageData", "Items")));
app.use("/combaticons", express.static(path.join(__dirname, "StorageData", "CombatSprites")));
app.get("/assets/tilemap/:file", (req, res, next) => {
  const file = findTileFile(req.params.file);
  if (!file) return next();
  res.sendFile(file);
});
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
const PALETTE_CHARS = (() => {
  let chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let code = 0x00c0; code <= 0x024f; code++) {
    if (code === 0x00d7 || code === 0x00f7) continue;
    chars += String.fromCharCode(code);
  }
  return chars;
})();
const TILE_ROTATIONS = [0, 90, 180, 270];

function parseTileName(full) {
  const text = String(full || "");
  const at = text.lastIndexOf("@");
  if (at > 0) {
    const m = text.substring(at + 1).match(/^(90|180|270)?(f)?$/);
    if (m && (m[1] || m[2])) return { base: text.substring(0, at), rot: m[1] ? parseInt(m[1], 10) : 0, flip: !!m[2] };
  }
  return { base: text, rot: 0, flip: false };
}
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

const TILE_CATEGORIES = ["Default", "Ocean", "River", "Volcanic", "Underwater", "Forest", "Meadow", "Plains", "Settlements", "Hills", "Mountains", "Sky", "Other"];

function tileCategoryFolders() {
  const folders = [];
  const seen = {};
  const add = (name) => {
    if (seen[name.toLowerCase()]) return;
    seen[name.toLowerCase()] = true;
    folders.push(name);
  };
  for (const name of TILE_CATEGORIES) add(name);
  try {
    for (const entry of fs.readdirSync(TILE_ASSET_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) add(entry.name);
    }
  } catch (e) {}
  return folders;
}

const TILE_SCAN_TTL = 3000;
const TILE_SCAN_DEPTH = 8;
let tileScanCache = { at: 0, data: null };

function walkTileFolder(dir, depth, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  entries.sort((x, y) => x.name.localeCompare(y.name));
  for (const entry of entries) {
    if (entry.isFile() && /\.png$/i.test(entry.name)) {
      out.push({ file: path.join(dir, entry.name), base: entry.name.replace(/\.png$/i, ""), parent: path.basename(dir) });
    }
  }
  if (depth >= TILE_SCAN_DEPTH) return;
  for (const entry of entries) {
    if (entry.isDirectory()) walkTileFolder(path.join(dir, entry.name), depth + 1, out);
  }
}

function scanTiles(force) {
  const now = Date.now();
  if (!force && tileScanCache.data && now - tileScanCache.at < TILE_SCAN_TTL) return tileScanCache.data;
  const files = {};
  const taken = {};
  const categories = [];
  const claimName = (found) => {
    let name = found.base;
    if (taken[name.toLowerCase()]) name = found.parent + " - " + found.base;
    let n = 2;
    const root = name;
    while (taken[name.toLowerCase()]) {
      name = root + " (" + n + ")";
      n++;
    }
    taken[name.toLowerCase()] = true;
    files[name] = found.file;
    return name;
  };
  const folders = tileCategoryFolders();
  const rootLoose = [];
  try {
    for (const entry of fs.readdirSync(TILE_ASSET_DIR, { withFileTypes: true })) {
      if (entry.isFile() && /\.png$/i.test(entry.name)) rootLoose.push({ file: path.join(TILE_ASSET_DIR, entry.name), base: entry.name.replace(/\.png$/i, ""), parent: path.basename(TILE_ASSET_DIR) });
    }
  } catch (e) {}
  rootLoose.sort((x, y) => x.base.localeCompare(y.base));
  for (const folder of folders) {
    const found = [];
    walkTileFolder(path.join(TILE_ASSET_DIR, folder), 0, found);
    const tiles = [];
    if (folder === "Default") {
      for (const f of rootLoose) tiles.push(claimName(f));
    }
    for (const f of found) tiles.push(claimName(f));
    tiles.sort();
    if (tiles.length > 0 || TILE_CATEGORIES.includes(folder)) categories.push({ name: folder, tiles: tiles });
  }
  if (!folders.includes("Default") && rootLoose.length > 0) {
    categories.unshift({ name: "Default", tiles: rootLoose.map(claimName).sort() });
  }
  tileScanCache = { at: now, data: { categories: categories, files: files } };
  return tileScanCache.data;
}

function tileCategoryList() {
  return scanTiles(false).categories;
}

function allTileNames() {
  return Object.keys(scanTiles(false).files).sort();
}

function findTileFile(name) {
  const wanted = String(name).replace(/\.png$/i, "");
  if (!wanted) return null;
  let data = scanTiles(false);
  if (!data.files[wanted]) data = scanTiles(true);
  return data.files[wanted] || null;
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
  sendPlayer(p, { type: "view", layer: p.layer, c0: c0, r0: r0, rows: rows, art: artRows, palette: tilePalette, objects: objectsInWindow(p.layer, c0, r0, w, h), entities: entitiesInWindow(p.layer, c0, r0, w, h), items: itemsInWindow(p.layer, c0, r0, w, h) });
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
  const kills = Array.isArray(p._kills) ? p._kills.splice(0) : [];
  const vitalsChanged = p.hp !== p._reportedHp || p.mp !== p._reportedMp;
  const accDirty = !!p._accDirty;
  if (!final && Object.keys(delta).length === 0 && kills.length === 0 && !vitalsChanged && !accDirty) return;
  const ailments = p._sheet && Array.isArray(p._sheet.ailments) ? p._sheet.ailments : [];
  const entry = { id: makeToken(), kind: p._npcName ? "npc" : undefined, npcName: p._npcName || undefined, userId: p.userId, name: p.name, slot: p._slot, pass: p._pass, delta: delta, kills: kills, hp: p.hp, mp: p.mp, ailments: ailments, layer: p.layer, col: p.col, row: p.row, final: final, ts: Date.now() };
  if (accDirty && p._sheet && p._sheet.accessories) {
    const a = p._sheet.accessories;
    entry.accessories = { head: a.head || null, neck: a.neck || null, back: a.back || null };
    p._accDirty = false;
  }
  pendingSaves.push(entry);
  p._reported = current;
  p._reportedHp = p.hp;
  p._reportedMp = p.mp;
  writeJsonFile(PENDING_FILE, pendingSaves);
}

function queueCompanionSave(e, final) {
  const kills = Array.isArray(e._kills) ? e._kills.splice(0) : [];
  const vitalsChanged = e.hp !== e._reportedHp || e.mp !== e._reportedMp;
  if (!final && kills.length === 0 && !vitalsChanged) return;
  const ailments = e._sheet && Array.isArray(e._sheet.ailments) ? e._sheet.ailments : [];
  pendingSaves.push({ id: makeToken(), kind: "npc", userId: e.userId, npcName: e.npcName, name: e.name, pass: e._pass, delta: {}, kills: kills, hp: e.hp, mp: e.mp, ailments: ailments, final: final, ts: Date.now() });
  e._reportedHp = e.hp;
  e._reportedMp = e.mp;
  writeJsonFile(PENDING_FILE, pendingSaves);
}

function companionsOf(p) {
  const list = [];
  if (!p._companions) return list;
  for (const id of p._companions) {
    const e = entities[id];
    if (e) list.push(e);
  }
  return list;
}

const COMPANION_FOLLOW_MS = 380;
const COMPANION_NEAR = 2;
const COMPANION_LEASH = 12;

function cleanCompanion(src) {
  if (!src || typeof src !== "object" || !src.npcName) return null;
  const sheet = src.character || {};
  return {
    npcName: String(src.npcName).slice(0, 60),
    name: String(src.name || src.npcName).slice(0, 40),
    dex: src.dex ? String(src.dex) : "0004",
    hp: Math.max(1, num(sheet.hp, 30)),
    maxHp: Math.max(1, num(sheet.maxHp, num(sheet.hp, 30))),
    mp: num(sheet.mp, 10),
    maxMp: num(sheet.maxMp, num(sheet.mp, 10)),
    inventory: Array.isArray(sheet.inventory) ? sheet.inventory.filter((x) => x && x.name).map((x) => ({ name: String(x.name), count: num(x.count, 1) })) : [],
    sheet: cleanSheet(sheet)
  };
}

function spawnCompanions(p, info) {
  p._companions = [];
  const list = Array.isArray(info.companions) ? info.companions : [];
  for (const c of list) {
    const id = "e" + entityNextId;
    entityNextId = entityNextId + 1;
    const spot = worldFreeSpot(p.layer, p.col, p.row, null);
    const inv = c.inventory.map((x) => ({ name: x.name, count: x.count }));
    const e = {
      id: id,
      kind: "companion",
      name: c.name,
      npcName: c.npcName,
      species: c.sheet.species,
      dex: c.dex,
      level: c.sheet.level,
      layer: p.layer,
      col: spot.col,
      row: spot.row,
      homeCol: spot.col,
      homeRow: spot.row,
      direction: p.direction,
      state: "idle",
      lines: [],
      wander: 0,
      sensor: 0,
      hp: c.hp,
      maxHp: c.maxHp,
      mp: c.mp,
      maxMp: c.maxMp,
      userId: p.userId,
      ownerPlayerId: p.id,
      _pass: p._pass,
      _sheet: c.sheet,
      _inv: inv,
      _kills: [],
      _fight: null,
      _reportedHp: c.hp,
      _reportedMp: c.mp,
      down: false
    };
    entities[id] = e;
    p._companions.push(id);
    broadcastEntity(e, null, 0, 0);
  }
}

function companionMoveTo(e, layer, col, row) {
  const oldLayer = e.layer;
  const oldCol = e.col;
  const oldRow = e.row;
  e.layer = layer;
  e.col = col;
  e.row = row;
  broadcastEntity(e, oldLayer, oldCol, oldRow);
}

function companionSnap(p) {
  for (const e of companionsOf(p)) {
    if (e._fight || e.down) continue;
    const spot = worldFreeSpot(p.layer, p.col, p.row, null);
    companionMoveTo(e, p.layer, spot.col, spot.row);
  }
}

function companionStepFree(e, c, r) {
  if (!isWalkable(e.layer, c, r)) return false;
  if (entityAt(e.layer, c, r, e.id)) return false;
  if (playerAt(e.layer, c, r)) return false;
  return true;
}

function companionFollowTick() {
  for (const id in worldSession.players) {
    const p = worldSession.players[id];
    if (!p._companions || p._companions.length === 0) continue;
    if (p._fight) continue;
    for (const e of companionsOf(p)) {
      if (e._fight || e.down) continue;
      const dist = e.layer === p.layer ? Math.max(Math.abs(e.col - p.col), Math.abs(e.row - p.row)) : Infinity;
      if (dist > COMPANION_LEASH) {
        const spot = worldFreeSpot(p.layer, p.col, p.row, null);
        companionMoveTo(e, p.layer, spot.col, spot.row);
        continue;
      }
      if (dist <= COMPANION_NEAR) continue;
      const steps = dist > 5 ? 2 : 1;
      for (let s = 0; s < steps; s++) {
        const dc = p.col - e.col;
        const dr = p.row - e.row;
        if (Math.max(Math.abs(dc), Math.abs(dr)) <= COMPANION_NEAR) break;
        const tries = [];
        const horizontal = dc === 0 ? null : (dc > 0 ? "right" : "left");
        const vertical = dr === 0 ? null : (dr > 0 ? "down" : "up");
        if (Math.abs(dc) >= Math.abs(dr)) tries.push(horizontal, vertical);
        else tries.push(vertical, horizontal);
        const sides = ["up", "down", "left", "right"];
        for (const d of sides) tries.push(d);
        let moved = false;
        for (const dir of tries) {
          if (!dir) continue;
          const d = DELTAS[dir];
          const nc = e.col + d.dc;
          const nr = e.row + d.dr;
          const before = Math.abs(p.col - e.col) + Math.abs(p.row - e.row);
          const after = Math.abs(p.col - nc) + Math.abs(p.row - nr);
          if (after >= before && dir !== horizontal && dir !== vertical) continue;
          if (!companionStepFree(e, nc, nr)) continue;
          const oc = e.col;
          const or = e.row;
          e.col = nc;
          e.row = nr;
          e.direction = dir;
          broadcastEntity(e, e.layer, oc, or);
          moved = true;
          break;
        }
        if (!moved) break;
      }
    }
  }
}

function leaveWorldPlayer(id) {
  const p = worldSession.players[id];
  if (!p) return false;
  worldCombat.onPlayerLeave(p);
  for (const ce of companionsOf(p)) {
    queueCompanionSave(ce, true);
    removeEntity(ce.id);
  }
  p._companions = [];
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

function clientSheet(sh) {
  return { species: sh.species, level: sh.level, types: sh.types, coins: sh.coins, capacity: sh.capacity, accessories: sh.accessories, moves: sh.moves.map((m) => m.name), moveInfo: worldCombat.sheetMoveInfo(sh) };
}

function cleanSheet(sheet) {
  const acc = sheet.accessories || {};
  const accName = (v) => (v ? String(v).slice(0, 80) : null);
  const out = {
    species: sheet.species ? String(sheet.species) : "",
    level: num(sheet.level, 1),
    exp: num(sheet.exp, 0),
    types: Array.isArray(sheet.types) ? sheet.types.map(String) : [],
    attack: num(sheet.attack, 1),
    defense: num(sheet.defense, 1),
    spAtk: num(sheet.spAtk, 1),
    spDef: num(sheet.spDef, 1),
    speed: num(sheet.speed, 1),
    moves: Array.isArray(sheet.moves) ? sheet.moves.filter((m) => m && m.name).slice(0, 4).map((m) => ({ name: String(m.name), data: m.data && typeof m.data === "object" ? m.data : null })) : [],
    ailments: Array.isArray(sheet.ailments) ? sheet.ailments : [],
    immunities: Array.isArray(sheet.immunities) ? sheet.immunities.map(String) : [],
    gender: sheet.gender ? String(sheet.gender) : null,
    mood: sheet.mood ? String(sheet.mood) : "Neutral",
    badge: sheet.badge ? String(sheet.badge) : "Normal",
    coins: num(sheet.coins, 0),
    capacity: Math.max(1, Math.min(200, num(sheet.capacity, 10))),
    variation: sheet.variation ? String(sheet.variation) : null,
    region: sheet.region ? String(sheet.region) : null,
    ivs: sheet.ivs && typeof sheet.ivs === "object" ? sheet.ivs : undefined,
    evs: sheet.evs && typeof sheet.evs === "object" ? sheet.evs : undefined,
    boosts: sheet.boosts && typeof sheet.boosts === "object" ? sheet.boosts : undefined,
    nature: sheet.nature ? String(sheet.nature) : null,
    moveBoosts: sheet.moveBoosts && typeof sheet.moveBoosts === "object" ? sheet.moveBoosts : {},
    hydrophobic: num(sheet.hydrophobic, 0),
    shield: num(sheet.shield, 0),
    accessories: { back: accName(acc.back), neck: accName(acc.neck), head: accName(acc.head) }
  };
  return out;
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
    inventory: Array.isArray(sheet.inventory) ? sheet.inventory.filter((e) => e && e.name).map((e) => ({ name: String(e.name), count: num(e.count, 1) })) : [],
    sheet: cleanSheet(sheet),
    npcName: body.npcName ? String(body.npcName).slice(0, 60) : null,
    companions: (Array.isArray(body.companions) ? body.companions : []).map(cleanCompanion).filter((c) => c).slice(0, 5)
  };
  worldByUser[userId] = pass;
  writeJsonFile(PASSES_FILE, worldPasses);
  res.json({ pass: pass, link: "/?session=" + WORLD_SESSION + "&pass=" + pass });
});

app.get("/api/world/species", (req, res) => {
  res.json({ species: Object.keys(speciesDex) });
});

app.get("/api/world/assets", (req, res) => {
  res.json({ tiles: allTileNames(), tileCategories: tileCategoryList(), objects: listAssetNames(OBJECT_ASSET_DIR), blocking: BLOCKING_TILES });
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

const ENTITIES_FILE = path.join(WORLD_DIR, "entities.json");
const SPECIES_DEX_FILE = path.join(__dirname, "StorageData", "SpeciesDex.json");
const ENTITY_TICK_MS = 600;
const ENTITY_SAVE_DELAY = 2000;
const MAX_ENTITY_LINES = 12;
const SPEECH_MIN_MS = 25000;
const SPEECH_MAX_MS = 45000;
const DEFAULT_SENSOR = 5;
const DEFAULT_WANDER = 4;
const WANDER_CHANCE = 0.3;

const speciesDex = readJsonFile(SPECIES_DEX_FILE, {});
const speciesDexLower = {};
for (const key of Object.keys(speciesDex)) {
  speciesDexLower[key.toLowerCase()] = { name: key, dex: String(speciesDex[key]).padStart(4, "0") };
}

const entityStore = readJsonFile(ENTITIES_FILE, { nextId: 1, list: [] });
const entities = {};
let entityNextId = Number.isInteger(entityStore.nextId) ? entityStore.nextId : 1;
for (const saved of Array.isArray(entityStore.list) ? entityStore.list : []) {
  if (!saved || typeof saved.id !== "string") continue;
  saved.state = "idle";
  saved._nextSpeech = Date.now() + SPEECH_MIN_MS + Math.random() * (SPEECH_MAX_MS - SPEECH_MIN_MS);
  saved._lineIdx = 0;
  entities[saved.id] = saved;
}

let entitySaveTimer = null;

function saveEntitiesNow() {
  if (entitySaveTimer) {
    clearTimeout(entitySaveTimer);
    entitySaveTimer = null;
  }
  const list = [];
  for (const id of Object.keys(entities)) {
    const e = entities[id];
    if (e.kind === "companion") continue;
    list.push({ id: e.id, kind: e.kind, name: e.name, species: e.species, dex: e.dex, level: e.level, layer: e.layer, col: e.col, row: e.row, homeCol: e.homeCol, homeRow: e.homeRow, direction: e.direction, wander: e.wander, sensor: e.sensor, lines: e.lines, boss: e.boss, ivs: e.ivs, accessories: e.accessories, loot: e.loot, moves: e.moves, fainted: e.fainted || false, faintUntil: e.faintUntil || 0 });
  }
  writeJsonFile(ENTITIES_FILE, { nextId: entityNextId, list: list });
}

function scheduleEntitySave() {
  if (entitySaveTimer) return;
  entitySaveTimer = setTimeout(saveEntitiesNow, ENTITY_SAVE_DELAY);
}

function publicEntity(e) {
  return { id: e.id, kind: e.kind, name: e.name, dex: e.dex, layer: e.layer, col: e.col, row: e.row, direction: e.direction, state: e.state, fainted: !!e.fainted };
}

function gmEntity(e) {
  return { id: e.id, kind: e.kind, name: e.name, species: e.species, dex: e.dex, level: e.level, layer: e.layer, col: e.col, row: e.row, homeCol: e.homeCol, homeRow: e.homeRow, direction: e.direction, wander: e.wander, sensor: e.sensor, lines: e.lines, state: e.state, boss: e.boss, ivs: e.ivs, accessories: e.accessories, loot: e.loot, moves: e.moves, fainted: !!e.fainted };
}

function entityAt(layer, col, row, ignoreId) {
  for (const id in entities) {
    const e = entities[id];
    if (e.down || e.kind === "corpse" || e.fainted) continue;
    if (e.id !== ignoreId && e.layer === layer && e.col === col && e.row === row) return e;
  }
  return null;
}

function playerAt(layer, col, row) {
  for (const id in worldSession.players) {
    const q = worldSession.players[id];
    if (q.layer === layer && q.col === col && q.row === row) return q;
  }
  return null;
}

function entitiesInWindow(layer, c0, r0, w, h) {
  const out = [];
  for (const id in entities) {
    const e = entities[id];
    if (!e.down && e.layer === layer && e.col >= c0 && e.col < c0 + w && e.row >= r0 && e.row < r0 + h) out.push(publicEntity(e));
  }
  return out;
}

function broadcastEntity(e, oldLayer, oldCol, oldRow) {
  for (const id in worldSession.players) {
    const q = worldSession.players[id];
    const nowIn = cellInView(q, e.layer, e.col, e.row);
    const wasIn = oldLayer !== null && cellInView(q, oldLayer, oldCol, oldRow);
    if (nowIn) sendPlayer(q, { type: "e_move", entity: publicEntity(e) });
    else if (wasIn) sendPlayer(q, { type: "e_del", id: e.id });
  }
  sendGms(e.layer, { type: "gm_entity", entity: gmEntity(e) });
  if (oldLayer !== null && oldLayer !== e.layer) sendGms(oldLayer, { type: "gm_entity_del", id: e.id });
}

function hideEntity(e) {
  for (const pid in worldSession.players) {
    const q = worldSession.players[pid];
    if (cellInView(q, e.layer, e.col, e.row)) sendPlayer(q, { type: "e_del", id: e.id });
  }
  sendGms(e.layer, { type: "gm_entity_del", id: e.id });
}

function reviveEntity(e) {
  e.down = false;
  e._downUntil = 0;
  e._fight = null;
  e.state = "idle";
  const spot = worldFreeSpot(e.layer, e.homeCol, e.homeRow, e.id);
  e.col = spot.col;
  e.row = spot.row;
  broadcastEntity(e, null, 0, 0);
}

function wakeNpc(e) {
  e.fainted = false;
  e.faintUntil = 0;
  e._fight = null;
  e.state = "idle";
  const oldCol = e.col;
  const oldRow = e.row;
  const spot = worldFreeSpot(e.layer, e.col, e.row, e.id);
  e.col = spot.col;
  e.row = spot.row;
  broadcastEntity(e, e.layer, oldCol, oldRow);
  scheduleEntitySave();
}

function broadcastFacing(p) {
  for (const id in p._seen) {
    const q = worldSession.players[id];
    if (q) sendPlayer(q, { type: "face", id: p.id, direction: p.direction });
  }
}

function removeEntity(id) {
  const e = entities[id];
  if (!e) return;
  worldCombat.onEntityRemoved(e);
  for (const pid in worldSession.players) {
    const q = worldSession.players[pid];
    if (cellInView(q, e.layer, e.col, e.row)) sendPlayer(q, { type: "e_del", id: id });
  }
  sendGms(e.layer, { type: "gm_entity_del", id: id });
  delete entities[id];
  scheduleEntitySave();
}

function layerHasViewers(layer) {
  for (const id in worldSession.players) {
    if (worldSession.players[id].layer === layer) return true;
  }
  for (const gm of worldGms) {
    if (gm.layer === layer) return true;
  }
  return false;
}

function saySpeech(e, text) {
  const message = { type: "npc_say", id: e.id, dex: e.dex, name: e.name, text: text };
  for (const pid in worldSession.players) {
    const q = worldSession.players[pid];
    if (cellInView(q, e.layer, e.col, e.row)) sendPlayer(q, message);
  }
  sendGms(e.layer, message);
}

function nearestPlayerTo(e) {
  let best = null;
  let bestDist = Infinity;
  for (const pid in worldSession.players) {
    const q = worldSession.players[pid];
    if (q.layer !== e.layer) continue;
    const dist = Math.max(Math.abs(q.col - e.col), Math.abs(q.row - e.row));
    if (dist < bestDist) {
      bestDist = dist;
      best = q;
    }
  }
  return best ? { player: best, dist: bestDist } : null;
}

function entityTick() {
  const now = Date.now();
  for (const id in entities) {
    const e = entities[id];
    if (e.down) {
      if (now >= e._downUntil) reviveEntity(e);
      continue;
    }
    if (e.fainted) {
      if (now >= (e.faintUntil || 0)) wakeNpc(e);
      continue;
    }
    if (e.kind === "companion" || e.kind === "corpse") continue;
    if (!layerHasViewers(e.layer)) continue;
    if (e._fight) continue;

    if (e.kind === "enemy") {
      const near = nearestPlayerTo(e);
      const nextState = near && near.dist <= e.sensor ? "alert" : "idle";
      if (nextState !== e.state) {
        e.state = nextState;
        broadcastEntity(e, e.layer, e.col, e.row);
      }
    }

    if (e.kind === "npc" && e.lines.length > 0 && now >= e._nextSpeech) {
      e._nextSpeech = now + SPEECH_MIN_MS + Math.random() * (SPEECH_MAX_MS - SPEECH_MIN_MS);
      let seen = false;
      for (const pid in worldSession.players) {
        if (cellInView(worldSession.players[pid], e.layer, e.col, e.row)) { seen = true; break; }
      }
      if (seen) {
        saySpeech(e, e.lines[Math.floor(Math.random() * e.lines.length)]);
      }
    }

    if (e.state === "alert") continue;
    if (e.wander <= 0 || Math.random() > WANDER_CHANCE) continue;
    const dirs = ["up", "down", "left", "right"];
    const dir = dirs[Math.floor(Math.random() * dirs.length)];
    const d = DELTAS[dir];
    const nc = e.col + d.dc;
    const nr = e.row + d.dr;
    if (Math.max(Math.abs(nc - e.homeCol), Math.abs(nr - e.homeRow)) > e.wander) continue;
    if (!isWalkable(e.layer, nc, nr)) continue;
    if (entityAt(e.layer, nc, nr, e.id)) continue;
    if (playerAt(e.layer, nc, nr)) continue;
    const oldCol = e.col;
    const oldRow = e.row;
    e.col = nc;
    e.row = nr;
    e.direction = dir;
    broadcastEntity(e, e.layer, oldCol, oldRow);
    scheduleEntitySave();
  }
  worldCombat.tick();
}

function cleanLines(value) {
  const out = [];
  if (Array.isArray(value)) {
    for (const line of value) {
      const text = String(line || "").trim().slice(0, 200);
      if (text) out.push(text);
      if (out.length >= MAX_ENTITY_LINES) break;
    }
  }
  return out;
}

function cleanIvs(value) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  let any = false;
  for (const stat of ["hp", "attack", "defense", "spAtk", "spDef", "speed"]) {
    const n = parseInt(value[stat], 10);
    if (Number.isNaN(n)) {
      out[stat] = 15;
    } else {
      out[stat] = Math.max(0, Math.min(31, n));
      any = true;
    }
  }
  return any ? out : null;
}

function cleanAccessories(value) {
  if (!value || typeof value !== "object") return null;
  const out = { back: null, neck: null, head: null };
  let any = false;
  for (const slot of ["back", "neck", "head"]) {
    const name = canonItemName(value[slot]);
    if (name) {
      out[slot] = name;
      any = true;
    }
  }
  return any ? out : null;
}

function cleanLoot(value) {
  const out = [];
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    if (!entry) continue;
    const name = canonItemName(entry.name);
    const count = Math.max(1, Math.min(99, parseInt(entry.count, 10) || 1));
    if (!name) continue;
    const existing = out.find((stack) => stack.name === name);
    if (existing) existing.count = Math.min(99, existing.count + count);
    else out.push({ name: name, count: count });
    if (out.length >= 12) break;
  }
  return out;
}

function cleanEnemyMoves(value) {
  const moves = [];
  const unknown = [];
  if (!Array.isArray(value)) return { moves: moves, unknown: unknown };
  for (const raw of value) {
    const name = String(raw || "").trim();
    if (!name) continue;
    if (getMoveData(name)) {
      if (moves.length < 4 && moves.indexOf(name) === -1) moves.push(name);
    } else {
      unknown.push(name);
    }
  }
  return { moves: moves, unknown: unknown };
}

function handleGmEntitySet(gm, data) {
  const src = data.entity;
  if (!src || typeof src !== "object") return;
  const kind = src.kind === "npc" ? "npc" : "enemy";
  const speciesName = String(src.species || "").trim();
  const found = speciesDexLower[speciesName.toLowerCase()];
  if (!found) {
    sendSocket(gm.socket, { type: "gm_notice", text: "Unknown species: " + speciesName });
    return;
  }
  const layer = parseInt(src.layer, 10);
  const col = parseInt(src.col, 10);
  const row = parseInt(src.row, 10);
  if (!validLayerNumber(layer) || !Number.isInteger(col) || !Number.isInteger(row)) return;
  if (col < 0 || col >= LAYER_W || row < 0 || row >= LAYER_H) return;

  let e = typeof src.id === "string" ? entities[src.id] : null;
  if (e && (e.kind === "companion" || e.kind === "corpse")) return;
  let oldLayer = null;
  let oldCol = 0;
  let oldRow = 0;
  if (e) {
    oldLayer = e.layer;
    oldCol = e.col;
    oldRow = e.row;
  } else {
    const id = "e" + entityNextId;
    entityNextId = entityNextId + 1;
    e = { id: id, direction: "down", state: "idle", _nextSpeech: Date.now() + SPEECH_MIN_MS, _lineIdx: 0 };
    entities[id] = e;
  }

  const level = Math.max(1, Math.min(100, parseInt(src.level, 10) || 5));
  const wander = Math.max(0, Math.min(30, parseInt(src.wander, 10)));
  const sensor = Math.max(1, Math.min(5, parseInt(src.sensor, 10)));
  const moved = e.layer !== layer || e.col !== col || e.row !== row;
  e.kind = kind;
  e.species = found.name;
  e.dex = found.dex;
  e.level = level;
  e.name = String(src.name || "").trim().slice(0, 30) || found.name;
  e.layer = layer;
  e.col = col;
  e.row = row;
  if (moved || typeof e.homeCol !== "number") {
    e.homeCol = col;
    e.homeRow = row;
  }
  e.wander = Number.isNaN(wander) ? DEFAULT_WANDER : wander;
  e.sensor = Number.isNaN(sensor) ? DEFAULT_SENSOR : sensor;
  e.lines = kind === "npc" ? cleanLines(src.lines) : [];
  {
    e.boss = kind === "enemy" ? !!src.boss : false;
    e.ivs = cleanIvs(src.ivs);
    e.accessories = cleanAccessories(src.accessories);
    e.loot = cleanLoot(src.loot);
    const moveCheck = cleanEnemyMoves(src.moves);
    e.moves = moveCheck.moves;
    if (moveCheck.unknown.length > 0) sendSocket(gm.socket, { type: "gm_notice", text: "Unknown moves ignored: " + moveCheck.unknown.join(", ") });
  }
  e.state = "idle";
  broadcastEntity(e, oldLayer, oldCol, oldRow);
  scheduleEntitySave();
}

function gmTargetOf(target) {
  if (!target || typeof target !== "object") return null;
  if (target.type === "player") {
    const p = worldSession.players[String(target.id)];
    return p ? { kind: "player", ref: p } : null;
  }
  const e = entities[String(target.id)];
  if (e && (e.kind === "npc" || e.kind === "enemy")) return { kind: "entity", ref: e };
  return null;
}

function inspectPayload(t) {
  if (t.kind === "player") {
    const p = t.ref;
    const acc = p._sheet && p._sheet.accessories ? p._sheet.accessories : {};
    return { type: "gm_inspect", target: { type: "player", id: p.id }, name: p.name, inv: p._inv.map((s) => ({ name: s.name, count: s.count })), accessories: { head: acc.head || null, neck: acc.neck || null, back: acc.back || null }, capacity: capacityOf(p) };
  }
  const e = t.ref;
  const acc = e.accessories || {};
  return { type: "gm_inspect", target: { type: "entity", id: e.id }, name: e.name, inv: (e.loot || []).map((s) => ({ name: s.name, count: s.count })), accessories: { head: acc.head || null, neck: acc.neck || null, back: acc.back || null }, capacity: 12 };
}

function syncPlayerInventory(p) {
  sendPlayer(p, { type: "inv_sync", inventory: p._inv.map((s) => ({ name: s.name, count: s.count })), sheet: clientSheet(p._sheet) });
  sendGms(null, { type: "gm_player", player: publicPlayer(p) });
  queueWorldSave(p, false);
}

function handleGmInv(gm, data) {
  const t = gmTargetOf(data.target);
  if (!t) {
    sendSocket(gm.socket, { type: "gm_notice", text: "That target is gone." });
    return;
  }
  const op = String(data.op || "");
  const name = canonItemName(data.name);
  const count = Math.max(1, Math.min(99, parseInt(data.count, 10) || 1));
  const slot = ["head", "neck", "back"].includes(data.slot) ? data.slot : null;
  const isPlayer = t.kind === "player";
  const list = isPlayer ? t.ref._inv : (Array.isArray(t.ref.loot) ? t.ref.loot : (t.ref.loot = []));

  if (op === "add") {
    if (!name) return;
    let mine = null;
    for (const entry of list) {
      if (entry.name === name) { mine = entry; break; }
    }
    const cap = isPlayer ? capacityOf(t.ref) : 12;
    if (!mine && list.length >= cap) {
      sendSocket(gm.socket, { type: "gm_notice", text: (isPlayer ? t.ref.name + "'s bag is full." : t.ref.name + " can't carry any more kinds of items.") });
      return;
    }
    if (mine) mine.count = Math.min(isPlayer ? 999 : 99, mine.count + count);
    else list.push({ name: name, count: count });
  } else if (op === "remove") {
    if (!name) return;
    for (let i = 0; i < list.length; i++) {
      if (list[i].name !== name) continue;
      list[i].count = list[i].count - count;
      if (list[i].count <= 0) list.splice(i, 1);
      break;
    }
  } else if (op === "equip") {
    if (!name || !slot) return;
    if (isPlayer) {
      if (!t.ref._sheet.accessories) t.ref._sheet.accessories = { back: null, neck: null, head: null };
      t.ref._sheet.accessories[slot] = name;
      t.ref._accDirty = true;
    } else {
      const acc = t.ref.accessories || { back: null, neck: null, head: null };
      acc[slot] = name;
      t.ref.accessories = acc;
    }
  } else if (op === "unequip") {
    if (!slot) return;
    if (isPlayer) {
      if (t.ref._sheet.accessories) t.ref._sheet.accessories[slot] = null;
      t.ref._accDirty = true;
    } else if (t.ref.accessories) {
      t.ref.accessories[slot] = null;
      if (!t.ref.accessories.back && !t.ref.accessories.neck && !t.ref.accessories.head) t.ref.accessories = null;
    }
  } else {
    return;
  }

  if (isPlayer) {
    syncPlayerInventory(t.ref);
  } else {
    sendGms(t.ref.layer, { type: "gm_entity", entity: gmEntity(t.ref) });
    scheduleEntitySave();
  }
  sendGms(null, inspectPayload(t));
}

function capacityOf(p) {
  return p._sheet && p._sheet.capacity ? p._sheet.capacity : 10;
}

function sendLoot(p, e) {
  sendPlayer(p, { type: "loot_open", id: e.id, name: e.name, items: e.loot.map((stack) => ({ name: stack.name, count: stack.count })) });
}

function handleInteract(p) {
  let best = null;
  let bestDist = Infinity;
  for (const id in entities) {
    const e = entities[id];
    if ((e.kind !== "npc" && e.kind !== "corpse") || e.layer !== p.layer || e.fainted) continue;
    const dist = Math.max(Math.abs(e.col - p.col), Math.abs(e.row - p.row));
    if (dist <= 1 && (dist < bestDist || (dist === bestDist && e.kind === "corpse"))) {
      bestDist = dist;
      best = e;
    }
  }
  if (!best) {
    sendPlayer(p, { type: "interact_none" });
    return;
  }
  if (best.kind === "corpse") {
    if (worldCombat.isInFight(p)) {
      sendPlayer(p, { type: "c_notice", text: "You can't loot during battle." });
      return;
    }
    sendLoot(p, best);
    return;
  }
  if (best.lines.length === 0) {
    saySpeech(best, "...");
    return;
  }
  const text = best.lines[best._lineIdx % best.lines.length];
  best._lineIdx = best._lineIdx + 1;
  best._nextSpeech = Date.now() + SPEECH_MIN_MS + Math.random() * (SPEECH_MAX_MS - SPEECH_MIN_MS);
  saySpeech(best, text);
}

function handleLootTake(p, data) {
  const e = entities[String(data.id)];
  if (!e || e.kind !== "corpse" || e.layer !== p.layer) {
    sendPlayer(p, { type: "loot_close" });
    return;
  }
  if (worldCombat.isInFight(p)) {
    sendPlayer(p, { type: "c_notice", text: "You can't loot during battle." });
    return;
  }
  if (Math.max(Math.abs(e.col - p.col), Math.abs(e.row - p.row)) > 1) {
    sendPlayer(p, { type: "item_result", ok: false, text: "You are too far away to loot that." });
    sendPlayer(p, { type: "loot_close" });
    return;
  }
  const wantedName = data.all ? null : String(data.name || "");
  let bagFull = false;
  for (const stack of e.loot.slice()) {
    if (wantedName !== null && stack.name !== wantedName) continue;
    const units = wantedName !== null && !data.all ? Math.max(1, Math.min(stack.count, parseInt(data.count, 10) || stack.count)) : stack.count;
    for (let i = 0; i < units; i++) {
      let mine = null;
      for (const entry of p._inv) {
        if (entry.name === stack.name) { mine = entry; break; }
      }
      if (!mine && p._inv.length >= capacityOf(p)) {
        bagFull = true;
        break;
      }
      if (mine) mine.count = mine.count + 1;
      else p._inv.push({ name: stack.name, count: 1 });
      stack.count = stack.count - 1;
      sendPlayer(p, { type: "pickedup", name: stack.name });
    }
    if (bagFull) break;
  }
  e.loot = e.loot.filter((stack) => stack.count > 0);
  if (bagFull) sendPlayer(p, { type: "item_result", ok: false, text: "Your bag is full." });
  if (e.loot.length === 0) {
    removeEntity(e.id);
    sendPlayer(p, { type: "loot_close" });
    sendPlayer(p, { type: "item_result", ok: true, text: "You took everything. The body fades away." });
  } else {
    scheduleEntitySave();
    sendLoot(p, e);
  }
}

function worldFreeSpot(layer, col, row, ignoreId) {
  function free(c, r) {
    if (!isWalkable(layer, c, r)) return false;
    if (entityAt(layer, c, r)) return false;
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
  companionSnap(p);
}

function handleWorldMove(p, dir) {
  const gate = worldCombat.canPlayerMove(p);
  if (!gate.ok) {
    sendPlayer(p, { type: "c_notice", text: gate.reason });
    sendPlayer(p, { type: "moveblocked", direction: p.direction });
    return;
  }
  const d = DELTAS[dir];
  if (d) p.direction = dir;
  const nc = d ? p.col + d.dc : p.col;
  const nr = d ? p.row + d.dr : p.row;
  let blocked = !d || !isWalkable(p.layer, nc, nr);
  let swapWith = null;
  if (!blocked) {
    const hit = entityAt(p.layer, nc, nr);
    if (hit) {
      if (hit.kind === "companion" && hit.ownerPlayerId === p.id && !hit._fight) swapWith = hit;
      else blocked = true;
    }
  }
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
    if (worldCombat.isInFight(p)) {
      sendPlayer(p, { type: "c_notice", text: "You can't leave through a portal during battle." });
      sendPlayer(p, { type: "moveblocked", direction: p.direction });
      return;
    }
    teleportPlayer(p, portal.layer, portal.col, portal.row);
    return;
  }

  const prevCol = p.col;
  const prevRow = p.row;
  p.col = nc;
  p.row = nr;
  if (swapWith) {
    const oc = swapWith.col;
    const or = swapWith.row;
    swapWith.col = prevCol;
    swapWith.row = prevRow;
    broadcastEntity(swapWith, swapWith.layer, oc, or);
  }
  refreshVisibility(p);
  const moved = { type: "moved", id: p.id, col: nc, row: nr, direction: p.direction };
  sendPlayer(p, moved);
  for (const id in p._seen) {
    const q = worldSession.players[id];
    if (q) sendPlayer(q, moved);
  }
  sendGms(null, { type: "gm_player", player: publicPlayer(p) });
  sendView(p);
  worldCombat.afterPlayerMove(p);
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
  const names = allTileNames();
  const changedArt = [];
  const logicCells = [];
  for (const op of ops) {
    const c = op[0];
    const r = op[1];
    const name = typeof op[2] === "string" ? op[2] : "";
    if (!Number.isInteger(c) || !Number.isInteger(r)) continue;
    if (c < 0 || c >= LAYER_W || r < 0 || r >= LAYER_H) continue;
    const oldCh = L.art[r][c];
    const oldName = oldCh === " " ? "" : parseTileName(tilePalette[oldCh] || "").base;
    const logic = L.rows[r][c];
    if (name === "") {
      if (oldCh === " ") continue;
      L.art[r] = L.art[r].substring(0, c) + " " + L.art[r].substring(c + 1);
      if (logic === "x" && isBlockingTile(oldName)) logicCells.push([c, r, "."]);
      changedArt.push([c, r, ""]);
      continue;
    }
    const parsed = parseTileName(name);
    if (names.indexOf(parsed.base) === -1) continue;
    const storedName = parsed.rot === 0 && !parsed.flip ? parsed.base : parsed.base + "@" + (parsed.rot === 0 ? "" : parsed.rot) + (parsed.flip ? "f" : "");
    const ch = paletteChar(storedName);
    if (!ch) continue;
    if (oldCh === ch) continue;
    L.art[r] = L.art[r].substring(0, c) + ch + L.art[r].substring(c + 1);
    changedArt.push([c, r, storedName]);
    if (logic === "P") continue;
    if (isBlockingTile(parsed.base)) {
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
    sendGms(layer, { type: "gm_art", layer: layer, cells: changedArt, palette: tilePalette });
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
  sendSocket(gm.socket, { type: "gm_layer", layer: gm.layer, name: L.name, rows: L.rows.map((row) => row.replace(/ +$/, "")), art: L.art.map((row) => row.replace(/ +$/, "")), palette: tilePalette, objects: objList, entities: Object.keys(entities).filter((id) => entities[id].layer === gm.layer && !entities[id].down).map((id) => gmEntity(entities[id])), portals: L.portals, spawn: L.spawn, floorItems: items, layers: layerSummaries() });
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

  if (data.type === "gm_entity_set") {
    handleGmEntitySet(gm, data);
    return;
  }

  if (data.type === "gm_entity_del") {
    if (typeof data.id === "string" && !(entities[data.id] && entities[data.id].kind === "companion")) removeEntity(data.id);
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

  if (data.type === "gm_inspect") {
    const t = gmTargetOf(data.target);
    if (t) sendSocket(gm.socket, inspectPayload(t));
    return;
  }

  if (data.type === "gm_inv") {
    handleGmInv(gm, data);
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
    _npcName: info.npcName || null,
    _pass: pass,
    _sheet: info.sheet || cleanSheet({}),
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
  sendPlayer(p, { type: "init", id: id, role: "player", world: true, layer: p.layer, turn: 1, players: players, floorItems: itemsInWindow(p.layer, p.col - VIEW_HALF_W, p.row - VIEW_HALF_H, w, h), inventory: inventory, sheet: clientSheet(p._sheet), itemFx: ITEM_FX });
  p._kills = [];
  p._reportedHp = p.hp;
  p._reportedMp = p.mp;
  sendView(p);
  sendGms(null, { type: "gm_player", player: publicPlayer(p) });
  spawnCompanions(p, info);
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

    if (typeof data.type === "string" && data.type.indexOf("c_") === 0) {
      worldCombat.handleMessage(me, data);
      return;
    }

    if (data.type === "face") {
      if (DELTAS[data.direction]) me.direction = data.direction;
      for (const seenId in me._seen) {
        const q = worldSession.players[seenId];
        if (q) sendPlayer(q, { type: "face", id: me.id, direction: me.direction });
      }
    } else if (data.type === "interact") {
      handleInteract(me);
    } else if (data.type === "loot_take") {
      handleLootTake(me, data);
    } else if (data.type === "attack_start") {
      worldCombat.startDuel(me, data);
    } else if (data.type === "item_use") {
      worldCombat.useItemOutside(me, data);
    } else if (data.type === "exit") {
      const exitUser = me.userId;
      forceLeaveUser(exitUser, "You left the world. Your character is saved.");
      sendLayerSummaries();
    } else if (data.type === "move") {
      handleWorldMove(me, data.dir);
    } else if (data.type === "pickup") {
      if (worldCombat.isInFight(me)) {
        sendPlayer(me, { type: "c_notice", text: "You can't pick things up during battle." });
        return;
      }
      let idx = -1;
      for (let i = 0; i < worldSession.floorItems.length; i++) {
        const it = worldSession.floorItems[i];
        if (it.layer === me.layer && it.col === me.col && it.row === me.row) { idx = i; break; }
      }
      if (idx !== -1) {
        const it = worldSession.floorItems[idx];
        let stack = null;
        for (const entry of me._inv) {
          if (entry.name === it.name) { stack = entry; break; }
        }
        if (!stack && me._inv.length >= capacityOf(me)) {
          sendPlayer(me, { type: "item_result", ok: false, text: "Your bag is full." });
          return;
        }
        worldSession.floorItems.splice(idx, 1);
        if (stack) {
          stack.count = stack.count + 1;
        } else {
          me._inv.push({ name: it.name, count: 1 });
        }
        notifyItem(me.layer, it.col, it.row, { type: "itemremoved", col: it.col, row: it.row });
        sendPlayer(me, { type: "pickedup", name: it.name });
      }
    } else if (data.type === "drop") {
      if (worldCombat.isInFight(me)) {
        sendPlayer(me, { type: "c_notice", text: "You can't drop things during battle." });
        sendPlayer(me, { type: "dropfail" });
        return;
      }
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

worldCombat.init({
  worldSession: worldSession,
  entities: entities,
  DELTAS: DELTAS,
  isWalkable: isWalkable,
  entityAt: entityAt,
  playerAt: playerAt,
  sendPlayer: sendPlayer,
  sendGms: sendGms,
  broadcastEntity: broadcastEntity,
  broadcastFacing: broadcastFacing,
  hideEntity: hideEntity,
  removeEntity: removeEntity,
  scheduleEntitySave: scheduleEntitySave,
  publicPlayer: publicPlayer,
  layerSpawn: layerSpawn,
  teleportPlayer: teleportPlayer,
  companionsOf: companionsOf,
  queueCompanionSave: queueCompanionSave,
  queueWorldSave: queueWorldSave
});

setInterval(saveWorldState, WORLD_SAVE_INTERVAL);
setInterval(entityTick, ENTITY_TICK_MS);
setInterval(companionFollowTick, COMPANION_FOLLOW_MS);
setInterval(saveEntitiesNow, WORLD_SAVE_INTERVAL);

setInterval(() => {
  for (const id in worldSession.players) {
    const cp = worldSession.players[id];
    queueWorldSave(cp, false);
    for (const ce of companionsOf(cp)) queueCompanionSave(ce, false);
  }
}, WORLD_CHECKPOINT_INTERVAL);

function shutdownWorld() {
  worldCombat.shutdown();
  for (const id of Object.keys(worldSession.players)) {
    leaveWorldPlayer(worldSession.players[id].id);
  }
  saveWorldState();
  saveLayersNow();
  saveEntitiesNow();
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