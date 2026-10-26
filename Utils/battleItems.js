const fs = require("fs");
const path = require("path");

const EFFECTS_PATH = path.join(__dirname, "..", "StorageData", "ItemEffects.json");
const nlChar = "\n";

let effects = null;
function loadEffects() {
  if (effects) return effects;
  try {
    effects = JSON.parse(fs.readFileSync(EFFECTS_PATH, "utf8"));
  } catch {
    effects = {};
  }
  return effects;
}

function allEffects() {
  return loadEffects();
}

function effectFor(itemName) {
  const map = loadEffects();
  if (map[itemName]) return map[itemName];
  const lower = itemName.toLowerCase();
  for (const k of Object.keys(map)) {
    if (k.toLowerCase() === lower) return map[k];
  }
  return null;
}

function usableItems(inventory) {
  const out = [];
  if (!Array.isArray(inventory)) return out;
  for (const slot of inventory) {
    const eff = slot && effectFor(slot.name);
    if (!eff) continue;
    const usable = Array.isArray(eff.effects)
      ? eff.effects.some(e => e && e.type !== "revive")
      : (eff.type !== "revive" && eff.type !== "misc");
    if (usable) out.push({ name: slot.name, count: slot.count });
  }
  return out;
}

function statusWord(s) {
  const map = { paralysis: "paralysis", burn: "its burn", poison: "poison", sleep: "sleep", freeze: "its freeze" };
  return map[s] || s;
}

function applyItemEffect(combatant, itemName) {
  const eff = effectFor(itemName);
  if (!eff) return { success: false, log: `${itemName} can't be used in battle.` };
  if (Array.isArray(eff.effects)) {
    const logs = [];
    let anySuccess = false;
    for (const single of eff.effects) {
      const r = applySingleEffect(combatant, itemName, single);
      if (r && r.log) logs.push(r.log);
      if (r && r.success) anySuccess = true;
    }
    return { success: anySuccess, log: logs.length ? logs.join(" ") : `${itemName} had no effect.` };
  }
  return applySingleEffect(combatant, itemName, eff);
}

