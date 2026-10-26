const { getMoveData } = require("./moveData");
const { effectiveStat } = require("./stages");
const { hasAilment } = require("./ailments");

const ENERGY_THRESHOLD = 100;
const MIN_EFFECTIVE_SPEED = 10;
const MAX_TICKS = 100000;

function effectiveSpeed(combatant) {
  let spd = effectiveStat(combatant, "speed");
  if (!Number.isFinite(spd)) spd = MIN_EFFECTIVE_SPEED;
  spd = Math.max(MIN_EFFECTIVE_SPEED, spd);
  if (hasAilment(combatant, "paralysis")) spd = Math.max(1, Math.floor(spd / 2));
  spd += (combatant.quickStack || 0) * 5;
  if (!Number.isFinite(spd) || spd < 1) spd = 1;
  return spd;
}

function canAct(combatant) {
  if (combatant.recharge) {
    combatant.recharge = false;
    return { canAct: false, reason: `${combatant.name} must recharge!` };
  }
  if (combatant.flinched) {
    combatant.flinched = false;
    return { canAct: false, reason: `${combatant.name} flinched and couldn't move!` };
  }
  if (combatant.protect) {
    combatant.protect = null;
  }
  if (combatant.endure) {
    combatant.endure = false;
  }
  if (combatant.confusion && combatant.confusion > 0) {
    combatant.confusion -= 1;
    if (combatant.confusion <= 0) {
      combatant.confusion = 0;
    } else if (Math.random() < 0.33) {
      const cd = Math.max(1, Math.floor((Math.floor((2 * combatant.level) / 5 + 2) * 40 * (combatant.attack || 50) / (combatant.defense || 50)) / 50) + 2);
      combatant.hp = Math.max(0, combatant.hp - cd);
      return { canAct: false, reason: `${combatant.name} is confused! It hurt itself in its confusion! (-${cd})` };
    }
  }
  if (combatant.infatuated && combatant.infatuated > 0) {
    combatant.infatuated -= 1;
    if (combatant.infatuated <= 0) {
      combatant.infatuated = 0;
    } else if (Math.random() < 0.5) {
      return { canAct: false, reason: `${combatant.name} is infatuated! It is immobilized by love!` };
    }
  }
  const cAil = Array.isArray(combatant.ailments) ? combatant.ailments : [];
  if (cAil.some(a => a.name === "petrify")) {
    return { canAct: false, reason: `${combatant.name} is petrified and cannot move!` };
  }
  if (cAil.some(a => a.name === "solidified")) {
    return { canAct: false, reason: `${combatant.name} is solidified and cannot move!` };
  }
  if (cAil.some(a => a.name === "permafrost")) {
    return { canAct: false, reason: `${combatant.name} is sealed in permafrost and cannot move!` };
  }
  const deepSleepA = cAil.find(a => a.name === "deepsleep");
  if (deepSleepA) {
    deepSleepA.turns = (deepSleepA.turns || 1) - 1;
    if (deepSleepA.turns <= 0) {
      combatant.ailments = cAil.filter(a => a !== deepSleepA);
      return { canAct: false, reason: `${combatant.name} is in a deep sleep... it will wake up next turn!` };
    }
    return { canAct: false, reason: `${combatant.name} is in a deep sleep!` };
  }
  const stunA = cAil.find(a => a.name === "stun");
  if (stunA) {
    stunA.turns = (stunA.turns || 1) - 1;
    if (stunA.turns <= 0) {
      combatant.ailments = cAil.filter(a => a !== stunA);
      return { canAct: false, reason: `${combatant.name} is stunned! The stun is wearing off.` };
    }
    return { canAct: false, reason: `${combatant.name} is stunned and can't move!` };
  }
  const sleepA = cAil.find(a => a.name === "sleep");
  if (sleepA) {
    sleepA.turns = (sleepA.turns || 1) - 1;
    if (sleepA.turns <= 0) {
      combatant.ailments = cAil.filter(a => a !== sleepA);
      return { canAct: true, reason: `${combatant.name} woke up!` };
    }
    return { canAct: false, reason: `${combatant.name} is fast asleep!` };
  }
  const goldA = cAil.find(a => a.name === "goldified");
  if (goldA) {
    if (Math.random() < 0.2) {
      combatant.ailments = cAil.filter(a => a !== goldA);
      return { canAct: true, reason: `${combatant.name}'s golden shell flaked away!` };
    }
    return { canAct: false, reason: `${combatant.name} is frozen in solid gold!` };
  }
  const freezeA = cAil.find(a => a.name === "freeze");
  if (freezeA) {
    if (Math.random() < 0.2) {
      combatant.ailments = cAil.filter(a => a !== freezeA);
      return { canAct: true, reason: `${combatant.name} thawed out!` };
    }
    return { canAct: false, reason: `${combatant.name} is frozen solid!` };
  }
  if (cAil.some(a => a.name === "paralysis") && Math.random() < 0.25) {
    return { canAct: false, reason: `${combatant.name} is paralyzed! It can't move!` };
  }

  return { canAct: true, reason: null };
}

