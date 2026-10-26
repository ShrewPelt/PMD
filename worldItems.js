const items = require("./Utils/battleItems");
const engine = require("./Utils/combat");

const THROW_RANGE = 3;
const CONE_DEPTH = 3;
const OFFENSIVE_TYPES = ["inflict", "petrify", "damage"];
const NOT_OUTSIDE_TYPES = ["inflict", "petrify", "damage", "blast", "knife", "fortuneDie"];
const DIRECTION_VECTORS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

function effectList(eff) {
  if (Array.isArray(eff.effects)) return eff.effects.filter((e) => e && typeof e === "object");
  return [eff];
}

function negativeStageSum(list) {
  let sum = 0;
  for (const e of list) {
    if (e.type !== "stage" || !e.stages) continue;
    for (const stat in e.stages) {
      if (e.stages[stat] < 0) sum += e.stages[stat];
    }
  }
  return sum;
}

function classify(name) {
  const eff = items.effectFor(name);
  if (!eff) return null;
  const list = effectList(eff);
  const types = list.map((e) => e.type);
  const base = { name: name, relic: !!eff.relic, cooldown: eff.cooldown || 0, userMp: eff.userMp || 0, unsupported: null, canUse: false, canThrow: false, cone: false, offensive: false, rule: "any", outside: false };
  if (types.every((t) => t === "misc" || t === undefined)) return null;
  if (types.every((t) => t === "revive")) {
    base.unsupported = "Revive items can't be used by hand here.";
    return base;
  }
  if (types.includes("fortuneDie")) {
    base.unsupported = "The Die of Fortunes can't be rolled in the open world yet.";
    return base;
  }
  const isBlast = types.includes("blast");
  const isKnife = types.includes("knife");
  const isSeed = /seed$/i.test(name);
  const negative = negativeStageSum(list) < 0;
  const offensiveDefault = !eff.target && (types.some((t) => OFFENSIVE_TYPES.includes(t)) || isBlast || isKnife || negative);
  let rule = eff.target || (offensiveDefault ? "enemy" : "any");
  if (isBlast || isKnife || eff.allyEffect === "randomBuff") rule = "enemy";
  base.rule = rule;
  base.offensive = rule === "enemy";
  base.cone = !isKnife && (isBlast || (isSeed && (types.includes("inflict") || negative)));
  base.canUse = base.cone || rule === "self" || rule === "ally" || rule === "any";
  base.canThrow = rule !== "self";
  base.outside = !base.offensive && !base.cone && !types.some((t) => NOT_OUTSIDE_TYPES.includes(t));
  return base;
}

function allInfo() {
  const out = {};
  const map = items.allEffects();
  for (const name of Object.keys(map)) {
    const c = classify(name);
    if (!c) continue;
    out[name] = { r: c.relic ? 1 : 0, u: c.canUse ? 1 : 0, t: c.canThrow ? 1 : 0, o: c.offensive ? 1 : 0, k: c.cone ? 1 : 0, x: c.outside ? 1 : 0, rule: c.rule, cd: c.cooldown, bad: c.unsupported || null };
  }
  return out;
}

function coneTiles(col, row, direction) {
  const v = DIRECTION_VECTORS[direction] || DIRECTION_VECTORS.down;
  const perpCol = Math.abs(v[1]);
  const perpRow = Math.abs(v[0]);
  const tiles = [];
  for (let d = 1; d <= CONE_DEPTH; d++) {
    for (let l = -(d - 1); l <= d - 1; l++) {
      tiles.push({ col: col + v[0] * d + perpCol * l, row: row + v[1] * d + perpRow * l });
    }
  }
  return tiles;
}

function getCooldown(sheet, name) {
  if (!sheet || !sheet.itemCooldowns) return 0;
  return sheet.itemCooldowns[name] || 0;
}