function applySingleEffect(combatant, itemName, eff) {
  const combat = require("./combat");

  if (eff.type === "restore") {
  const toxic = !combat.canHeal(combatant);
  const hpFull = toxic ? true : combatant.hp >= combatant.maxHp;
  const mpFull = combatant.usesEnergy ? true : combatant.mp >= combatant.maxMp;
  if (hpFull && mpFull) {
    if (toxic) return { success: false, log: `${itemName} is useless | ${combatant.name}'s toxin blocks all healing!` };
    return { success: false, log: `${combatant.name} is already at full HP${combatant.usesEnergy ? "" : " and MP"}.` };
  }
  const hpBefore = combatant.hp, mpBefore = combatant.mp;
  if (eff.hp && !toxic) combatant.hp = Math.min(combatant.maxHp, combatant.hp + eff.hp);
  if (eff.mp && !combatant.usesEnergy) combatant.mp = Math.min(combatant.maxMp, combatant.mp + eff.mp);
  const parts = [];
  if (combatant.hp - hpBefore > 0) parts.push(`${combatant.hp - hpBefore} HP`);
  if (combatant.mp - mpBefore > 0) parts.push(`${combatant.mp - mpBefore} MP`);
  if (parts.length === 0) return { success: false, log: `${itemName} had no effect | ${combatant.name}'s Energy can't be restored by items.` };
  return { success: true, log: `${combatant.name} used ${itemName} and recovered ${parts.join(" and ")}!` };
  }

  if (eff.type === "heal" || eff.type === "healPercent") {
    if (!combat.canHeal(combatant)) return { success: false, log: `${itemName} is useless | ${combatant.name}'s toxin blocks all healing!` };
    if (combatant.hp >= combatant.maxHp) return { success: false, log: `${combatant.name} is already at full HP.` };
    const amount = eff.type === "heal" ? eff.amount : Math.max(1, Math.floor(combatant.maxHp * eff.percent / 100));
    const before = combatant.hp;
    combatant.hp = Math.min(combatant.maxHp, combatant.hp + amount);
    return { success: true, log: `${combatant.name} used ${itemName} and recovered ${combatant.hp - before} HP!` };
  }

  if (eff.type === "mp") {
    if (combatant.usesEnergy) return { success: false, log: `${combatant.name}'s Energy can't be restored by items.` };
    if (combatant.mp >= combatant.maxMp) return { success: false, log: `${combatant.name}'s MP is already full.` };
    const before = combatant.mp;
    combatant.mp = Math.min(combatant.maxMp, combatant.mp + eff.amount);
    return { success: true, log: `${combatant.name} used ${itemName} and recovered ${combatant.mp - before} MP!` };
  }

  if (eff.type === "immunize") {
    const protectTurns = eff.turns || 10;
    if ((combatant.hydrophobic || 0) >= protectTurns) {
      return { success: false, log: `${combatant.name} is already protected by ${itemName}.` };
    }
    const protectRes = combat.applyHydrophobic(combatant, protectTurns);
    return { success: true, log: `${combatant.name} used ${itemName}! ${protectRes.log}` };
  }

  if (eff.type === "cure") {
    if (Array.isArray(combatant.ailments)) {
      const stuck = combatant.ailments.find(a => combat.isUpgradedAilment(a.name) && combat.canonStatus(eff.status) === require("./Combat/ailments").baseOfUpgraded(a.name));
      if (stuck) return { success: false, log: `${combatant.name}'s ${stuck.name} can't be cured by ${itemName}!` };
    }
    if (!Array.isArray(combatant.ailments) || !combatant.ailments.some(a => a.name === eff.status)) {
      return { success: false, log: `${combatant.name} isn't affected by ${statusWord(eff.status)}.` };
    }
    combatant.ailments = combatant.ailments.filter(a => a.name !== eff.status);
    return { success: true, log: `${combatant.name} used ${itemName} and was cured of ${statusWord(eff.status)}!` };
  }

  if (eff.type === "cureAll") {
    if (!Array.isArray(combatant.ailments) || combatant.ailments.length === 0) {
      return { success: false, log: `${combatant.name} has no status to cure.` };
    }
    const removed = combat.clearCurableAilments(combatant);
    if (removed.length === 0) return { success: false, log: `${combatant.name}'s affliction is too severe for ${itemName} to cure!` };
    return { success: true, log: `${combatant.name} used ${itemName} and cleared its status!` };
  }

  if (eff.type === "regen") {
    const regenHp = combat.canHeal(combatant) ? (eff.hp || 0) : 0;
    combatant.regen = { hp: regenHp, mp: eff.mp || 0, turns: eff.turns || 1, source: itemName };
    return { success: true, log: `${combatant.name} drank ${itemName}! It will restore ${eff.hp || 0} HP and ${eff.mp || 0} MP each turn for ${eff.turns || 1} turns.` };
  }

  if (eff.type === "rum") {
    const rumLines = [`${combatant.name} downed the ${itemName}!`];
    if (combat.canHeal(combatant)) {
      const rumHeal = Math.max(1, Math.floor(combatant.maxHp * 0.2));
      const rumBefore = combatant.hp;
      combatant.hp = Math.min(combatant.maxHp, combatant.hp + rumHeal);
      if (combatant.hp - rumBefore > 0) rumLines.push(`It recovered ${combatant.hp - rumBefore} HP.`);
    } else {
      rumLines.push("The toxin blocked all healing.");
    }
    const rumPoison = combat.applyAilmentStack(combatant, "poison", 5);
    if (rumPoison.log) rumLines.push(rumPoison.log);
    if (combat.isImmuneTo(combatant, "confusion")) {
      rumLines.push(`${combatant.name} is immune to confusion!`);
    } else {
      combatant.confusion = 5;
      rumLines.push(`${combatant.name} became confused!`);
    }
    return { success: true, log: rumLines.join(" ") };
  }

  if (eff.type === "fortuneDie") {
    return { success: false, log: `${itemName} can only be rolled in battle.` };
  }

  if (eff.type === "revive") {
    return { success: false, log: `${itemName} only works when ${combatant.name} faints.` };
  }

  if (eff.type === "damage") {
    const dmg = eff.percent ? Math.max(1, Math.floor(combatant.maxHp * eff.percent / 100)) : (eff.amount || 0);
    if (dmg <= 0) return { success: false, log: `${itemName} fizzled.` };
    const before = combatant.hp;
    combatant.hp = Math.max(0, combatant.hp - dmg);
    const dealt = before - combatant.hp;
    const shatterRes = combat.shatterOnHit(combatant, dealt, "item", 1);
    if (shatterRes.logs.length) return { success: true, log: `${itemName} burst on ${combatant.name} for ${dealt} damage! ${shatterRes.logs.join(" ")}` };
    return { success: true, log: `${itemName} burst on ${combatant.name} for ${dealt} damage!` };
  }

  if (eff.type === "petrify") {
    if (!Array.isArray(combatant.ailments)) combatant.ailments = [];
    if (combat.isImmuneTo(combatant, "petrify")) return { success: false, log: `${combatant.name} is immune to petrification!` };
    const petRes = combat.applyAilmentStack(combatant, "petrify", eff.turns || 5, { ignoreOther: true });
    if (!petRes.applied) return { success: false, log: `${combatant.name} is already solidified.` };
    if (petRes.reason === "applied") return { success: true, log: `${itemName} turned ${combatant.name} to solid stone! It is petrified until a direct hit shatters it.` };
    return { success: true, log: petRes.log };
  }

  if (eff.type === "inflict") {
    if (!Array.isArray(combatant.ailments)) combatant.ailments = [];
    const pool = (Array.isArray(eff.statuses) && eff.statuses.length) ? eff.statuses : [eff.status];
    if (pool.length > 0 && pool.every(st => combat.isImmuneTo(combatant, st))) {
      return { success: false, log: `${combatant.name} is immune to ${itemName}'s effect!` };
    }
    const available = pool.filter(st => {
      if (combat.isImmuneTo(combatant, st)) return false;
      if (st === "corruption") return true;
      if (st === "confusion") return !(combatant.confusion > 0);
      const upgradedForm = require("./Combat/ailments").AILMENT_UPGRADES[combat.canonStatus(st)];
      if (upgradedForm && combatant.ailments.some(a => a.name === upgradedForm)) return false;
      return true;
    });
    if (available.length === 0) return { success: false, log: `${combatant.name} can't be afflicted any further by ${itemName}.` };
    const status = available[Math.floor(Math.random() * available.length)];
    if (status === "confusion") {
      combatant.confusion = eff.turns || (2 + Math.floor(Math.random() * 3));
      return { success: true, log: `${combatant.name} became confused!` };
    }
    if (status === "corruption") {
      return { success: true, log: combat.applyCorruptionStack(combatant) };
    }
    const inflictRes = combat.applyAilmentStack(combatant, status, eff.turns || 5, { ignoreOther: true });
    if (!inflictRes.applied) return { success: false, log: `${combatant.name} can't be afflicted any further by ${itemName}.` };
    if (inflictRes.reason === "applied") return { success: true, log: `${combatant.name} was afflicted with ${statusWord(status)}!` };
    return { success: true, log: inflictRes.log };
  }

  if (eff.type === "mpToHp") {
    if (!combat.canHeal(combatant)) return { success: false, log: `${itemName} is useless | ${combatant.name}'s toxin blocks all healing!` };
    if (combatant.mp <= 0) return { success: false, log: `${combatant.name} has no MP to convert.` };
    const convert = combatant.mp;
    combatant.mp = 0;
    const before = combatant.hp;
    combatant.hp = Math.min(combatant.maxHp, combatant.hp + convert);
    const healed = combatant.hp - before;
    const overflow = convert - healed;
    let log = `${combatant.name} used ${itemName}! ${convert} MP surged into ${healed} HP`;
    if (overflow > 0) {
      const beforeShield = combatant.shield || 0;
      combatant.shield = Math.min(500, beforeShield + overflow);
      const stored = combatant.shield - beforeShield;
      if (stored > 0) log += ` and ${stored} shield`;
    }
    log += "!";
    return { success: true, log };
  }

  if (eff.type === "stage") {
    if (!combatant.stages) combatant.stages = { attack: 0, defense: 0, spAtk: 0, spDef: 0, speed: 0 };
    const changes = eff.stages || {};
    const moved = [];
    for (const stat of Object.keys(changes)) {
      const before = combatant.stages[stat] || 0;
      combatant.stages[stat] = Math.max(-6, Math.min(6, before + changes[stat]));
      if (combatant.stages[stat] !== before) moved.push(stat);
    }
    if (moved.length === 0) return { success: false, log: `${combatant.name}'s stats can't change further.` };
    return { success: true, log: `${itemName} shifted ${combatant.name}'s ${moved.join(" and ")}!` };
  }

  return { success: false, log: `${itemName} has no effect here.` };
}