function pickAiMove(actor) {
  const affordable = actor.moves.filter(m => {
    const d = getMoveData(m);
    if (!d || actor.mp < (d.mpCost || 0)) return false;
    if (actor.tauntTurns > 0 && d.category === "status") return false;
    if (actor.disabledMove && actor.disabledTurns > 0 && m === actor.disabledMove) return false;
    if (actor.encoreMove && actor.encoreTurns > 0 && m !== actor.encoreMove) return false;
    if (actor.tormented && m === actor.lastMoveUsed) return false;
    return true;
  });
  const damaging = affordable.filter(m => {
    const d = getMoveData(m);
    return d && d.power > 0;
  });
  const pool = damaging.length ? damaging : (affordable.length ? affordable : actor.moves);
  return pool[Math.floor(Math.random() * pool.length)];
}

function nextActorMulti(combatants) {
  const living = combatants.filter(c => c.hp > 0);
  if (living.length === 0) return null;
  for (const c of living) {
    if (!Number.isFinite(c.energy)) c.energy = 0;
  }
  let ticks = 0;
  while (!living.some(c => c.energy >= ENERGY_THRESHOLD)) {
    for (const c of living) c.energy += Math.max(1, effectiveSpeed(c));
    ticks++;
    if (ticks > MAX_TICKS) {
      living[0].energy = ENERGY_THRESHOLD;
      break;
    }
  }
  let actor = null;
  for (const c of living) {
    if (c.energy >= ENERGY_THRESHOLD && (!actor || c.energy > actor.energy)) actor = c;
  }
  actor.energy -= ENERGY_THRESHOLD;
  return actor;
}

function nextActor(a, b) {
  if (!Number.isFinite(a.energy)) a.energy = 0;
  if (!Number.isFinite(b.energy)) b.energy = 0;
  let ticks = 0;
  while (a.energy < ENERGY_THRESHOLD && b.energy < ENERGY_THRESHOLD) {
    a.energy += Math.max(1, effectiveSpeed(a));
    b.energy += Math.max(1, effectiveSpeed(b));
    ticks++;
    if (ticks > MAX_TICKS) {
      a.energy = ENERGY_THRESHOLD;
      break;
    }
  }

  let actor;
  if (a.energy >= ENERGY_THRESHOLD && b.energy >= ENERGY_THRESHOLD) {
    actor = a.energy >= b.energy ? a : b;
  } else {
    actor = a.energy >= ENERGY_THRESHOLD ? a : b;
  }

  actor.energy -= ENERGY_THRESHOLD;
  return actor;
}

module.exports = { ENERGY_THRESHOLD, effectiveSpeed, canAct, pickAiMove, nextActor, nextActorMulti };