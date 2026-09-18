const express = require("express");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use("/items", express.static(path.join(__dirname, "StorageData", "Items")));

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

function isFloor(col, row) {
  if (row < 0 || row >= MAP.length) return false;
  if (col < 0 || col >= MAP[row].length) return false;
  return MAP[row][col] === ".";
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
  if (!isFloor(nc, nr)) { blocked(); return; }
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

  const passInfo = pass ? passcodes[pass] : null;
  const role = passInfo ? passInfo.role : "player";

  const session = getSession(sessionId);
  socket.sessionId = sessionId;
  socket.role = role;

  if (role === "gm") {
    socket.playerId = null;
    socket.send(JSON.stringify({ type: "init", id: null, role: "gm", turn: session.turnNumber, players: session.players, floorItems: session.floorItems }));
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
    socket.send(JSON.stringify({ type: "init", id: id, role: "player", turn: session.turnNumber, players: session.players, floorItems: session.floorItems }));
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