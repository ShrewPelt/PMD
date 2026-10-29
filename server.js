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
  if (!itemIndexCache.data || now - itemIndexCache.at > 5000) {
    const fresh = {};
    scanItemIcons(ITEMS_DIR, ITEMS_DIR, fresh);
    if (Object.keys(fresh).length === 0) {
      try {
        const old = JSON.parse(fs.readFileSync(path.join(__dirname, "public", "items-index.json"), "utf8"));
        for (const k of Object.keys(old)) fresh[k] = old[k];
      } catch (e) {}
    }
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
app.get("/assets/objects/:file", (req, res, next) => {
  const file = findObjectFile(req.params.file);
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
const LAYER_W = 1024;
const LAYER_H = 1024;
const MAX_LAYER = 999;
const MIN_LAYER = -999;
const CHAT_RANGE = 10;
const VIEW_HALF_W = 10;
const VIEW_HALF_H = 10;
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

function collectFolderGroups(dir, parts, depth, parentName, out, claim) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  entries.sort((x, y) => x.name.localeCompare(y.name));
  const direct = [];
  for (const entry of entries) {
    if (entry.isFile() && /\.png$/i.test(entry.name)) {
      direct.push({ file: path.join(dir, entry.name), base: entry.name.replace(/\.png$/i, ""), parent: path.basename(dir) });
    }
  }
  if (direct.length > 0) out.push({ name: parts.join(" > "), objects: direct.map(claim).sort() });
  if (depth >= TILE_SCAN_DEPTH) return;
  for (const entry of entries) {
    if (entry.isDirectory()) collectFolderGroups(path.join(dir, entry.name), parts.concat([entry.name]), depth + 1, parentName, out, claim);
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

let objectScanCache = { at: 0, data: null };

function scanObjects(force) {
  const now = Date.now();
  if (!force && objectScanCache.data && now - objectScanCache.at < TILE_SCAN_TTL) return objectScanCache.data;
  const files = {};
  const taken = {};
  const claim = (found) => {
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
  const categories = [];
  const rootLoose = [];
  const rootDirs = [];
  try {
    const entries = fs.readdirSync(OBJECT_ASSET_DIR, { withFileTypes: true });
    entries.sort((x, y) => x.name.localeCompare(y.name));
    for (const entry of entries) {
      if (entry.isFile() && /\.png$/i.test(entry.name)) rootLoose.push({ file: path.join(OBJECT_ASSET_DIR, entry.name), base: entry.name.replace(/\.png$/i, ""), parent: path.basename(OBJECT_ASSET_DIR) });
      else if (entry.isDirectory()) rootDirs.push(entry.name);
    }
  } catch (e) {}
  const defaultGroups = [];
  if (rootLoose.length > 0) defaultGroups.push({ name: "", objects: rootLoose.map(claim).sort() });
  categories.push({ name: "Default", groups: defaultGroups });
  const catRoots = rootDirs.map((folder) => ({ name: folder, dir: path.join(OBJECT_ASSET_DIR, folder) }));
  let hasStructures = false;
  for (const entry of catRoots) {
    if (entry.name.toLowerCase() === "structures") hasStructures = true;
  }
  if (!hasStructures && fs.existsSync(STRUCTURES_DIR)) catRoots.push({ name: "Structures", dir: STRUCTURES_DIR });
  for (const rootEntry of catRoots) {
    const folder = rootEntry.name;
    if (folder.toLowerCase() === "default") {
      const extraGroups = [];
      collectFolderGroups(rootEntry.dir, [], 0, folder, extraGroups, claim);
      for (const g of extraGroups) categories[0].groups.push(g);
      continue;
    }
    const catDir = rootEntry.dir;
    const groups = [];
    collectFolderGroups(catDir, [], 0, folder, groups, claim);
    categories.push({ name: folder, groups: groups });
  }
  objectScanCache = { at: now, data: { categories: categories, files: files } };
  return objectScanCache.data;
}

function allObjectNames() {
  return Object.keys(scanObjects(false).files).sort();
}

function findObjectFile(name) {
  const wanted = String(name).replace(/\.png$/i, "");
  if (!wanted) return null;
  let data = scanObjects(false);
  if (!data.files[wanted]) data = scanObjects(true);
  return data.files[wanted] || null;
}

function berryItemForObject(name) {
  const text = String(name || "");
  const cut = text.lastIndexOf(" - ");
  const base = cut >= 0 ? text.substring(cut + 3) : text;
  const m = base.match(/^([A-Za-z]+)[ _]Berry[ _]Bush/i);
  if (!m) return null;
  const wanted = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() + " Berry";
  const canon = canonItemName(wanted);
  if (!canon || !itemIndexCache.lower || !itemIndexCache.lower[canon.toLowerCase()]) return null;
  return canon;
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

function cleanRot(value) {
  const n = parseInt(value, 10);
  return n === 90 || n === 180 || n === 270 ? n : 0;
}

function makeLayer(name) {
  const rows = [];
  const blank = " ".repeat(LAYER_W);
  for (let r = 0; r < LAYER_H; r++) rows.push(blank);
  return { name: name || "", rows: rows, art: rows.slice(), objects: {}, passable: {}, portals: {}, spawn: null, light: "outdoor" };
}

function layerHasContent(L) {
  if (L.name || L.spawn || (L.light && L.light !== "outdoor") || Object.keys(L.portals).length > 0 || Object.keys(L.objects).length > 0 || Object.keys(L.passable).length > 0) return true;
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
        if (Array.isArray(o) && o.length >= 3) L.objects[o[0] + "," + o[1]] = { name: String(o[2]), solid: o[3] !== 0, rot: cleanRot(o[4]), flip: o[5] === 1 };
      }
      const passList = Array.isArray(saved.passable) ? saved.passable : [];
      for (const pc of passList) {
        if (Array.isArray(pc) && pc.length >= 2) L.passable[pc[0] + "," + pc[1]] = 1;
      }
      L.portals = saved.portals && typeof saved.portals === "object" ? saved.portals : {};
      L.spawn = saved.spawn || null;
      L.light = saved.light === "indoor" || saved.light === "dark" ? saved.light : "outdoor";
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

const SPAWNS_FILE = path.join(WORLD_DIR, "spawns.json");
let spawnPoints = [];
let spawnNextId = 1;

function saveSpawns() {
  writeJsonFile(SPAWNS_FILE, { nextId: spawnNextId, list: spawnPoints });
}

function validSpawnSpot(layer, col, row) {
  return validLayerNumber(layer) && Number.isInteger(col) && Number.isInteger(row) && col >= 0 && col < LAYER_W && row >= 0 && row < LAYER_H;
}

function loadSpawns() {
  const data = readJsonFile(SPAWNS_FILE, null);
  if (data && Array.isArray(data.list)) {
    for (const sp of data.list) {
      if (sp && typeof sp.id === "string" && validSpawnSpot(sp.layer, sp.col, sp.row)) {
        spawnPoints.push({ id: sp.id, name: String(sp.name || "Spawn").slice(0, 40), layer: sp.layer, col: sp.col, row: sp.row });
      }
    }
    spawnNextId = Number.isInteger(data.nextId) ? data.nextId : spawnPoints.length + 1;
    return;
  }
  const keys = Object.keys(layers).map((k) => parseInt(k, 10)).sort((a, b) => a - b);
  for (const n of keys) {
    const L = layers[n];
    if (L.spawn && validSpawnSpot(n, L.spawn.col, L.spawn.row)) {
      spawnPoints.push({ id: "s" + spawnNextId, name: n === 0 ? "Main spawn" : "Layer " + n + " spawn", layer: n, col: L.spawn.col, row: L.spawn.row });
      spawnNextId = spawnNextId + 1;
    }
    L.spawn = null;
  }
  saveSpawns();
}

loadSpawns();

function spawnList() {
  return spawnPoints.map((sp) => ({ id: sp.id, name: sp.name, layer: sp.layer, col: sp.col, row: sp.row, layerName: layers[sp.layer] ? layers[sp.layer].name : "" }));
}

function broadcastSpawns() {
  sendGms(null, { type: "gm_spawns", spawns: spawnList() });
}

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
      objList.push([parseInt(parts[0], 10), parseInt(parts[1], 10), L.objects[k].name, L.objects[k].solid ? 1 : 0, L.objects[k].rot || 0, L.objects[k].flip ? 1 : 0]);
    }
    const passOut = [];
    for (const k of Object.keys(L.passable)) {
      const parts = k.split(",");
      passOut.push([parseInt(parts[0], 10), parseInt(parts[1], 10)]);
    }
    out[key] = { name: L.name, passable: passOut, rows: L.rows.map((row) => row.replace(/ +$/, "")), art: L.art.map((row) => row.replace(/ +$/, "")), objects: objList, portals: L.portals, spawn: L.spawn, light: L.light || "outdoor" };
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
  if (obj && obj.solid && !(L.passable && L.passable[col + "," + row])) return false;
  return true;
}

function layerSpawn(layer) {
  const L = layers[layer];
  for (const sp of spawnPoints) {
    if (sp.layer === layer) return { col: sp.col, row: sp.row };
  }
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
  const lightInfo = playerLightInfo(p);
  return { id: p.id, layer: p.layer, col: p.col, row: p.row, direction: p.direction, dex: p.dex, name: p.name, userId: p.userId, hp: p.hp, maxHp: p.maxHp, mp: p.mp, maxMp: p.maxMp, light: lightInfo.r, lc: lightInfo.c };
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
      if (!obj) {
        const farmPlot = farmState.plots[layer + "," + c + "," + r];
        if (farmPlot) {
          for (const entry of farmPlotEntries(layer, c, r, farmPlot)) out.push(entry);
        }
      }
      if (obj) {
        const walk = !obj.solid || !!(L.passable && L.passable[c + "," + r]);
        const blocks = !walk && VISION_BLOCK_RE !== null && VISION_BLOCK_RE.test(obj.name);
        out.push({ col: c, row: r, name: harvestedShownName(layer, c, r, obj), rot: obj.rot || 0, flip: obj.flip ? 1 : 0, w: walk ? 1 : 0, b: blocks ? 1 : 0 });
      }
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


const VISION_FILE = path.join(WORLD_DIR, "vision.json");
const CLOCK_FILE = path.join(WORLD_DIR, "clock.json");
const STRUCTURES_DIR = path.join(__dirname, "assets", "structures");
const SPECIES_TYPES_FILE = path.join(__dirname, "StorageData", "SpeciesTypes.json");

const VISION_VERSION = 6;

const VISION_DEFAULTS = {
  version: VISION_VERSION,
  dayMinutes: 24,
  coneDegrees: 110,
  dayRange: 10,
  nearRadius: 1.5,
  nightReach: 0,
  nightVisionReach: 8,
  darknessMax: 1,
  fireTypeLight: { radius: 3.5, color: "#ff8a3c" },
  lightObjects: [
    { match: "Lit_Stone_Campfire", radius: 6.5, color: "#ff9a3c", flicker: 0.1, flame: { part: "top", size: 0.6 }, sound: "SFX/Campfire Crackling.ogg", soundRadius: 9, soundVolume: 0.6 },
    { match: "Lit_Campfire", radius: 6.5, color: "#ff9a3c", flicker: 0.1, flame: { part: "top", size: 0.6 }, sound: "SFX/Campfire Crackling.ogg", soundRadius: 9, soundVolume: 0.6 },
    { match: "Metal_Brazier", radius: 6, color: "#ff8f33", flicker: 0.05, flame: { part: "top", size: 0.5 } },
    { match: "Pillar_Brazier", radius: 5, color: "#ff9a3c", flicker: 0.05, flame: { part: "top", size: 0.45 } },
    { match: "Lamp_Post3", radius: 5, color: "#ff6a3a", flicker: 0.04, flame: { part: "top", size: 0.4 } },
    { match: "Lamp_Post4", radius: 4.5, color: "#ffc266", flicker: 0.04, flame: { part: "top", size: 0.45 } },
    { match: "Lamp_Post", radius: 6.5, color: "#ffd27a", flicker: 0.04, flame: { part: "top", size: 0.35 } },
    { match: "Hanging_Torch", radius: 4.5, color: "#ff9a3c", flicker: 0.05, flame: { part: "top", size: 0.45 } },
    { match: "Hanging_Lantern", radius: 5, color: "#ffd27a", flicker: 0.04, flame: { part: "bottom", size: 0.5 } },
    { match: "Candle", radius: 2.5, color: "#ffb84d", flicker: 0.06, flame: { part: "top", size: 0.5 } }
  ],
  lightItems: [
    { item: "Lit Torch", radius: 5, color: "#ffb347", burnSeconds: 60, onGround: true },
    { item: "Lantern", radius: 7, color: "#ffd27a", burnSeconds: 0, onGround: true }
  ],
  lightable: [
    { unlit: "Unlit_Stone_Campfire", lit: "Lit_Stone_Campfire", label: "stone campfire", burnMinutes: 5 },
    { unlit: "Unlit_Campfire", lit: "Lit_Campfire", label: "campfire", burnMinutes: 5 }
  ],
  igniterItems: ["Lit Torch", "Flint and Steel"],
  combineRecipes: [
    { id: "stick_torch", a: "Flint and Steel", b: "Stick", result: "Lit Torch", resultCount: 1, consumeA: false, consumeB: true, text: "You strike the Flint and Steel and the Stick catches fire. It is now a Lit Torch." }
  ],
  torchStick: { item: "Stick", result: "Lit Torch", range: 2, structures: ["Lit_Stone_Campfire", "Lit_Campfire", "Metal_Brazier", "Pillar_Brazier", "Hanging_Torch"] },
  sightBlockers: ["Tree", "Wall", "House", "Building", "Pillar", "Statue", "Cliff", "Boulder"],
  nightVisionTypes: ["Dark", "Ghost"],
  nightVisionSpecies: ["Meowth", "Persian", "Zubat", "Golbat", "Crobat", "Hoothoot", "Noctowl", "Murkrow", "Honchkrow", "Umbreon", "Sneasel", "Weavile", "Houndour", "Houndoom", "Poochyena", "Mightyena", "Absol", "Shinx", "Luxio", "Luxray", "Purrloin", "Liepard", "Glameow", "Purugly", "Espurr", "Meowstic", "Litten", "Torracat", "Incineroar", "Rockruff", "Lycanroc", "Sableye", "Skuntank", "Stunky", "Spinarak", "Ariados"]
};

function visionFileText(cfg) {
  const entries = [];
  for (const key of Object.keys(cfg)) {
    const v = cfg[key];
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") {
      entries.push('  "' + key + '": [\n' + v.map((e) => "    " + JSON.stringify(e)).join(",\n") + "\n  ]");
    } else {
      entries.push('  "' + key + '": ' + JSON.stringify(v));
    }
  }
  return "{\n" + entries.join(",\n") + "\n}\n";
}

function fillEntryDefaults(list, defList, keyName) {
  return list.map((entry) => {
    const found = defList.find((d) => String(d[keyName]).toLowerCase() === String(entry[keyName]).toLowerCase());
    return found ? Object.assign({}, found, entry) : entry;
  });
}

function addMissingEntries(list, defList, keyName) {
  const out = list.slice();
  for (const d of defList) {
    let found = false;
    for (const entry of out) {
      if (String(entry[keyName]).toLowerCase() === String(d[keyName]).toLowerCase()) found = true;
    }
    if (!found) out.push(d);
  }
  return out;
}

function loadVisionConfig() {
  let saved = {};
  let exists = true;
  try {
    saved = JSON.parse(fs.readFileSync(VISION_FILE, "utf8"));
  } catch (e) {
    exists = false;
    saved = {};
  }
  const cfg = {};
  for (const key of Object.keys(VISION_DEFAULTS)) {
    const def = VISION_DEFAULTS[key];
    const got = saved[key];
    if (got === undefined || got === null || typeof got !== typeof def || Array.isArray(got) !== Array.isArray(def)) cfg[key] = def;
    else cfg[key] = got;
  }
  let migrated = false;
  if (exists && saved.version !== VISION_VERSION) {
    if ((Number(saved.version) || 0) < 2) {
      cfg.nightReach = VISION_DEFAULTS.nightReach;
      cfg.darknessMax = VISION_DEFAULTS.darknessMax;
    }
    cfg.lightObjects = addMissingEntries(cfg.lightObjects, VISION_DEFAULTS.lightObjects, "match");
    cfg.lightable = addMissingEntries(cfg.lightable, VISION_DEFAULTS.lightable, "unlit");
    cfg.lightItems = addMissingEntries(cfg.lightItems, VISION_DEFAULTS.lightItems, "item");
    if ((Number(saved.version) || 0) < 6) {
      for (const entry of cfg.lightItems) {
        if (String(entry.item).toLowerCase() === "lit torch") entry.onGround = true;
      }
    }
    cfg.combineRecipes = addMissingEntries(cfg.combineRecipes, VISION_DEFAULTS.combineRecipes, "id");
    for (const name of VISION_DEFAULTS.igniterItems) {
      if (cfg.igniterItems.map((v) => String(v).toLowerCase()).indexOf(String(name).toLowerCase()) === -1) cfg.igniterItems.push(name);
    }
    cfg.version = VISION_VERSION;
    migrated = true;
  }
  cfg.lightItems = fillEntryDefaults(cfg.lightItems, VISION_DEFAULTS.lightItems, "item");
  cfg.lightable = fillEntryDefaults(cfg.lightable, VISION_DEFAULTS.lightable, "unlit");
  cfg.lightObjects = fillEntryDefaults(cfg.lightObjects, VISION_DEFAULTS.lightObjects, "match");
  if (!exists || migrated) {
    try {
      fs.mkdirSync(WORLD_DIR, { recursive: true });
      fs.writeFileSync(VISION_FILE, visionFileText(cfg));
    } catch (e) {
      console.error("Could not write vision.json: " + e.message);
    }
  }
  return cfg;
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const VISION = loadVisionConfig();
const VISION_BLOCK_RE = VISION.sightBlockers.length > 0 ? new RegExp(VISION.sightBlockers.map(escapeRegex).join("|"), "i") : null;
const NIGHT_SPECIES_SET = {};
for (const name of VISION.nightVisionSpecies) NIGHT_SPECIES_SET[String(name).toLowerCase()] = true;

const speciesTypeMap = {};
try {
  const rawTypes = JSON.parse(fs.readFileSync(SPECIES_TYPES_FILE, "utf8"));
  for (const name of Object.keys(rawTypes)) speciesTypeMap[name.toLowerCase()] = rawTypes[name];
} catch (e) {}

function typesOfSpecies(species) {
  const found = speciesTypeMap[String(species || "").toLowerCase()];
  return Array.isArray(found) ? found : [];
}

function typesOfPlayer(p) {
  const sheet = p._sheet || {};
  if (Array.isArray(sheet.types) && sheet.types.length > 0) return sheet.types;
  return typesOfSpecies(sheet.species);
}

function fireLightInfo() {
  return { r: Number(VISION.fireTypeLight.radius) || 0, c: String(VISION.fireTypeLight.color || "#ff8a3c") };
}

function playerLightInfo(p) {
  let best = { r: 0, c: "" };
  if (typesOfPlayer(p).indexOf("Fire") !== -1) best = fireLightInfo();
  const inv = Array.isArray(p._inv) ? p._inv : [];
  for (const def of VISION.lightItems) {
    const want = String(def.item || "").toLowerCase();
    let has = false;
    for (const stack of inv) {
      if (stack && String(stack.name).toLowerCase() === want) {
        has = true;
        break;
      }
    }
    if (has && Number(def.radius) > best.r) best = { r: Number(def.radius), c: String(def.color || "#ffb347") };
  }
  return best;
}

const entityLightCache = {};

function entityLightInfo(e) {
  if (e.kind === "corpse" || e.fainted) return { r: 0, c: "" };
  const key = String(e.species || "").toLowerCase();
  if (entityLightCache[key] === undefined) {
    entityLightCache[key] = typesOfSpecies(e.species).indexOf("Fire") !== -1 ? fireLightInfo() : { r: 0, c: "" };
  }
  return entityLightCache[key];
}

function playerNightVision(p) {
  const species = String((p._sheet && p._sheet.species) || "").toLowerCase();
  if (NIGHT_SPECIES_SET[species]) return true;
  const types = typesOfPlayer(p);
  for (const t of VISION.nightVisionTypes) {
    if (types.indexOf(t) !== -1) return true;
  }
  return false;
}

function loadClock() {
  const base = { dayMinutes: VISION.dayMinutes, baseHour: 8, baseAt: Date.now(), frozen: false };
  try {
    const saved = JSON.parse(fs.readFileSync(CLOCK_FILE, "utf8"));
    if (typeof saved.dayMinutes === "number" && saved.dayMinutes >= 1) base.dayMinutes = saved.dayMinutes;
    if (typeof saved.baseHour === "number") base.baseHour = saved.baseHour;
    if (typeof saved.baseAt === "number") base.baseAt = saved.baseAt;
    if (typeof saved.frozen === "boolean") base.frozen = saved.frozen;
  } catch (e) {}
  return base;
}

const worldClock = loadClock();

function clockHour() {
  if (worldClock.frozen) return worldClock.baseHour;
  const dayMs = worldClock.dayMinutes * 60000;
  const elapsed = (Date.now() - worldClock.baseAt) / dayMs * 24;
  return (((worldClock.baseHour + elapsed) % 24) + 24) % 24;
}

function saveClock() {
  writeJsonFile(CLOCK_FILE, worldClock);
}

function timeMessage() {
  return { type: "time", hour: clockHour(), dayMs: worldClock.dayMinutes * 60000, frozen: worldClock.frozen };
}

function broadcastTime() {
  const msg = timeMessage();
  for (const id in worldSession.players) sendPlayer(worldSession.players[id], msg);
  sendGms(null, msg);
}

function handleGmTime(gm, data) {
  farmClockCheck();
  const now = Date.now();
  const currentHour = clockHour();
  if (typeof data.dayMinutes === "number" && isFinite(data.dayMinutes) && data.dayMinutes >= 1 && data.dayMinutes <= 1440) {
    worldClock.baseHour = currentHour;
    worldClock.baseAt = now;
    worldClock.dayMinutes = Math.round(data.dayMinutes * 100) / 100;
  }
  if (typeof data.frozen === "boolean") {
    worldClock.baseHour = clockHour();
    worldClock.baseAt = now;
    worldClock.frozen = data.frozen;
  }
  if (typeof data.hour === "number" && isFinite(data.hour)) {
    worldClock.baseHour = ((data.hour % 24) + 24) % 24;
    worldClock.baseAt = now;
    farmClockJump(currentHour, clockHour());
  }
  farmState.lastHour = clockHour();
  farmState.lastAt = now;
  saveClock();
  broadcastTime();
}

function handleGmLightMode(gm, data) {
  const mode = String(data.mode || "");
  if (mode !== "outdoor" && mode !== "indoor" && mode !== "dark") return;
  const L = ensureLayer(gm.layer);
  L.light = mode;
  scheduleLayerSave();
  for (const id in worldSession.players) {
    const q = worldSession.players[id];
    if (q.layer === gm.layer) sendView(q);
  }
  sendGms(gm.layer, { type: "gm_light_mode", layer: gm.layer, mode: mode });
}

function checkLightChange(p) {
  const info = playerLightInfo(p);
  const sig = info.r + "|" + info.c;
  if (p._lightSig === sig) return;
  const msg = { type: "p_light", id: p.id, light: info.r, lc: info.c };
  sendPlayer(p, msg);
  for (const id in p._seen) {
    const q = worldSession.players[id];
    if (q) sendPlayer(q, msg);
  }
  sendView(p);
}

function lightableFor(name) {
  const lower = String(name || "").toLowerCase();
  for (const pair of VISION.lightable) {
    const unlit = String(pair.unlit || "").toLowerCase();
    if (unlit && lower.indexOf(unlit) !== -1) return pair;
  }
  return null;
}

function isFireTyped(p) {
  for (const t of typesOfPlayer(p)) {
    if (String(t).toLowerCase() === "fire") return true;
  }
  return false;
}

function knownFireAttacks(p) {
  const out = [];
  const moves = p._sheet && Array.isArray(p._sheet.moves) ? p._sheet.moves : [];
  for (const m of moves) {
    if (!m || !m.name) continue;
    const data = getMoveData(m.name) || (m.data && typeof m.data === "object" ? m.data : null);
    if (!data) continue;
    if (String(data.type).toLowerCase() === "fire" && String(data.category).toLowerCase() !== "status") out.push(m.name);
  }
  return out;
}

function fireMovesOf(p) {
  return knownFireAttacks(p);
}

function playerHasTorch(p) {
  const inv = Array.isArray(p._inv) ? p._inv : [];
  for (const igniter of VISION.igniterItems) {
    const want = String(igniter).toLowerCase();
    for (const stack of inv) {
      if (stack && String(stack.name).toLowerCase() === want) return true;
    }
  }
  return false;
}

function lightObject(p, col, row, obj, pair, moveName) {
  if (worldCombat.isInFight(p)) {
    sendPlayer(p, { type: "item_result", ok: false, text: "You can't do that during battle." });
    return;
  }
  const label = pair.label || "fire";
  const fireMoves = fireMovesOf(p);
  let usedMove = "";
  if (moveName) {
    if (fireMoves.indexOf(moveName) === -1) {
      sendPlayer(p, { type: "item_result", ok: false, text: "You can't light the " + label + " with " + moveName + "." });
      return;
    }
    usedMove = moveName;
  } else if (fireMoves.length > 0) {
    usedMove = fireMoves[0];
  } else if (!playerHasTorch(p)) {
    const reason = knownFireAttacks(p).length > 0 ? "Only Fire-type Pokemon can light this " + label + " with a move." : "You need a Fire-type move or a lit torch to light this " + label + ".";
    sendPlayer(p, { type: "item_result", ok: false, text: reason });
    return;
  }
  const lowerName = obj.name.toLowerCase();
  const at = lowerName.indexOf(String(pair.unlit).toLowerCase());
  const litName = obj.name.substring(0, at) + pair.lit + obj.name.substring(at + String(pair.unlit).length);
  if (allObjectNames().indexOf(litName) === -1) {
    sendPlayer(p, { type: "item_result", ok: false, text: "The lit " + label + " image is missing (" + pair.lit + ")." });
    return;
  }
  applyObjects(p.layer, [[col, row, litName, obj.solid ? 1 : 0, obj.rot || 0, obj.flip ? 1 : 0]]);
  const burnMs = (Number(pair.burnMinutes) || 0) * 60000;
  if (burnMs > 0) {
    fires[p.layer + "," + col + "," + row] = Date.now() + burnMs;
    saveFires();
  }
  sendPlayer(p, { type: "item_result", ok: true, text: usedMove ? "You light the " + label + " with " + usedMove + "." : "You light the " + label + " with your torch." });
}

function stickStructureMatch(name) {
  const cfg = VISION.torchStick;
  for (const part of cfg.structures) {
    const re = new RegExp("(^|[^A-Za-z])" + escapeRegex(part), "i");
    if (re.test(String(name || ""))) return part;
  }
  return null;
}

function lightBurnMs(name) {
  for (const def of VISION.lightItems) {
    if (String(def.item).toLowerCase() === String(name).toLowerCase()) return (Number(def.burnSeconds) || 0) * 1000;
  }
  return 0;
}

function floorItemAt(layer, col, row) {
  for (const fi of worldSession.floorItems) {
    if (fi.layer === layer && fi.col === col && fi.row === row) return true;
  }
  return false;
}

function findDropSpot(p) {
  if (!floorItemAt(p.layer, p.col, p.row)) return { col: p.col, row: p.row };
  const L = layers[p.layer];
  if (!L) return null;
  const found = [];
  const reach = 5;
  for (let dr = -reach; dr <= reach; dr++) {
    for (let dc = -reach; dc <= reach; dc++) {
      if (dc === 0 && dr === 0) continue;
      const c = p.col + dc;
      const r = p.row + dr;
      if (tileAt(p.layer, c, r) !== ".") continue;
      if (L.objects[c + "," + r]) continue;
      if (floorItemAt(p.layer, c, r)) continue;
      found.push({ col: c, row: r, d: Math.hypot(dc, dr) });
    }
  }
  if (found.length === 0) return null;
  found.sort((x, y) => x.d - y.d);
  return { col: found[0].col, row: found[0].row };
}

function dropStackItem(p, stackIndex) {
  const stack = p._inv[stackIndex];
  if (!stack) return false;
  const spot = findDropSpot(p);
  if (!spot) {
    sendPlayer(p, { type: "item_result", ok: false, text: "There is no room to drop that here." });
    return false;
  }
  const name = stack.name;
  stack.count = stack.count - 1;
  if (stack.count <= 0) p._inv.splice(stackIndex, 1);
  const entry = { layer: p.layer, col: spot.col, row: spot.row, name: name };
  const burnMs = lightBurnMs(name);
  if (burnMs > 0) {
    const carried = p._burn && p._burn[name] ? p._burn[name] : Date.now() + burnMs;
    entry.burnAt = carried;
    if (p._burn && p._inv.every((s) => String(s.name).toLowerCase() !== String(name).toLowerCase())) delete p._burn[name];
  }
  worldSession.floorItems.push(entry);
  notifyItem(p.layer, spot.col, spot.row, { type: "itemadded", col: spot.col, row: spot.row, name: name });
  journalPlayer(p);
  return true;
}

function handleInvMove(p, data) {
  const from = parseInt(data.from, 10);
  const to = parseInt(data.to, 10);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return;
  if (from < 0 || from >= p._inv.length || to < 0) return;
  const target = Math.min(to, p._inv.length - 1);
  if (target !== from) {
    const moved = p._inv.splice(from, 1)[0];
    p._inv.splice(target, 0, moved);
  }
  syncPlayerInventory(p);
}

function handleInvCombine(p, data) {
  const from = parseInt(data.from, 10);
  const onto = parseInt(data.onto, 10);
  if (!Number.isInteger(from) || !Number.isInteger(onto) || from === onto) return;
  const first = p._inv[from];
  const second = p._inv[onto];
  if (!first || !second) {
    syncPlayerInventory(p);
    return;
  }
  let recipe = null;
  const allRecipes = VISION.combineRecipes.concat(FARM.combineRecipes);
  for (const r of allRecipes) {
    if ((farmNameMatches(r.a, first.name) && farmNameMatches(r.b, second.name)) || (farmNameMatches(r.a, second.name) && farmNameMatches(r.b, first.name))) {
      recipe = r;
      break;
    }
  }
  if (!recipe) {
    p._inv[from] = second;
    p._inv[onto] = first;
    syncPlayerInventory(p);
    return;
  }
  if (worldCombat.isInFight(p)) {
    sendPlayer(p, { type: "item_result", ok: false, text: "You can't do that during battle." });
    syncPlayerInventory(p);
    return;
  }
  const chargeNeeded = Number(recipe.charge) || 0;
  if (chargeNeeded > 0 && farmCanWater(p) < chargeNeeded) {
    sendPlayer(p, { type: "item_result", ok: false, text: "Your Watering Can is empty. Fill it at a water source first." });
    syncPlayerInventory(p);
    return;
  }
  const count = Math.max(1, Number(recipe.resultCount) || 1);
  const resultName = farmItem(recipe.result);
  const returnList = Array.isArray(recipe.returns) ? recipe.returns : [];
  const takes = [];
  if (recipe.consumeA) takes.push({ spec: recipe.a, count: 1 });
  if (recipe.consumeB) takes.push({ spec: recipe.b, count: 1 });
  const gives = [{ spec: resultName, count: count }];
  for (const x of returnList) gives.push({ spec: x.item, count: Number(x.count) || 1 });
  if (!farmInvFits(p, takes, gives)) {
    sendPlayer(p, { type: "item_result", ok: false, text: "Your bag is full." });
    syncPlayerInventory(p);
    return;
  }
  let resultStack = null;
  for (const stack of p._inv) {
    if (String(stack.name).toLowerCase() === resultName.toLowerCase()) resultStack = stack;
  }
  let insertAt = -1;
  const consumeSpecs = [];
  if (recipe.consumeA) consumeSpecs.push(recipe.a);
  if (recipe.consumeB) consumeSpecs.push(recipe.b);
  for (const spec of consumeSpecs) {
    for (let i = 0; i < p._inv.length; i++) {
      const stack = p._inv[i];
      if (farmNameMatches(spec, stack.name)) {
        stack.count = stack.count - 1;
        if (stack.count <= 0) {
          p._inv.splice(i, 1);
          if (insertAt === -1) insertAt = i;
        }
        break;
      }
    }
  }
  if (resultStack && p._inv.indexOf(resultStack) !== -1) {
    resultStack.count = resultStack.count + count;
  } else {
    const entry = { name: resultName, count: count };
    if (insertAt === -1 || insertAt > p._inv.length) p._inv.push(entry);
    else p._inv.splice(insertAt, 0, entry);
  }
  for (const x of returnList) farmInvGive(p, x.item, Number(x.count) || 1);
  if (chargeNeeded > 0) farmSetCanWater(p, farmCanWater(p) - chargeNeeded);
  syncPlayerInventory(p);
  sendPlayer(p, { type: "item_result", ok: true, text: recipe.text || ("You made " + resultName + ".") });
}

function handleInvDrop(p, data) {
  const slot = parseInt(data.slot, 10);
  if (!Number.isInteger(slot) || slot < 0 || slot >= p._inv.length) {
    syncPlayerInventory(p);
    return;
  }
  if (worldCombat.isInFight(p)) {
    sendPlayer(p, { type: "c_notice", text: "You can't drop things during battle." });
    syncPlayerInventory(p);
    return;
  }
  dropStackItem(p, slot);
  syncPlayerInventory(p);
}

function handleLightStick(p, data) {
  const cfg = VISION.torchStick;
  if (worldCombat.isInFight(p)) {
    sendPlayer(p, { type: "item_result", ok: false, text: "You can't do that during battle." });
    return;
  }
  let hasStick = false;
  for (const stack of p._inv) {
    if (stack && String(stack.name).toLowerCase() === String(cfg.item).toLowerCase() && stack.count > 0) hasStick = true;
  }
  if (!hasStick) {
    sendPlayer(p, { type: "item_result", ok: false, text: "You don't have a " + cfg.item + "." });
    return;
  }
  const via = String(data.via || "");
  let usedWith = "";
  if (via === "move") {
    const moveName = String(data.name || "");
    if (fireMovesOf(p).indexOf(moveName) === -1) {
      sendPlayer(p, { type: "item_result", ok: false, text: "You can't light the " + cfg.item + " with " + moveName + "." });
      return;
    }
    usedWith = moveName;
  } else if (via === "item") {
    const itemName = String(data.name || "");
    let allowed = false;
    for (const igniter of VISION.igniterItems) {
      if (String(igniter).toLowerCase() === itemName.toLowerCase() && itemName.toLowerCase() !== String(cfg.item).toLowerCase()) allowed = true;
    }
    let has = false;
    for (const stack of p._inv) {
      if (stack && String(stack.name).toLowerCase() === itemName.toLowerCase() && stack.count > 0) has = true;
    }
    if (!allowed || !has) {
      sendPlayer(p, { type: "item_result", ok: false, text: "You can't light the " + cfg.item + " with that." });
      return;
    }
    usedWith = itemName;
  } else if (via === "structure") {
    const col = parseInt(data.col, 10);
    const row = parseInt(data.row, 10);
    const L = layers[p.layer];
    const obj = L && Number.isInteger(col) && Number.isInteger(row) ? L.objects[col + "," + row] : null;
    if (!obj || !stickStructureMatch(obj.name)) {
      sendPlayer(p, { type: "item_result", ok: false, text: "There is no fire there to light the " + cfg.item + " with." });
      return;
    }
    if (Math.max(Math.abs(p.col - col), Math.abs(p.row - row)) > (Number(cfg.range) || 2)) {
      sendPlayer(p, { type: "item_result", ok: false, text: "You are too far from the fire." });
      return;
    }
    usedWith = obj.name.replace(/^Lit[_ ]/i, "").replace(/[_ ]?\d+$/, "").replace(/_/g, " ");
  } else {
    return;
  }
  let resultStack = null;
  for (const stack of p._inv) {
    if (stack && String(stack.name).toLowerCase() === String(cfg.result).toLowerCase()) resultStack = stack;
  }
  removeOneItem(p, cfg.item);
  if (resultStack && resultStack.count > 0) {
    resultStack.count = resultStack.count + 1;
  } else {
    p._inv.push({ name: cfg.result, count: 1 });
  }
  syncPlayerInventory(p);
  sendPlayer(p, { type: "item_result", ok: true, text: "You light the " + cfg.item + " with " + usedWith + ". It is now a " + cfg.result + "." });
}

function handleLightWithMove(p, data) {
  const col = parseInt(data.col, 10);
  const row = parseInt(data.row, 10);
  if (!Number.isInteger(col) || !Number.isInteger(row)) return;
  const L = layers[p.layer];
  const obj = L ? L.objects[col + "," + row] : null;
  if (!obj) return;
  const pair = lightableFor(obj.name);
  if (!pair) return;
  if (Math.max(Math.abs(p.col - col), Math.abs(p.row - row)) > 2) {
    sendPlayer(p, { type: "item_result", ok: false, text: "Move closer to the " + (pair.label || "fire") + "." });
    return;
  }
  lightObject(p, col, row, obj, pair, String(data.move || ""));
}

const FIRES_FILE = path.join(WORLD_DIR, "fires.json");
let fires = {};
try {
  const savedFires = JSON.parse(fs.readFileSync(FIRES_FILE, "utf8"));
  if (savedFires && typeof savedFires === "object") fires = savedFires;
} catch (e) {}

function saveFires() {
  writeJsonFile(FIRES_FILE, fires);
}

function extinguishFire(key) {
  const parts = key.split(",").map((v) => parseInt(v, 10));
  const layer = parts[0];
  const col = parts[1];
  const row = parts[2];
  const L = layers[layer];
  const obj = L ? L.objects[col + "," + row] : null;
  if (!obj) return;
  for (const pair of VISION.lightable) {
    const re = new RegExp("(^|[^A-Za-z])" + escapeRegex(pair.lit), "i");
    if (!re.test(obj.name)) continue;
    const unlitName = obj.name.replace(re, (m, pre) => pre + pair.unlit);
    if (allObjectNames().indexOf(unlitName) === -1) return;
    applyObjects(layer, [[col, row, unlitName, obj.solid ? 1 : 0, obj.rot || 0, obj.flip ? 1 : 0]]);
    return;
  }
}

function fireTick() {
  const now = Date.now();
  let changed = false;
  for (const key of Object.keys(fires)) {
    if (fires[key] <= now) {
      extinguishFire(key);
      delete fires[key];
      changed = true;
    }
  }
  if (changed) saveFires();
}

function removeOneItem(p, name) {
  const want = String(name).toLowerCase();
  for (let i = 0; i < p._inv.length; i++) {
    const stack = p._inv[i];
    if (stack && String(stack.name).toLowerCase() === want) {
      stack.count = stack.count - 1;
      if (stack.count <= 0) p._inv.splice(i, 1);
      return true;
    }
  }
  return false;
}

function floorBurnTick(now) {
  for (let i = worldSession.floorItems.length - 1; i >= 0; i--) {
    const it = worldSession.floorItems[i];
    const burnMs = lightBurnMs(it.name);
    if (burnMs <= 0) continue;
    if (!it.burnAt) {
      it.burnAt = now + burnMs;
      continue;
    }
    if (now >= it.burnAt) {
      worldSession.floorItems.splice(i, 1);
      notifyItem(it.layer, it.col, it.row, { type: "itemremoved", col: it.col, row: it.row });
    }
  }
}

function lightCarryTick() {
  const now = Date.now();
  floorBurnTick(now);
  for (const id of Object.keys(worldSession.players)) {
    const p = worldSession.players[id];
    if (!p) continue;
    if (!p._burn) p._burn = {};
    for (const def of VISION.lightItems) {
      const burnMs = (Number(def.burnSeconds) || 0) * 1000;
      if (burnMs <= 0) continue;
      const has = p._inv.some((stack) => stack && String(stack.name).toLowerCase() === String(def.item).toLowerCase());
      if (!has) {
        delete p._burn[def.item];
        continue;
      }
      if (!p._burn[def.item]) {
        p._burn[def.item] = now + burnMs;
        continue;
      }
      if (now >= p._burn[def.item]) {
        delete p._burn[def.item];
        removeOneItem(p, def.item);
        sendPlayer(p, { type: "item_result", ok: false, text: "Your " + def.item + " burned out." });
        syncPlayerInventory(p);
      }
    }
    checkLightChange(p);
  }
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
  const selfLight = playerLightInfo(p);
  p._lightSig = selfLight.r + "|" + selfLight.c;
  const layerObj = layers[p.layer];
  sendPlayer(p, { type: "view", layer: p.layer, c0: c0, r0: r0, rows: rows, art: artRows, palette: tilePalette, objects: objectsInWindow(p.layer, c0, r0, w, h), entities: entitiesInWindow(p.layer, c0, r0, w, h), items: itemsInWindow(p.layer, c0, r0, w, h), lm: layerObj && layerObj.light ? layerObj.light : "outdoor", nv: playerNightVision(p) ? 1 : 0, sl: selfLight.r, slc: selfLight.c });
}

function notifyItem(layer, col, row, data) {
  for (const id in worldSession.players) {
    const q = worldSession.players[id];
    if (cellInView(q, layer, col, row)) sendPlayer(q, data);
  }
  sendGms(layer, data);
}

const JOURNAL_FILE = path.join(WORLD_DIR, "journal.json");
const JOURNAL_WINDOW_MS = 5 * 60 * 1000;
const JOURNAL_KEEP_MS = 24 * 60 * 60 * 1000;
let journal = readJsonFile(JOURNAL_FILE, {});
if (!journal || typeof journal !== "object" || Array.isArray(journal)) journal = {};
let journalTimer = null;

function scheduleJournalWrite() {
  if (journalTimer) return;
  journalTimer = setTimeout(() => {
    journalTimer = null;
    const now = Date.now();
    for (const key of Object.keys(journal)) {
      if (now - journal[key].at > JOURNAL_KEEP_MS) delete journal[key];
    }
    writeJsonFile(JOURNAL_FILE, journal);
  }, 400);
}

function journalSignature(p) {
  const coins = p._sheet ? Number(p._sheet.coins) || 0 : 0;
  return JSON.stringify([p._inv, p._reported, p._coinsPending || 0, p._kills || [], p.hp, p.mp, coins]);
}

function journalPlayer(p) {
  if (!p._pass || p._npcName) return;
  journal[p._pass] = {
    at: Date.now(),
    inventory: p._inv.map((stack) => ({ name: stack.name, count: stack.count })),
    reported: p._reported || {},
    coins: p._sheet ? Number(p._sheet.coins) || 0 : 0,
    coinsPending: p._coinsPending || 0,
    kills: Array.isArray(p._kills) ? p._kills.slice() : [],
    hp: p.hp,
    mp: p.mp
  };
  p._journalSig = journalSignature(p);
  scheduleJournalWrite();
}

function journalTick() {
  for (const id of Object.keys(worldSession.players)) {
    const p = worldSession.players[id];
    if (!p || !p._pass || p._npcName) continue;
    if (journalSignature(p) !== p._journalSig || !journal[p._pass]) {
      journalPlayer(p);
    } else {
      journal[p._pass].at = Date.now();
    }
  }
}

function journalRestore(p, info, pass) {
  const entry = journal[pass];
  if (!entry || p._npcName) return false;
  if (Date.now() - entry.at > JOURNAL_WINDOW_MS) return false;
  if (!Array.isArray(entry.inventory)) return false;
  p._inv.length = 0;
  for (const stack of entry.inventory) {
    if (stack && stack.name) p._inv.push({ name: String(stack.name), count: Number(stack.count) || 1 });
  }
  p._reported = entry.reported && typeof entry.reported === "object" ? entry.reported : countInventory(info.inventory);
  p._coinsPending = Number(entry.coinsPending) || 0;
  p._kills = Array.isArray(entry.kills) ? entry.kills.slice() : [];
  if (p._sheet) p._sheet.coins = Number(entry.coins) || 0;
  if (Number(entry.hp) > 0) p.hp = Math.min(p.maxHp, Number(entry.hp));
  if (Number(entry.mp) >= 0) p.mp = Math.min(p.maxMp, Number(entry.mp));
  return true;
}

const COMBAT_LOG_FILE = path.join(WORLD_DIR, "combatlog.json");
const COMBAT_LOG_PERCENT = 20;
let combatLogs = readJsonFile(COMBAT_LOG_FILE, {});
if (!combatLogs || typeof combatLogs !== "object" || Array.isArray(combatLogs)) combatLogs = {};

function saveCombatLogs() {
  writeJsonFile(COMBAT_LOG_FILE, combatLogs);
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
  const coinsPending = p._coinsPending || 0;
  if (!final && Object.keys(delta).length === 0 && kills.length === 0 && !vitalsChanged && !accDirty && coinsPending === 0 && !p._coinLossPercent) return;
  p._coinsPending = 0;
  const ailments = p._sheet && Array.isArray(p._sheet.ailments) ? p._sheet.ailments : [];
  const entry = { id: makeToken(), kind: p._npcName ? "npc" : undefined, npcName: p._npcName || undefined, userId: p.userId, name: p.name, slot: p._slot, pass: p._pass, delta: delta, kills: kills, hp: p.hp, mp: p.mp, ailments: ailments, layer: p.layer, col: p.col, row: p.row, final: final, ts: Date.now() };
  if (coinsPending > 0) entry.coins = coinsPending;
  if (p._coinLossPercent) {
    entry.coinLossPercent = p._coinLossPercent;
    p._coinLossPercent = 0;
  }
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

function leaveWorldPlayer(id, skipPenalty) {
  const p = worldSession.players[id];
  if (!p) return false;
  const wasInFight = worldCombat.isInFight(p);
  if (wasInFight && !skipPenalty && !p._npcName) {
    combatLogs[p._key] = Date.now();
    saveCombatLogs();
  }
  worldCombat.onPlayerLeave(p);
  for (const ce of companionsOf(p)) {
    queueCompanionSave(ce, true);
    removeEntity(ce.id);
  }
  p._companions = [];
  queueWorldSave(p, true);
  journalPlayer(p);
  const passRecord = p._pass ? worldPasses[p._pass] : null;
  if (passRecord && !p._npcName) {
    passRecord.inventory = p._inv.map((stack) => ({ name: stack.name, count: stack.count }));
    if (passRecord.sheet && p._sheet) passRecord.sheet.coins = Number(p._sheet.coins) || 0;
    passRecord.hp = p.hp;
    passRecord.mp = p.mp;
    writeJsonFile(PASSES_FILE, worldPasses);
  }
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

const MUSIC_DIR = path.join(__dirname, "assets", "music", "Background");

function walkMusic(dir, rel, out, depth) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  entries.sort((x, y) => x.name.localeCompare(y.name));
  for (const entry of entries) {
    if (entry.isFile() && /\.ogg$/i.test(entry.name)) {
      const parts = rel.concat([entry.name]);
      out.push({ name: entry.name.replace(/\.ogg$/i, ""), url: "assets/music/Background/" + parts.map(encodeURIComponent).join("/"), group: rel.length > 0 ? String(rel[0]).toLowerCase() : "" });
    }
  }
  if (depth >= 4) return;
  for (const entry of entries) {
    if (entry.isDirectory()) walkMusic(path.join(dir, entry.name), rel.concat([entry.name]), out, depth + 1);
  }
}

app.get("/api/world/music", (req, res) => {
  const tracks = [];
  walkMusic(MUSIC_DIR, [], tracks, 0);
  res.set("Cache-Control", "no-cache");
  res.json({ tracks: tracks });
});

app.get("/api/world/assets", (req, res) => {
  res.json({ tiles: allTileNames(), tileCategories: tileCategoryList(), objects: allObjectNames(), objectCategories: scanObjects(false).categories, blocking: BLOCKING_TILES });
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
  const lightInfo = entityLightInfo(e);
  return { id: e.id, kind: e.kind, name: e.name, dex: e.dex, layer: e.layer, col: e.col, row: e.row, direction: e.direction, state: e.state, fainted: !!e.fainted, light: lightInfo.r, lc: lightInfo.c };
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
    const sheet = p._sheet || {};
    let expGained = 0;
    for (const k of Array.isArray(p._kills) ? p._kills : []) expGained += (Number(k && k.level) || 0) * 12;
    const stats = { species: sheet.species || "", dex: p.dex, types: Array.isArray(sheet.types) ? sheet.types : [], level: sheet.level || 1, exp: sheet.exp || 0, expGained: expGained, hp: p.hp, maxHp: p.maxHp, mp: p.mp, maxMp: p.maxMp, moves: worldCombat.sheetMoveInfo(sheet) };
    return { type: "gm_inspect", target: { type: "player", id: p.id }, name: p.name, inv: p._inv.map((s) => ({ name: s.name, count: s.count })), accessories: { head: acc.head || null, neck: acc.neck || null, back: acc.back || null }, capacity: capacityOf(p), stats: stats };
  }
  const e = t.ref;
  const acc = e.accessories || {};
  return { type: "gm_inspect", target: { type: "entity", id: e.id }, name: e.name, inv: (e.loot || []).map((s) => ({ name: s.name, count: s.count })), accessories: { head: acc.head || null, neck: acc.neck || null, back: acc.back || null }, capacity: 12 };
}

function syncPlayerInventory(p) {
  sendPlayer(p, { type: "inv_sync", inventory: p._inv.map((s) => ({ name: s.name, count: s.count })), sheet: clientSheet(p._sheet) });
  sendFarmCan(p);
  sendGms(null, { type: "gm_player", player: publicPlayer(p) });
  queueWorldSave(p, false);
  journalPlayer(p);
  checkLightChange(p);
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

const BUSH_SEARCH_MS = Number(process.env.PMD_BUSH_SEARCH_MS) || 2000;
const BUSH_WOBBLE_MS = 1000;
const BUSH_SOUND = "SFX/Bush Rustle.mp3";
const BUSH_REGROW_MS = Number(process.env.PMD_BUSH_REGROW_MS) || 300000;
const bushStates = {};

function plainBushName() {
  const files = scanObjects(false).files;
  if (files["Bush"]) return "Bush";
  const names = Object.keys(files).sort();
  for (const name of names) {
    if (/ - Bush$/.test(name)) return name;
  }
  return null;
}

function harvestedShownName(layer, col, row, obj) {
  const st = bushStates[layer + "," + col + "," + row];
  if (!st || !st.harvested || st.name !== obj.name) return obj.name;
  return plainBushName() || obj.name;
}

function handleObjectInteract(p) {
  const L = layers[p.layer];
  if (!L) return false;
  const facing = DELTAS[p.direction] || null;
  const candidates = [];
  if (facing) candidates.push([p.col + facing.dc, p.row + facing.dr]);
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dc === 0 && dr === 0) continue;
      candidates.push([p.col + dc, p.row + dr]);
    }
  }
  candidates.push([p.col, p.row]);
  for (const cell of candidates) {
    const obj = L.objects[cell[0] + "," + cell[1]];
    if (!obj) continue;
    if (chestIsObject(obj.name)) {
      if (worldCombat.isInFight(p)) {
        farmNotice(p, false, "You can't do that during battle.");
        return true;
      }
      chestOpen(p, cell[0], cell[1]);
      return true;
    }
    const stationInfo = farmStationOf(obj.name);
    if (stationInfo) {
      farmStationQuickAction(p, cell[0], cell[1], obj, stationInfo);
      return true;
    }
    if (isCoinPile(obj.name)) {
      collectCoinPile(p, cell[0], cell[1], obj);
      return true;
    }
    const lightPair = lightableFor(obj.name);
    if (lightPair) {
      lightObject(p, cell[0], cell[1], obj, lightPair);
      return true;
    }
    const item = berryItemForObject(obj.name);
    if (!item) continue;
    startBushSearch(p, cell[0], cell[1], obj, item);
    return true;
  }
  return false;
}

const FARM_CONFIG_FILE = path.join(WORLD_DIR, "farming.json");
const FARM_STATE_FILE = path.join(WORLD_DIR, "farm.json");

const FARM_DEFAULTS = {
  growthHour: 6,
  dryExpireSeconds: 60,
  dryExpireWithCrop: true,
  canCapacity: 10,
  reach: 2,
  tillableMatch: "Tillable",
  waterMatch: "water",
  showUnavailableRecipes: false,
  items: {
    hoe: ["Hoe"],
    scythe: ["Scythe"],
    shovel: ["Shovel"],
    can: ["Watering Can", "Watering_Can"],
    bowl: ["Bowl"],
    bowlWater: ["Bowl of Water", "Bow of Water", "Bowl_of_Water", "Bow_of_Water"]
  },
  soils: {
    brown: { label: "Brown earth", dry: ["BrownEarth_Tilled_Soil", "Brown_Earth_Tilled_Soil"], wet: ["Watered_BrownEarth_Tilled_Soil", "BrownEarth_Watered_Tilled_Soil", "Watered_Brown_Earth_Tilled_Soil"] },
    normal: { label: "Tilled soil", dry: ["Tilled_Soil"], wet: ["Watered_Tilled_Soil", "Tilled_Soil_Watered"] },
    red: { label: "Red soil", dry: ["Red_Tilled_Soil"], wet: ["Watered_Red_Tilled_Soil", "Red_Watered_Tilled_Soil"] }
  },
  soilFolders: {
    brown: ["Plains", "Meadow"],
    normal: ["Forest"],
    red: ["River", "Mountain", "Mountains", "Hills"]
  },
  soilFallback: "normal",
  crops: {
    wheat: {
      label: "Wheat",
      stages: ["Wheat_Stage0", "Wheat_Stage1", "Wheat_Stage2", "Wheat_Grown"],
      harvest: { item: ["Wheat"], min: 3, max: 4 }
    }
  },
  seeds: [
    { item: ["Wheat_Seeds_Packet", "Wheat Seeds Packet", "Wheat_Seed_Packet"], crop: "wheat" }
  ],
  stations: {
    mill: {
      label: "Milling Station",
      idle: ["Unfilled_Milling_Station"],
      busy: ["Filled_Milling_Station"],
      input: ["Wheat_Bundle", "Wheat Bundle"],
      inputCount: 1,
      output: ["Wheat_Flour", "Wheat Flour"],
      outputCount: 1,
      seconds: 60
    },
    oven: {
      label: "Baking Oven",
      unlit: ["Unlit_Baking_Oven"],
      lit: ["Lit_Baking_Oven"],
      input: ["Wheat_Dough", "Wheat Dough"],
      output: ["White_Bread", "White Bread"],
      seconds: 60,
      litSeconds: 180
    }
  },
  combineRecipes: [
    {
      id: "bowl_water",
      a: ["Bowl"],
      b: ["Watering Can", "Watering_Can"],
      result: ["Bowl of Water", "Bow of Water", "Bowl_of_Water", "Bow_of_Water"],
      resultCount: 1,
      consumeA: true,
      consumeB: false,
      charge: 1,
      returns: [],
      text: "You fill the Bowl from your Watering Can."
    },
    {
      id: "wheat_dough_drag",
      a: ["Bowl of Water", "Bow of Water", "Bowl_of_Water", "Bow_of_Water"],
      b: ["Wheat_Flour", "Wheat Flour"],
      result: ["Wheat_Dough", "Wheat Dough"],
      resultCount: 1,
      consumeA: true,
      consumeB: true,
      charge: 0,
      returns: [{ item: ["Bowl"], count: 1 }],
      text: "You knead the flour and water into dough."
    }
  ],
  recipes: [
    {
      id: "wheat_bundle",
      name: "Wheat Bundle",
      category: "Materials",
      needs: [{ item: ["Wheat"], count: 3 }, { item: ["Rope"], count: 1 }],
      gives: { item: ["Wheat_Bundle", "Wheat Bundle"], count: 1 },
      returns: [],
      text: "You tie the wheat into a bundle."
    },
    {
      id: "wheat_dough",
      name: "Wheat Dough",
      category: "Cooking",
      needs: [{ item: ["Bowl of Water", "Bow of Water", "Bowl_of_Water", "Bow_of_Water"], count: 1 }, { item: ["Wheat_Flour", "Wheat Flour"], count: 1 }],
      gives: { item: ["Wheat_Dough", "Wheat Dough"], count: 1 },
      returns: [{ item: ["Bowl"], count: 1 }],
      text: "You knead the flour and water into dough."
    }
  ]
};

function farmFill(defaults, saved) {
  const out = {};
  for (const key of Object.keys(defaults)) {
    const d = defaults[key];
    const s = saved && typeof saved === "object" ? saved[key] : undefined;
    if (s === undefined) {
      out[key] = d;
    } else if (d && typeof d === "object" && !Array.isArray(d) && s && typeof s === "object" && !Array.isArray(s)) {
      out[key] = farmFill(d, s);
      for (const extra of Object.keys(s)) {
        if (out[key][extra] === undefined) out[key][extra] = s[extra];
      }
    } else {
      out[key] = s;
    }
  }
  if (saved && typeof saved === "object") {
    for (const extra of Object.keys(saved)) {
      if (out[extra] === undefined) out[extra] = saved[extra];
    }
  }
  return out;
}

function loadFarmConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(FARM_CONFIG_FILE, "utf8"));
  } catch (e) {
    saved = {};
  }
  const cfg = farmFill(FARM_DEFAULTS, saved);
  if (Array.isArray(saved.combineRecipes)) cfg.combineRecipes = addMissingEntries(saved.combineRecipes, FARM_DEFAULTS.combineRecipes, "id");
  if (Array.isArray(saved.recipes)) cfg.recipes = addMissingEntries(saved.recipes, FARM_DEFAULTS.recipes, "id");
  try {
    writeJsonFile(FARM_CONFIG_FILE, cfg);
  } catch (e) {}
  return cfg;
}

const FARM = loadFarmConfig();

function loadFarmState() {
  const raw = readJsonFile(FARM_STATE_FILE, {});
  const state = { plots: {}, stations: {}, cans: {}, lastHour: null, lastAt: Date.now() };
  if (raw && typeof raw === "object") {
    if (raw.plots && typeof raw.plots === "object") state.plots = raw.plots;
    if (raw.stations && typeof raw.stations === "object") state.stations = raw.stations;
    if (raw.cans && typeof raw.cans === "object") state.cans = raw.cans;
    if (typeof raw.lastHour === "number") state.lastHour = raw.lastHour;
    if (typeof raw.lastAt === "number") state.lastAt = raw.lastAt;
  }
  return state;
}

const farmState = loadFarmState();
let farmSaveTimer = null;

function saveFarmState() {
  if (farmSaveTimer) return;
  farmSaveTimer = setTimeout(() => {
    farmSaveTimer = null;
    writeJsonFile(FARM_STATE_FILE, farmState);
  }, 500);
}

function farmNorm(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function farmSpecList(spec) {
  if (Array.isArray(spec)) return spec;
  return [spec];
}

function farmNameMatches(spec, name) {
  const wanted = farmNorm(name);
  for (const candidate of farmSpecList(spec)) {
    if (farmNorm(candidate) === wanted) return true;
  }
  return false;
}

let farmItemLookupCache = { source: null, map: null };

function farmItem(spec) {
  const index = currentItemIndex();
  if (farmItemLookupCache.source !== index) {
    const map = {};
    for (const key of Object.keys(index)) map[farmNorm(key)] = key;
    farmItemLookupCache = { source: index, map: map };
  }
  for (const candidate of farmSpecList(spec)) {
    const found = farmItemLookupCache.map[farmNorm(candidate)];
    if (found) return found;
  }
  return farmSpecList(spec)[0];
}

let farmObjectLookupCache = { source: null, map: null };

function farmObjectName(spec) {
  const data = scanObjects(false);
  if (farmObjectLookupCache.source !== data) {
    const map = {};
    for (const key of Object.keys(data.files)) {
      map[farmNorm(key)] = key;
      const cut = key.lastIndexOf(" - ");
      if (cut >= 0 && !map[farmNorm(key.substring(cut + 3))]) map[farmNorm(key.substring(cut + 3))] = key;
    }
    farmObjectLookupCache = { source: data, map: map };
  }
  for (const candidate of farmSpecList(spec)) {
    const found = farmObjectLookupCache.map[farmNorm(candidate)];
    if (found) return found;
  }
  return null;
}

function farmObjectNameMatches(spec, objName) {
  const text = String(objName || "");
  const cut = text.lastIndexOf(" - ");
  const base = cut >= 0 ? text.substring(cut + 3) : text;
  return farmNameMatches(spec, base) || farmNameMatches(spec, text);
}

function farmInvCount(p, spec) {
  let total = 0;
  for (const stack of p._inv) {
    if (stack && farmNameMatches(spec, stack.name)) total += stack.count;
  }
  return total;
}

function farmInvStack(p, spec) {
  for (const stack of p._inv) {
    if (stack && farmNameMatches(spec, stack.name)) return stack;
  }
  return null;
}

function farmInvTake(p, spec, count) {
  let left = count;
  for (let i = 0; i < p._inv.length && left > 0; i++) {
    const stack = p._inv[i];
    if (!stack || !farmNameMatches(spec, stack.name)) continue;
    const used = Math.min(left, stack.count);
    stack.count -= used;
    left -= used;
    if (stack.count <= 0) {
      p._inv.splice(i, 1);
      i--;
    }
  }
  return left === 0;
}

function farmInvGive(p, spec, count) {
  const name = farmItem(spec);
  for (const stack of p._inv) {
    if (stack && String(stack.name).toLowerCase() === name.toLowerCase()) {
      stack.count += count;
      return;
    }
  }
  p._inv.push({ name: name, count: count });
}

function farmInvFits(p, takes, gives) {
  const sim = p._inv.map((s) => ({ key: farmNorm(s.name), count: s.count }));
  for (const t of takes) {
    let left = t.count;
    for (let i = 0; i < sim.length && left > 0; i++) {
      if (!farmNameMatches(t.spec, sim[i].key)) continue;
      const used = Math.min(left, sim[i].count);
      sim[i].count -= used;
      left -= used;
      if (sim[i].count <= 0) {
        sim.splice(i, 1);
        i--;
      }
    }
  }
  for (const g of gives) {
    const key = farmNorm(farmItem(g.spec));
    let found = false;
    for (const s of sim) {
      if (s.key === key) {
        s.count += g.count;
        found = true;
        break;
      }
    }
    if (!found) sim.push({ key: key, count: g.count });
  }
  return sim.length <= capacityOf(p);
}

function farmCanKey(p) {
  return String(p._pass || p.id);
}

function farmCanWater(p) {
  const v = farmState.cans[farmCanKey(p)];
  return typeof v === "number" && v > 0 ? v : 0;
}

function farmSetCanWater(p, value) {
  farmState.cans[farmCanKey(p)] = Math.max(0, Math.min(Number(FARM.canCapacity) || 10, value));
  saveFarmState();
  sendFarmCan(p);
}

function sendFarmCan(p) {
  sendPlayer(p, { type: "farm_can", water: farmCanWater(p), cap: Number(FARM.canCapacity) || 10 });
}

function farmNotice(p, ok, text) {
  sendPlayer(p, { type: "item_result", ok: ok, text: text });
}

function farmArtNameAt(layer, col, row) {
  const ch = artAt(layer, col, row);
  if (!ch || ch === " ") return "";
  return parseTileName(tilePalette[ch] || "").base;
}

function farmTileCategory(tileName) {
  const wanted = String(tileName || "").toLowerCase();
  const cats = tileCategoryList();
  for (const cat of cats) {
    for (const t of cat.tiles) {
      if (String(t).toLowerCase() === wanted) return cat.name;
    }
  }
  return "";
}

function farmSoilKindFor(tileName) {
  const category = farmTileCategory(tileName).toLowerCase();
  for (const kind of Object.keys(FARM.soilFolders)) {
    for (const folder of FARM.soilFolders[kind]) {
      if (String(folder).toLowerCase() === category) return kind;
    }
  }
  return FARM.soilFallback;
}

function farmIsTillable(layer, col, row) {
  if (tileAt(layer, col, row) !== ".") return false;
  const name = farmArtNameAt(layer, col, row);
  if (!name) return false;
  return name.toLowerCase().indexOf(String(FARM.tillableMatch).toLowerCase()) !== -1;
}

function farmIsWater(layer, col, row) {
  const name = farmArtNameAt(layer, col, row);
  if (!name) return false;
  return name.toLowerCase().indexOf(String(FARM.waterMatch).toLowerCase()) !== -1;
}

function farmKey(layer, col, row) {
  return layer + "," + col + "," + row;
}

function farmPlotAt(layer, col, row) {
  return farmState.plots[farmKey(layer, col, row)] || null;
}

function farmCropDef(plot) {
  return plot && plot.crop ? FARM.crops[plot.crop.type] || null : null;
}

function farmCropRipe(plot) {
  const def = farmCropDef(plot);
  if (!def) return false;
  return plot.crop.stage >= def.stages.length - 1;
}

function farmPlotEntries(layer, col, row, plot) {
  const out = [];
  const soil = FARM.soils[plot.soil] || FARM.soils[FARM.soilFallback];
  const soilName = farmObjectName(plot.wet ? soil.wet : soil.dry) || farmSpecList(plot.wet ? soil.wet : soil.dry)[0];
  out.push({ col: col, row: row, name: soilName, rot: 0, flip: 0, w: 0, b: 0 });
  const def = farmCropDef(plot);
  if (def) {
    const stageIndex = Math.max(0, Math.min(def.stages.length - 1, plot.crop.stage));
    const cropName = farmObjectName(def.stages[stageIndex]) || def.stages[stageIndex];
    out.push({ col: col, row: row, name: cropName, rot: 0, flip: 0, w: 0, b: 0, k: 1 });
  }
  return out;
}

function farmRefresh(layer, col, row) {
  refreshViewsForCells(layer, [[col, row]]);
}

function farmRemovePlot(layer, col, row) {
  delete farmState.plots[farmKey(layer, col, row)];
  saveFarmState();
  farmRefresh(layer, col, row);
}

function farmAdvanceDays(days) {
  const changed = [];
  for (const key of Object.keys(farmState.plots)) {
    const plot = farmState.plots[key];
    const def = farmCropDef(plot);
    if (!def || !plot.wet) continue;
    const top = def.stages.length - 1;
    if (plot.crop.stage >= top) continue;
    plot.crop.stage = Math.min(top, plot.crop.stage + days);
    changed.push(key);
  }
  if (changed.length === 0) return;
  saveFarmState();
  for (const key of changed) {
    const parts = key.split(",").map((v) => parseInt(v, 10));
    farmRefresh(parts[0], parts[1], parts[2]);
  }
}

function farmCrossings(fromHour, advanced) {
  const gh = Number(FARM.growthHour);
  return Math.floor((fromHour + advanced - gh) / 24) - Math.floor((fromHour - gh) / 24);
}

function farmClockCheck() {
  const now = Date.now();
  if (farmState.lastHour === null) {
    farmState.lastHour = clockHour();
    farmState.lastAt = now;
    saveFarmState();
    return;
  }
  let advanced = 0;
  if (!worldClock.frozen) advanced = (now - farmState.lastAt) / (worldClock.dayMinutes * 60000) * 24;
  const crossings = advanced > 0 ? farmCrossings(farmState.lastHour, advanced) : 0;
  farmState.lastHour = clockHour();
  farmState.lastAt = now;
  if (crossings > 0) farmAdvanceDays(crossings);
}

function farmClockJump(beforeHour, afterHour) {
  const forward = (((afterHour - beforeHour) % 24) + 24) % 24;
  if (forward > 0) {
    const crossings = farmCrossings(beforeHour, forward);
    if (crossings > 0) farmAdvanceDays(crossings);
  }
  farmState.lastHour = afterHour;
  farmState.lastAt = Date.now();
  saveFarmState();
}

function farmStationOf(objName) {
  const mill = FARM.stations.mill;
  if (farmObjectNameMatches(mill.idle, objName)) return { kind: "mill", phase: "idle" };
  if (farmObjectNameMatches(mill.busy, objName)) return { kind: "mill", phase: "busy" };
  const oven = FARM.stations.oven;
  if (farmObjectNameMatches(oven.unlit, objName)) return { kind: "oven", phase: "unlit" };
  if (farmObjectNameMatches(oven.lit, objName)) return { kind: "oven", phase: "lit" };
  return null;
}

function farmSwapObject(layer, col, row, obj, spec) {
  const name = farmObjectName(spec);
  if (!name) return false;
  applyObjects(layer, [[col, row, name, obj.solid ? 1 : 0, obj.rot || 0, obj.flip ? 1 : 0]]);
  return true;
}

function farmStationState(layer, col, row) {
  return farmState.stations[farmKey(layer, col, row)] || null;
}

function farmWaterMoves(p) {
  const out = [];
  const moves = p._sheet && Array.isArray(p._sheet.moves) ? p._sheet.moves : [];
  for (const m of moves) {
    if (!m || !m.name) continue;
    const data = getMoveData(m.name) || (m.data && typeof m.data === "object" ? m.data : null);
    if (!data) continue;
    if (String(data.type).toLowerCase() === "water") out.push(m.name);
  }
  return out;
}

function farmIgniterStacks(p) {
  const out = [];
  for (const igniter of VISION.igniterItems) {
    const stack = farmInvStack(p, igniter);
    if (stack) out.push(stack);
  }
  return out;
}

function farmSecondsLeft(at) {
  return Math.max(1, Math.ceil((at - Date.now()) / 1000));
}

function farmStationOptions(p, col, row, obj, info) {
  const options = [];
  let title = "";
  let hint = "";
  const now = Date.now();
  if (info.kind === "mill") {
    const cfg = FARM.stations.mill;
    title = cfg.label;
    const st = farmStationState(p.layer, col, row);
    if (info.phase === "idle") {
      const have = farmInvCount(p, cfg.input);
      const need = Number(cfg.inputCount) || 1;
      if (have >= need) options.push({ act: "mill_start", arg: "", item: farmItem(cfg.input), label: "Grind " + farmItem(cfg.input).replace(/_/g, " ") + " into " + farmItem(cfg.output).replace(/_/g, " ") });
      else hint = "You need " + need + " " + farmItem(cfg.input).replace(/_/g, " ") + " to grind.";
    } else {
      const readyAt = st && typeof st.readyAt === "number" ? st.readyAt : 0;
      if (now >= readyAt) options.push({ act: "mill_take", arg: "", item: "", label: "Collect " + farmItem(cfg.output).replace(/_/g, " ") });
      else hint = "The mill is still grinding (" + farmSecondsLeft(readyAt) + "s left).";
    }
  } else {
    const cfg = FARM.stations.oven;
    title = cfg.label;
    let st = farmStationState(p.layer, col, row);
    const lit = info.phase === "lit";
    const doughName = farmItem(cfg.input).replace(/_/g, " ");
    const breadName = farmItem(cfg.output).replace(/_/g, " ");
    const holding = st && st.dough > 0;
    if (holding && st.bakeAt && now >= st.bakeAt) {
      options.push({ act: "oven_take", arg: "", item: "", label: "Take out " + breadName });
    } else if (holding && st.bakeAt) {
      hint = "The " + doughName + " is baking (" + farmSecondsLeft(st.bakeAt) + "s left).";
    }
    if (!holding && farmInvCount(p, cfg.input) > 0) {
      options.push({ act: "oven_dough", arg: "", item: farmItem(cfg.input), label: "Put " + doughName + " in the oven" });
    }
    if (!lit) {
      for (const m of knownFireAttacks(p)) options.push({ act: "oven_light", arg: "move:" + m, item: "", label: "Light the oven with " + m });
      for (const stack of farmIgniterStacks(p)) options.push({ act: "oven_light", arg: "item:" + stack.name, item: stack.name, label: "Light the oven with " + stack.name });
      if (options.length === 0 && !hint) hint = "You need Flint and Steel, a fire move or a lit torch to light the oven, or " + doughName + " to bake.";
    }
    if (options.length === 0 && !hint) hint = "Put " + doughName + " in the oven to bake " + breadName + ".";
  }
  return { title: title, options: options, hint: hint };
}

function farmOptionsAt(p, col, row, sel) {
  const L = layers[p.layer];
  const options = [];
  let title = "";
  let hint = "";
  if (!L) return { title: title, options: options, hint: hint };
  const obj = L.objects[col + "," + row];
  if (obj) {
    const info = farmStationOf(obj.name);
    if (info) {
      const result = farmStationOptions(p, col, row, obj, info);
      return result;
    }
    return { title: "", options: [], hint: "" };
  }
  const plot = farmPlotAt(p.layer, col, row);
  const canStack = farmInvStack(p, FARM.items.can);
  if (plot) {
    const soil = FARM.soils[plot.soil] || FARM.soils[FARM.soilFallback];
    title = soil.label + (plot.wet ? " (watered)" : " (dry)");
    const def = farmCropDef(plot);
    if (def) title += " | " + def.label + " " + (farmCropRipe(plot) ? "ready to harvest" : "stage " + (plot.crop.stage + 1) + " of " + def.stages.length);
    if (def && farmCropRipe(plot) && farmInvStack(p, FARM.items.scythe)) {
      options.push({ act: "harvest", arg: "", item: farmItem(FARM.items.scythe), label: "Harvest " + def.label + " with " + farmItem(FARM.items.scythe).replace(/_/g, " ") });
    }
    if (!plot.wet) {
      if (canStack && farmCanWater(p) > 0) options.push({ act: "water_can", arg: "", item: canStack.name, label: "Water with " + canStack.name + " (" + farmCanWater(p) + " left)" });
      for (const m of farmWaterMoves(p)) options.push({ act: "water_move", arg: m, item: "", label: "Water with " + m });
    }
    if (!def) {
      for (const seed of FARM.seeds) {
        const stack = farmInvStack(p, seed.item);
        if (stack && FARM.crops[seed.crop]) options.push({ act: "plant", arg: seed.crop + ":" + stack.name, item: stack.name, label: "Plant " + String(stack.name).replace(/_/g, " ") });
      }
    }
    const shovel = farmInvStack(p, FARM.items.shovel);
    if (shovel) options.push({ act: "shovel", arg: "", item: shovel.name, label: "Dig up with " + shovel.name });
    if (options.length === 0) hint = def ? "The " + def.label.toLowerCase() + " is still growing." : "Nothing to do with this soil right now.";
  } else {
    const hoe = farmInvStack(p, FARM.items.hoe);
    if (hoe && farmIsTillable(p.layer, col, row)) {
      title = "Tillable ground";
      options.push({ act: "till", arg: "", item: hoe.name, label: "Till soil with " + hoe.name });
    }
    const waterHere = farmIsWater(p.layer, col, row) || (col === p.col && row === p.row && farmIsWater(p.layer, p.col, p.row));
    if (waterHere && canStack) {
      title = title || "Water";
      options.push({ act: "fill", arg: "", item: canStack.name, label: "Fill " + canStack.name + " (" + farmCanWater(p) + "/" + FARM.canCapacity + ")" });
    }
  }
  if (sel) {
    const wanted = farmNorm(sel);
    options.sort((x, y) => {
      const xs = farmNorm(x.item) === wanted ? 0 : 1;
      const ys = farmNorm(y.item) === wanted ? 0 : 1;
      return xs - ys;
    });
  }
  return { title: title, options: options, hint: hint };
}

function farmInReach(p, col, row) {
  const reach = Number(FARM.reach) || 2;
  return Math.max(Math.abs(p.col - col), Math.abs(p.row - row)) <= reach;
}

function handleFarmQuery(p, data) {
  if (worldCombat.isInFight(p)) return;
  const col = parseInt(data.col, 10);
  const row = parseInt(data.row, 10);
  if (!Number.isInteger(col) || !Number.isInteger(row)) return;
  if (!farmInReach(p, col, row)) return;
  const chestObj = layers[p.layer] ? layers[p.layer].objects[col + "," + row] : null;
  if (chestObj && chestIsObject(chestObj.name)) {
    chestOpen(p, col, row);
    return;
  }
  const result = farmOptionsAt(p, col, row, String(data.sel || ""));
  if (result.options.length === 0) {
    if (result.hint) farmNotice(p, false, result.hint);
    return;
  }
  sendPlayer(p, { type: "farm_menu", col: col, row: row, title: result.title, options: result.options.map((o) => ({ act: o.act, arg: o.arg, label: o.label })) });
}

function handleFarmDo(p, data) {
  if (worldCombat.isInFight(p)) {
    farmNotice(p, false, "You can't do that during battle.");
    return;
  }
  const col = parseInt(data.col, 10);
  const row = parseInt(data.row, 10);
  if (!Number.isInteger(col) || !Number.isInteger(row)) return;
  if (!farmInReach(p, col, row)) {
    farmNotice(p, false, "Move closer.");
    return;
  }
  const act = String(data.act || "");
  const arg = String(data.arg || "");
  const result = farmOptionsAt(p, col, row, "");
  let found = null;
  for (const o of result.options) {
    if (o.act === act && o.arg === arg) found = o;
  }
  if (!found) {
    farmNotice(p, false, result.hint || "You can't do that right now.");
    return;
  }
  farmExecute(p, col, row, act, arg);
}

function farmExecute(p, col, row, act, arg) {
  const layer = p.layer;
  const L = layers[layer];
  const plot = farmPlotAt(layer, col, row);
  const key = farmKey(layer, col, row);
  if (act === "till") {
    const kind = farmSoilKindFor(farmArtNameAt(layer, col, row));
    farmState.plots[key] = { soil: kind, wet: false, dryAt: Date.now(), crop: null };
    saveFarmState();
    farmRefresh(layer, col, row);
    farmNotice(p, true, "You till the ground.");
    return;
  }
  if (act === "fill") {
    farmSetCanWater(p, Number(FARM.canCapacity) || 10);
    farmNotice(p, true, "You fill your Watering Can (" + farmCanWater(p) + "/" + FARM.canCapacity + ").");
    return;
  }
  if (act === "water_can") {
    if (!plot) return;
    farmSetCanWater(p, farmCanWater(p) - 1);
    plot.wet = true;
    saveFarmState();
    farmRefresh(layer, col, row);
    farmNotice(p, true, "You water the soil (" + farmCanWater(p) + " left in the can).");
    return;
  }
  if (act === "water_move") {
    if (!plot) return;
    plot.wet = true;
    saveFarmState();
    farmRefresh(layer, col, row);
    farmNotice(p, true, "You water the soil with " + arg + ".");
    return;
  }
  if (act === "plant") {
    if (!plot || plot.crop) return;
    const cut = arg.indexOf(":");
    const cropType = arg.substring(0, cut);
    const seedName = arg.substring(cut + 1);
    if (!FARM.crops[cropType]) return;
    if (!farmInvTake(p, seedName, 1)) return;
    plot.crop = { type: cropType, stage: 0 };
    saveFarmState();
    syncPlayerInventory(p);
    farmRefresh(layer, col, row);
    farmNotice(p, true, "You plant the seeds.");
    return;
  }
  if (act === "harvest") {
    const def = farmCropDef(plot);
    if (!def || !farmCropRipe(plot)) return;
    const min = Number(def.harvest.min) || 1;
    const max = Math.max(min, Number(def.harvest.max) || min);
    const amount = min + Math.floor(Math.random() * (max - min + 1));
    if (!farmInvFits(p, [], [{ spec: def.harvest.item, count: amount }])) {
      farmNotice(p, false, "Your bag is full.");
      return;
    }
    farmInvGive(p, def.harvest.item, amount);
    plot.crop = null;
    plot.wet = false;
    plot.dryAt = Date.now();
    saveFarmState();
    syncPlayerInventory(p);
    farmRefresh(layer, col, row);
    farmNotice(p, true, "You harvest " + amount + " " + farmItem(def.harvest.item).replace(/_/g, " ") + ".");
    return;
  }
  if (act === "shovel") {
    if (!plot) return;
    farmRemovePlot(layer, col, row);
    farmNotice(p, true, "You dig up the soil.");
    return;
  }
  const obj = L ? L.objects[col + "," + row] : null;
  if (!obj) return;
  const info = farmStationOf(obj.name);
  if (!info) return;
  const now = Date.now();
  if (act === "mill_start" && info.kind === "mill" && info.phase === "idle") {
    const cfg = FARM.stations.mill;
    const need = Number(cfg.inputCount) || 1;
    if (farmInvCount(p, cfg.input) < need) return;
    if (!farmSwapObject(layer, col, row, obj, cfg.busy)) {
      farmNotice(p, false, "The filled mill image is missing.");
      return;
    }
    farmInvTake(p, cfg.input, need);
    farmState.stations[key] = { kind: "mill", readyAt: now + (Number(cfg.seconds) || 60) * 1000 };
    saveFarmState();
    syncPlayerInventory(p);
    farmNotice(p, true, "The mill starts grinding. Come back in " + (Number(cfg.seconds) || 60) + " seconds.");
    return;
  }
  if (act === "mill_take" && info.kind === "mill" && info.phase === "busy") {
    const cfg = FARM.stations.mill;
    const st = farmStationState(layer, col, row);
    if (st && now < st.readyAt) return;
    const amount = Number(cfg.outputCount) || 1;
    if (!farmInvFits(p, [], [{ spec: cfg.output, count: amount }])) {
      farmNotice(p, false, "Your bag is full.");
      return;
    }
    farmInvGive(p, cfg.output, amount);
    farmSwapObject(layer, col, row, obj, cfg.idle);
    delete farmState.stations[key];
    saveFarmState();
    syncPlayerInventory(p);
    farmNotice(p, true, "You collect " + amount + " " + farmItem(cfg.output).replace(/_/g, " ") + ".");
    return;
  }
  if (info.kind !== "oven") return;
  const cfg = FARM.stations.oven;
  let st = farmStationState(layer, col, row);
  if (!st) {
    st = { kind: "oven", dough: 0, bakeAt: null, litUntil: 0 };
    farmState.stations[key] = st;
  }
  const bakeMs = (Number(cfg.seconds) || 60) * 1000;
  const litMs = (Number(cfg.litSeconds) || 180) * 1000;
  if (act === "oven_light" && info.phase === "unlit") {
    const cut = arg.indexOf(":");
    const via = arg.substring(0, cut);
    const name = arg.substring(cut + 1);
    if (via === "move" && knownFireAttacks(p).indexOf(name) === -1) return;
    if (via === "item" && !farmInvStack(p, name)) return;
    if (!farmSwapObject(layer, col, row, obj, cfg.lit)) {
      farmNotice(p, false, "The lit oven image is missing.");
      return;
    }
    st.litUntil = now + litMs;
    if (st.dough > 0 && !st.bakeAt) {
      st.bakeAt = now + bakeMs;
      st.litUntil = Math.max(st.litUntil, st.bakeAt + 5000);
    }
    saveFarmState();
    farmNotice(p, true, "You light the oven with " + name + ".");
    return;
  }
  if (act === "oven_dough") {
    if (st.dough > 0) return;
    if (!farmInvTake(p, cfg.input, 1)) return;
    st.dough = 1;
    st.bakeAt = null;
    if (info.phase === "lit") {
      st.bakeAt = now + bakeMs;
      st.litUntil = Math.max(st.litUntil || 0, st.bakeAt + 5000);
    }
    saveFarmState();
    syncPlayerInventory(p);
    farmNotice(p, true, info.phase === "lit" ? "You put the dough in. It will bake in " + (bakeMs / 1000) + " seconds." : "You put the dough in. Light the oven to start baking.");
    return;
  }
  if (act === "oven_take") {
    if (!(st.dough > 0 && st.bakeAt && now >= st.bakeAt)) return;
    if (!farmInvFits(p, [], [{ spec: cfg.output, count: 1 }])) {
      farmNotice(p, false, "Your bag is full.");
      return;
    }
    farmInvGive(p, cfg.output, 1);
    st.dough = 0;
    st.bakeAt = null;
    saveFarmState();
    syncPlayerInventory(p);
    farmNotice(p, true, "You take out a fresh " + farmItem(cfg.output).replace(/_/g, " ") + ".");
    return;
  }
}

function farmStationQuickAction(p, col, row, obj, info) {
  if (worldCombat.isInFight(p)) {
    farmNotice(p, false, "You can't do that during battle.");
    return;
  }
  const result = farmStationOptions(p, col, row, obj, info);
  if (result.options.length === 0) {
    farmNotice(p, false, result.hint || "Nothing to do here.");
    return;
  }
  const first = result.options[0];
  farmExecute(p, col, row, first.act, first.arg);
}

function farmTick() {
  farmClockCheck();
  const now = Date.now();
  const expireMs = (Number(FARM.dryExpireSeconds) || 60) * 1000;
  for (const key of Object.keys(farmState.plots)) {
    const plot = farmState.plots[key];
    const parts = key.split(",").map((v) => parseInt(v, 10));
    const layer = parts[0];
    const col = parts[1];
    const row = parts[2];
    const L = layers[layer];
    if (!L || L.objects[col + "," + row] || tileAt(layer, col, row) !== ".") {
      farmRemovePlot(layer, col, row);
      continue;
    }
    if (plot.wet) continue;
    if (plot.crop && !FARM.dryExpireWithCrop) continue;
    if (now - (plot.dryAt || now) >= expireMs) farmRemovePlot(layer, col, row);
  }
  for (const key of Object.keys(farmState.stations)) {
    const st = farmState.stations[key];
    const parts = key.split(",").map((v) => parseInt(v, 10));
    const layer = parts[0];
    const col = parts[1];
    const row = parts[2];
    const L = layers[layer];
    const obj = L ? L.objects[col + "," + row] : null;
    const info = obj ? farmStationOf(obj.name) : null;
    if (!info || info.kind !== st.kind) {
      delete farmState.stations[key];
      saveFarmState();
      continue;
    }
    if (st.kind === "oven" && info.phase === "lit" && !(st.dough > 0) && now >= (st.litUntil || 0)) {
      farmSwapObject(layer, col, row, obj, FARM.stations.oven.unlit);
      delete farmState.stations[key];
      saveFarmState();
    }
  }
}

function farmCraftRecipes(p) {
  const out = [];
  for (const r of FARM.recipes) {
    const needs = r.needs.map((n) => ({ item: farmItem(n.item), count: Number(n.count) || 1, have: farmInvCount(p, n.item) }));
    let available = true;
    for (const n of needs) {
      if (n.have < n.count) available = false;
    }
    if (!available && !FARM.showUnavailableRecipes) continue;
    out.push({
      id: r.id,
      name: r.name || farmItem(r.gives.item).replace(/_/g, " "),
      category: r.category || "Other",
      icon: farmItem(r.gives.item),
      count: Number(r.gives.count) || 1,
      needs: needs,
      returns: (r.returns || []).map((x) => ({ item: farmItem(x.item), count: Number(x.count) || 1 })),
      available: available
    });
  }
  return out;
}

function sendCraftMenu(p) {
  const recipes = farmCraftRecipes(p);
  const pages = [];
  for (const r of recipes) {
    let page = null;
    for (const pg of pages) {
      if (pg.name === r.category) page = pg;
    }
    if (!page) {
      page = { name: r.category, recipes: [] };
      pages.push(page);
    }
    page.recipes.push(r);
  }
  pages.sort((a, b) => a.name.localeCompare(b.name));
  sendPlayer(p, { type: "craft_menu", pages: pages });
}

function handleCraftMake(p, data) {
  if (worldCombat.isInFight(p)) {
    farmNotice(p, false, "You can't craft during battle.");
    return;
  }
  const id = String(data.id || "");
  let recipe = null;
  for (const r of FARM.recipes) {
    if (r.id === id) recipe = r;
  }
  if (!recipe) return;
  for (const n of recipe.needs) {
    if (farmInvCount(p, n.item) < (Number(n.count) || 1)) {
      farmNotice(p, false, "You don't have the ingredients.");
      sendCraftMenu(p);
      return;
    }
  }
  const takes = recipe.needs.map((n) => ({ spec: n.item, count: Number(n.count) || 1 }));
  const gives = [{ spec: recipe.gives.item, count: Number(recipe.gives.count) || 1 }];
  for (const x of recipe.returns || []) gives.push({ spec: x.item, count: Number(x.count) || 1 });
  if (!farmInvFits(p, takes, gives)) {
    farmNotice(p, false, "Your bag is full.");
    return;
  }
  for (const t of takes) farmInvTake(p, t.spec, t.count);
  for (const g of gives) farmInvGive(p, g.spec, g.count);
  syncPlayerInventory(p);
  farmNotice(p, true, recipe.text || ("You made " + farmItem(recipe.gives.item).replace(/_/g, " ") + "."));
  sendCraftMenu(p);
}

const CHEST_CONFIG_FILE = path.join(WORLD_DIR, "chests.json");
const CHEST_DATA_FILE = path.join(WORLD_DIR, "chestdata.json");

const CHEST_DEFAULTS = {
  slots: 20,
  maxStack: 99,
  reach: 2,
  match: ["Chest_Front", "Chest_Side"]
};

function loadChestConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CHEST_CONFIG_FILE, "utf8"));
  } catch (e) {
    saved = {};
  }
  const cfg = farmFill(CHEST_DEFAULTS, saved);
  try {
    writeJsonFile(CHEST_CONFIG_FILE, cfg);
  } catch (e) {}
  return cfg;
}

