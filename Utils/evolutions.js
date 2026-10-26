const fs = require("fs");
const path = require("path");

const EVOLUTIONS_PATH = path.join(__dirname, "..", "StorageData", "Evolutions.json");

let evolutionsMap = null;
function loadEvolutions() {
  if (evolutionsMap) return evolutionsMap;
  try {
    evolutionsMap = JSON.parse(fs.readFileSync(EVOLUTIONS_PATH, "utf8"));
  } catch {
    evolutionsMap = {};
  }
  return evolutionsMap;
}

function evolutionsFor(species) {
  const map = loadEvolutions();
  if (map[species]) return map[species];
  const lower = species.toLowerCase();
  for (const key of Object.keys(map)) {
    if (key.toLowerCase() === lower) return map[key];
  }
  return [];
}

function levelEvolutionFor(species, level) {
  const list = evolutionsFor(species);
  for (const entry of list) {
    if (entry.method === "level" && level >= entry.level) return entry;
  }
  return null;
}

function itemEvolutionFor(species, itemName) {
  const list = evolutionsFor(species);
  const wanted = String(itemName).toLowerCase();
  for (const entry of list) {
    if (entry.method === "item" && entry.item.toLowerCase() === wanted) return entry;
  }
  return null;
}

function hasKeepStone(character) {
  const KEEP = "keep stone";
  if (Array.isArray(character.inventory)) {
    for (const slot of character.inventory) {
      if (slot && String(slot.name).toLowerCase() === KEEP) return true;
    }
  }
  if (character.accessories) {
    for (const key of ["back", "neck", "head"]) {
      const a = character.accessories[key];
      if (!a) continue;
      const name = typeof a === "string" ? a : a.name;
      if (name && String(name).toLowerCase() === KEEP) return true;
    }
  }
  return false;
}

function evolve(character, intoSpecies) {
  const from = character.species;
  character.species = intoSpecies;
  return { from, into: intoSpecies };
}

module.exports = { loadEvolutions, evolutionsFor, levelEvolutionFor, itemEvolutionFor, hasKeepStone, evolve };