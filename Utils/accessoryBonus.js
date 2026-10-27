const fs = require("fs");
const path = require("path");

function loadJson(fileName) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "StorageData", fileName), "utf8"));
  } catch (e) {
    return {};
  }
}

const accessoryEffects = loadJson("AccessoryEffects.json");
const accessoryEffectsLower = {};
for (const key of Object.keys(accessoryEffects)) {
  accessoryEffectsLower[key.toLowerCase()] = accessoryEffects[key];
}

const inventoryPassives = loadJson("InventoryPassives.json");
const inventoryPassivesLower = {};
for (const key of Object.keys(inventoryPassives)) {
  inventoryPassivesLower[key.toLowerCase()] = inventoryPassives[key];
}

const BUILTIN_BAGS = {
  backpack: { slots: 10 },
  rescuebag: { slots: 5 },
  merchantsache: { slots: 30, type: "stat", stats: { speed: -20 } }
};

function accessoryEffectFor(name) {
  if (!name) return null;
  if (accessoryEffects[name]) return accessoryEffects[name];
  const lower = name.toLowerCase();
  if (accessoryEffectsLower[lower]) return accessoryEffectsLower[lower];
  if (BUILTIN_BAGS[lower]) return BUILTIN_BAGS[lower];
  const bagKeys = Object.keys(BUILTIN_BAGS).sort((a, b) => b.length - a.length);
  for (const key of bagKeys) {
    if (lower.includes(key)) return BUILTIN_BAGS[key];
  }
  return null;
}

function addStats(total, stats) {
  if (!stats) return;
  for (const stat of ["hp", "mp", "attack", "defense", "spAtk", "spDef", "speed"]) {
    if (stats[stat]) total[stat] += stats[stat];
  }
}

function accessoryBonusFor(character) {
  const total = { hp: 0, mp: 0, attack: 0, defense: 0, spAtk: 0, spDef: 0, speed: 0 };
  if (character.accessories) {
    const slots = [character.accessories.back, character.accessories.neck, character.accessories.head];
    for (const item of slots) {
      if (!item) continue;
      const name = typeof item === "string" ? item : item.name;
      const eff = accessoryEffectFor(name);
      if (!eff || eff.type !== "stat" || !eff.stats) continue;
      addStats(total, eff.stats);
    }
  }
  if (Array.isArray(character.inventory)) {
    const counted = {};
    for (const entry of character.inventory) {
      const name = typeof entry === "string" ? entry : (entry && entry.name);
      if (!name) continue;
      const lower = name.toLowerCase();
      if (counted[lower]) continue;
      const passive = inventoryPassivesLower[lower];
      if (!passive || !passive.stats) continue;
      counted[lower] = true;
      addStats(total, passive.stats);
    }
  }
  return total;
}

function bagSlotsFor(backName) {
  const eff = accessoryEffectFor(backName);
  return eff && typeof eff.slots === "number" ? eff.slots : 10;
}

module.exports = { accessoryBonusFor, accessoryEffectFor, bagSlotsFor };