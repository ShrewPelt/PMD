const fs = require("fs");
const path = require("path");
const { computeStats, maxMpForLevel } = require("./leveling");
let sprites;
try { sprites = require("./sprites"); } catch (e) { sprites = { formPath: () => null }; }

const REGIONAL_PATH = path.join(__dirname, "..", "StorageData", "RegionalForms.json");
const REGIONAL_MOVES_PATH = path.join(__dirname, "..", "StorageData", "RegionalMoves.json");
const MEGA_PATH = path.join(__dirname, "..", "StorageData", "MegaForms.json");

const MEGA_STONE_LEVEL_BONUS = 25;
const POWERED_CANE_LEVEL_BONUS = 5;
const ENERGY_LINE_NAMES = ["jangmoo", "hakamoo", "kommoo"];

const STONE_TO_REGION = {
  "nocturne stone": "hisui",
  "void stone": "galar",
  "pearl stone": "alola",
  "geode stone": "paldea"
};

let regionalMap = null;
function loadRegional() {
  if (regionalMap) return regionalMap;
  try {
    regionalMap = JSON.parse(fs.readFileSync(REGIONAL_PATH, "utf8"));
  } catch {
    regionalMap = {};
  }
  return regionalMap;
}

function regionalDataFor(species, region) {
  const map = loadRegional();
  let entry = map[species];
  if (!entry) {
    const lower = species.toLowerCase();
    for (const k of Object.keys(map)) {
      if (k.toLowerCase() === lower) { entry = map[k]; break; }
    }
  }
  if (!entry) return null;
  return entry[region] || null;
}

function heldRegionFor(character) {
  if (!character) return null;
  if (character.region && regionalDataFor(character.species, character.region)) {
    return character.region;
  }
  if (!Array.isArray(character.inventory)) return null;
  for (const slot of character.inventory) {
    if (!slot || !slot.name) continue;
    const region = STONE_TO_REGION[String(slot.name).toLowerCase()];
    if (region && regionalDataFor(character.species, region)) return region;
  }
  return null;
}

let regionalMovesMap = null;
function loadRegionalMoves() {
  if (regionalMovesMap) return regionalMovesMap;
  try {
    regionalMovesMap = JSON.parse(fs.readFileSync(REGIONAL_MOVES_PATH, "utf8"));
  } catch (e) {
    regionalMovesMap = {};
  }
  return regionalMovesMap;
}

function regionalMovesFor(species, region) {
  const map = loadRegionalMoves();
  let entry = map[species];
  if (!entry) {
    const lower = species.toLowerCase();
    for (const k of Object.keys(map)) {
      if (k.toLowerCase() === lower) { entry = map[k]; break; }
    }
  }
  if (!entry || !Array.isArray(entry[region])) return [];
  return entry[region];
}

function hasHeldItem(character, name) {
  if (!character || !Array.isArray(character.inventory)) return false;
  const lower = name.toLowerCase();
  return character.inventory.some(slot => {
    const n = typeof slot === "string" ? slot : (slot && slot.name);
    return n && String(n).toLowerCase() === lower;
  });
}

function heldMegaKey(character) {
  if (!character || !hasHeldItem(character, "mega stone")) return null;
  for (const key of ["mega", "megax", "megay"]) {
    try { if (sprites.formPath(character.species, key)) return key; } catch (e) {}
  }
  return null;
}

function heldFormVariation(character) {
  if (!character) return null;
  const species = character.species;
  const shiny = hasHeldItem(character, "shiny diamond");
  let base = heldMegaKey(character);
  if (!base) base = heldRegionFor(character);
  if (base) {
    if (shiny) {
      const shinyKey = base + "shiny";
      try { if (sprites.formPath(species, shinyKey)) return shinyKey; } catch (e) {}
    }
    return base;
  }
  if (shiny) {
    try { if (sprites.formPath(species, "shiny")) return "shiny"; } catch (e) {}
  }
  return null;
}

let megaMap = null;
function loadMega() {
  if (megaMap) return megaMap;
  try {
    megaMap = JSON.parse(fs.readFileSync(MEGA_PATH, "utf8"));
  } catch (e) {
    megaMap = {};
  }
  return megaMap;
}

function megaDataFor(species, spriteKey) {
  const map = loadMega();
  let entry = map[species];
  if (!entry) {
    const lower = species.toLowerCase();
    for (const k of Object.keys(map)) {
      if (k.toLowerCase() === lower) { entry = map[k]; break; }
    }
  }
  if (!entry) return null;
  return entry[spriteKey] || null;
}

function heldMegaData(character) {
  const key = heldMegaKey(character);
  if (!key) return null;
  return megaDataFor(character.species, key);
}

function formTypesFor(character) {
  const megaData = heldMegaData(character);
  if (megaData && Array.isArray(megaData.types)) return megaData.types.slice();
  const region = heldRegionFor(character);
  if (region) {
    const data = regionalDataFor(character.species, region);
    if (data && Array.isArray(data.types)) return data.types.slice();
  }
  return null;
}