const CHEST = loadChestConfig();
let chestData = readJsonFile(CHEST_DATA_FILE, {});
if (!chestData || typeof chestData !== "object" || Array.isArray(chestData)) chestData = {};
let chestSaveTimer = null;

function saveChestData() {
  if (chestSaveTimer) return;
  chestSaveTimer = setTimeout(() => {
    chestSaveTimer = null;
    writeJsonFile(CHEST_DATA_FILE, chestData);
  }, 500);
}

function chestIsObject(name) {
  return farmObjectNameMatches(CHEST.match, name);
}

function chestSlotsOf(key) {
  const total = Number(CHEST.slots) || 20;
  let slots = chestData[key];
  if (!Array.isArray(slots)) {
    slots = [];
    chestData[key] = slots;
  }
  while (slots.length < total) slots.push(null);
  return slots;
}

function chestPayload(key) {
  return chestSlotsOf(key).map((s) => (s && s.name ? { name: s.name, count: s.count } : null));
}

function chestParseKey(key) {
  const parts = key.split(",").map((v) => parseInt(v, 10));
  return { layer: parts[0], col: parts[1], row: parts[2] };
}

function chestBroadcast(key) {
  const payload = chestPayload(key);
  for (const id in worldSession.players) {
    const q = worldSession.players[id];
    if (q._chestKey === key) sendPlayer(q, { type: "chest_sync", key: key, slots: payload });
  }
}

