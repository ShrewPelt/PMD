const { emptyStages, applyStage } = require("./stages");
const { speciesAbility } = require("../abilities");

const NATURAL_AILMENT_TURNS = 5;
const CORRUPTION_STACK_THRESHOLD = 4;
const CORRUPTION_STACK_DRAIN_PERCENT = 10;
const CORRUPTION_STACK_EXTRA_PERCENT = 2;
const AILMENT_STACK_LIMIT = 5;
const UPGRADED_AILMENT_TURNS = 5;
const TOXIN_PERCENT = 12.5;
const PERMAFROST_PERCENT = 5;
const MELT_PERCENT = 5;
const DEEP_SLEEP_HEAL_PERCENT = 50;
const PERMAFROST_SHATTER_DAMAGE = 100;
const GOLDIFIED_SHATTER_COINS = 100;
const SOAKED_TURNS = 5;
const HYDROPHOBIC_TURNS = 10;

const AILMENT_UPGRADES = {
  poison: "toxin",
  freeze: "permafrost",
  sleep: "deepsleep",
  paralysis: "stun",
  burn: "melt",
  petrify: "solidified"
};

const UPGRADED_LABEL = {
  toxin: "Toxin",
  permafrost: "Permafrost",
  deepsleep: "Deep Sleep",
  stun: "Stun",
  melt: "Melt",
  solidified: "Solidified"
};

const UPGRADED_NAMES = Object.keys(UPGRADED_LABEL);

const STATUS_ALIAS = {
  burn: "burn", burned: "burn", burnt: "burn",
  poison: "poison", poisoned: "poison", toxic: "poison", tox: "poison",
  paralysis: "paralysis", paralyze: "paralysis", paralyse: "paralysis", paralyzed: "paralysis", paralysed: "paralysis", para: "paralysis",
  sleep: "sleep", asleep: "sleep", slept: "sleep",
  freeze: "freeze", frozen: "freeze", freeze: "freeze",
  confusion: "confusion", confuse: "confusion", confused: "confusion",
  petrify: "petrify", petrified: "petrify", stone: "petrify", petrification: "petrify",
  corruption: "corruption", corrupt: "corruption", corrupted: "corruption",
  goldified: "goldified", goldify: "goldified", gold: "goldified", golden: "goldified", gldn: "goldified",
  soaked: "soaked", soak: "soaked", soaking: "soaked", skd: "soaked",
  all: "all", any: "all", everything: "all", every: "all"
};

function isUpgradedAilment(name) {
  return UPGRADED_NAMES.includes(name);
}

function baseOfUpgraded(name) {
  for (const base of Object.keys(AILMENT_UPGRADES)) {
    if (AILMENT_UPGRADES[base] === name) return base;
  }
  return null;
}

function canHeal(combatant) {
  return !(combatant && Array.isArray(combatant.ailments) && combatant.ailments.some(a => a.name === "toxin"));
}

function clearCurableAilments(combatant) {
  if (!Array.isArray(combatant.ailments)) return [];
  const removed = [];
  const kept = [];
  for (const a of combatant.ailments) {
    if (isUpgradedAilment(a.name)) kept.push(a);
    else removed.push(a);
  }
  combatant.ailments = kept;
  return removed;
}

function clearAilmentsKeepToxin(combatant) {
  if (!Array.isArray(combatant.ailments)) {
    combatant.ailments = [];
    return;
  }
  combatant.ailments = combatant.ailments.filter(a => a.name === "toxin");
}

function upgradeAilment(who, entry) {
  const upgradedName = AILMENT_UPGRADES[entry.name];
  const index = who.ailments.indexOf(entry);
  let replacement;
  let log;
  if (upgradedName === "toxin") {
    replacement = { name: "toxin" };
    log = `${who.name}'s poison became TOXIN! It can't be cured and healing is useless!`;
  } else if (upgradedName === "permafrost") {
    replacement = { name: "permafrost" };
    log = `${who.name} was sealed in PERMAFROST! Only a blow of ${PERMAFROST_SHATTER_DAMAGE}+ damage can shatter it!`;
  } else if (upgradedName === "deepsleep") {
    replacement = { name: "deepsleep", turns: UPGRADED_AILMENT_TURNS };
    const heal = Math.max(1, Math.floor(who.maxHp * DEEP_SLEEP_HEAL_PERCENT / 100));
    const before = who.hp;
    if (canHeal(who)) who.hp = Math.min(who.maxHp, who.hp + heal);
    const gained = who.hp - before;
    log = `${who.name} fell into a DEEP SLEEP${gained > 0 ? ` and recovered ${gained} HP` : ""}! It can't be woken for ${UPGRADED_AILMENT_TURNS} turns!`;
  } else if (upgradedName === "stun") {
    replacement = { name: "stun", turns: UPGRADED_AILMENT_TURNS };
    log = `${who.name} is STUNNED! It can't move for ${UPGRADED_AILMENT_TURNS} turns!`;
  } else if (upgradedName === "melt") {
    replacement = { name: "melt", turns: UPGRADED_AILMENT_TURNS };
    applyStage(who, "defense", -4, UPGRADED_AILMENT_TURNS);
    applyStage(who, "spDef", -4, UPGRADED_AILMENT_TURNS);
    log = `${who.name} is MELTING! Its Defense and Sp. Def collapsed!`;
  } else {
    replacement = { name: "solidified" };
    log = `${who.name} was SOLIDIFIED! Only a super effective special attack can shatter it!`;
  }
  who.ailments[index] = replacement;
  return log;
}

