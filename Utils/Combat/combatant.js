const { getTypes } = require("../types");
const leveling = require("../leveling");
const { defaultMoves } = require("./moveData");
const { normalizeImmunities } = require("./ailments");
const { emptyStages } = require("./stages");
const { effectiveVariation, applyToCombatant } = require("../regionalForms");

const ENERGY_RESOURCE_CAP = 100;
const ENERGY_RESOURCE_LINE = ["jangmoo", "hakamoo", "kommoo"];

function usesEnergyResource(species) {
  if (!species) return false;
  const norm = String(species).toLowerCase().replace(/[^a-z0-9]/g, "");
  return ENERGY_RESOURCE_LINE.includes(norm);
}

function hasRelic(character, name) {
  const inv = character.inventory;
  if (!Array.isArray(inv)) return false;
  const norm = name.toLowerCase().replace(/\s+/g, "");
  return inv.some(s => s && s.name && s.name.toLowerCase().replace(/\s+/g, "") === norm);
}

function accEquipped(character, normName) {
  const acc = character.accessories;
  if (!acc) return false;
  for (const v of [acc.back, acc.neck, acc.head]) {
    if (!v) continue;
    const n = (typeof v === "string" ? v : v.name || "").toLowerCase().replace(/\s+/g, "");
    if (n === normName) return true;
  }
  return false;
}

function accessoryImmunities(character) {
  const out = [];
  if (accEquipped(character, "no-stickcap")) out.push("paralysis");
  if (accEquipped(character, "detectband")) out.push("sleep");
  if (accEquipped(character, "trapscarf")) out.push("petrify");
  if (accEquipped(character, "weatherband")) { out.push("burn"); out.push("freeze"); }
  if (hasRelic(character, "Odd Disc") && hasRelic(character, "Music Box")) out.push("corruption");
  return out;
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanMoves(character) {
  const listed = Array.isArray(character.moves) ? character.moves.filter(m => typeof m === "string" && m.trim().length > 0) : [];
  if (listed.length) return listed.slice();
  const learned = defaultMoves(character.species, character.level);
  if (learned.length) return learned;
  return ["Tackle"];
}

function makeCombatant(character, name) {
  const usesEnergy = usesEnergyResource(character.species);
  const safeMaxHp = Math.max(1, finiteOr(character.maxHp, 1));
  const safeMaxMp = Math.max(0, finiteOr(character.maxMp, 0));
  const cappedMaxMp = usesEnergy ? Math.min(safeMaxMp, ENERGY_RESOURCE_CAP) : safeMaxMp;
  const combatant = {
    name: name || character.name || character.species,
    sheetName: character.name || character.species,
    species: character.species,
    level: character.level,
    types: Array.isArray(character.types) && character.types.length ? character.types : getTypes(character.species),
    maxHp: safeMaxHp,
    hp: Math.min(finiteOr(character.hp, safeMaxHp), safeMaxHp),
    maxMp: cappedMaxMp,
    mp: usesEnergy ? 0 : Math.max(0, Math.min(finiteOr(character.mp, cappedMaxMp), cappedMaxMp)),
    usesEnergy,
    nextMoveDoubleDamage: false,
    attack: finiteOr(character.attack, 1),
    defense: finiteOr(character.defense, 1),
    spAtk: finiteOr(character.spAtk, 1),
    spDef: finiteOr(character.spDef, 1),
    speed: finiteOr(character.speed, 1),
    moves: cleanMoves(character),
    ailments: Array.isArray(character.ailments) ? character.ailments.filter(a => a && typeof a === "object" && a.name).map(a => Object.assign({}, a)) : [],
    immunities: normalizeImmunities([...(Array.isArray(character.immunities) ? character.immunities : []), ...accessoryImmunities(character)]),
    soaked: 0,
    hydrophobic: finiteOr(character.hydrophobic, 0),
    stages: emptyStages(),
    energy: 0,
    userId: character.userId,
    gender: character.gender || null,
    isNpc: character.isNpc,
    moveBoosts: character.moveBoosts || {},
    customExpressions: character.customExpressions || {},
    hasCradle: hasRelic(character, "Avatar Cradle"),
    hasClarityTransfusion: hasRelic(character, "Clarity Transfusion"),
    thorns: accEquipped(character, "spiralscales") ? 30 : 0,
    drainShield: accEquipped(character, "brazencape"),
    physAbsorb: accEquipped(character, "avatarmask") ? 50 : 0,
    shield: accEquipped(character, "brazencape") ? (character.shield || 0) : 0,
    absorbCharge: 0,
    hasFriendBow: accEquipped(character, "friendbow"),
    hasPassScarf: accEquipped(character, "passscarf"),
    hasPierceBand: accEquipped(character, "pierceband"),
    hasPatsyBand: accEquipped(character, "patsyband"),
    hasWarpScarf: accEquipped(character, "warpscarf"),
    warpScarfUsed: false,
    hasDietRibbon: accEquipped(character, "dietribbon"),
    hasPechaScarf: accEquipped(character, "pechascarf"),
    hasPersimBand: accEquipped(character, "persimband"),
    hasHealBand: accEquipped(character, "healband"),
    variation: effectiveVariation(character)
  };
  applyToCombatant(combatant, character);
  return combatant;
}

function makeWildPokemon(species, level) {
  const stub = {
    species,
    level,
    nature: null,
    ivs: { hp: 15, attack: 15, defense: 15, spAtk: 15, spDef: 15, speed: 15 },
    evs: { hp: 0, attack: 0, defense: 0, spAtk: 0, spDef: 0, speed: 0 },
    boosts: { hp: 0, mp: 0, attack: 0, defense: 0, spAtk: 0, spDef: 0, speed: 0 },
    hp: 1, maxHp: 1, mp: 1, maxMp: 1
  };
  leveling.recalcStats(stub);

  const usesEnergy = usesEnergyResource(species);
  const cappedMaxMp = usesEnergy ? Math.min(stub.maxMp, ENERGY_RESOURCE_CAP) : stub.maxMp;

  return {
    name: species,
    species,
    level,
    types: getTypes(species),
    maxHp: stub.maxHp,
    hp: stub.maxHp,
    maxMp: cappedMaxMp,
    mp: usesEnergy ? 0 : cappedMaxMp,
    usesEnergy,
    nextMoveDoubleDamage: false,
    attack: stub.attack,
    defense: stub.defense,
    spAtk: stub.spAtk,
    spDef: stub.spDef,
    speed: stub.speed,
    moves: defaultMoves(species, level),
    ailments: [],
    stages: emptyStages(),
    energy: 0
  };
}

module.exports = { ENERGY_RESOURCE_CAP, usesEnergyResource, hasRelic, accEquipped, accessoryImmunities, makeCombatant, makeWildPokemon };