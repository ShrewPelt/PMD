const fs = require("fs");
const path = require("path");

const SPECIES_TYPES_PATH = path.join(__dirname, "..", "StorageData", "SpeciesTypes.json");

const TYPE_CHART = {
  Normal:   { Rock: 0.5, Ghost: 0, Steel: 0.5 },
  Fire:     { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 2, Bug: 2, Rock: 0.5, Dragon: 0.5, Steel: 2 },
  Water:    { Fire: 2, Water: 0.5, Grass: 0.5, Ground: 2, Rock: 2, Dragon: 0.5 },
  Electric: { Water: 2, Electric: 0.5, Grass: 0.5, Ground: 0, Flying: 2, Dragon: 0.5 },
  Grass:    { Fire: 0.5, Water: 2, Grass: 0.5, Poison: 0.5, Ground: 2, Flying: 0.5, Bug: 0.5, Rock: 2, Dragon: 0.5, Steel: 0.5 },
  Ice:      { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 0.5, Ground: 2, Flying: 2, Dragon: 2, Steel: 0.5 },
  Fighting: { Normal: 2, Ice: 2, Poison: 0.5, Flying: 0.5, Psychic: 0.5, Bug: 0.5, Rock: 2, Ghost: 0, Dark: 2, Steel: 2, Fairy: 0.5 },
  Poison:   { Grass: 2, Poison: 0.5, Ground: 0.5, Rock: 0.5, Ghost: 0.5, Steel: 0, Fairy: 2 },
  Ground:   { Fire: 2, Electric: 2, Grass: 0.5, Poison: 2, Flying: 0, Bug: 0.5, Rock: 2, Steel: 2 },
  Flying:   { Electric: 0.5, Grass: 2, Fighting: 2, Bug: 2, Rock: 0.5, Steel: 0.5 },
  Psychic:  { Fighting: 2, Poison: 2, Psychic: 0.5, Dark: 0, Steel: 0.5 },
  Bug:      { Fire: 0.5, Grass: 2, Fighting: 0.5, Poison: 0.5, Flying: 0.5, Psychic: 2, Ghost: 0.5, Dark: 2, Steel: 0.5, Fairy: 0.5 },
  Rock:     { Fire: 2, Ice: 2, Fighting: 0.5, Ground: 0.5, Flying: 2, Bug: 2, Steel: 0.5 },
  Ghost:    { Normal: 0, Psychic: 2, Ghost: 2, Dark: 0.5 },
  Dragon:   { Dragon: 2, Steel: 0.5, Fairy: 0 },
  Dark:     { Fighting: 0.5, Psychic: 2, Ghost: 2, Dark: 0.5, Fairy: 0.5 },
  Steel:    { Fire: 0.5, Water: 0.5, Electric: 0.5, Ice: 2, Rock: 2, Steel: 0.5, Fairy: 2 },
  Fairy:    { Fire: 0.5, Fighting: 2, Poison: 0.5, Dragon: 2, Dark: 2, Steel: 0.5 }
};

function loadSpeciesTypes() {
  try {
    return JSON.parse(fs.readFileSync(SPECIES_TYPES_PATH, "utf8"));
  } catch {
    return {};
  }
}

function getTypes(species) {
  const map = loadSpeciesTypes();
  if (map[species]) return map[species];
  const lower = species.toLowerCase();
  for (const key of Object.keys(map)) {
    if (key.toLowerCase() === lower) return map[key];
  }
  return ["Normal"];
}

function multiplierAgainst(attackType, defenderTypes) {
  if (!Array.isArray(defenderTypes)) defenderTypes = [];
  let multiplier = 1;
  const row = TYPE_CHART[attackType] || {};
  for (const defenderType of defenderTypes) {
    if (row[defenderType] !== undefined) {
      multiplier *= row[defenderType];
    }
  }
  return multiplier;
}

function getDefensiveMatchups(defenderTypes) {
  const weaknesses = [];
  const resistances = [];
  const immunities = [];
  for (const attackType of Object.keys(TYPE_CHART)) {
    const multiplier = multiplierAgainst(attackType, defenderTypes);
    if (multiplier === 0) {
      immunities.push(attackType);
    } else if (multiplier > 1) {
      weaknesses.push({ type: attackType, multiplier });
    } else if (multiplier < 1) {
      resistances.push({ type: attackType, multiplier });
    }
  }
  return { weaknesses, resistances, immunities };
}

function getEffectiveness(moveType, defenderTypes) {
  return multiplierAgainst(moveType, defenderTypes);
}

function hasStab(attackerTypes, moveType) {
  return attackerTypes.includes(moveType);
}

module.exports = { TYPE_CHART, getTypes, getDefensiveMatchups, getEffectiveness, hasStab };