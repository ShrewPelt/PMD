const fs = require("fs");
const path = require("path");

const MOVES_PATH = path.join(__dirname, "..", "..", "StorageData", "Moves.json");
const CUSTOM_MOVES_PATH = path.join(__dirname, "..", "..", "StorageData", "CustomMoves.json");
const LEARNSETS_PATH = path.join(__dirname, "..", "..", "StorageData", "SpeciesMoves.json");

const jsonCache = {};
const overrides = {};

function registerMove(moveName, data) {
  if (moveName && data && typeof data === "object") overrides[moveName] = data;
}

function loadJson(p) {
  try {
    const mtime = fs.statSync(p).mtimeMs;
    const cached = jsonCache[p];
    if (cached && cached.mtime === mtime) return cached.data;
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    jsonCache[p] = { mtime, data };
    return data;
  } catch {
    return {};
  }
}

function getMoveData(moveName) {
  if (overrides[moveName]) return overrides[moveName];
  const custom = loadJson(CUSTOM_MOVES_PATH);
  if (custom[moveName]) return custom[moveName];
  const moves = loadJson(MOVES_PATH);
  return moves[moveName] || null;
}

function allMoveNames() {
  const moves = loadJson(MOVES_PATH);
  const custom = loadJson(CUSTOM_MOVES_PATH);
  return Array.from(new Set([...Object.keys(moves), ...Object.keys(custom)]));
}

function getLearnset(species) {
  const map = loadJson(LEARNSETS_PATH);
  if (map[species]) return map[species];
  const lower = species.toLowerCase();
  for (const key of Object.keys(map)) {
    if (key.toLowerCase() === lower) return map[key];
  }
  return [];
}

function defaultMoves(species, level) {
  const learnset = getLearnset(species);
  const learned = learnset.filter(e => e.level <= level).map(e => e.move);
  const unique = [];
  for (const m of learned) {
    if (!unique.includes(m)) unique.push(m);
  }
  return unique.slice(-4);
}

module.exports = { registerMove, MOVES_PATH, CUSTOM_MOVES_PATH, LEARNSETS_PATH, getMoveData, allMoveNames, getLearnset, defaultMoves };