function chestInReach(p, key) {
  const c = chestParseKey(key);
  if (c.layer !== p.layer) return false;
  return Math.max(Math.abs(p.col - c.col), Math.abs(p.row - c.row)) <= (Number(CHEST.reach) || 2);
}

function chestOpen(p, col, row) {
  const key = farmKey(p.layer, col, row);
  p._chestKey = key;
  const c = chestParseKey(key);
  sendPlayer(p, { type: "chest_open", key: key, col: c.col, row: c.row, slots: chestPayload(key), max: Number(CHEST.maxStack) || 99 });
}

function chestClosePlayer(p) {
  if (!p._chestKey) return;
  p._chestKey = null;
  sendPlayer(p, { type: "chest_close" });
}

function chestInsert(slots, name, count, preferred) {
  const max = Number(CHEST.maxStack) || 99;
  let left = count;
  if (Number.isInteger(preferred) && preferred >= 0 && preferred < slots.length) {
    const target = slots[preferred];
    if (!target) {
      const put = Math.min(max, left);
      slots[preferred] = { name: name, count: put };
      left -= put;
    } else if (String(target.name).toLowerCase() === name.toLowerCase() && target.count < max) {
      const put = Math.min(max - target.count, left);
      target.count += put;
      left -= put;
    }
  }
  for (let i = 0; i < slots.length && left > 0; i++) {
    const s = slots[i];
    if (s && String(s.name).toLowerCase() === name.toLowerCase() && s.count < max) {
      const put = Math.min(max - s.count, left);
      s.count += put;
      left -= put;
    }
  }
  for (let i = 0; i < slots.length && left > 0; i++) {
    if (!slots[i]) {
      const put = Math.min(max, left);
      slots[i] = { name: name, count: put };
      left -= put;
    }
  }
  return left;
}

