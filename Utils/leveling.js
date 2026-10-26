const fs = require("fs");
const path = require("path");
const { levelEvolutionFor, hasKeepStone, evolve } = require("./evolutions");

const BASE_STATS_PATH = path.join(__dirname, "..", "StorageData", "SpeciesBaseStats.json");

const DEFAULT_BASE = { hp: 50, attack: 50, defense: 50, spAtk: 50, spDef: 50, speed: 50, growthRate: "mediumFast" };

const NATURES = {
  Hardy: {}, Lonely: { up: "attack", down: "defense" }, Brave: { up: "attack", down: "speed" }, Adamant: { up: "attack", down: "spAtk" }, Naughty: { up: "attack", down: "spDef" },
  Bold: { up: "defense", down: "attack" }, Docile: {}, Relaxed: { up: "defense", down: "speed" }, Impish: { up: "defense", down: "spAtk" }, Lax: { up: "defense", down: "spDef" },
  Timid: { up: "speed", down: "attack" }, Hasty: { up: "speed", down: "defense" }, Serious: {}, Jolly: { up: "speed", down: "spAtk" }, Naive: { up: "speed", down: "spDef" },
  Modest: { up: "spAtk", down: "attack" }, Mild: { up: "spAtk", down: "defense" }, Quiet: { up: "spAtk", down: "speed" }, Bashful: {}, Rash: { up: "spAtk", down: "spDef" },
  Calm: { up: "spDef", down: "attack" }, Gentle: { up: "spDef", down: "defense" }, Sassy: { up: "spDef", down: "speed" }, Careful: { up: "spDef", down: "spAtk" }, Quirky: {}
};

function loadBaseStats() {
  try {
    return JSON.parse(fs.readFileSync(BASE_STATS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function getBaseStats(species) {
  const map = loadBaseStats();
  if (map[species]) return map[species];
  const lower = species.toLowerCase();
  for (const key of Object.keys(map)) {
    if (key.toLowerCase() === lower) return map[key];
  }
  return null;
}

function growthRateFor(species) {
  const base = getBaseStats(species);
  return (base && base.growthRate) || "mediumFast";
}

function expForLevel(level, group) {
  if (level <= 1) return 0;
  const n = level;
  if (group === "fast") return Math.floor(0.8 * n * n * n);
  if (group === "slow") return Math.floor(1.25 * n * n * n);
  if (group === "mediumSlow") return Math.floor(1.2 * n * n * n - 15 * n * n + 100 * n - 140);
  return n * n * n;
}

function expToNext(level, group) {
  return expForLevel(level + 1, group) - expForLevel(level, group);
}

function levelForExp(exp, group) {
  let level = 1;
  while (level < 100 && expForLevel(level + 1, group) <= exp) {
    level++;
  }
  return level;
}

function statHp(base, iv, ev, level) {
  return Math.floor((2 * base + iv + Math.floor(ev / 4)) * level / 100) + level + 10;
}

function statOther(base, iv, ev, level, natureMult) {
  const raw = Math.floor((2 * base + iv + Math.floor(ev / 4)) * level / 100) + 5;
  return Math.floor(raw * natureMult);
}

function maxMpForLevel(level) {
  return 5 + level * 2;
}

function computeStats(character, baseOverride) {
  const base = baseOverride || getBaseStats(character.species) || DEFAULT_BASE;
  const iv = character.ivs;
  const ev = character.evs;
  const level = character.level;
  const nature = NATURES[character.nature] || {};
  const mult = (stat) => (nature.up === stat ? 1.1 : (nature.down === stat ? 0.9 : 1));
  return {
    hp: statHp(base.hp, iv.hp, ev.hp, level),
    attack: statOther(base.attack, iv.attack, ev.attack, level, mult("attack")),
    defense: statOther(base.defense, iv.defense, ev.defense, level, mult("defense")),
    spAtk: statOther(base.spAtk, iv.spAtk, ev.spAtk, level, mult("spAtk")),
    spDef: statOther(base.spDef, iv.spDef, ev.spDef, level, mult("spDef")),
    speed: statOther(base.speed, iv.speed, ev.speed, level, mult("speed"))
  };
}

function recalcStats(character) {
  const stats = computeStats(character);
  const boosts = character.boosts || {};
  character.attack = stats.attack + (boosts.attack || 0);
  character.defense = stats.defense + (boosts.defense || 0);
  character.spAtk = stats.spAtk + (boosts.spAtk || 0);
  character.spDef = stats.spDef + (boosts.spDef || 0);
  character.speed = stats.speed + (boosts.speed || 0);
  character.maxHp = stats.hp + (boosts.hp || 0);
  character.maxMp = maxMpForLevel(character.level) + (boosts.mp || 0);
  if (character.hp > character.maxHp) character.hp = character.maxHp;
  if (character.mp > character.maxMp) character.mp = character.maxMp;
  return character;
}

function applyExp(character, amount) {
  const group = growthRateFor(character.species);
  const oldMaxHp = character.maxHp;
  const oldMaxMp = character.maxMp;
  const before = character.level;

  character.exp = (character.exp || 0) + amount;
  const newLevel = levelForExp(character.exp, group);
  const leveledUp = newLevel > character.level;
  character.level = newLevel;

  recalcStats(character);
  if (leveledUp) {
    character.hp += (character.maxHp - oldMaxHp);
    character.mp += (character.maxMp - oldMaxMp);
    if (character.hp > character.maxHp) character.hp = character.maxHp;
    if (character.mp > character.maxMp) character.mp = character.maxMp;
  }

  const evolutions = [];
  let evo = levelEvolutionFor(character.species, character.level);
  while (evo && !hasKeepStone(character)) {
    const fromSpecies = character.species;
    const beforeMaxHp = character.maxHp;
    const beforeMaxMp = character.maxMp;
    evolve(character, evo.into);
    recalcStats(character);
    character.hp += Math.max(0, character.maxHp - beforeMaxHp);
    character.mp += Math.max(0, character.maxMp - beforeMaxMp);
    if (character.hp > character.maxHp) character.hp = character.maxHp;
    if (character.mp > character.maxMp) character.mp = character.maxMp;
    evolutions.push({ from: fromSpecies, into: evo.into });
    evo = levelEvolutionFor(character.species, character.level);
  }

  if (evolutions.length) {
    try { require("./evolutionAnnounce").announce(character, evolutions); } catch (e) {}
  }

  return { character, leveledUp, from: before, to: newLevel, evolutions };
}

module.exports = { NATURES, getBaseStats, growthRateFor, expForLevel, expToNext, levelForExp, computeStats, recalcStats, applyExp, maxMpForLevel };