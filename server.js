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

const SPAWNS = [
  { col: 13, row: 9 },
  { col: 14, row: 9 },
  { col: 12, row: 9 },
  { col: 13, row: 10 }
];

const DEXES = ["0004", "0133", "0495", "0025"];

const players = {};
let nextId = 1;

function broadcast(data, exceptId) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.playerId !== exceptId) {
      client.send(msg);
    }
  });
}

wss.on("connection", (socket) => {
  const id = nextId;
  nextId = nextId + 1;
  socket.playerId = id;

  const spawn = SPAWNS[(id - 1) % SPAWNS.length];
  players[id] = { id: id, col: spawn.col, row: spawn.row, direction: "down", dex: DEXES[(id - 1) % DEXES.length] };

  socket.send(JSON.stringify({ type: "init", id: id, players: players }));
  broadcast({ type: "join", player: players[id] }, id);

  socket.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (data.type === "move") {
      const p = players[id];
      if (!p) return;
      p.col = data.col;
      p.row = data.row;
      p.direction = data.direction;
      broadcast({ type: "move", id: id, col: p.col, row: p.row, direction: p.direction }, id);
    }
    if (data.type === "chat") {
      const p = players[id];
      if (!p) return;
      const text = String(data.text || "").slice(0, 200);
      broadcast({ type: "chat", id: id, dex: p.dex, text: text }, id);
    }
  });

  socket.on("close", () => {
    delete players[id];
    broadcast({ type: "leave", id: id }, id);
  });
});

server.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});