function chestCheck(p, data) {
  if (worldCombat.isInFight(p)) {
    farmNotice(p, false, "You can't do that during battle.");
    return null;
  }
  const key = p._chestKey;
  if (!key || String(data.key || key) !== key) return null;
  if (!chestInReach(p, key)) {
    chestClosePlayer(p);
    return null;
  }
  const c = chestParseKey(key);
  const L = layers[c.layer];
  const obj = L ? L.objects[c.col + "," + c.row] : null;
  if (!obj || !chestIsObject(obj.name)) {
    chestClosePlayer(p);
    return null;
  }
  return key;
}

function handleChestPut(p, data) {
  const key = chestCheck(p, data);
  if (!key) return;
  const from = parseInt(data.from, 10);
  if (!Number.isInteger(from) || from < 0 || from >= p._inv.length) {
    syncPlayerInventory(p);
    return;
  }
  const stack = p._inv[from];
  if (lightBurnMs(stack.name) > 0) {
    farmNotice(p, false, "A burning " + stack.name + " can't be stored.");
    syncPlayerInventory(p);
    return;
  }
  const slots = chestSlotsOf(key);
  const preferred = data.to === undefined || data.to === null ? -1 : parseInt(data.to, 10);
  const total = stack.count;
  const left = chestInsert(slots, stack.name, total, preferred);
  const moved = total - left;
  if (moved <= 0) {
    farmNotice(p, false, "The chest is full.");
    return;
  }
  stack.count = left;
  if (stack.count <= 0) p._inv.splice(from, 1);
  saveChestData();
  syncPlayerInventory(p);
  chestBroadcast(key);
}

