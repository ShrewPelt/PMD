const express = require("express");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use("/items", express.static(path.join(__dirname, "StorageData", "Items")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MAP = [
  "############################",
  "########...........#########",
  "##.......#########........##",
  "##.......##############...##",
  "##....#..............##...##",
  "##....#######.####...##...##",
  "##.......####.####........##",
  "###.#########.########.#####",
  "###....####......#####....##",
  "######.####....#.########.##",
  "######........##.###......##",
  "######.####......###.#######",
  "######.######.######.#######",
  "##.....######.#####.......##",
  "##....#######.####.......###",
  "##...###..............######",
  "##....#...########........##",
  "##........#########...##..##",
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

const players = {};
let nextId = 1;
let turnNumber = 1;
let intents = {};
let turnTimer = null;

function isFloor(col, row) {
  if (row < 0 || row >= MAP.length) return false;
  if (col < 0 || col >= MAP[row].length) return false;
  return MAP[row][col] === ".";
}

function broadcast(data, exceptId) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.playerId !== exceptId) {
      client.send(msg);
    }
  });
}

function connectedIds() {
  return Object.keys(players);
}

function allSubmitted() {
  const ids = connectedIds();
  if (ids.length === 0) return false;
  for (const id of ids) {
    if (!intents[id]) return false;
  }
  return true;
}

function onIntent(id, dir) {
  if (!players[id]) return;
  intents[id] = { dir: dir };
  if (dir) players[id].direction = dir;
  if (turnTimer === null) {
    turnTimer = setTimeout(resolveTurn, TURN_TIMEOUT);
  }
  if (allSubmitted()) {
    resolveTurn();
  }
}

function resolveTurn() {
  if (turnTimer !== null) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }

  const ids = connectedIds();
  const desired = {};

  for (const id of ids) {
    const p = players[id];
    const it = intents[id];
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

  turnNumber = turnNumber + 1;
  intents = {};
  broadcast({ type: "resolve", turn: turnNumber, players: result });
}

wss.on("connection", (socket) => {
  const id = nextId;
  nextId = nextId + 1;
  socket.playerId = id;

  const spawn = SPAWNS[(id - 1) % SPAWNS.length];
  players[id] = { id: id, col: spawn.col, row: spawn.row, direction: "down", dex: DEXES[(id - 1) % DEXES.length] };

  socket.send(JSON.stringify({ type: "init", id: id, turn: turnNumber, players: players }));
  broadcast({ type: "join", player: players[id] }, id);

  socket.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (data.type === "face") {
      const p = players[id];
      if (!p) return;
      p.direction = data.direction;
      broadcast({ type: "face", id: id, direction: p.direction }, id);
    } else if (data.type === "intent") {
      onIntent(id, data.dir);
    } else if (data.type === "chat") {
      const p = players[id];
      if (!p) return;
      const text = String(data.text || "").slice(0, 200);
      broadcast({ type: "chat", id: id, dex: p.dex, text: text }, id);
    }
  });

  socket.on("close", () => {
    delete players[id];
    delete intents[id];
    broadcast({ type: "leave", id: id }, id);
    if (connectedIds().length > 0 && turnTimer !== null && allSubmitted()) {
      resolveTurn();
    }
  });
});

server.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});