function applyAilmentStack(who, status, turns, opts) {
  const ignoreOther = !!(opts && opts.ignoreOther);
  const name = canonStatus(status);
  if (!Array.isArray(who.ailments)) who.ailments = [];
  if (terrainProtects(who, name)) {
    const terrainLabel = who.terrain.kind === "electric" ? "Electric" : "Misty";
    return { applied: false, reason: "terrain", log: `${who.name} is protected by the ${terrainLabel} Terrain and can't be afflicted with ${statusWordFull(name)}!` };
  }
  if (isImmuneTo(who, name)) {
    return { applied: false, reason: "immune", log: `${who.name} is immune to ${statusWordFull(name)}!` };
  }
  const upgradedName = AILMENT_UPGRADES[name];
  if (!upgradedName) {
    if (who.ailments.length === 0 || ignoreOther) {
      who.ailments.push({ name, turns: turns || NATURAL_AILMENT_TURNS });
      return { applied: true, reason: "applied", log: `${who.name} ${ailmentApplyMsg(name)}` };
    }
    return { applied: false, reason: "other", log: null };
  }
  if (who.ailments.some(a => a.name === upgradedName)) {
    return { applied: false, reason: "maxed", log: null };
  }
  const existing = who.ailments.find(a => a.name === name);
  if (existing) {
    existing.stacks = (existing.stacks || 1) + 1;
    existing.turns = turns || NATURAL_AILMENT_TURNS;
    if (existing.stacks >= AILMENT_STACK_LIMIT) {
      return { applied: true, reason: "upgraded", log: upgradeAilment(who, existing) };
    }
    return { applied: true, reason: "stacked", log: `${who.name}'s ${statusWordFull(name)} intensified! (${existing.stacks} stacks)` };
  }
  if (who.ailments.length > 0 && !ignoreOther) {
    return { applied: false, reason: "other", log: null };
  }
  who.ailments.push({ name, turns: turns || NATURAL_AILMENT_TURNS, stacks: 1 });
  return { applied: true, reason: "applied", log: `${who.name} ${ailmentApplyMsg(name)}` };
}

function ailmentApplyMsg(name) {
  if (name === "burn") return "was burned!";
  if (name === "paralysis") return "was paralyzed!";
  if (name === "sleep") return "fell asleep!";
  if (name === "freeze") return "was frozen solid!";
  if (name === "poison") return "was poisoned!";
  if (name === "corruption") return "was corrupted!";
  if (name === "goldified") return "was turned to solid gold!";
  return "was afflicted!";
}

function applySoaked(target, turns) {
  const duration = turns || SOAKED_TURNS;
  if (isImmuneTo(target, "soaked")) {
    return { applied: false, reason: "immune", log: `${target.name} is hydrophobic and can't be soaked!` };
  }
  if (target.soaked > 0) {
    target.soaked = duration;
    return { applied: true, reason: "refreshed", log: `${target.name} got even more soaked! (${duration} turns)` };
  }
  target.soaked = duration;
  return { applied: true, reason: "applied", log: `${target.name} was soaked to the bone! Electric attacks will now always paralyze it!` };
}

function applyHydrophobic(who, turns) {
  const duration = turns || HYDROPHOBIC_TURNS;
  who.hydrophobic = duration;
  let log = `${who.name} became hydrophobic! Water can't soak it for ${duration} turns!`;
  if (who.soaked > 0) {
    who.soaked = 0;
    log += ` The water beaded off and ${who.name} is dry again.`;
  }
  return { applied: true, log };
}

function hasAilment(combatant, name) {
  return Array.isArray(combatant.ailments) && combatant.ailments.some(a => a.name === name);
}