function handleChestTake(p, data) {
  const key = chestCheck(p, data);
  if (!key) return;
  const slots = chestSlotsOf(key);
  const from = parseInt(data.from, 10);
  if (!Number.isInteger(from) || from < 0 || from >= slots.length || !slots[from]) {
    chestBroadcast(key);
    return;
  }
  const entry = slots[from];
  let existing = null;
  for (const stack of p._inv) {
    if (String(stack.name).toLowerCase() === String(entry.name).toLowerCase()) existing = stack;
  }
  if (!existing && p._inv.length >= capacityOf(p)) {
    farmNotice(p, false, "Your bag is full.");
    return;
  }
  if (existing) existing.count += entry.count;
  else p._inv.push({ name: entry.name, count: entry.count });
  slots[from] = null;
  saveChestData();
  syncPlayerInventory(p);
  chestBroadcast(key);
}

function handleChestMove(p, data) {
  const key = chestCheck(p, data);
  if (!key) return;
  const slots = chestSlotsOf(key);
  const from = parseInt(data.from, 10);
  const to = parseInt(data.to, 10);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return;
  if (from < 0 || to < 0 || from >= slots.length || to >= slots.length || !slots[from]) {
    chestBroadcast(key);
    return;
  }
  const a = slots[from];
  const b = slots[to];
  const max = Number(CHEST.maxStack) || 99;
  if (!b) {
    slots[to] = a;
    slots[from] = null;
  } else if (String(a.name).toLowerCase() === String(b.name).toLowerCase()) {
    const put = Math.min(max - b.count, a.count);
    b.count += put;
    a.count -= put;
    if (a.count <= 0) slots[from] = null;
  } else {
    slots[to] = a;
    slots[from] = b;
  }
  saveChestData();
  chestBroadcast(key);
}

