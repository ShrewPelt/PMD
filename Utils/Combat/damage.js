const { getEffectiveness } = require("../types");
const { getMoveData } = require("./moveData");
const { effectiveStat } = require("./stages");
const { hasAilment } = require("./ailments");

function calcDamage(attacker, defender, moveName) {
  const move = getMoveData(moveName);
  if (!move || move.category === "status" || !move.power) {
    return { damage: 0, effectiveness: 1, stab: false };
  }

  const atkStat = move.category === "physical" ? "attack" : "spAtk";
  const defStat = move.category === "physical" ? "defense" : "spDef";
  let atk = effectiveStat(attacker, atkStat);
  const def = effectiveStat(defender, defStat);

  if (move.category === "physical" && hasAilment(attacker, "burn")) {
    atk = Math.max(1, Math.floor(atk / 2));
  }
  if (move.category === "special" && attacker.spAtkDebuff && attacker.spAtkDebuff.turns > 0) {
    atk = Math.max(1, Math.floor(atk * attacker.spAtkDebuff.multiplier));
  }

  const boostedPower = move.power + ((attacker.moveBoosts && attacker.moveBoosts[moveName]) || 0);
  const baseline = Math.floor(Math.floor(Math.floor((2 * attacker.level) / 5 + 2) * boostedPower * atk / def) / 50) + 2;
  const stab = attacker.types.includes(move.type) ? 1.5 : 1;
  const eff = getEffectiveness(move.type, defender.types);
  const rand = 0.85 + Math.random() * 0.15;

  let wMult = 1;
  if (attacker.weather) {
    const w = attacker.weather.kind;
    if (w === "rain") { if (move.type === "Water") wMult = 1.5; else if (move.type === "Fire") wMult = 0.5; }
    else if (w === "sun") { if (move.type === "Fire") wMult = 1.5; else if (move.type === "Water") wMult = 0.5; }
  }
  let tMult = 1;
  if (attacker.terrain && !attacker.types.includes("Flying")) {
    const t = attacker.terrain.kind;
    if (t === "electric" && move.type === "Electric") tMult = 1.3;
    else if (t === "grassy" && move.type === "Grass") tMult = 1.3;
    else if (t === "psychic" && move.type === "Psychic") tMult = 1.3;
  }
  if (attacker.darkBoost && attacker.darkBoost.turns > 0 && move.type === "Dark") {
    tMult *= attacker.darkBoost.multiplier;
  }
  if (defender.terrain && defender.terrain.kind === "misty" && move.type === "Dragon" && !defender.types.includes("Flying")) {
    tMult *= 0.5;
  }

  let damage = Math.floor(baseline * stab * eff * rand * wMult * tMult);
  if (defender.screens && !attacker.hasPassScarf) {
    const sc = defender.screens;
    const physCut = move.category === "physical" && ((sc.reflect || 0) > 0 || (sc.auroraVeil || 0) > 0);
    const specCut = move.category === "special" && ((sc.lightScreen || 0) > 0 || (sc.auroraVeil || 0) > 0 || (sc.corruptedScreen || 0) > 0);
    if (physCut || specCut) damage = Math.floor(damage * 0.5);
  }
  if (eff === 0) {
    damage = 0;
  } else if (damage < 1) {
    damage = 1;
  }

  return { damage, effectiveness: eff, stab: stab > 1 };
}

module.exports = { calcDamage };