function setCooldown(sheet, name, turns) {
  if (!sheet.itemCooldowns) sheet.itemCooldowns = {};
  sheet.itemCooldowns[name] = turns;
}

function tickCooldowns(sheet) {
  if (!sheet || !sheet.itemCooldowns) return;
  for (const k of Object.keys(sheet.itemCooldowns)) {
    if (sheet.itemCooldowns[k] > 0) sheet.itemCooldowns[k] -= 1;
  }
}

function blastOn(c, eff, withBurn) {
  const parts = [];
  if (eff.amount) {
    const before = c.hp;
    c.hp = Math.max(0, c.hp - eff.amount);
    if (before - c.hp > 0) parts.push(`${c.name} took ${before - c.hp}`);
    const shatter = engine.shatterOnHit(c, before - c.hp, "item", 1);
    for (const line of shatter.logs) parts.push(line);
  }
  if (withBurn && eff.burn && c.hp > 0) {
    const burn = engine.applyAilmentStack(c, "burn", 5);
    if (burn.reason === "applied") {
      const entry = c.ailments.find((a) => a.name === "burn");
      if (entry) delete entry.turns;
    }
    if (burn.log) parts.push(burn.log);
  }
  return parts;
}

function miracleTonicTeam(user, allies) {
  const teamHeal = 20;
  const teamMp = 10;
  const teamShield = 50;
  const everyoneFull = allies.every((m) => m.c.hp >= m.c.maxHp);
  const parts = [];
  for (const mate of allies) {
    const c = mate.c;
    const hpBefore = c.hp;
    const mpBefore = c.mp;
    const shieldBefore = c.shield || 0;
    if (everyoneFull) c.shield = Math.min(500, shieldBefore + teamShield);
    else if (engine.canHeal(c)) c.hp = Math.min(c.maxHp, c.hp + teamHeal);
    c.mp = Math.min(c.maxMp, c.mp + teamMp);
    const bits = [];
    if (c.hp - hpBefore > 0) bits.push(`${c.hp - hpBefore} HP`);
    if ((c.shield || 0) - shieldBefore > 0) bits.push(`${(c.shield || 0) - shieldBefore} Shield`);
    if (c.mp - mpBefore > 0) bits.push(`${c.mp - mpBefore} ${c.usesEnergy ? "Energy" : "MP"}`);
    if (bits.length) parts.push(`${c.name} +${bits.join(" +")}`);
  }
  if (parts.length === 0) return { success: false, log: "The whole team is already at full strength and shielded to the max." };
  return { success: true, log: `${user.c.name} raised the Miracle Tonic! A warm light washed over the team | ${parts.join(", ")}!` };
}