function chestTick() {
  for (const id in worldSession.players) {
    const q = worldSession.players[id];
    if (!q._chestKey) continue;
    if (!chestInReach(q, q._chestKey)) {
      chestClosePlayer(q);
      continue;
    }
    const c = chestParseKey(q._chestKey);
    const L = layers[c.layer];
    const obj = L ? L.objects[c.col + "," + c.row] : null;
    if (!obj || !chestIsObject(obj.name)) chestClosePlayer(q);
  }
}

const COIN_PILE_MIN = 40;
const COIN_PILE_MAX = 100;

function isCoinPile(name) {
  return /pile[ _]of[ _]coins/i.test(String(name || ""));
}

function collectCoinPile(p, col, row, obj) {
  if (worldCombat.isInFight(p)) {
    sendPlayer(p, { type: "item_result", ok: false, text: "You can't pick that up during battle." });
    return;
  }
  const layer = p.layer;
  const current = layers[layer] && layers[layer].objects[col + "," + row];
  if (!current || current.name !== obj.name) return;
  applyObjects(layer, [[col, row, "", 0]]);
  const amount = COIN_PILE_MIN + Math.floor(Math.random() * (COIN_PILE_MAX - COIN_PILE_MIN + 1));
  if (p._sheet) p._sheet.coins = (Number(p._sheet.coins) || 0) + amount;
  p._coinsPending = (p._coinsPending || 0) + amount;
  syncPlayerInventory(p);
  sendPlayer(p, { type: "item_result", ok: true, text: "You picked up " + amount + " coins!" });
}

