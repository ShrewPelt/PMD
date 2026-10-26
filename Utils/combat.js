const { getMoveData, getLearnset, defaultMoves } = require("./Combat/moveData");
const { hasAilment, isImmuneTo, normalizeImmunities, canonStatus, statusWordFull, applyCorruptionStack, shatterPetrify, shatterOnHit, canHeal, applyAilmentStack, clearCurableAilments, clearAilmentsKeepToxin, isUpgradedAilment, isGrounded, terrainProtects, tickAilments, genderKind, normalizeGender, genderAffects, applySoaked, applyHydrophobic } = require("./Combat/ailments");
const { applyStage, tickStages } = require("./Combat/stages");
const { makeCombatant, makeWildPokemon, accEquipped, hasRelic, usesEnergyResource, ENERGY_RESOURCE_CAP } = require("./Combat/combatant");
const { calcDamage } = require("./Combat/damage");
const { applyMove, applySupportToAlly } = require("./Combat/applyMove");
const { canAct, pickAiMove, nextActor, nextActorMulti, ENERGY_THRESHOLD } = require("./Combat/turnOrder");
const { tickScreens, tickField, tickCradle } = require("./Combat/fieldEffects");

module.exports = { applySoaked, applyHydrophobic, getMoveData, getLearnset, defaultMoves, makeCombatant, makeWildPokemon, calcDamage, nextActor, nextActorMulti, applyMove, applySupportToAlly, pickAiMove, canAct, tickAilments, hasAilment, isImmuneTo, normalizeImmunities, canonStatus, statusWordFull, applyCorruptionStack, shatterPetrify, shatterOnHit, canHeal, applyAilmentStack, clearCurableAilments, clearAilmentsKeepToxin, isUpgradedAilment, isGrounded, terrainProtects, genderKind, normalizeGender, genderAffects, ENERGY_THRESHOLD, tickScreens, tickField, tickStages, tickCradle, accEquipped, hasRelic, usesEnergyResource, ENERGY_RESOURCE_CAP, applyStage };