function levelBonuses(character) {
  const out = [];
  if (!character) return out;
  if (hasHeldItem(character, "powered cane")) out.push({ label: "Powered Cane", amount: POWERED_CANE_LEVEL_BONUS });
  if (heldMegaKey(character)) out.push({ label: "Mega Stone", amount: MEGA_STONE_LEVEL_BONUS });
  return out;
}

function totalLevelBonus(character) {
  let total = 0;
  for (const b of levelBonuses(character)) total += b.amount;
  return total;
}

function effectiveLevel(character) {
  return (Number(character && character.level) || 1) + totalLevelBonus(character);
}

function levelDisplay(character) {
  const bonuses = levelBonuses(character);
  const base = Number(character.level) || 1;
  if (bonuses.length === 0) return String(base);
  let text = String(base);
  let total = base;
  for (const b of bonuses) {
    text += ` (+${b.amount})`;
    total += b.amount;
  }
  return `${text} : ${total}`;
}

function applyToCombatant(combatant, character) {
  const bonus = totalLevelBonus(character);
  const effChar = bonus > 0 ? Object.assign({}, character, { level: character.level + bonus }) : character;
  const boosts = character.boosts || {};

  if (bonus > 0) {
    combatant.level = effChar.level;
    const normSpecies = String(character.species || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!ENERGY_LINE_NAMES.includes(normSpecies)) {
      combatant.maxMp = maxMpForLevel(effChar.level) + (boosts.mp || 0);
      if (combatant.mp > combatant.maxMp) combatant.mp = combatant.maxMp;
    }
  }

  const megaData = heldMegaData(character);
  if (megaData) {
    combatant.types = megaData.types.slice();
    combatant.variation = heldFormVariation(character) || heldMegaKey(character);
    if (megaData.ability) combatant.ability = megaData.ability;
    const mstats = computeStats(effChar, megaData.base);
    combatant.attack = mstats.attack + (boosts.attack || 0);
    combatant.defense = mstats.defense + (boosts.defense || 0);
    combatant.spAtk = mstats.spAtk + (boosts.spAtk || 0);
    combatant.spDef = mstats.spDef + (boosts.spDef || 0);
    combatant.speed = mstats.speed + (boosts.speed || 0);
    combatant.maxHp = mstats.hp + (boosts.hp || 0);
    if (combatant.hp > combatant.maxHp) combatant.hp = combatant.maxHp;
    return;
  }

  const region = heldRegionFor(character);
  if (!region) {
    if (bonus > 0) {
      const plain = computeStats(effChar);
      combatant.attack = plain.attack + (boosts.attack || 0);
      combatant.defense = plain.defense + (boosts.defense || 0);
      combatant.spAtk = plain.spAtk + (boosts.spAtk || 0);
      combatant.spDef = plain.spDef + (boosts.spDef || 0);
      combatant.speed = plain.speed + (boosts.speed || 0);
      combatant.maxHp = plain.hp + (boosts.hp || 0);
      if (combatant.hp > combatant.maxHp) combatant.hp = combatant.maxHp;
    }
    return;
  }
  const data = regionalDataFor(character.species, region);
  if (!data) return;

  combatant.types = data.types.slice();
  combatant.variation = heldFormVariation(character) || region;

  const stats = computeStats(effChar, data.base);
  combatant.attack = stats.attack + (boosts.attack || 0);
  combatant.defense = stats.defense + (boosts.defense || 0);
  combatant.spAtk = stats.spAtk + (boosts.spAtk || 0);
  combatant.spDef = stats.spDef + (boosts.spDef || 0);
  combatant.speed = stats.speed + (boosts.speed || 0);
  combatant.maxHp = stats.hp + (boosts.hp || 0);
  if (combatant.hp > combatant.maxHp) combatant.hp = combatant.maxHp;

  const sigMoves = regionalMovesFor(character.species, region);
  if (sigMoves.length && Array.isArray(combatant.moves)) {
    for (const mv of sigMoves) {
      if (combatant.moves.some(m => String(m).toLowerCase() === mv.toLowerCase())) continue;
      if (combatant.moves.length < 4) combatant.moves.push(mv);
      else combatant.moves[combatant.moves.length - 1] = mv;
    }
  }
}

function effectiveVariation(character) {
  if (!character) return null;
  return heldFormVariation(character) || character.variation || null;
}

function effectiveSheet(character) {
  const sim = {
    types: Array.isArray(character.types) ? character.types.slice() : [],
    level: character.level,
    hp: character.hp,
    maxHp: character.maxHp,
    mp: character.mp,
    maxMp: character.maxMp,
    attack: character.attack,
    defense: character.defense,
    spAtk: character.spAtk,
    spDef: character.spDef,
    speed: character.speed,
    moves: []
  };
  try { applyToCombatant(sim, character); } catch (e) {}
  return sim;
}

module.exports = { levelBonuses, totalLevelBonus, effectiveLevel, levelDisplay, effectiveSheet, STONE_TO_REGION, heldRegionFor, regionalDataFor, regionalMovesFor, heldFormVariation, formTypesFor, applyToCombatant, effectiveVariation };