function shatterOnHit(target, damage, category, effectiveness) {
  const logs = [];
  if (!target || !Array.isArray(target.ailments) || !(damage > 0)) return { logs, extraDamage: 0 };
  let extraDamage = 0;
  if (target.ailments.some(a => a.name === "petrify")) {
    target.ailments = target.ailments.filter(a => a.name !== "petrify");
    logs.push(`The blow shattered the stone | ${target.name} broke free from petrification!`);
  }
  if (target.ailments.some(a => a.name === "permafrost") && damage >= PERMAFROST_SHATTER_DAMAGE) {
    target.ailments = target.ailments.filter(a => a.name !== "permafrost");
    logs.push(`The ${damage} damage blow shattered the permafrost | ${target.name} broke free!`);
  }
  if (target.ailments.some(a => a.name === "solidified") && category === "special" && effectiveness > 1) {
    target.ailments = target.ailments.filter(a => a.name !== "solidified");
    extraDamage = damage;
    target.hp = Math.max(0, target.hp - extraDamage);
    logs.push(`The super effective special blow shattered ${target.name}'s solidified shell for ${extraDamage} extra damage!`);
  }
  if (target.ailments.some(a => a.name === "goldified")) {
    target.ailments = target.ailments.filter(a => a.name !== "goldified");
    if (!Array.isArray(target.fortunePending)) target.fortunePending = [];
    target.fortunePending.push({ kind: "gold", amount: GOLDIFIED_SHATTER_COINS });
    logs.push(`The blow shattered the gold | ${target.name} burst out of its golden shell!`);
  }
  return { logs, extraDamage };
}

function shatterPetrify(target) {
  if (!Array.isArray(target.ailments) || !target.ailments.some(a => a.name === "petrify")) return null;
  target.ailments = target.ailments.filter(a => a.name !== "petrify");
  return `The blow shattered the stone | ${target.name} broke free from petrification!`;
}

function applyCorruptionStack(who) {
  if (!Array.isArray(who.ailments)) who.ailments = [];
  const existing = who.ailments.find(a => a.name === "corruption");
  if (existing) {
    existing.stacks = (existing.stacks || 1) + 1;
    return `${who.name}'s corruption intensifies! (${existing.stacks} stacks)`;
  }
  who.ailments.push({ name: "corruption", stacks: 1 });
  return `${who.name} was corrupted!`;
}

function canonStatus(name) {
  if (!name) return "";
  const key = String(name).trim().toLowerCase().replace(/[^a-z]/g, "");
  return STATUS_ALIAS[key] || key;
}

