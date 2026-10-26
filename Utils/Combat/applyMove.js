const { getEffectiveness } = require("../types");
const { getMoveData } = require("./moveData");
const { calcDamage } = require("./damage");
const { applyStage, statLabel, emptyStages, DEFAULT_BUFF_TURNS } = require("./stages");
const { hasAilment, isImmuneTo, applyCorruptionStack, shatterPetrify, shatterOnHit, statusWordFull, ailmentApplyMsg, applyAilmentStack, canHeal, clearCurableAilments, isUpgradedAilment, isGrounded, terrainProtects, genderAffects, canonStatus, applySoaked, NATURAL_AILMENT_TURNS } = require("./ailments");

const FORTUNE_DAMAGE_TAKEN_MULT = 1.25;
const FORTUNE_PAYOUT_MIN = 50;
const FORTUNE_PAYOUT_MAX = 200;
const FORTUNE_CRIT_CHANCE = 0.125;
const FORTUNE_STEAL_NORMAL = 200;
const FORTUNE_STEAL_CRIT = 1000;

const SUPPORT_EFFECTS = {
  "Heal Pulse": { kind: "heal", percent: 50 },
  "Floral Healing": { kind: "heal", percent: 50 },
  "Life Dew": { kind: "heal", percent: 25 },
  "Helping Hand": { kind: "boost", mult: 1.5 },
  "Aromatherapy": { kind: "cure" },
  "Heal Bell": { kind: "cure" },
  "Soul Siphon": { kind: "siphon" },
  "Soul Link": { kind: "link" }
};

function getMoveRestriction(user, target, moveName, moveCategory, priorMove) {
  if (user.tauntTurns > 0 && moveCategory === "status") {
    return `${user.name} can't use status moves after the taunt!`;
  }
  if (user.disabledMove && user.disabledTurns > 0 && moveName === user.disabledMove) {
    return `${moveName} is disabled!`;
  }
  if (user.encoreMove && user.encoreTurns > 0 && moveName !== user.encoreMove) {
    return `${user.name} can only use ${user.encoreMove} right now!`;
  }
  if (user.tormented && priorMove && moveName === priorMove) {
    return `${user.name} can't use the same move twice in a row due to the torment!`;
  }
  if (target && target.imprisoning && Array.isArray(target.moves) && target.moves.includes(moveName)) {
    return `${user.name} is imprisoned | it can't use ${moveName}!`;
  }
  return null;
}

function applySupportToAlly(ally, moveName, caster) {
  const support = SUPPORT_EFFECTS[moveName];
  if (!support) return null;
  if (support.kind === "heal") {
    const boost = (caster && caster.hasFriendBow) ? 1.25 : 1;
    const amt = Math.max(1, Math.floor(ally.maxHp * support.percent / 100 * boost));
    const before = ally.hp;
    ally.hp = canHeal(ally) ? Math.min(ally.maxHp, ally.hp + amt) : ally.hp;
    const healed = ally.hp - before;
    return healed > 0 ? `${ally.name} recovered ${healed} HP!` : null;
  }
  if (support.kind === "cure") {
    if (Array.isArray(ally.ailments) && ally.ailments.length) {
      const removedAilments = clearCurableAilments(ally);
      if (removedAilments.length === 0) return null;
      return `${ally.name}'s status cleared!`;
    }
    return null;
  }
  return null;
}