function resolveInCombat(cls, A, mode, T, arena) {
  const name = cls.name;
  const eff = items.effectFor(name);
  const list = effectList(eff);
  const isBlast = list.some((e) => e.type === "blast");
  const isKnife = eff.type === "knife";
  const blastEff = list.find((e) => e.type === "blast") || eff;

  if (mode === "use") {
    if (cls.cone) {
      const pos = arena.pos(A);
      const tiles = coneTiles(pos.col, pos.row, arena.direction(A));
      const keys = {};
      for (const t of tiles) keys[t.col + "," + t.row] = true;
      const hit = arena.foes.filter((F) => {
        const p = arena.pos(F);
        return keys[p.col + "," + p.row] && F.c.hp > 0 && !F.c.hasCradle;
      });
      if (hit.length === 0) return { success: false, log: `There are no foes in front of ${A.c.name} for the ${name} to hit.`, cone: tiles };
      const parts = [];
      let any = false;
      for (const F of hit) {
        if (isBlast) {
          const bits = blastOn(F.c, blastEff, true);
          if (bits.length) parts.push(bits.join(", "));
          any = true;
        } else {
          const r = items.applyItemEffect(F.c, name);
          parts.push(r.log);
          if (r.success) any = true;
        }
      }
      if (!any) return { success: false, log: parts.join(" "), cone: tiles };
      return { success: true, log: `${A.c.name} unleashed the ${name} in a cone! ${parts.join(" | ")}`, cone: tiles };
    }
    if (name.toLowerCase() === "miracle tonic") return miracleTonicTeam(A, arena.allies);
    const r = items.applyItemEffect(A.c, name);
    return { success: r.success, log: r.log };
  }

  if (isKnife) {
    const before = T.c.hp;
    T.c.hp = Math.max(0, T.c.hp - (eff.amount || 10));
    const dealt = before - T.c.hp;
    const shatter = engine.shatterOnHit(T.c, dealt, "item", 1).logs.join(" ");
    let log = `${A.c.name} stabbed ${T.c.name} with the ${name} for ${dealt} true damage`;
    if (shatter) log += ` | ${shatter}`;
    return { success: true, log: `${log}!` };
  }

  if (isBlast) {
    const splashAmount = Math.floor((blastEff.amount || 0) * (blastEff.splashPercent || 75) / 100);
    const before = T.c.hp;
    const bits = blastOn(T.c, blastEff, false);
    let burned = "";
    if (blastEff.burn && T.c.hp > 0) {
      const burn = engine.applyAilmentStack(T.c, "burn", 5);
      if (burn.reason === "applied") {
        const entry = T.c.ailments.find((a) => a.name === "burn");
        if (entry) delete entry.turns;
        burned = " and was burned";
      } else if (burn.log) {
        burned = ` and ${burn.log.replace(T.c.name, "").trim()}`;
      }
    }
    const splash = [];
    const tpos = arena.pos(T);
    for (const O of arena.sameSideAs(T)) {
      if (O === T || O.c.hp <= 0 || O.c.hasCradle) continue;
      const p = arena.pos(O);
      if (Math.max(Math.abs(p.col - tpos.col), Math.abs(p.row - tpos.row)) > 1) continue;
      if (splashAmount > 0) {
        const ob = O.c.hp;
        O.c.hp = Math.max(0, O.c.hp - splashAmount);
        if (ob - O.c.hp > 0) splash.push(`${O.c.name} took ${ob - O.c.hp} splash`);
        const shatter = engine.shatterOnHit(O.c, ob - O.c.hp, "item", 1);
        for (const line of shatter.logs) splash.push(line);
      }
    }
    let log = `${A.c.name} threw the ${name}! It burst on ${T.c.name} for ${before - T.c.hp} damage${burned}`;
    const extra = bits.filter((b) => b.indexOf("took") === -1);
    if (extra.length) log += ` | ${extra.join(" ")}`;
    if (splash.length) log += ` | ${splash.join(", ")}`;
    return { success: true, log: `${log}!` };
  }

  const r = items.applyItemEffect(T.c, name);
  if (!r.success) return { success: false, log: r.log };
  return { success: true, log: `${A.c.name} threw the ${name} at ${T.c.name}! ${r.log}` };
}

function resolveOutside(cls, name, targetCombatant, userName) {
  const eff = items.effectFor(name);
  if (eff && eff.outHeal) {
    if (!engine.canHeal(targetCombatant)) return { success: false, log: `${name} is useless | ${targetCombatant.name}'s toxin blocks all healing!` };
    if (targetCombatant.hp >= targetCombatant.maxHp) return { success: false, log: `${targetCombatant.name} is already at full HP.` };
    const before = targetCombatant.hp;
    targetCombatant.hp = Math.min(targetCombatant.maxHp, targetCombatant.hp + eff.outHeal);
    return { success: true, log: `${targetCombatant.name} recovered ${targetCombatant.hp - before} HP from the ${name}!` };
  }
  return items.applyItemEffect(targetCombatant, name);
}

module.exports = { THROW_RANGE, CONE_DEPTH, classify, allInfo, coneTiles, getCooldown, setCooldown, tickCooldowns, resolveInCombat, resolveOutside };