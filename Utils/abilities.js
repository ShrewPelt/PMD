const fs = require("fs");
const path = require("path");

const ABILITIES_PATH = path.join(__dirname, "..", "StorageData", "SpeciesAbilities.json");

let abilityMap = null;
function loadAbilities() {
  if (abilityMap) return abilityMap;
  try { abilityMap = JSON.parse(fs.readFileSync(ABILITIES_PATH, "utf8")); } catch (e) { abilityMap = {}; }
  return abilityMap;
}

function speciesAbility(species) {
  if (!species) return null;
  const map = loadAbilities();
  if (map[species]) return map[species];
  const lower = species.toLowerCase();
  for (const k of Object.keys(map)) {
    if (k.toLowerCase() === lower) return map[k];
  }
  return null;
}

function onBattleStart(combatant, opponents) {
  if (!combatant || !combatant.ability) return null;
  const a = combatant.ability;

  if (a === "Intimidate") {
    const foes = (opponents || []).filter(o => o && o.hp > 0);
    let hit = 0;
    for (const o of foes) {
      if (!o.stages) o.stages = {};
      const before = o.stages.attack || 0;
      o.stages.attack = Math.max(-6, before - 1);
      if (o.stages.attack !== before) hit++;
    }
    if (hit === 1) return `${combatant.name}'s **Intimidate** cut ${foes[0].name}'s Attack!`;
    if (hit > 1) return `${combatant.name}'s **Intimidate** cut the foes' Attack!`;
  }
  return null;
}

function abilityImmune(defender, moveType) {
  if (!defender || !defender.ability) return false;
  const a = defender.ability;
  if (a === "Levitate" && moveType === "Ground") return true;
  return false;
}

function attackStatMultiplier(attacker, move) {
  if (!attacker || !attacker.ability) return 1;
  const a = attacker.ability;
  let mult = 1;
  if ((a === "Huge Power" || a === "Pure Power") && move.category === "physical") mult *= 2;
  if (a === "Guts" && move.category === "physical" && Array.isArray(attacker.ailments) && attacker.ailments.length > 0) mult *= 1.5;
  return mult;
}

function ignoresBurnDrop(attacker) {
  return !!attacker && attacker.ability === "Guts";
}

function damageMultiplier(attacker, defender, move) {
  let mult = 1;
  const atkAbil = attacker && attacker.ability;
  const defAbil = defender && defender.ability;

  if (attacker && attacker.hp <= Math.floor(attacker.maxHp / 3)) {
    if (atkAbil === "Blaze" && move.type === "Fire") mult *= 1.5;
    else if (atkAbil === "Torrent" && move.type === "Water") mult *= 1.5;
    else if (atkAbil === "Overgrow" && move.type === "Grass") mult *= 1.5;
    else if (atkAbil === "Swarm" && move.type === "Bug") mult *= 1.5;
  }

  if (defAbil === "Thick Fat" && (move.type === "Fire" || move.type === "Ice")) mult *= 0.5;

  return mult;
}

module.exports = { speciesAbility, onBattleStart, abilityImmune, attackStatMultiplier, ignoresBurnDrop, damageMultiplier };