function normalizeImmunities(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const c = canonStatus(raw);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

function genderKind(gender) {
  const g = String(gender === undefined || gender === null ? "" : gender).trim().toLowerCase();
  if (g === "male") return "male";
  if (g === "female") return "female";
  return "genderless";
}

function normalizeGender(gender) {
  if (gender === undefined || gender === null || String(gender).trim() === "") return null;
  const kind = genderKind(gender);
  if (kind === "male") return "Male";
  if (kind === "female") return "Female";
  return "Genderless";
}

function genderAffects(user, target) {
  const targetKind = genderKind(target && target.gender);
  if (targetKind === "genderless") return true;
  const userKind = genderKind(user && user.gender);
  if (userKind === "genderless") return false;
  return userKind !== targetKind;
}

function isGrounded(combatant) {
  if (!combatant) return false;
  if (Array.isArray(combatant.types) && combatant.types.includes("Flying")) return false;
  const ability = combatant.ability || (combatant.species ? speciesAbility(combatant.species) : null);
  if (ability === "Levitate") return false;
  return true;
}

const MISTY_PROTECTED_STATUSES = ["burn", "poison", "paralysis", "sleep", "freeze", "confusion", "petrify"];

function terrainProtects(combatant, status) {
  if (!combatant || !combatant.terrain || !(combatant.terrain.turns > 0)) return false;
  const want = canonStatus(status);
  if (!want || !isGrounded(combatant)) return false;
  const kind = combatant.terrain.kind;
  if (kind === "electric") return want === "sleep";
  if (kind === "misty") return MISTY_PROTECTED_STATUSES.includes(want);
  return false;
}

function isImmuneTo(combatant, status) {
  if (terrainProtects(combatant, status)) return true;
  if (combatant && combatant.hydrophobic > 0 && canonStatus(status) === "soaked") return true;
  if (!combatant || !Array.isArray(combatant.immunities) || combatant.immunities.length === 0) return false;
  const want = canonStatus(status);
  if (!want) return false;
  return combatant.immunities.some(x => {
    const c = canonStatus(x);
    return c === "all" || c === want;
  });
}

function statusWordFull(name) {
  const c = canonStatus(name);
  if (c === "burn") return "burning";
  if (c === "poison") return "poison";
  if (c === "paralysis") return "paralysis";
  if (c === "sleep") return "sleep";
  if (c === "freeze") return "freezing";
  if (c === "confusion") return "confusion";
  if (c === "petrify") return "petrification";
  if (c === "corruption") return "corruption";
  if (c === "goldified") return "goldification";
  if (c === "soaked") return "soaking";
  if (UPGRADED_LABEL[c]) return UPGRADED_LABEL[c].toLowerCase();
  return c || "that status";
}

function tickAilments(combatant) {
  const log = [];
  if (combatant.hasPechaScarf && Array.isArray(combatant.ailments) && combatant.ailments.some(a => a.name === "poison")) {
    combatant.ailments = combatant.ailments.filter(a => a.name !== "poison");
    log.push(`${combatant.name}'s Pecha Scarf cured its poison!`);
  }
  if (combatant.hasPersimBand && combatant.confusion > 0) {
    combatant.confusion = 0;
    log.push(`${combatant.name}'s Persim Band cured its confusion!`);
  }
  if (combatant.hasHealBand && canHeal(combatant) && combatant.hp > 0 && combatant.hp < combatant.maxHp) {
    const heal = Math.max(1, Math.floor(combatant.maxHp * 0.05));
    const beforeHB = combatant.hp;
    combatant.hp = Math.min(combatant.maxHp, combatant.hp + heal);
    const gHB = combatant.hp - beforeHB;
    if (gHB > 0) log.push(`${combatant.name}'s Heal Band restored ${gHB} HP!`);
  }
  if (combatant.hasWarpScarf && !combatant.warpScarfUsed && combatant.hp > 0 && combatant.hp < combatant.maxHp * 0.5) {
    combatant.warpScarfUsed = true;
    if (!combatant.stages) combatant.stages = emptyStages();
    combatant.stages.speed = Math.min(6, (combatant.stages.speed || 0) + 2);
    log.push(`${combatant.name}'s Warp Scarf surges | Speed sharply rose!`);
  }
  const ailList = Array.isArray(combatant.ailments) ? combatant.ailments : [];
  const keptAil = [];
  for (const ailment of ailList) {
    if (combatant.hp > 0 && ailment.name === "burn") {
      const dmg = Math.max(1, Math.floor(combatant.maxHp / 16));
      combatant.hp = Math.max(0, combatant.hp - dmg);
      log.push(`${combatant.name} is hurt by its burn! (-${dmg})`);
    } else if (combatant.hp > 0 && ailment.name === "poison") {
      const dmg = Math.max(1, Math.floor(combatant.maxHp / 8));
      combatant.hp = Math.max(0, combatant.hp - dmg);
      log.push(`${combatant.name} is hurt by poison! (-${dmg})`);
    } else if (combatant.hp > 0 && ailment.name === "toxin") {
      const dmg = Math.max(1, Math.floor(combatant.maxHp * TOXIN_PERCENT / 100));
      combatant.hp = Math.max(0, combatant.hp - dmg);
      log.push(`${combatant.name} is ravaged by toxin! (-${dmg})`);
    } else if (combatant.hp > 0 && ailment.name === "permafrost") {
      const dmg = Math.max(1, Math.floor(combatant.maxHp * PERMAFROST_PERCENT / 100));
      combatant.hp = Math.max(0, combatant.hp - dmg);
      log.push(`${combatant.name} is gnawed by the permafrost! (-${dmg})`);
    } else if (combatant.hp > 0 && ailment.name === "melt") {
      const dmg = Math.max(1, Math.floor(combatant.maxHp * MELT_PERCENT / 100));
      combatant.hp = Math.max(0, combatant.hp - dmg);
      log.push(`${combatant.name} is melting away! (-${dmg})`);
    } else if (combatant.hp > 0 && ailment.name === "corruption" && (ailment.stacks || 1) >= CORRUPTION_STACK_THRESHOLD) {
      const stacks = ailment.stacks || 1;
      const percent = CORRUPTION_STACK_DRAIN_PERCENT + (CORRUPTION_STACK_EXTRA_PERCENT * (stacks - CORRUPTION_STACK_THRESHOLD));
      const dmg = Math.max(1, Math.floor(combatant.maxHp * percent / 100));
      combatant.hp = Math.max(0, combatant.hp - dmg);
      log.push(`${combatant.name}: The corruption drains your life by ${dmg}! Cleanse it quickly!`);
    }
    if (ailment.name !== "sleep" && ailment.name !== "deepsleep" && ailment.name !== "stun" && typeof ailment.turns === "number") {
      ailment.turns -= 1;
      if (ailment.turns <= 0) {
        log.push(`${combatant.name}'s ${ailment.name} wore off.`);
        continue;
      }
    }
    keptAil.push(ailment);
  }
  combatant.ailments = keptAil;
  if (combatant.yawnTurns > 0 && combatant.hp > 0) {
    combatant.yawnTurns -= 1;
    if (combatant.yawnTurns <= 0) {
      combatant.yawnTurns = 0;
      if (hasAilment(combatant, "sleep")) {
      } else if (isImmuneTo(combatant, "sleep")) {
        log.push(`${combatant.name} is immune to sleep!`);
      } else {
        if (!Array.isArray(combatant.ailments)) combatant.ailments = [];
        combatant.ailments.push({ name: "sleep", turns: NATURAL_AILMENT_TURNS });
        log.push(`${combatant.name} grew drowsy and fell asleep!`);
      }
    }
  }
  if (combatant.perish && combatant.hp > 0) {
    combatant.perish -= 1;
    if (combatant.perish <= 0) {
      combatant.perish = 0;
      combatant.hp = 0;
      log.push(`${combatant.name}'s perish count reached 0 | it fainted!`);
    } else {
      log.push(`${combatant.name}'s perish count fell to ${combatant.perish}.`);
    }
  }
  if (combatant.hp > 0 && canHeal(combatant) && (combatant.aquaRing || combatant.ingrain)) {
    const heal = Math.max(1, Math.floor(combatant.maxHp / 16));
    const beforeAR = combatant.hp;
    combatant.hp = Math.min(combatant.maxHp, combatant.hp + heal);
    const gAR = combatant.hp - beforeAR;
    if (gAR > 0) log.push(`${combatant.name} restored a little HP! (+${gAR})`);
  }
  if (combatant.hp > 0 && combatant.nightmare) {
    const asleep = Array.isArray(combatant.ailments) && combatant.ailments.some(a => a.name === "sleep");
    if (asleep) {
      const nd = Math.max(1, Math.floor(combatant.maxHp / 4));
      combatant.hp = Math.max(0, combatant.hp - nd);
      log.push(`${combatant.name} is locked in a nightmare! (-${nd})`);
    } else {
      combatant.nightmare = false;
    }
  }
  if (combatant.hp > 0 && combatant.leechSeededBy) {
    const ld = Math.max(1, Math.floor(combatant.maxHp / 8));
    combatant.hp = Math.max(0, combatant.hp - ld);
    log.push(`${combatant.name}'s health is sapped by Leech Seed! (-${ld})`);
    const seeder = combatant.leechSeededBy;
    if (seeder && seeder.hp > 0 && canHeal(seeder)) {
      const beforeS = seeder.hp;
      seeder.hp = Math.min(seeder.maxHp, seeder.hp + ld);
      const gS = seeder.hp - beforeS;
      if (gS > 0) log.push(`${seeder.name} restored ${gS} HP!`);
    }
  }
  if (combatant.soaked > 0) {
    combatant.soaked -= 1;
    if (combatant.soaked <= 0) {
      combatant.soaked = 0;
      log.push(`${combatant.name} dried off. The soaking wore off.`);
    }
  }
  if (combatant.hydrophobic > 0) {
    combatant.hydrophobic -= 1;
    if (combatant.hydrophobic <= 0) {
      combatant.hydrophobic = 0;
      log.push(`${combatant.name}'s hydrophobic protection wore off.`);
    }
  }
  return { log, fainted: combatant.hp <= 0 };
}

module.exports = { SOAKED_TURNS, HYDROPHOBIC_TURNS, applySoaked, applyHydrophobic, GOLDIFIED_SHATTER_COINS, genderKind, normalizeGender, genderAffects, isGrounded, terrainProtects, AILMENT_STACK_LIMIT, AILMENT_UPGRADES, UPGRADED_LABEL, UPGRADED_NAMES, PERMAFROST_SHATTER_DAMAGE, isUpgradedAilment, baseOfUpgraded, canHeal, clearCurableAilments, clearAilmentsKeepToxin, applyAilmentStack, shatterOnHit, NATURAL_AILMENT_TURNS, CORRUPTION_STACK_THRESHOLD, CORRUPTION_STACK_DRAIN_PERCENT, CORRUPTION_STACK_EXTRA_PERCENT, ailmentApplyMsg, hasAilment, shatterPetrify, applyCorruptionStack, canonStatus, normalizeImmunities, isImmuneTo, statusWordFull, tickAilments };