function reviveInfoFor(itemName) {
  const eff = effectFor(itemName);
  if (!eff || eff.type !== "revive") return null;
  return eff;
}

function reviveAmount(eff, maxHp) {
  if (eff.amount) return Math.max(1, Math.min(maxHp, eff.amount));
  const pct = eff.percent || 50;
  return Math.max(1, Math.min(maxHp, Math.floor(maxHp * pct / 100)));
}

function getCooldown(character, itemName) {
  if (!character || !character.itemCooldowns) return 0;
  return character.itemCooldowns[itemName] || 0;
}

function setCooldown(character, itemName, turns) {
  if (!character.itemCooldowns) character.itemCooldowns = {};
  character.itemCooldowns[itemName] = turns;
}

function tickCooldowns(character) {
  if (!character || !character.itemCooldowns) return false;
  let changed = false;
  for (const k of Object.keys(character.itemCooldowns)) {
    if (character.itemCooldowns[k] > 0) { character.itemCooldowns[k] -= 1; changed = true; }
  }
  return changed;
}

function loadEffectsFresh() {
  try {
    effects = JSON.parse(fs.readFileSync(EFFECTS_PATH, "utf8"));
  } catch {
    effects = {};
  }
  return effects;
}

function serializeEffect(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(serializeEffect).join(", ") + "]";
  return "{" + Object.keys(v).map(k => JSON.stringify(k) + ": " + serializeEffect(v[k])).join(", ") + "}";
}

function saveEffects(map) {
  const lines = Object.keys(map).map(k => "  " + JSON.stringify(k) + ": " + serializeEffect(map[k]));
  fs.writeFileSync(EFFECTS_PATH, "{" + nlChar + lines.join("," + nlChar) + nlChar + "}" + nlChar);
  effects = map;
}

module.exports = { allEffects, effectFor, EFFECTS_PATH, loadEffectsFresh, saveEffects, usableItems, applyItemEffect, reviveInfoFor, reviveAmount, getCooldown, setCooldown, tickCooldowns };