function applyMove(user, target, moveName) {
  const move = getMoveData(moveName);
  const log = [];
  if (!move) {
    log.push(`${user.name} floundered.`);
    return { log };
  }
  let cost = move.mpCost || 0;
  if (user.hasDietRibbon) cost = Math.max(0, cost - 1);
  if (user.mp < cost) {
    log.push(`${user.name} is too worn out to use ${moveName}.`);
    return { log, failed: true };
  }
  const priorMove = user.lastMoveUsed;
  const restrictionMsg = getMoveRestriction(user, target, moveName, move.category, priorMove);
  if (restrictionMsg) {
    log.push(`${user.name} tried to use ${moveName}!`);
    log.push(restrictionMsg);
    return { log, failed: true };
  }
  user.mp -= cost;
  log.push(`${user.name} used ${moveName}!`);
  user.lastMoveUsed = moveName;

  const doubleDamageActive = !!user.nextMoveDoubleDamage;
  user.nextMoveDoubleDamage = false;

  if (moveName === "Quick Attack") {
    const before = user.quickStack || 0;
    user.quickStack = Math.min(5, before + 1);
    if (user.quickStack > before) log.push(`${user.name} builds momentum! (+${user.quickStack * 5} Speed)`);
  } else if (user.quickStack) {
    user.quickStack = 0;
    log.push(`${user.name}'s momentum fades.`);
  }

  if (move.restrict) {
    if (move.restrict === "taunt") {
      target.tauntTurns = 3;
      log.push(`${target.name} fell for the taunt!`);
      return { log, restrict: true };
    }
    if (move.restrict === "torment") {
      target.tormented = true;
      log.push(`${target.name} was subjected to torment!`);
      return { log, restrict: true };
    }
    if (move.restrict === "disable") {
      if (!target.lastMoveUsed) {
        log.push("But it failed!");
        return { log, restrict: true, failed: true };
      }
      target.disabledMove = target.lastMoveUsed;
      target.disabledTurns = 4;
      log.push(`${target.name}'s ${target.disabledMove} was disabled!`);
      return { log, restrict: true };
    }
    if (move.restrict === "encore") {
      if (!target.lastMoveUsed || target.lastMoveUsed === "Encore") {
        log.push("But it failed!");
        return { log, restrict: true, failed: true };
      }
      target.encoreMove = target.lastMoveUsed;
      target.encoreTurns = 3;
      log.push(`${target.name} received an encore!`);
      return { log, restrict: true };
    }
    if (move.restrict === "imprison") {
      user.imprisoning = true;
      log.push(`${user.name} sealed the target's matching moves!`);
      return { log, restrict: true };
    }
  }

  if (move.protect) {
    if (move.protect === "endure") {
      const priorEndure = priorMove && (getMoveData(priorMove) || {}).protect;
      user.protectStreak = priorEndure ? (user.protectStreak || 0) + 1 : 0;
      if (user.protectStreak > 0 && Math.random() >= Math.pow(1 / 3, user.protectStreak)) {
        log.push("But it failed!");
        return { log, failed: true };
      }
      user.endure = true;
      log.push(`${user.name} braced itself!`);
      return { log, protect: true };
    }
    const priorWasProtect = priorMove && (getMoveData(priorMove) || {}).protect;
    if (priorWasProtect) {
      user.protectStreak = (user.protectStreak || 0) + 1;
    } else {
      user.protectStreak = 0;
    }
    if (user.protectStreak > 0 && Math.random() >= Math.pow(1 / 3, user.protectStreak)) {
      user.protect = null;
      log.push("But it failed!");
      return { log, failed: true };
    }
    user.protect = move.protect;
    const protectMsg = move.protect === "spiky" ? `${user.name} surrounded itself with needles!` : move.protect === "baneful" ? `${user.name} set up a baneful bunker!` : move.protect === "craftyStatus" ? `${user.name} crafted a protective shield!` : move.protect === "obstruct" ? `${user.name} readied itself to obstruct any attack!` : `${user.name} protected itself!`;
    log.push(protectMsg);
    return { log, protect: true };
  }

  if (move.target === "enemy" && target.protect && target.hp > 0) {
    const kind = target.protect;
    const blocksThis = kind !== "craftyStatus" || move.category === "status";
    if (blocksThis) {
      log.push(`${target.name} protected itself!`);
      const isDamaging = move.category === "physical" || move.category === "special";
      if (kind === "spiky" && isDamaging) {
        const rec = Math.max(1, Math.floor(user.maxHp / 8));
        user.hp = Math.max(0, user.hp - rec);
        log.push(`${user.name} was hurt by the spikes! (-${rec})`);
      } else if (kind === "baneful" && isDamaging) {
        if (!Array.isArray(user.ailments)) user.ailments = [];
        if (isImmuneTo(user, "poison")) {
          log.push(`${user.name} is immune to poison!`);
        } else {
          const baneRes = applyAilmentStack(user, "poison", NATURAL_AILMENT_TURNS);
          if (baneRes.log) log.push(baneRes.log);
        }
      } else if (kind === "obstruct" && isDamaging) {
        const changed = applyStage(user, "defense", -2, DEFAULT_BUFF_TURNS);
        if (changed !== 0) log.push(`${user.name}'s Defense sharply fell!`);
      }
      return { log, protect: true };
    }
  }

  if (move.corruptedDrain) {
    const drain = Math.max(1, Math.floor(target.hp * 0.5));
    target.hp = Math.max(0, target.hp - drain);
    if (Array.isArray(target.ailments)) target.ailments = target.ailments.filter(a => a.name !== "petrify");
    const beforeHp = user.hp;
    user.hp = canHeal(user) ? Math.min(user.maxHp, user.hp + drain) : user.hp;
    const gained = user.hp - beforeHp;
    log.push(`${moveName} siphoned ${drain} HP from ${target.name}!`);
    if (gained > 0) log.push(`${user.name} absorbed ${gained} HP!`);
    if (user.drainShield) {
      const overflow = drain - gained;
      if (overflow > 0) {
        const beforeShield = user.shield || 0;
        user.shield = Math.min(500, beforeShield + overflow);
        const stored = user.shield - beforeShield;
        if (stored > 0) log.push(`${user.name}'s Brazen Cape stored ${stored} shield!`);
      }
    }
    target.bagLocked = 3;
    log.push(`${target.name}'s bag was corrupted | no items for 3 turns!`);
    return { log, damage: drain };
  }

  const support = SUPPORT_EFFECTS[moveName];
  if (support) {
    if (support.kind === "heal") {
      const boost = user.hasFriendBow ? 1.25 : 1;
      const amt = Math.max(1, Math.floor(target.maxHp * support.percent / 100 * boost));
      const before = target.hp;
      target.hp = canHeal(target) ? Math.min(target.maxHp, target.hp + amt) : target.hp;
      const healed = target.hp - before;
      log.push(healed > 0 ? `${target.name} recovered ${healed} HP!` : `${target.name}'s HP is already full.`);
    } else if (support.kind === "boost") {
      target.helpingHand = support.mult;
      log.push(`${target.name} is getting fired up!`);
    } else if (support.kind === "cure") {
      if (Array.isArray(target.ailments) && clearCurableAilments(target).length) {
        log.push(`${target.name}'s status cleared!`);
      } else {
        log.push(`${target.name} has no status to heal.`);
      }
    } else if (support.kind === "siphon") {
      const stolen = target.shield || 0;
      if (stolen > 0) {
        target.shield = 0;
        const before = user.mp;
        user.mp = Math.min(user.maxMp, user.mp + stolen);
        const gained = user.mp - before;
        log.push(`${user.name} siphons ${target.name}'s shield into ${gained} ${user.usesEnergy ? "Energy" : "MP"}!`);
        if (user.usesEnergy && gained > 0) {
          user.nextMoveDoubleDamage = true;
          log.push(`${user.name}'s next move is enhanced!`);
        }
      } else {
        log.push(`${target.name} has no shield to siphon.`);
      }
    } else if (support.kind === "link") {
      if (!target.usesEnergy) {
        log.push(`${target.name} doesn't rely on Energy | Soul Link had no effect.`);
      } else {
        const converted = Math.max(1, Math.floor(user.hp * 0.2));
        const beforeHp = user.hp;
        user.hp = Math.max(0, user.hp - converted);
        const spent = beforeHp - user.hp;
        const beforeMp = target.mp;
        target.mp = Math.min(target.maxMp, target.mp + spent);
        const gained = target.mp - beforeMp;
        log.push(`${user.name} channels ${spent} HP into ${target.name}'s Energy!`);
        if (gained > 0) log.push(`${target.name} gained ${gained} Energy!`);
        const leftover = spent - gained;
        if (leftover > 0) {
          const beforeUserHp = user.hp;
          user.hp = canHeal(user) ? Math.min(user.maxHp, user.hp + leftover) : user.hp;
          const returned = user.hp - beforeUserHp;
          if (returned > 0) log.push(`${target.name}'s Energy is full | ${returned} HP returned to ${user.name}!`);
        }
      }
    }
    return { log, support: true };
  }

  if (move.statOp) {
    if (move.statOp === "guardSwap") {
      if (!user.stages) user.stages = emptyStages();
      if (!target.stages) target.stages = emptyStages();
      const uDef = user.stages.defense, uSpDef = user.stages.spDef;
      user.stages.defense = target.stages.defense;
      user.stages.spDef = target.stages.spDef;
      target.stages.defense = uDef;
      target.stages.spDef = uSpDef;
      log.push(`${user.name} switched Defense and Sp. Def stat changes with ${target.name}!`);
    } else if (move.statOp === "powerSplit") {
      const avgAtk = Math.floor((user.attack + target.attack) / 2);
      const avgSpAtk = Math.floor((user.spAtk + target.spAtk) / 2);
      user.attack = avgAtk;
      target.attack = avgAtk;
      user.spAtk = avgSpAtk;
      target.spAtk = avgSpAtk;
      log.push(`${user.name} and ${target.name} split their Attack and Sp. Atk!`);
    } else if (move.statOp === "speedSwap") {
      const uSpd = user.speed;
      user.speed = target.speed;
      target.speed = uSpd;
      log.push(`${user.name} swapped Speed with ${target.name}!`);
    } else if (move.statOp === "heartSwap") {
      if (!user.stages) user.stages = emptyStages();
      if (!target.stages) target.stages = emptyStages();
      const uStages = user.stages;
      user.stages = target.stages;
      target.stages = uStages;
      log.push(`${user.name} switched stat changes with ${target.name}!`);
    } else if (move.statOp === "psychUp") {
      if (!target.stages) target.stages = emptyStages();
      user.stages = Object.assign({}, target.stages);
      log.push(`${user.name} copied ${target.name}'s stat changes!`);
    }
    return { log, statOp: true };
  }

  const targetsEnemy = move.target === "enemy" || (move.category !== "status" && move.power > 0);
  if (targetsEnemy) {
    const accStages = (user.stages && user.stages.accuracy) || 0;
    const evaStages = (target.stages && target.stages.evasion) || 0;
    const combined = Math.max(-6, Math.min(6, accStages - evaStages));
    const accMult = combined >= 0 ? (3 + combined) / 3 : 3 / (3 - combined);
    const effAcc = (typeof move.accuracy === "number" ? move.accuracy : 100) * accMult;
    if (Math.random() * 100 >= effAcc) {
      log.push(`${user.name}'s ${moveName} missed!`);
      return { log, missed: true };
    }
  }

  let damage = 0;
  let hitEffectiveness = 1;
  if (move.ohko) {
    const immune = getEffectiveness(move.type, target.types) === 0;
    if (immune) {
      log.push("It had no effect...");
    } else if (Math.random() * 100 < (move.ohkoChance || 30)) {
      damage = target.hp;
      target.hp = 0;
      log.push("It's a one-hit KO!");
    } else {
      log.push(`${target.name} endured the hit!`);
    }
  }
  if (move.fixedDamage) {
    const immune = getEffectiveness(move.type, target.types) === 0;
    if (immune) {
      log.push("It had no effect...");
    } else {
      let dmg = 0;
      if (move.fixedDamage === "level") dmg = user.level;
      else if (move.fixedDamage === "halfTarget") dmg = Math.max(1, Math.floor(target.hp / 2));
      else if (move.fixedDamage === "endeavor") dmg = Math.max(0, target.hp - user.hp);
      else if (move.fixedDamage === "userHp") dmg = user.hp;
      else if (typeof move.fixedDamage === "number") dmg = move.fixedDamage;
      if (dmg > 0) {
        damage = dmg;
        target.hp -= damage;
        if (target.hp < 0) target.hp = 0;
        log.push(`It dealt ${damage} damage.`);
      } else {
        log.push("But it failed!");
      }
      if (move.userFaints) {
        user.hp = 0;
        log.push(`${user.name} fainted!`);
      }
    }
  }
  if (move.counter) {
    const hit = user.lastHitBy;
    const want = move.counter;
    if (hit && hit.damage > 0 && (want === "any" || hit.category === want) && hit.attacker && hit.attacker.hp > 0) {
      const ret = Math.max(1, Math.floor(hit.damage * (move.counterMult || 2)));
      hit.attacker.hp = Math.max(0, hit.attacker.hp - ret);
      damage = ret;
      log.push(`${user.name} struck back at ${hit.attacker.name}! (${ret} damage)`);
      user.lastHitBy = null;
    } else {
      log.push("But it failed!");
    }
  }
  if (move.maxHpDrain) {
    const immune = getEffectiveness(move.type, target.types) === 0;
    if (immune) {
      log.push("It had no effect...");
    } else {
      const pct = move.maxHpDrain.percent || 10;
      const mult = move.maxHpDrain.multiplier || 1;
      const drained = Math.max(1, Math.floor(target.maxHp * pct / 100));
      let toHp = drained;
      if (target.shield > 0 && !user.hasPierceBand) {
        const absorbed = Math.min(target.shield, toHp);
        target.shield -= absorbed;
        toHp -= absorbed;
      }
      target.hp = Math.max(0, target.hp - toHp);
      damage = drained;
      log.push(`It dealt ${drained} damage.`);
      const healAmt = Math.floor(drained * mult);
      const beforeHp = user.hp;
      user.hp = canHeal(user) ? Math.min(user.maxHp, user.hp + healAmt) : user.hp;
      const gained = user.hp - beforeHp;
      if (gained > 0) log.push(`${user.name} drained ${gained} HP!`);
      if (user.drainShield) {
        const overflow = healAmt - gained;
        if (overflow > 0) {
          const beforeShield = user.shield || 0;
          user.shield = Math.min(500, beforeShield + overflow);
          const stored = user.shield - beforeShield;
          if (stored > 0) log.push(`${user.name}'s Brazen Cape stored ${stored} shield!`);
        }
      }
    }
  }
  if (move.hazardDamage) {
    const grounded = !move.hazardDamage.groundedOnly || isGrounded(target);
    if (!grounded) {
      log.push(`${target.name} is immune | it's not grounded!`);
    } else {
      const pct = move.hazardDamage.percent || 12.5;
      const dmg = Math.max(1, Math.floor(target.maxHp * pct / 100));
      target.hp = Math.max(0, target.hp - dmg);
      damage = dmg;
      log.push(`${target.name} is struck by the hazard! (-${dmg})`);
    }
  }
  if (move.goldenTouch && target.hp > 0) {
    if (hasAilment(target, "goldified")) {
      log.push(`${target.name} is already solid gold!`);
    } else if (isImmuneTo(target, "goldified")) {
      log.push(`${target.name} is immune to goldification!`);
    } else if (Math.random() < 0.5) {
      const goldRes = applyAilmentStack(target, "goldified", NATURAL_AILMENT_TURNS, { ignoreOther: true });
      if (goldRes.log) log.push(goldRes.log);
    } else {
      const touchDamage = Math.max(1, Math.floor((user.spAtk || 0) * 0.25));
      target.hp = Math.max(0, target.hp - touchDamage);
      damage = touchDamage;
      log.push(`The golden touch fizzled | it dealt ${touchDamage} damage instead.`);
    }
  }
  if (!move.fixedDamage && !move.ohko && !move.counter && !move.maxHpDrain && !move.hazardDamage && move.category !== "status" && move.power) {
    let hits = 1;
    if (move.multihit) {
      if (Array.isArray(move.multihit)) {
        const lo = move.multihit[0], hi = move.multihit[1];
        hits = lo + Math.floor(Math.random() * (hi - lo + 1));
      } else {
        hits = move.multihit;
      }
    }
    let lastEff = 1;
    let landed = 0;
    let maskBoost = 1;
    if (user.physAbsorb && user.absorbCharge > 0 && move.category === "physical") {
      maskBoost = 1 + user.absorbCharge / 100;
    }
    for (let h = 0; h < hits && target.hp > 0; h++) {
      const r = calcDamage(user, target, moveName);
      let hitDmg = r.damage;
      if (h === 0 && user.helpingHand && user.helpingHand > 1) {
        hitDmg = Math.floor(hitDmg * user.helpingHand);
        user.helpingHand = 1;
        log.push("The move was boosted by Helping Hand!");
      }
      if (maskBoost > 1) hitDmg = Math.floor(hitDmg * maskBoost);
      if (doubleDamageActive) hitDmg = Math.floor(hitDmg * 2);
      if (target.physAbsorb && move.category === "physical") hitDmg = Math.floor(hitDmg * 0.5);
      if (target.fortune && target.fortune.roll === 4 && target.fortune.turns > 0 && hitDmg > 0) {
        hitDmg = Math.floor(hitDmg * FORTUNE_DAMAGE_TAKEN_MULT);
        const payoutCeiling = Math.max(FORTUNE_PAYOUT_MIN, Math.min(FORTUNE_PAYOUT_MAX, hitDmg));
        const payout = FORTUNE_PAYOUT_MIN + Math.floor(Math.random() * (payoutCeiling - FORTUNE_PAYOUT_MIN + 1));
        if (!Array.isArray(target.fortunePending)) target.fortunePending = [];
        target.fortunePending.push({ kind: "gain", amount: payout });
      }
      let toHp = hitDmg;
      if (target.shield > 0 && !user.hasPierceBand) {
        const absorbed = Math.min(target.shield, toHp);
        target.shield -= absorbed;
        toHp -= absorbed;
      }
      target.hp -= toHp;
      if (target.hp < 0) target.hp = 0;
      damage += hitDmg;
      lastEff = r.effectiveness;
      hitEffectiveness = r.effectiveness;
      landed++;
    }
    if (move.multihit) log.push(`Hit ${landed} time${landed === 1 ? "" : "s"}! It dealt ${damage} damage.`);
    else log.push(`It dealt ${damage} damage.`);
    if (doubleDamageActive && landed > 0) log.push(`${user.name}'s stored energy surged | double damage!`);
    if (lastEff === 0) log.push("It had no effect...");
    else if (lastEff > 1) log.push("It's super effective!");
    else if (lastEff < 1) log.push("It's not very effective...");
    if (maskBoost > 1) {
      user.absorbCharge = 0;
      log.push(`${user.name}'s Avatar Mask unleashed its stored force!`);
    }
    if (target.physAbsorb && move.category === "physical" && damage > 0) {
      const beforeCharge = target.absorbCharge || 0;
      target.absorbCharge = Math.min(300, beforeCharge + 50);
      log.push(`${target.name}'s Avatar Mask soaked the blow! (charge ${target.absorbCharge}%)`);
    }
    if (target.thorns && move.category === "special" && damage > 0 && user.hp > 0) {
      const ret = Math.max(1, Math.floor(damage * target.thorns / 100));
      user.hp = Math.max(0, user.hp - ret);
      log.push(`${target.name}'s Spiral Scales lashed back! (${user.name} took ${ret})`);
    }
    if (move.drain && damage > 0) {
      const drained = Math.max(1, Math.floor(damage * move.drain / 100));
      const beforeHp = user.hp;
      user.hp = canHeal(user) ? Math.min(user.maxHp, user.hp + drained) : user.hp;
      const gained = user.hp - beforeHp;
      if (gained > 0) log.push(`${user.name} drained ${gained} HP!`);
      if (user.drainShield) {
        const overflow = drained - gained;
        if (overflow > 0) {
          const beforeShield = user.shield || 0;
          user.shield = Math.min(500, beforeShield + overflow);
          const stored = user.shield - beforeShield;
          if (stored > 0) log.push(`${user.name}'s Brazen Cape stored ${stored} shield!`);
        }
      }
    }
    if (move.recoil && damage > 0) {
      const rec = Math.max(1, Math.floor(damage * move.recoil / 100));
      user.hp = Math.max(0, user.hp - rec);
      log.push(`${user.name} was hurt by recoil! (-${rec})`);
    }
    if (move.shieldGain && damage > 0) {
      const gained = Math.max(1, Math.floor(damage * move.shieldGain / 100));
      const beforeShield = user.shield || 0;
      user.shield = Math.min(500, beforeShield + gained);
      const stored = user.shield - beforeShield;
      if (stored > 0) log.push(`${user.name} gained ${stored} shield!`);
    }
  }

  if (target.screens && (target.screens.corruptedScreen || 0) > 0 && move.category === "special" && damage > 0 && user.hp > 0) {
    if (isImmuneTo(user, "corruption")) {
      log.push(`${target.name}'s Corrupted Screen crackles, but ${user.name} is immune to corruption!`);
    } else {
      log.push(`${target.name}'s Corrupted Screen strikes back at ${user.name}!`);
      log.push(applyCorruptionStack(user));
    }
  }

  if (damage > 0 && user.fortune && user.fortune.roll === 2 && user.fortune.turns > 0) {
    const jackpot = Math.random() < FORTUNE_CRIT_CHANCE;
    if (!Array.isArray(user.fortunePending)) user.fortunePending = [];
    user.fortunePending.push({ kind: "steal", amount: jackpot ? FORTUNE_STEAL_CRIT : FORTUNE_STEAL_NORMAL, crit: jackpot, victim: target });
    user.fortune = null;
  }

  if (damage > 0) {
    const shatterRes = shatterOnHit(target, damage, move.category, hitEffectiveness);
    for (const shatterLine of shatterRes.logs) log.push(shatterLine);
  }

  const moveEffectList = Array.isArray(move.effects) ? move.effects : (move.effect ? [move.effect] : []);
  const groundedOk = !move.groundedOnly || isGrounded(target);
  const genderOk = !move.genderGated || genderAffects(user, target);
  let groundSkipLogged = false;
  let genderSkipLogged = false;
  const soakedShock = targetsEnemy && target !== user && move.type === "Electric" && target.soaked > 0 && target.hp > 0;
  let soakedParHandled = false;
  for (const eff of moveEffectList) {
    if (!(target.hp > 0)) break;
    if (!genderOk) {
      if (!genderSkipLogged) {
        log.push(`It doesn't affect ${target.name}...`);
        genderSkipLogged = true;
      }
      continue;
    }
    if (!groundedOk) {
      if (!groundSkipLogged) {
        log.push(`${target.name} is immune | it's not grounded!`);
        groundSkipLogged = true;
      }
      continue;
    }
    let chance = eff.chance !== undefined ? eff.chance : 100;
    if (soakedShock && eff.status && eff.target !== "self" && canonStatus(eff.status) === "paralysis") {
      chance = 100;
      soakedParHandled = true;
    }
    if (Math.random() * 100 < chance) {
      if (eff.stat) {
        const who = eff.target === "self" ? user : target;
        const changed = applyStage(who, eff.stat, eff.stages, eff.turns);
        if (changed !== 0) {
          const dir = eff.stages > 0 ? "rose" : "fell";
          const amt = Math.abs(eff.stages) >= 2 ? " sharply" : "";
          log.push(`${who.name}'s ${statLabel(eff.stat)}${amt} ${dir}!`);
        } else {
          log.push(`${who.name}'s ${statLabel(eff.stat)} won't go ${eff.stages > 0 ? "higher" : "lower"}!`);
        }
      }
      if (eff.status) {
        const who = eff.target === "self" ? user : target;
        if (!Array.isArray(who.ailments)) who.ailments = [];
        if (isImmuneTo(who, eff.status)) {
          log.push(`${who.name} is immune to ${statusWordFull(eff.status)}!`);
        } else if (eff.status === "corruption") {
          log.push(applyCorruptionStack(who));
        } else {
          const stackRes = applyAilmentStack(who, eff.status, NATURAL_AILMENT_TURNS);
          if (stackRes.log) log.push(stackRes.log);
        }
      }
      if (eff.perish) {
        if (!target.perish) {
          target.perish = eff.perish;
          log.push(`${target.name} will faint in ${eff.perish} turns!`);
        }
        if (eff.perishSelf && !user.perish) {
          user.perish = eff.perish;
          log.push(`${user.name} will faint in ${eff.perish} turns!`);
        }
      }
    }
  }

  if (soakedShock && !soakedParHandled && target.hp > 0 && (damage > 0 || (move.category === "status" && getEffectiveness(move.type, target.types) > 0))) {
    if (isImmuneTo(target, "paralysis")) {
      log.push(`${target.name} is immune to paralysis!`);
    } else {
      log.push(`The water conducted the shock through ${target.name}!`);
      const soakPar = applyAilmentStack(target, "paralysis", NATURAL_AILMENT_TURNS);
      if (soakPar.log) log.push(soakPar.log);
    }
  }

  if (targetsEnemy && target !== user && move.type === "Water" && target.hp > 0 && (damage > 0 || move.category === "status")) {
    const soakRes = applySoaked(target);
    if (soakRes.log) log.push(soakRes.log);
  }

  if (move.shieldFlat) {
    const beforeShield = user.shield || 0;
    user.shield = Math.min(500, beforeShield + move.shieldFlat);
    const stored = user.shield - beforeShield;
    if (stored > 0) log.push(`${user.name} gained ${stored} shield!`);
  }

  if (move.flinch && target.hp > 0 && Math.random() * 100 < move.flinch) {
    target.flinched = true;
  }
  if (move.confuse && target.hp > 0 && Math.random() * 100 < move.confuse) {
    if (isImmuneTo(target, "confusion")) {
      log.push(`${target.name} is immune to confusion!`);
    } else if (!target.confusion || target.confusion <= 0) {
      target.confusion = 2 + Math.floor(Math.random() * 3);
      log.push(`${target.name} became confused!`);
    }
  }
  if (move.aquaRing) {
    user.aquaRing = true;
    log.push(`${user.name} surrounded itself with a veil of water!`);
  }
  if (move.ingrain) {
    user.ingrain = true;
    log.push(`${user.name} planted its roots!`);
  }
  if (move.attract && target.hp > 0) {
    if (target.infatuated > 0) {
      log.push(`${target.name} is already infatuated!`);
    } else if (!genderAffects(user, target)) {
      log.push(`It doesn't affect ${target.name}...`);
    } else {
      target.infatuated = 5;
      log.push(`${target.name} fell in love with ${user.name}!`);
    }
  }
  if (move.yawn && target.hp > 0) {
    if (hasAilment(target, "sleep") || target.yawnTurns > 0) {
      log.push(`${target.name} is already drowsy!`);
    } else if (isImmuneTo(target, "sleep")) {
      log.push(`${target.name} is immune to sleep!`);
    } else {
      target.yawnTurns = 2;
      log.push(`${target.name} grew drowsy!`);
    }
  }
  if (move.leechSeed && target.hp > 0) {
    if (Array.isArray(target.types) && target.types.includes("Grass")) {
      log.push(`It doesn't affect ${target.name}...`);
    } else if (target.leechSeededBy) {
      log.push(`${target.name} is already seeded!`);
    } else {
      target.leechSeededBy = user;
      log.push(`${target.name} was seeded!`);
    }
  }
  if (move.nightmare && target.hp > 0) {
    const asleepN = target.ailments && target.ailments[0] && target.ailments[0].name === "sleep";
    if (asleepN) {
      target.nightmare = true;
      log.push(`${target.name} began having a nightmare!`);
    } else {
      log.push("But it failed!");
    }
  }
  if (move.screen) {
    if (!user.screens) user.screens = { reflect: 0, lightScreen: 0, auroraVeil: 0, corruptedScreen: 0 };
    const st = move.screenTurns || 5;
    user.screens[move.screen] = st;
    const label = move.screen === "reflect" ? "Reflect" : move.screen === "lightScreen" ? "Light Screen" : move.screen === "corruptedScreen" ? "Corrupted Screen" : "Aurora Veil";
    log.push(`${user.name} put up ${label}!`);
  }
  if (move.startBide) {
    user.biding = { turns: 2, damage: 0, attacker: null };
    log.push(`${user.name} began storing energy!`);
  }
  if (move.weather) {
    user.weather = { kind: move.weather, turns: move.weatherTurns || 5 };
    const wm = move.weather === "rain" ? "It started to rain!" : move.weather === "sun" ? "The sunlight turned harsh!" : move.weather === "sand" ? "A sandstorm kicked up!" : "It started to hail!";
    log.push(wm);
  }
  if (move.terrain) {
    user.terrain = { kind: move.terrain, turns: move.terrainTurns || 5 };
    log.push(`The battlefield was bathed in ${move.terrain} energy!`);
  }
  if (move.recharge) {
    user.recharge = true;
  }

  if (move.healSelf) {
    const heal = Math.max(1, Math.floor(user.maxHp * move.healSelf / 100));
    const beforeHeal = user.hp;
    user.hp = canHeal(user) ? Math.min(user.maxHp, user.hp + heal) : user.hp;
    const healedSelf = user.hp - beforeHeal;
    log.push(healedSelf > 0 ? `${user.name} restored ${healedSelf} HP!` : `${user.name}'s HP is already full!`);
  }
  if (move.sleepSelf) {
    if (terrainProtects(user, "sleep")) {
      log.push(`${user.name} can't fall asleep on this terrain!`);
    } else if (Array.isArray(user.ailments) && user.ailments.some(a => isUpgradedAilment(a.name))) {
      log.push(`${user.name} is too afflicted to fall asleep!`);
    } else {
      user.ailments = [{ name: "sleep", turns: 2 }];
      log.push(`${user.name} fell asleep to recover!`);
    }
  }

  if (damage > 0 && !move.counter && (move.category === "physical" || move.category === "special")) {
    target.lastHitBy = { attacker: user, damage: damage, category: move.category };
  }
  if (damage > 0 && target.biding) {
    target.biding.damage += damage;
    target.biding.attacker = user;
  }
  if (target.endure && target.hp <= 0) {
    target.hp = 1;
    target.endure = false;
    log.push(`${target.name} endured the hit!`);
  }
  const fainted = target.hp <= 0;
  if (fainted) log.push(`${target.name} fainted!`);
  return { log, damage, fainted };
}

module.exports = { SUPPORT_EFFECTS, applySupportToAlly, applyMove, getMoveRestriction };