function startBushSearch(p, col, row, obj, item) {
  if (worldCombat.isInFight(p)) {
    sendPlayer(p, { type: "item_result", ok: false, text: "You can't search a bush during battle." });
    return;
  }
  if (p._bushSearch) return;
  const layer = p.layer;
  const cdKey = layer + "," + col + "," + row;
  const existing = bushStates[cdKey];
  if (existing && existing.name === obj.name) return;
  bushStates[cdKey] = { name: obj.name, harvested: false };
  p._bushSearch = true;
  const wobble = { type: "obj_wobble", layer: layer, col: col, row: row, ms: BUSH_WOBBLE_MS, sound: BUSH_SOUND, volume: 0.5 };
  for (const id in worldSession.players) {
    const q = worldSession.players[id];
    if (cellInView(q, layer, col, row)) sendPlayer(q, wobble);
  }
  sendGms(layer, wobble);
  sendPlayer(p, { type: "item_result", ok: true, text: "You search the " + item.replace(/ Berry$/, "") + " berry bush..." });
  setTimeout(() => {
    p._bushSearch = false;
    const release = () => {
      const st = bushStates[cdKey];
      if (st && !st.harvested) delete bushStates[cdKey];
    };
    if (worldSession.players[p.id] !== p || p.layer !== layer) {
      release();
      return;
    }
    if (Math.max(Math.abs(p.col - col), Math.abs(p.row - row)) > 1) {
      release();
      sendPlayer(p, { type: "item_result", ok: false, text: "You moved away and stopped searching." });
      return;
    }
    if (worldCombat.isInFight(p)) {
      release();
      return;
    }
    const current = layers[layer] && layers[layer].objects[col + "," + row];
    if (!current || current.name !== obj.name) {
      release();
      return;
    }
    const amount = 1 + Math.floor(Math.random() * 3);
    let got = 0;
    let bagFull = false;
    for (let i = 0; i < amount; i++) {
      let mine = null;
      for (const entry of p._inv) {
        if (entry.name === item) { mine = entry; break; }
      }
      if (!mine && p._inv.length >= capacityOf(p)) {
        bagFull = true;
        break;
      }
      if (mine) mine.count = mine.count + 1;
      else p._inv.push({ name: item, count: 1 });
      got++;
    }
    if (got > 0) {
      bushStates[cdKey].harvested = true;
      refreshViewsForCells(layer, [[col, row]]);
      setTimeout(() => {
        const st = bushStates[cdKey];
        if (st) delete bushStates[cdKey];
        refreshViewsForCells(layer, [[col, row]]);
      }, BUSH_REGROW_MS);
      syncPlayerInventory(p);
      sendPlayer(p, { type: "item_result", ok: true, text: "You found " + got + " " + (got > 1 ? item.replace(/Berry$/, "Berries") : item) + "!" + (bagFull ? " Your bag is full." : "") });
    } else {
      release();
      sendPlayer(p, { type: "item_result", ok: false, text: "Your bag is full." });
    }
  }, BUSH_SEARCH_MS);
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
    if (!handleObjectInteract(p)) sendPlayer(p, { type: "interact_none" });
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
  const names = allObjectNames();
  const changedObjs = [];
  for (const op of ops) {
    const c = op[0];
    const r = op[1];
    const name = typeof op[2] === "string" ? op[2] : "";
    const solid = op[3] === 0 || op[3] === false ? false : true;
    const rot = cleanRot(op[4]);
    const flip = op[5] === 1 || op[5] === true;
    if (!Number.isInteger(c) || !Number.isInteger(r)) continue;
    if (c < 0 || c >= LAYER_W || r < 0 || r >= LAYER_H) continue;
    const key = c + "," + r;
    const old = L.objects[key];
    if (name === "") {
      if (!old) continue;
      delete L.objects[key];
      changedObjs.push([c, r, "", 0, 0, 0]);
      continue;
    }
    if (names.indexOf(name) === -1) continue;
    if (old && old.name === name && old.solid === solid && (old.rot || 0) === rot && !!old.flip === flip) continue;
    L.objects[key] = { name: name, solid: solid, rot: rot, flip: flip };
    changedObjs.push([c, r, name, solid ? 1 : 0, rot, flip ? 1 : 0]);
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
    objList.push([parseInt(parts[0], 10), parseInt(parts[1], 10), L.objects[k].name, L.objects[k].solid ? 1 : 0, L.objects[k].rot || 0, L.objects[k].flip ? 1 : 0]);
  }
  const passList = Object.keys(L.passable || {}).map((k) => k.split(",").map((v) => parseInt(v, 10)));
  sendSocket(gm.socket, { type: "gm_layer", layer: gm.layer, passable: passList, name: L.name, rows: L.rows.map((row) => row.replace(/ +$/, "")), art: L.art.map((row) => row.replace(/ +$/, "")), palette: tilePalette, objects: objList, entities: Object.keys(entities).filter((id) => entities[id].layer === gm.layer && !entities[id].down).map((id) => gmEntity(entities[id])), portals: L.portals, spawn: null, spawns: spawnList(), floorItems: items, layers: layerSummaries(), light: L.light || "outdoor" });
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

  if (data.type === "gm_pass") {
    const n = parseInt(data.layer, 10);
    if (!validLayerNumber(n) || !Array.isArray(data.ops)) return;
    const L = ensureLayer(n);
    const changed = [];
    for (const op of data.ops.slice(0, MAX_EDIT_OPS)) {
      const c = op[0];
      const r = op[1];
      if (!Number.isInteger(c) || !Number.isInteger(r)) continue;
      if (c < 0 || c >= LAYER_W || r < 0 || r >= LAYER_H) continue;
      const key = c + "," + r;
      const on = op[2] === 1 || op[2] === true;
      if (on && !L.passable[key]) {
        L.passable[key] = 1;
        changed.push([c, r, 1]);
      } else if (!on && L.passable[key]) {
        delete L.passable[key];
        changed.push([c, r, 0]);
      }
    }
    if (changed.length > 0) {
      scheduleLayerSave();
      sendGms(n, { type: "gm_pass", layer: n, cells: changed });
      sendLayerSummaries();
    }
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

  if (data.type === "gm_spawn_add" || data.type === "gm_spawn") {
    const n = parseInt(data.layer, 10);
    const c = parseInt(data.col, 10);
    const r = parseInt(data.row, 10);
    if (!validSpawnSpot(n, c, r)) return;
    ensureLayer(n);
    const name = String(data.name || "").trim().slice(0, 40) || "Spawn " + spawnNextId;
    spawnPoints.push({ id: "s" + spawnNextId, name: name, layer: n, col: c, row: r });
    spawnNextId = spawnNextId + 1;
    saveSpawns();
    broadcastSpawns();
    return;
  }

  if (data.type === "gm_spawn_edit") {
    const sp = spawnPoints.find((x) => x.id === String(data.id));
    if (!sp) return;
    if (typeof data.name === "string" && data.name.trim()) sp.name = data.name.trim().slice(0, 40);
    if (data.col !== undefined) {
      const n = parseInt(data.layer, 10);
      const c = parseInt(data.col, 10);
      const r = parseInt(data.row, 10);
      if (validSpawnSpot(n, c, r)) {
        ensureLayer(n);
        sp.layer = n;
        sp.col = c;
        sp.row = r;
      }
    }
    saveSpawns();
    broadcastSpawns();
    return;
  }

  if (data.type === "gm_spawn_del") {
    const idx = spawnPoints.findIndex((x) => x.id === String(data.id));
    if (idx === -1) return;
    spawnPoints.splice(idx, 1);
    saveSpawns();
    broadcastSpawns();
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

  if (data.type === "gm_vitals") {
    const t = gmTargetOf(data.target);
    if (!t || t.kind !== "player") return;
    const p = t.ref;
    const pick = (value, fallback, lo, hi) => {
      const n = parseInt(value, 10);
      if (!Number.isFinite(n)) return fallback;
      return Math.max(lo, Math.min(hi, n));
    };
    const maxHp = pick(data.maxHp, p.maxHp, 1, 9999);
    const maxMp = pick(data.maxMp, p.maxMp, 0, 9999);
    p.maxHp = maxHp;
    p.maxMp = maxMp;
    p.hp = pick(data.hp, p.hp, 1, maxHp);
    p.mp = pick(data.mp, p.mp, 0, maxMp);
    sendPlayer(p, { type: "vitals", hp: p.hp, mp: p.mp, maxHp: p.maxHp, maxMp: p.maxMp });
    for (const seenId in p._seen) {
      const q = worldSession.players[seenId];
      if (q) sendPlayer(q, { type: "p_vitals", id: p.id, hp: p.hp, maxHp: p.maxHp, mp: p.mp, maxMp: p.maxMp });
    }
    sendGms(null, { type: "gm_player", player: publicPlayer(p) });
    queueWorldSave(p, false);
    sendSocket(gm.socket, inspectPayload(t));
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
    if (c < 0 || c >= LAYER_W || r < 0 || r >= LAYER_H) {
      sendSocket(gm.socket, { type: "gm_notice", text: "Coordinates must be between 0 and " + (LAYER_W - 1) + "." });
      return;
    }
    teleportPlayer(p, n, c, r);
    sendLayerSummaries();
    sendSocket(gm.socket, { type: "gm_notice", text: "Moved " + p.name + " to layer " + p.layer + " (" + p.col + ", " + p.row + ")." });
    return;
  }

  if (data.type === "gm_time") {
    handleGmTime(gm, data);
    return;
  }

  if (data.type === "gm_light_mode") {
    handleGmLightMode(gm, data);
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

  sendSocket(socket, { type: "init", id: null, role: "gm", world: true, turn: 1, players: {}, floorItems: [], vision: VISION });
  sendSocket(socket, timeMessage());
  const list = [];
  for (const id in worldSession.players) list.push(publicPlayer(worldSession.players[id]));
  sendSocket(socket, { type: "gm_players", players: list });
  sendSocket(socket, { type: "gm_spawns", spawns: spawnList() });
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

const pendingSpawnSockets = {};
const SPAWN_PICK_WAIT_MS = 300000;
const IDLE_LOGOUT_MS = Number(process.env.PMD_IDLE_LOGOUT_MS) || 300000;
const IDLE_WARN_MS = Math.min(IDLE_LOGOUT_MS - 1000, Number(process.env.PMD_IDLE_WARN_MS) || 270000);

function closePendingSpawn(userId) {
  const old = pendingSpawnSockets[String(userId)];
  if (!old) return;
  delete pendingSpawnSockets[String(userId)];
  old.pendingSpawn = false;
  try { old.send(JSON.stringify({ type: "ended", reason: "You opened the world in another window." })); } catch (e) {}
  try { old.close(); } catch (e) {}
}

function idleTick() {
  const now = Date.now();
  for (const id of Object.keys(worldSession.players)) {
    const p = worldSession.players[id];
    if (!p) continue;
    if (worldCombat.isInFight(p)) {
      p._lastActive = now;
      p._idleWarned = false;
      continue;
    }
    const idle = now - (p._lastActive || now);
    if (idle >= IDLE_LOGOUT_MS) {
      forceLeaveUser(p.userId, "You were logged out for being idle for 5 minutes. Your character is saved.");
      sendLayerSummaries();
    } else if (idle >= IDLE_WARN_MS && !p._idleWarned) {
      p._idleWarned = true;
      sendPlayer(p, { type: "idle_warn", seconds: Math.ceil((IDLE_LOGOUT_MS - idle) / 1000) });
    }
  }
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
  closePendingSpawn(info.userId);

  const preKey = info.userId + "|" + info.name;
  const preSaved = worldState.positions[preKey];
  const preLayer = preSaved && Number.isInteger(preSaved.layer) ? preSaved.layer : 0;
  const hasSaved = !!(preSaved && Number.isInteger(preSaved.col) && Number.isInteger(preSaved.row) && layers[preLayer]);

  if (!hasSaved && spawnPoints.length > 1) {
    socket.pendingSpawn = true;
    socket.playerId = null;
    socket.userId = info.userId;
    pendingSpawnSockets[String(info.userId)] = socket;
    sendSocket(socket, { type: "spawn_select", name: info.name, spawns: spawnList().map((sp) => ({ id: sp.id, name: sp.name, layer: sp.layer, layerName: sp.layerName })) });
    const waitTimer = setTimeout(() => {
      if (socket.pendingSpawn) {
        try { socket.close(); } catch (e) {}
      }
    }, SPAWN_PICK_WAIT_MS);
    socket.on("message", (raw) => {
      if (!socket.pendingSpawn) return;
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        return;
      }
      if (!data || data.type !== "spawn_pick") return;
      const chosen = spawnPoints.find((x) => x.id === String(data.id));
      if (!chosen) return;
      socket.pendingSpawn = false;
      clearTimeout(waitTimer);
      if (pendingSpawnSockets[String(info.userId)] === socket) delete pendingSpawnSockets[String(info.userId)];
      startWorldPlayer(socket, pass, info, chosen);
    });
    socket.on("close", () => {
      clearTimeout(waitTimer);
      socket.pendingSpawn = false;
      if (pendingSpawnSockets[String(info.userId)] === socket) delete pendingSpawnSockets[String(info.userId)];
    });
    return;
  }

  startWorldPlayer(socket, pass, info, hasSaved ? null : (spawnPoints[0] || null));
}

function startWorldPlayer(socket, pass, info, spawn) {
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
  if (spawn) {
    ensureLayer(spawn.layer);
    layer = spawn.layer;
    startCol = spawn.col;
    startRow = spawn.row;
  }
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
    _socket: socket,
    _lastActive: Date.now(),
    _idleWarned: false
  };
  const joinNotices = [];
  const restored = journalRestore(p, info, pass);
  if (restored) {
    p._kills = p._kills || [];
    joinNotices.push("Your inventory was restored from your last session.");
  }
  let combatLogged = false;
  if (combatLogs[key] && !p._npcName) {
    delete combatLogs[key];
    saveCombatLogs();
    const coinsBefore = p._sheet ? Number(p._sheet.coins) || 0 : 0;
    const coinLoss = Math.floor(coinsBefore * COMBAT_LOG_PERCENT / 100);
    if (p._sheet) p._sheet.coins = coinsBefore - coinLoss;
    p._coinLossPercent = COMBAT_LOG_PERCENT;
    combatLogged = true;
    joinNotices.push("You left during a battle last time. Combat logging cost you " + coinLoss + " coins (" + COMBAT_LOG_PERCENT + "%).");
  }
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
  sendPlayer(p, { type: "init", id: id, role: "player", world: true, layer: p.layer, turn: 1, players: players, floorItems: itemsInWindow(p.layer, p.col - VIEW_HALF_W, p.row - VIEW_HALF_H, w, h), inventory: inventory, sheet: clientSheet(p._sheet), itemFx: ITEM_FX, vision: VISION, chatRange: CHAT_RANGE });
  sendPlayer(p, timeMessage());
  for (const notice of joinNotices) sendPlayer(p, { type: "item_result", ok: !combatLogged, text: notice });
  if (!restored) p._kills = [];
  p._reportedHp = p.hp;
  p._reportedMp = p.mp;
  sendView(p);
  sendGms(null, { type: "gm_player", player: publicPlayer(p) });
  journalPlayer(p);
  if (combatLogged) queueWorldSave(p, false);
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
    me._lastActive = Date.now();
    me._idleWarned = false;

    if (data.type === "active") return;

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
    } else if (data.type === "inv_move") {
      handleInvMove(me, data);
    } else if (data.type === "inv_combine") {
      handleInvCombine(me, data);
    } else if (data.type === "inv_drop") {
      handleInvDrop(me, data);
    } else if (data.type === "farm_query") {
      handleFarmQuery(me, data);
    } else if (data.type === "farm_do") {
      handleFarmDo(me, data);
    } else if (data.type === "chest_put") {
      handleChestPut(me, data);
    } else if (data.type === "chest_take") {
      handleChestTake(me, data);
    } else if (data.type === "chest_move") {
      handleChestMove(me, data);
    } else if (data.type === "chest_close") {
      me._chestKey = null;
    } else if (data.type === "craft_open") {
      sendCraftMenu(me);
    } else if (data.type === "craft_make") {
      handleCraftMake(me, data);
    } else if (data.type === "light_stick") {
      handleLightStick(me, data);
    } else if (data.type === "light_move") {
      handleLightWithMove(me, data);
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
        const pickBurnMs = lightBurnMs(it.name);
        if (pickBurnMs > 0) {
          if (!me._burn) me._burn = {};
          const floorBurn = it.burnAt || Date.now() + pickBurnMs;
          me._burn[it.name] = stack && me._burn[it.name] ? Math.min(me._burn[it.name], floorBurn) : floorBurn;
        }
        if (stack) {
          stack.count = stack.count + 1;
        } else {
          me._inv.push({ name: it.name, count: 1 });
        }
        notifyItem(me.layer, it.col, it.row, { type: "itemremoved", col: it.col, row: it.row });
        sendPlayer(me, { type: "pickedup", name: it.name });
        journalPlayer(me);
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
      if (!dropStackItem(me, stackIndex)) {
        sendPlayer(me, { type: "dropfail" });
        return;
      }
      sendPlayer(me, { type: "dropok", name: name });
    } else if (data.type === "chat") {
      const text = String(data.text || "").slice(0, 200);
      const message = { type: "chat", id: me.id, dex: me.dex, name: me.name, text: text, ts: Date.now() };
      for (const otherId in worldSession.players) {
        const q = worldSession.players[otherId];
        if (!q || q === me || q.layer !== me.layer) continue;
        if (Math.hypot(q.col - me.col, q.row - me.row) > CHAT_RANGE) continue;
        sendPlayer(q, message);
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
setInterval(idleTick, 2000);
setInterval(fireTick, 5000);
setInterval(farmTick, 1000);
setInterval(chestTick, 1000);
setInterval(lightCarryTick, 2000);
setInterval(journalTick, 2000);
setInterval(scheduleJournalWrite, 30000);
setInterval(broadcastTime, 20000);
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
    leaveWorldPlayer(worldSession.players[id].id, true);
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