const engine = require("./Utils/combat");
const { getMoveRestriction, SUPPORT_EFFECTS } = require("./Utils/Combat/applyMove");
const { effectiveSpeed } = require("./Utils/Combat/turnOrder");
const { registerMove } = require("./Utils/Combat/moveData");
const worldItems = require("./worldItems");
const battleItems = require("./Utils/battleItems");
const leveling = require("./Utils/leveling");
const { accessoryBonusFor } = require("./Utils/accessoryBonus");

const MOVE_STEPS = 3;
const PLAYER_TURN_MS = 30000;
const ENEMY_STEP_MS = 320;
const ENEMY_THINK_MS = 700;
const ACTION_MS = 1500;
const BETWEEN_TURNS_MS = 500;
const MELEE_RANGE = 1;
const RANGED_RANGE = 3;
const WIDE_RANGE = 5;
const WIDE_POWER = 100;
const FLEE_COOLDOWN_MS = 20000;
const FLEE_CHANCE = 0.2;
const FLEE_DISTANCE = 10;
const ENGAGE_MAX = 5;
const DEFEAT_COOLDOWN_MS = 12000;
const WIN_COOLDOWN_MS = 3000;
const RESPAWN_MS = 90000;
const NPC_FAINT_MS = parseInt(process.env.PMD_NPC_FAINT_MS, 10) || 300000;
const DEFEAT_HP_PERCENT = 25;
const ORDER_PREVIEW = 8;
const LOG_KEEP = 40;

const UNSUPPORTED_MOVES = {
  "Follow Me": true,
  "Absorb Pain": true,
  "Impending Doom": true,
  "Corrupted Terrain": true,
  "Golden Hour": true,
  "Energized Flow": true,
  "Move Swap": true
};

let ctx = null;
const fights = {};
let nextFightId = 1;

function init(context) {
  ctx = context;
}

function chebyshev(aCol, aRow, bCol, bRow) {
  return Math.max(Math.abs(aCol - bCol), Math.abs(aRow - bRow));
}

function rangeOf(moveData) {
  if (!moveData) return MELEE_RANGE;
  if (typeof moveData.range === "number") return moveData.range;
  const target = moveData.target || "enemy";
  if (target === "self" || target === "all-allies") return 0;
  if (moveData.category === "physical" && moveData.power > 0) return MELEE_RANGE;
  if (moveData.category === "special" && (moveData.power >= WIDE_POWER || moveData.recharge || moveData.ohko)) return WIDE_RANGE;
  return RANGED_RANGE;
}

function moveInfo(name) {
  const d = engine.getMoveData(name) || {};
  return {
    name: name,
    type: d.type || "Normal",
    category: d.category || "physical",
    power: d.power || 0,
    accuracy: d.accuracy || 100,
    mpCost: d.mpCost || 0,
    target: d.target || "enemy",
    range: rangeOf(d),
    unsupported: UNSUPPORTED_MOVES[name] === true
  };
}

function actorPos(A) {
  return { col: A.ref.col, row: A.ref.row };
}

function actorDistance(A, B) {
  return chebyshev(A.ref.col, A.ref.row, B.ref.col, B.ref.row);
}

function sideOf(A) {
  if (A.side) return A.side;
  return A.kind === "enemy" ? "enemies" : "players";
}

function livingSide(f, side) {
  return livingActors(f).filter((A) => sideOf(A) === side);
}

function livingActors(f) {
  const out = [];
  for (const id in f.actors) {
    const A = f.actors[id];
    if (A.c.hp > 0 && !A.gone) out.push(A);
  }
  return out;
}

function livingOfKind(f, kind) {
  return livingActors(f).filter((A) => A.kind === kind);
}

function nonZeroStages(c) {
  const out = {};
  if (!c.stages) return out;
  for (const stat of ["attack", "defense", "spAtk", "spDef", "speed"]) {
    if (c.stages[stat]) out[stat] = c.stages[stat];
  }
  return out;
}

function publicActor(A) {
  const c = A.c;
  const ailNames = [];
  for (const a of Array.isArray(c.ailments) ? c.ailments : []) ailNames.push(a.name);
  return {
    id: A.id,
    kind: A.kind,
    side: sideOf(A),
    name: c.name,
    dex: A.ref.dex,
    level: c.level,
    col: A.ref.col,
    row: A.ref.row,
    direction: A.ref.direction,
    hp: Math.max(0, c.hp),
    maxHp: c.maxHp,
    mp: Math.max(0, c.mp),
    maxMp: c.maxMp,
    ailments: ailNames,
    stages: nonZeroStages(c),
    stageTurns: c.stageTurns || null,
    hydrophobic: c.hydrophobic || 0,
    dead: c.hp <= 0
  };
}

function orderPreview(f) {
  const living = livingActors(f);
  if (living.length === 0) return [];
  const clones = living.map((A) => {
    const clone = Object.assign({}, A.c);
    clone._actor = A;
    return clone;
  });
  const out = [];
  for (let i = 0; i < ORDER_PREVIEW; i++) {
    const pick = engine.nextActorMulti(clones);
    if (!pick) break;
    out.push(pick._actor.id);
  }
  return out;
}

function participants(f) {
  const list = [];
  for (const id in f.actors) {
    const A = f.actors[id];
    if (A.kind === "player" && !A.gone) list.push(A.ref);
  }
  return list;
}

function emit(f, data) {
  for (const p of participants(f)) ctx.sendPlayer(p, data);
  ctx.sendGms(f.layer, data);
}

function emitState(f) {
  const actors = [];
  for (const id in f.actors) {
    if (!f.actors[id].gone) actors.push(publicActor(f.actors[id]));
  }
  emit(f, { type: "c_state", fight: f.id, layer: f.layer, actors: actors, order: orderPreview(f), turn: f.turnActor ? f.turnActor.id : null, steps: f.turnActor ? f.turnActor.steps : 0 });
}

function pushLog(f, lines) {
  const list = Array.isArray(lines) ? lines : [lines];
  const clean = [];
  for (const line of list) {
    if (typeof line !== "string") continue;
    for (const part of line.split("\n")) {
      if (part.trim()) clean.push(part);
    }
  }
  if (clean.length === 0) return;
  for (const line of clean) f.log.push(line);
  while (f.log.length > LOG_KEEP) f.log.shift();
  emit(f, { type: "c_log", lines: clean });
}

function syncPlayerVitals(A) {
  if (A.kind === "enemy") return;
  A.ref.hp = Math.max(0, A.c.hp);
  A.ref.mp = Math.max(0, A.c.mp);
  A.ref._sheet.ailments = JSON.parse(JSON.stringify(A.c.ailments || []));
}

function buildPlayerCombatant(p) {
  const sheet = p._sheet || {};
  for (const m of Array.isArray(sheet.moves) ? sheet.moves : []) {
    if (m && m.name && m.data) registerMove(m.name, m.data);
  }
  const character = {
    name: p.name,
    species: sheet.species || "Sobble",
    level: sheet.level || 1,
    types: sheet.types && sheet.types.length ? sheet.types.slice() : undefined,
    hp: p.hp,
    maxHp: p.maxHp,
    mp: p.mp,
    maxMp: p.maxMp,
    attack: sheet.attack,
    defense: sheet.defense,
    spAtk: sheet.spAtk,
    spDef: sheet.spDef,
    speed: sheet.speed,
    moves: Array.isArray(sheet.moves) ? sheet.moves.map((m) => m.name) : [],
    ailments: Array.isArray(sheet.ailments) ? JSON.parse(JSON.stringify(sheet.ailments)) : [],
    immunities: Array.isArray(sheet.immunities) ? sheet.immunities.slice() : [],
    gender: sheet.gender || null,
    userId: p.userId,
    isNpc: p.kind === "companion" ? true : undefined,
    inventory: p._inv,
    accessories: sheet.accessories || {},
    variation: sheet.variation || null,
    region: sheet.region || null,
    ivs: sheet.ivs || undefined,
    evs: sheet.evs || undefined,
    boosts: sheet.boosts || undefined,
    nature: sheet.nature || null,
    moveBoosts: sheet.moveBoosts || {},
    hydrophobic: sheet.hydrophobic || 0,
    shield: sheet.shield || 0
  };
  const c = engine.makeCombatant(character, p.name);
  c.maxHp = Math.max(c.maxHp, p.maxHp);
  c.hp = Math.min(p.hp, c.maxHp);
  c.energy = 0;
  return c;
}

function buildEnemyCombatant(e) {
  const hasIvs = !!e.ivs;
  const hasAccessories = !!(e.accessories && (e.accessories.back || e.accessories.neck || e.accessories.head));
  const hasLoot = Array.isArray(e.loot) && e.loot.length > 0;
  const hasMoves = Array.isArray(e.moves) && e.moves.length > 0;
  if (!hasIvs && !hasAccessories && !hasLoot && !hasMoves) {
    const plain = engine.makeWildPokemon(e.species, e.level);
    plain.name = e.name;
    plain.energy = 0;
    return plain;
  }
  const ivs = { hp: 15, attack: 15, defense: 15, spAtk: 15, spDef: 15, speed: 15 };
  if (hasIvs) {
    for (const stat of Object.keys(ivs)) {
      if (typeof e.ivs[stat] === "number") ivs[stat] = e.ivs[stat];
    }
  }
  const character = {
    name: e.name,
    species: e.species,
    level: e.level,
    nature: null,
    ivs: ivs,
    evs: { hp: 0, attack: 0, defense: 0, spAtk: 0, spDef: 0, speed: 0 },
    boosts: { hp: 0, mp: 0, attack: 0, defense: 0, spAtk: 0, spDef: 0, speed: 0 },
    hp: 1,
    maxHp: 1,
    mp: 1,
    maxMp: 1,
    accessories: hasAccessories ? { back: e.accessories.back || null, neck: e.accessories.neck || null, head: e.accessories.head || null } : {},
    inventory: hasLoot ? e.loot.map((stack) => ({ name: stack.name, count: stack.count })) : [],
    moves: hasMoves ? e.moves.slice() : []
  };
  leveling.recalcStats(character);
  const bonus = accessoryBonusFor(character);
  character.maxHp += bonus.hp;
  character.maxMp += bonus.mp;
  character.attack += bonus.attack;
  character.defense += bonus.defense;
  character.spAtk += bonus.spAtk;
  character.spDef += bonus.spDef;
  character.speed += bonus.speed;
  character.hp = character.maxHp;
  character.mp = character.maxMp;
  const c = engine.makeCombatant(character, e.name);
  c.energy = 0;
  return c;
}

function addActor(f, kind, ref, side) {
  const id = String(ref.id);
  if (f.actors[id] && !f.actors[id].gone) return f.actors[id];
  const c = kind === "enemy" ? buildEnemyCombatant(ref) : buildPlayerCombatant(ref);
  const A = { id: ref.id, kind: kind, ref: ref, c: c, steps: 0, gone: false, side: side || (kind === "enemy" ? "enemies" : "players") };
  f.actors[id] = A;
  ref._fight = f.id;
  if (kind === "enemy") ref.state = "alert";
  return A;
}

function actorById(f, id) {
  const A = f.actors[String(id)];
  return A && !A.gone ? A : null;
}

function sensorOf(e) {
  const own = typeof e.sensor === "number" ? e.sensor : ENGAGE_MAX;
  return Math.min(own, ENGAGE_MAX);
}

function findFleeSpot(f, p) {
  const foes = livingOfKind(f, "enemy");
  let best = null;
  let bestScore = Infinity;
  const reach = FLEE_DISTANCE + 12;
  for (let dc = -reach; dc <= reach; dc++) {
    for (let dr = -reach; dr <= reach; dr++) {
      const col = p.col + dc;
      const row = p.row + dr;
      if (!ctx.isWalkable(p.layer, col, row)) continue;
      if (ctx.entityAt(p.layer, col, row)) continue;
      if (ctx.playerAt(p.layer, col, row)) continue;
      let nearest = Infinity;
      for (const E of foes) nearest = Math.min(nearest, chebyshev(col, row, E.ref.col, E.ref.row));
      if (nearest < FLEE_DISTANCE) continue;
      const score = Math.max(Math.abs(dc), Math.abs(dr)) * 100 + Math.abs(dc) + Math.abs(dr);
      if (score < bestScore) {
        bestScore = score;
        best = { col: col, row: row };
      }
    }
  }
  return best;
}

function expand(f) {
  let changed = false;
  let grew = true;
  let guard = 0;
  while (grew && guard < 8) {
    grew = false;
    guard++;
    const enemyActors = f.duel ? [] : livingOfKind(f, "enemy");
    for (const id in ctx.worldSession.players) {
      if (f.duel) break;
      const p = ctx.worldSession.players[id];
      if (p.layer !== f.layer || p._fight || p.hp <= 0) continue;
      if (p._noFightUntil && Date.now() < p._noFightUntil) continue;
      for (const E of enemyActors) {
        if (actorDistance({ ref: p }, E) <= sensorOf(E.ref)) {
          addActor(f, "player", p);
          sendStart(f, p);
          grew = true;
          changed = true;
          break;
        }
      }
    }
    for (const P of livingOfKind(f, "player")) {
      for (const e of ctx.companionsOf(P.ref)) {
        if (e._fight || e.down || e.hp <= 0 || e.layer !== f.layer) continue;
        addActor(f, "ally", e, sideOf(P));
        grew = true;
        changed = true;
      }
    }
    const playerActors = f.duel ? [] : livingOfKind(f, "player");
    for (const id in ctx.entities) {
      if (f.duel) break;
      const e = ctx.entities[id];
      if (e.kind !== "enemy" || e.layer !== f.layer || e._fight || e.down) continue;
      for (const P of playerActors) {
        if (actorDistance(P, { ref: e }) <= sensorOf(e)) {
          addActor(f, "enemy", e);
          ctx.broadcastEntity(e, e.layer, e.col, e.row);
          grew = true;
          changed = true;
          break;
        }
      }
    }
  }
  return changed;
}

function sendStart(f, p) {
  ctx.sendPlayer(p, { type: "c_start", fight: f.id, layer: f.layer, log: f.log.slice(-12) });
}

function startFight(layer, firstEnemy) {
  const f = { id: nextFightId, layer: layer, actors: {}, turnActor: null, timer: null, busy: false, ended: false, log: [], turnToken: 0 };
  nextFightId = nextFightId + 1;
  fights[f.id] = f;
  addActor(f, "enemy", firstEnemy);
  ctx.broadcastEntity(firstEnemy, firstEnemy.layer, firstEnemy.col, firstEnemy.row);
  expand(f);
  if (livingOfKind(f, "player").length === 0) {
    endFight(f, "none");
    return null;
  }
  const names = livingOfKind(f, "enemy").map((A) => A.c.name).join(", ");
  pushLog(f, `${names} spotted you! Battle start!`);
  emitState(f);
  schedule(f, 900, () => nextTurn(f));
  return f;
}

function sheetMoveInfo(sheet) {
  const out = [];
  for (const m of Array.isArray(sheet.moves) ? sheet.moves : []) {
    if (!m || !m.name) continue;
    if (m.data) registerMove(m.name, m.data);
    out.push(moveInfo(m.name));
  }
  return out;
}

const DUMMY_SPECIES = "Ditto";
const DUMMY_LEVEL = 50;
const DUMMY_COOLDOWN_MS = 700;
const DUMMY_HP = 999999;

function dummyAttack(p, data) {
  if (!data || typeof data !== "object") return;
  if (isInFight(p)) {
    notice(p, "You can't train during a battle.");
    return;
  }
  const col = parseInt(data.col, 10);
  const row = parseInt(data.row, 10);
  if (!Number.isInteger(col) || !Number.isInteger(row) || !ctx.isDummyAt(p.layer, col, row)) {
    notice(p, "There is no dummy there.");
    return;
  }
  const now = Date.now();
  if (p._dummyAt && now - p._dummyAt < DUMMY_COOLDOWN_MS) return;
  const sheet = p._sheet || {};
  const moveIdx = parseInt(data.move, 10);
  const moveRaw = Array.isArray(sheet.moves) ? sheet.moves[moveIdx] : null;
  const moveName = moveRaw ? (typeof moveRaw === "string" ? moveRaw : moveRaw.name) : null;
  if (!moveName) {
    notice(p, "Pick one of your moves.");
    return;
  }
  if (moveRaw && moveRaw.name && moveRaw.data) registerMove(moveRaw.name, moveRaw.data);
  if (UNSUPPORTED_MOVES[moveName]) {
    notice(p, `${moveName} can't be used in the open world yet.`);
    return;
  }
  const md = engine.getMoveData(moveName);
  if (!md) {
    notice(p, "That move has no data.");
    return;
  }
  const targetKind = md.target || "enemy";
  if (targetKind === "self" || targetKind === "all-allies" || targetKind === "ally") {
    notice(p, `${moveName} can't be used on a dummy.`);
    return;
  }
  const dist = chebyshev(p.col, p.row, col, row);
  if (dist > rangeOf(md)) {
    notice(p, `The dummy is out of range for ${moveName} (${dist} tiles, range ${rangeOf(md)}).`);
    return;
  }
  p._dummyAt = now;
  const dc = col - p.col;
  const dr = row - p.row;
  if (dc !== 0 || dr !== 0) {
    p.direction = Math.abs(dc) >= Math.abs(dr) ? (dc > 0 ? "right" : "left") : (dr > 0 ? "down" : "up");
    ctx.broadcastFacing(p);
  }
  const attacker = buildPlayerCombatant(p);
  attacker.mp = attacker.maxMp;
  attacker.energy = 0;
  const dummy = engine.makeWildPokemon(DUMMY_SPECIES, DUMMY_LEVEL);
  dummy.name = "Dummy";
  dummy.maxHp = DUMMY_HP;
  dummy.hp = DUMMY_HP;
  dummy.energy = 0;
  const result = engine.applyMove(attacker, dummy, moveName);
  const damage = Math.max(0, DUMMY_HP - dummy.hp);
  const lines = Array.isArray(result.log) ? result.log.slice(0, 8) : [];
  ctx.sendPlayer(p, { type: "dummy_result", col: col, row: row, move: moveName, damage: damage, lines: lines });
  const hit = { type: "dummy_hit", col: col, row: row, damage: damage, by: p.name, move: moveName };
  for (const id in ctx.worldSession.players) {
    const q = ctx.worldSession.players[id];
    if (q.id !== p.id && ctx.cellInView(q, p.layer, col, row)) ctx.sendPlayer(q, hit);
  }
  ctx.sendPlayer(p, hit);
}

function startDuel(p, data) {
  if (!data || typeof data !== "object") return;
  if (p._fight && fights[p._fight]) {
    notice(p, "You are already in a battle.");
    return;
  }
  if (p.hp <= 0) return;
  if (p._noFightUntil && Date.now() < p._noFightUntil) {
    notice(p, "You can't start a fight right now.");
    return;
  }
  const sheet = p._sheet || {};
  const moveIdx = parseInt(data.move, 10);
  const moveRaw = Array.isArray(sheet.moves) ? sheet.moves[moveIdx] : null;
  const moveName = moveRaw ? (typeof moveRaw === "string" ? moveRaw : moveRaw.name) : null;
  if (!moveName) {
    notice(p, "Pick one of your moves.");
    return;
  }
  if (moveRaw && moveRaw.name && moveRaw.data) registerMove(moveRaw.name, moveRaw.data);
  if (UNSUPPORTED_MOVES[moveName]) {
    notice(p, `${moveName} can't be used in the open world yet.`);
    return;
  }
  const md = engine.getMoveData(moveName);
  if (!md) {
    notice(p, "That move has no data.");
    return;
  }
  const targetKind = md.target || "enemy";
  if (targetKind === "self" || targetKind === "all-allies" || targetKind === "ally") {
    notice(p, `${moveName} can't be used to start a fight.`);
    return;
  }
  const cost = md.mpCost || 0;
  if (p.mp < cost) {
    notice(p, `Not enough MP for ${moveName}.`);
    return;
  }
  let targetRef = null;
  let targetIsPlayer = false;
  if (data.targetType === "player") {
    targetRef = ctx.worldSession.players[String(data.id)] || null;
    targetIsPlayer = true;
    if (!targetRef || targetRef.id === p.id || targetRef.layer !== p.layer || targetRef.kind === "companion") {
      notice(p, "That player isn't there.");
      return;
    }
    if (targetRef.hp <= 0) {
      notice(p, `${targetRef.name} can't fight right now.`);
      return;
    }
    if (targetRef._fight && fights[targetRef._fight]) {
      notice(p, `${targetRef.name} is already in a battle.`);
      return;
    }
    if (targetRef._noFightUntil && Date.now() < targetRef._noFightUntil) {
      notice(p, `${targetRef.name} just finished a battle and can't be challenged yet.`);
      return;
    }
  } else {
    targetRef = ctx.entities[String(data.id)] || null;
    if (!targetRef || targetRef.kind !== "npc" || targetRef.layer !== p.layer) {
      notice(p, "That target isn't there.");
      return;
    }
    if (targetRef.fainted) {
      notice(p, `${targetRef.name} has already fainted.`);
      return;
    }
    if (targetRef._fight && fights[targetRef._fight]) {
      notice(p, `${targetRef.name} is already in a battle.`);
      return;
    }
  }
  const dist = chebyshev(p.col, p.row, targetRef.col, targetRef.row);
  if (dist > rangeOf(md)) {
    notice(p, `${targetRef.name} is out of range for ${moveName} (${dist} tiles, range ${rangeOf(md)}).`);
    return;
  }
  const f = { id: nextFightId, layer: p.layer, actors: {}, turnActor: null, timer: null, busy: false, ended: false, log: [], turnToken: 0, duel: true, forceFirst: null };
  nextFightId = nextFightId + 1;
  fights[f.id] = f;
  const attacker = addActor(f, "player", p, "players");
  let defender = null;
  if (targetIsPlayer) {
    defender = addActor(f, "player", targetRef, "enemies");
    sendStart(f, targetRef);
  } else {
    defender = addActor(f, "enemy", targetRef, "enemies");
    ctx.broadcastEntity(targetRef, targetRef.layer, targetRef.col, targetRef.row);
  }
  sendStart(f, p);
  expand(f);
  f.forceFirst = attacker;
  pushLog(f, `${attacker.c.name} challenged ${defender.c.name}! Battle start!`);
  emitState(f);
  schedule(f, 700, () => {
    nextTurn(f);
    if (f.ended || f.turnActor !== attacker) return;
    const combatIdx = attacker.c.moves.indexOf(moveName);
    handleAttack(f, attacker, { move: combatIdx, target: defender.id });
  });
}

function schedule(f, ms, fn) {
  if (f.timer) clearTimeout(f.timer);
  f.timer = setTimeout(() => {
    f.timer = null;
    if (f.ended) return;
    try {
      fn();
    } catch (err) {
      console.error("[worldCombat] fight crashed:", err);
      endFight(f, "error");
    }
  }, ms);
}

function checkEnd(f) {
  const players = livingSide(f, "players");
  const enemies = livingSide(f, "enemies");
  if (enemies.length === 0) {
    endFight(f, "win");
    return true;
  }
  if (players.length === 0) {
    endFight(f, "lose");
    return true;
  }
  return false;
}

function settleAfterLeave(f) {
  if (livingOfKind(f, "player").length === 0) {
    endFight(f, "fled");
    return true;
  }
  return checkEnd(f);
}

function releaseAllies(f, ownerRef) {
  for (const id in f.actors) {
    const B = f.actors[id];
    if (B.kind !== "ally" || B.gone || B.ref.ownerPlayerId !== ownerRef.id) continue;
    B.gone = true;
    syncPlayerVitals(B);
    B.ref._fight = null;
    ctx.queueCompanionSave(B.ref, false);
  }
}

function releasePlayer(f, A, cooldownMs) {
  A.gone = true;
  syncPlayerVitals(A);
  A.ref._fight = null;
  A.ref._noFightUntil = Date.now() + cooldownMs;
  releaseAllies(f, A.ref);
}

function defeatPlayer(f, A) {
  const p = A.ref;
  A.gone = true;
  p._fight = null;
  releaseAllies(f, p);
  p._noFightUntil = Date.now() + DEFEAT_COOLDOWN_MS;
  p._sheet.ailments = [];
  p.hp = Math.max(1, Math.floor(p.maxHp * DEFEAT_HP_PERCENT / 100));
  ctx.sendPlayer(p, { type: "c_end", fight: f.id, result: "defeat", hp: p.hp, mp: p.mp });
  const spawn = ctx.layerSpawn(p.layer);
  ctx.teleportPlayer(p, p.layer, spawn.col, spawn.row);
  ctx.sendGms(null, { type: "gm_player", player: ctx.publicPlayer(p) });
}

function downEnemy(f, A) {
  const e = A.ref;
  e._fight = null;
  e.state = "idle";
  if (e.kind === "npc") {
    e.fainted = true;
    e.faintUntil = Date.now() + NPC_FAINT_MS;
    e.hp = 0;
    ctx.broadcastEntity(e, e.layer, e.col, e.row);
    ctx.scheduleEntitySave();
    return;
  }
  if (ctx.queueEnemyRespawn) ctx.queueEnemyRespawn(e);
  const loot = Array.isArray(e.loot) ? e.loot.filter((stack) => stack && stack.count > 0) : [];
  if (!e.boss && loot.length > 0) {
    e.kind = "corpse";
    e.loot = loot;
    e.hp = 0;
    ctx.broadcastEntity(e, e.layer, e.col, e.row);
    ctx.scheduleEntitySave();
    setTimeout(() => {
      if (ctx.entities[e.id] === e) ctx.broadcastEntity(e, e.layer, e.col, e.row);
    }, 900);
    return;
  }
  ctx.removeEntity(e.id);
}

function resetEnemy(A) {
  const e = A.ref;
  e._fight = null;
  e.state = "idle";
  ctx.broadcastEntity(e, e.layer, e.col, e.row);
}

function endFight(f, result) {
  if (f.ended) return;
  f.ended = true;
  if (f.timer) {
    clearTimeout(f.timer);
    f.timer = null;
  }
  delete fights[f.id];
  const kills = [];
  const gains = { exp: 0, coins: 0 };
  if (result === "win") {
    for (const id in f.actors) {
      const E = f.actors[id];
      if (E.kind === "enemy" && sideOf(E) === "enemies" && E.c.hp <= 0) kills.push({ species: E.c.species || E.c.name, level: E.c.level });
    }
    for (const k of kills) {
      gains.exp += k.level * 12;
      gains.coins += k.level * 3;
    }
  }
  for (const id in f.actors) {
    const A = f.actors[id];
    if (A.kind === "enemy") {
      if (A.c.hp <= 0) downEnemy(f, A);
      else resetEnemy(A);
    } else if (A.kind === "ally") {
      if (A.gone) continue;
      syncPlayerVitals(A);
      A.ref._fight = null;
      if (A.c.hp <= 0) {
        A.ref.hp = Math.max(1, Math.floor(A.ref.maxHp * DEFEAT_HP_PERCENT / 100));
        A.ref._sheet.ailments = [];
      }
      if (kills.length > 0) A.ref._kills = A.ref._kills.concat(kills);
      ctx.queueCompanionSave(A.ref, false);
    } else if (!A.gone) {
      syncPlayerVitals(A);
      A.ref._fight = null;
      const won = (sideOf(A) === "players" && result === "win") || (sideOf(A) === "enemies" && result === "lose");
      A.ref._noFightUntil = Date.now() + (won ? WIN_COOLDOWN_MS : FLEE_COOLDOWN_MS);
      if (A.c.hp <= 0) {
        A.gone = false;
        defeatPlayer(f, A);
      } else {
        const earns = sideOf(A) === "players";
        if (earns && kills.length > 0) A.ref._kills = A.ref._kills.concat(kills);
        ctx.sendPlayer(A.ref, { type: "c_end", fight: f.id, result: won ? "win" : "over", hp: A.ref.hp, mp: A.ref.mp, exp: earns ? gains.exp : 0, coins: earns ? gains.coins : 0 });
        ctx.sendGms(null, { type: "gm_player", player: ctx.publicPlayer(A.ref) });
        if (earns && kills.length > 0) ctx.queueWorldSave(A.ref, false);
        else if (!earns) ctx.queueWorldSave(A.ref, false);
      }
    }
  }
  ctx.sendGms(f.layer, { type: "c_end", fight: f.id, result: result });
}

function tryAutoRevive(A) {
  if (A.c.hp > 0) return null;
  const inv = invOf(A.ref);
  const norm = (n) => String(n).toLowerCase().replace(/\s+/g, "");
  const relicLocked = A.kind === "enemy" && A.relicRevived;
  if (!relicLocked && inv.some((s) => s && norm(s.name) === "theshade")) {
    A.relicRevived = true;
    A.c.hp = A.c.maxHp;
    engine.clearAilmentsKeepToxin(A.c);
    return `The Shade prevents ${A.c.name} from fainting and forced them back up again!`;
  }
  if (!relicLocked && inv.some((s) => s && norm(s.name) === "shadeling")) {
    A.relicRevived = true;
    A.c.hp = Math.min(1, A.c.maxHp);
    engine.clearAilmentsKeepToxin(A.c);
    return `The Shadeling clings to ${A.c.name} and refuses to let them fall | they cling on with 1 HP!`;
  }
  for (const slot of inv) {
    if (!slot || !battleItems.reviveInfoFor(slot.name)) continue;
    const seed = slot.name;
    const amount = battleItems.reviveAmount(battleItems.reviveInfoFor(seed), A.c.maxHp);
    A.c.hp = amount;
    engine.clearAilmentsKeepToxin(A.c);
    removeOneFromInventory(A.ref, seed);
    if (A.kind === "player") ctx.sendPlayer(A.ref, { type: "itemused", name: seed, consumed: true });
    return `${A.c.name}'s ${seed} activated! It sprang back with ${amount} HP!`;
  }
  return null;
}

function removeFainted(f) {
  const lines = [];
  for (const id in f.actors) {
    const A = f.actors[id];
    if (A.gone || A.c.hp > 0 || A.fainted) continue;
    const revived = tryAutoRevive(A);
    if (revived) {
      lines.push(revived);
      continue;
    }
    A.fainted = true;
    const already = f.log.slice(-8).some((line) => line.indexOf(A.c.name + " fainted") !== -1);
    if (!already) lines.push(`${A.c.name} fainted!`);
  }
  if (lines.length) pushLog(f, lines);
  for (const id in f.actors) {
    const A = f.actors[id];
    if (A.kind === "player" && !A.gone && A.c.hp <= 0) defeatPlayer(f, A);
  }
}

function nextTurn(f) {
  if (f.ended) return;
  removeFainted(f);
  if (checkEnd(f)) return;
  expand(f);
  const living = livingActors(f);
  let A = null;
  if (f.forceFirst && !f.forceFirst.gone && f.forceFirst.c.hp > 0) {
    A = f.forceFirst;
    f.forceFirst = null;
  } else {
    f.forceFirst = null;
    const picked = engine.nextActorMulti(living.map((C) => C.c));
    if (!picked) {
      endFight(f, "error");
      return;
    }
    for (const cand of living) {
      if (cand.c === picked) A = cand;
    }
  }
  if (!A) {
    endFight(f, "error");
    return;
  }
  f.turnActor = A;
  f.turnToken = f.turnToken + 1;
  A.steps = MOVE_STEPS;
  A.c.protected = false;
  A.acted = false;

  const act = engine.canAct(A.c);
  if (!act.canAct) {
    const tick = tickAllActors(f);
    pushLog(f, [act.reason].concat(tick));
    syncAllVitals(f);
    emitState(f);
    schedule(f, 1100, () => finishTurn(f, A, true));
    return;
  }
  if (act.reason) pushLog(f, act.reason);

  emitState(f);
  if (A.kind === "player") {
    ctx.sendPlayer(A.ref, { type: "c_turn", fight: f.id, token: f.turnToken, steps: A.steps, ms: PLAYER_TURN_MS, moves: A.c.moves.map(moveInfo), mp: A.c.mp, maxMp: A.c.maxMp });
    ctx.sendGms(f.layer, { type: "c_turn", fight: f.id, actor: A.id });
    const token = f.turnToken;
    schedule(f, PLAYER_TURN_MS, () => {
      if (f.turnToken !== token || f.busy) return;
      pushLog(f, `${A.c.name} hesitated and lost its turn.`);
      finishTurn(f, A, false);
    });
  } else {
    ctx.sendGms(f.layer, { type: "c_turn", fight: f.id, actor: A.id });
    if (A.kind === "ally") schedule(f, ENEMY_THINK_MS, () => runAllyTurn(f, A));
    else schedule(f, ENEMY_THINK_MS, () => runEnemyTurn(f, A));
  }
}

function tickAllActors(f) {
  const all = livingActors(f).map((A) => A.c);
  const out = [];
  for (const c of all) {
    if (!c || c.hp <= 0) continue;
    const t = engine.tickAilments(c);
    if (t.log && t.log.length) out.push(...t.log);
  }
  return out;
}

function syncAllVitals(f) {
  for (const id in f.actors) syncPlayerVitals(f.actors[id]);
}

function finishTurn(f, A, skipTicks) {
  if (f.ended) return;
  const lines = [];
  if (A.c.hp > 0 && !skipTicks) {
    lines.push(...tickAllActors(f));
  }
  if (A.kind === "player") worldItems.tickCooldowns(A.ref._sheet);
  if (A.c.hp > 0) {
    const stageMsg = engine.tickStages(A.c);
    if (stageMsg) lines.push(stageMsg);
    const scr = engine.tickScreens(A.c);
    if (scr) lines.push(scr);
    const cradle = engine.tickCradle(A.c);
    if (cradle) lines.push(cradle);
    const fld = engine.tickField(A.c);
    if (fld) lines.push(fld);
    A.c.lastHitBy = null;
  }
  if (lines.length) pushLog(f, lines);
  syncAllVitals(f);
  emitState(f);
  f.turnActor = null;
  schedule(f, BETWEEN_TURNS_MS, () => nextTurn(f));
}

function teamOf(f, A) {
  return livingSide(f, sideOf(A));
}

function foesOf(f, A) {
  return livingSide(f, sideOf(A) === "players" ? "enemies" : "players");
}

function animKind(md) {
  const target = md.target || "enemy";
  if (target === "self" || target === "all-allies") return "self";
  if (rangeOf(md) <= MELEE_RANGE) return "melee";
  return "ranged";
}

function resolveRest(f, A) {
  const c = A.c;
  if (c.usesEnergy) return `${c.name} rests, but gains no Energy from it.`;
  const restAmount = c.hasClarityTransfusion ? 20 : 10;
  const gain = Math.min(restAmount, c.maxMp - c.mp);
  c.mp = Math.min(c.maxMp, c.mp + restAmount);
  return `${c.name} rested and recovered ${gain} MP.`;
}

function runMove(f, A, moveName, T) {
  const md = engine.getMoveData(moveName);
  const own = teamOf(f, A);
  const targetType = (md && md.target) || "enemy";
  let target = T;
  if (targetType === "self" || targetType === "all-allies") target = A;
  if (!target) target = A;

  let atkTarget = target;
  const preLog = [];
  if (md && targetType === "enemy" && engine.hasAilment(A.c, "corruption") && atkTarget.c.hp > 0) {
    const pool = own.filter((o) => o !== A);
    if (pool.length > 0 && Math.random() * 100 < 50) {
      const redirected = pool[Math.floor(Math.random() * pool.length)];
      preLog.push(`${A.c.name}'s corruption twists its aim | it strikes ${redirected.c.name} instead!`);
      atkTarget = redirected;
    }
  }
  if (md && targetType === "enemy" && atkTarget.c.hp > 0) {
    const foes = foesOf(f, A);
    const patsy = foes.find((m) => m !== atkTarget && m.c.hasPatsyBand);
    if (patsy && Math.random() < 0.2) {
      preLog.push(`${patsy.c.name}'s Patsy Band pulls the attack onto itself!`);
      atkTarget = patsy;
    }
  }

  const before = {};
  for (const id in f.actors) {
    const X = f.actors[id];
    before[id] = { hp: X.c.hp, mp: X.c.mp };
  }

  const result = engine.applyMove(A.c, atkTarget.c, moveName);
  const lines = preLog.concat(result.log || []);

  if (md && md.screen) {
    const st = md.screenTurns || 5;
    for (const mate of own.filter((m) => m !== A)) {
      if (!mate.c.screens) mate.c.screens = { reflect: 0, lightScreen: 0, auroraVeil: 0, corruptedScreen: 0 };
      mate.c.screens[md.screen] = st;
    }
  }
  const everyone = livingActors(f);
  if (md && md.weather) for (const X of everyone) X.c.weather = { kind: md.weather, turns: md.weatherTurns || 5 };
  if (md && md.terrain) for (const X of everyone) X.c.terrain = { kind: md.terrain, turns: md.terrainTurns || 5 };
  if (md && md.tailwind) for (const mate of own) mate.c.tailwind = md.tailwindTurns || 4;
  if (md && md.haze) for (const X of everyone) X.c.stages = { attack: 0, defense: 0, spAtk: 0, spDef: 0, speed: 0 };
  if (md && targetType === "all-allies") {
    for (const mate of own.filter((m) => m !== A)) {
      const extra = engine.applySupportToAlly(mate.c, moveName, A.c);
      if (extra) lines.push(extra);
    }
  }

  const changes = [];
  for (const id in f.actors) {
    const X = f.actors[id];
    const b = before[id];
    if (!b) continue;
    if (X.c.hp !== b.hp || X.c.mp !== b.mp) {
      changes.push({ id: X.id, hp: Math.max(0, X.c.hp), mp: Math.max(0, X.c.mp), dhp: X.c.hp - b.hp });
    }
  }
  return { lines: lines, changes: changes, target: atkTarget, md: md };
}

function performAction(f, A, kind, moveName, T) {
  f.busy = true;
  if (f.timer) {
    clearTimeout(f.timer);
    f.timer = null;
  }
  A.acted = true;
  let lines = [];
  let changes = [];
  let animTarget = null;
  let md = null;
  if (kind === "rest") {
    lines = [resolveRest(f, A)];
    changes = [{ id: A.id, hp: A.c.hp, mp: A.c.mp, dhp: 0 }];
  } else {
    const out = runMove(f, A, moveName, T);
    lines = out.lines;
    changes = out.changes;
    animTarget = out.target;
    md = out.md;
  }
  syncAllVitals(f);
  const payload = {
    type: "c_act",
    fight: f.id,
    actor: A.id,
    target: animTarget ? animTarget.id : A.id,
    kind: kind,
    move: moveName || null,
    moveType: md ? md.type : null,
    category: md ? md.category : null,
    anim: md ? animKind(md) : "self",
    lines: lines,
    changes: changes,
    ms: ACTION_MS
  };
  for (const line of lines) f.log.push(line);
  while (f.log.length > LOG_KEEP) f.log.shift();
  emit(f, payload);
  schedule(f, ACTION_MS, () => {
    f.busy = false;
    emitState(f);
    finishTurn(f, A, false);
  });
}

function stepToward(f, A, T) {
  const e = A.ref;
  let best = null;
  let bestScore = Infinity;
  const startDist = actorDistance(A, T);
  const names = Object.keys(ctx.DELTAS);
  for (const name of names) {
    const d = ctx.DELTAS[name];
    const nc = e.col + d.dc;
    const nr = e.row + d.dr;
    if (!ctx.isWalkable(e.layer, nc, nr)) continue;
    if (ctx.entityAt(e.layer, nc, nr, e.id)) continue;
    if (ctx.playerAt(e.layer, nc, nr)) continue;
    const dist = chebyshev(nc, nr, T.ref.col, T.ref.row);
    if (dist >= startDist) continue;
    const euclid = (nc - T.ref.col) * (nc - T.ref.col) + (nr - T.ref.row) * (nr - T.ref.row);
    const score = dist * 1000 + euclid + Math.random() * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = { name: name, col: nc, row: nr };
    }
  }
  if (!best) return false;
  const oldCol = e.col;
  const oldRow = e.row;
  e.col = best.col;
  e.row = best.row;
  e.direction = best.name;
  ctx.broadcastEntity(e, e.layer, oldCol, oldRow);
  emit(f, { type: "c_pos", id: e.id, kind: A.kind, col: e.col, row: e.row, direction: e.direction });
  return true;
}

function faceToward(A, T) {
  const dc = Math.sign(T.ref.col - A.ref.col);
  const dr = Math.sign(T.ref.row - A.ref.row);
  for (const name in ctx.DELTAS) {
    const d = ctx.DELTAS[name];
    if (d.dc === dc && d.dr === dr) {
      A.ref.direction = name;
      return;
    }
  }
}

function nearestFoe(f, A) {
  const foes = foesOf(f, A);
  let best = null;
  let bestDist = Infinity;
  for (const X of foes) {
    const dist = actorDistance(A, X);
    if (dist < bestDist || (dist === bestDist && Math.random() < 0.5)) {
      bestDist = dist;
      best = X;
    }
  }
  return best;
}

function affordableMoves(A) {
  return A.c.moves.filter((m) => {
    if (UNSUPPORTED_MOVES[m]) return false;
    const d = engine.getMoveData(m);
    if (!d) return false;
    let cost = d.mpCost || 0;
    if (A.c.hasDietRibbon) cost = Math.max(0, cost - 1);
    if (A.c.mp < cost) return false;
    if (getMoveRestriction(A.c, null, m, d.category, A.c.lastMoveUsed)) return false;
    return true;
  });
}

function runEnemyTurn(f, A) {
  const T = nearestFoe(f, A);
  if (!T) {
    finishTurn(f, A, false);
    return;
  }
  const pool = affordableMoves(A);
  if (pool.length === 0) {
    performAction(f, A, "rest", null, null);
    return;
  }
  let chosen = engine.pickAiMove(Object.assign({}, A.c, { moves: pool }));
  if (!chosen || pool.indexOf(chosen) === -1) chosen = pool[Math.floor(Math.random() * pool.length)];

  const walk = () => {
    if (f.ended) return;
    const dist = actorDistance(A, T);
    const need = rangeOf(engine.getMoveData(chosen));
    if (need === 0 || dist <= need) {
      faceToward(A, T);
      performAction(f, A, "move", chosen, need === 0 ? A : T);
      return;
    }
    if (A.steps > 0 && stepToward(f, A, T)) {
      A.steps = A.steps - 1;
      schedule(f, ENEMY_STEP_MS, walk);
      return;
    }
    const alt = pool.filter((m) => {
      const r = rangeOf(engine.getMoveData(m));
      return r === 0 || r >= dist;
    });
    if (alt.length > 0) {
      chosen = alt[Math.floor(Math.random() * alt.length)];
      faceToward(A, T);
      const r = rangeOf(engine.getMoveData(chosen));
      performAction(f, A, "move", chosen, r === 0 ? A : T);
      return;
    }
    finishTurn(f, A, false);
  };
  walk();
}


function hitCount(md) {
  if (Array.isArray(md.multihit)) return (md.multihit[0] + md.multihit[1]) / 2;
  if (typeof md.multihit === "number") return md.multihit;
  return 1;
}

function effectList(md) {
  const list = [];
  if (md.effect) list.push(md.effect);
  if (Array.isArray(md.effects)) {
    for (const e of md.effects) list.push(e);
  }
  return list;
}

function offenseCounts(A) {
  let physical = 0;
  let special = 0;
  for (const m of A.c.moves) {
    const d = engine.getMoveData(m);
    if (!d || !(d.power > 0)) continue;
    if (d.category === "physical") physical++;
    else if (d.category === "special") special++;
  }
  return { physical: physical, special: special };
}

function buffValue(A, ef) {
  const stage = (A.c.stages && A.c.stages[ef.stat]) || 0;
  if (stage >= 3) return 0;
  const counts = offenseCounts(A);
  let relevance = 1;
  if (ef.stat === "attack") relevance = counts.physical > 0 ? 1.25 : 0.2;
  else if (ef.stat === "spAtk") relevance = counts.special > 0 ? 1.25 : 0.2;
  let value = (22 + 8 * Math.min(ef.stages, 3)) * relevance - stage * 10;
  if (A.c.hp / A.c.maxHp < 0.35) value = value * 0.4;
  return Math.max(0, value);
}

function scoreOnEnemy(f, A, moveName, md, T) {
  const accuracy = Math.min(1, (md.accuracy || 100) / 100);
  const selfFrac = A.c.hp / A.c.maxHp;
  const damaging = md.power > 0 || md.fixedDamage || md.ohko;
  if (damaging) {
    const calc = engine.calcDamage(A.c, T.c, moveName);
    if (md.power > 0 && calc.effectiveness === 0) return null;
    let est = calc.damage * hitCount(md);
    if (md.ohko) est = T.c.hp;
    else if (typeof md.fixedDamage === "number") est = md.fixedDamage;
    else if (md.fixedDamage === "level") est = A.c.level;
    else if (md.fixedDamage === "halfTarget") est = Math.floor(T.c.hp / 2);
    else if (md.fixedDamage === "userHp") est = A.c.hp;
    let score = Math.min(1, est / Math.max(1, T.c.hp)) * 100 * accuracy;
    if (est >= T.c.hp) score += 45;
    score += 12 * (1 - T.c.hp / T.c.maxHp);
    if (md.recoil) score -= md.recoil * 0.3;
    if (md.recharge) score -= 18;
    if (md.userFaints && selfFrac > 0.25) score -= 200;
    if (md.drain && selfFrac < 0.6) score += 12;
    for (const ef of effectList(md)) {
      if ((ef.chance || 0) > 0) score += Math.min(10, ef.chance * 0.1);
    }
    return score;
  }
  let score = 0;
  let recognised = false;
  for (const ef of effectList(md)) {
    const chance = (ef.chance === undefined ? 100 : ef.chance) / 100;
    if (ef.status) {
      recognised = true;
      if (engine.isImmuneTo(T.c, ef.status)) continue;
      if (engine.hasAilment(T.c, ef.status)) continue;
      const busy = Array.isArray(T.c.ailments) && T.c.ailments.length > 0;
      score += 40 * chance * (busy ? 0.3 : 1);
    } else if (ef.stat && ef.target === "enemy" && ef.stages < 0) {
      recognised = true;
      const stage = (T.c.stages && T.c.stages[ef.stat]) || 0;
      if (stage <= -2) continue;
      score += 24 * Math.min(2, Math.abs(ef.stages)) * chance;
    } else if (ef.stat && ef.target === "self" && ef.stages > 0) {
      recognised = true;
      score += buffValue(A, ef) * chance;
    }
  }
  if (md.leechSeed) {
    recognised = true;
    if (!T.c.leechSeededBy) score += 28;
  }
  if (md.restrict) {
    recognised = true;
    score += 10;
  }
  if (!recognised) score = 5;
  return score * accuracy;
}

function scoreOnSelf(f, A, moveName, md) {
  const selfFrac = A.c.hp / A.c.maxHp;
  const foes = foesOf(f, A);
  if (md.healSelf) {
    if (!engine.canHeal(A.c)) return null;
    const need = 1 - selfFrac;
    if (need < 0.35) return null;
    return need * 115 + (selfFrac < 0.2 ? 30 : 0);
  }
  if (md.protect) {
    if (A.c.lastMoveUsed && (engine.getMoveData(A.c.lastMoveUsed) || {}).protect) return null;
    if (selfFrac < 0.4 && foes.length > 0) return 36;
    return null;
  }
  let score = 0;
  let recognised = false;
  for (const ef of effectList(md)) {
    if (ef.stat && ef.stages > 0 && (ef.target === "self" || ef.target === undefined)) {
      recognised = true;
      score += buffValue(A, ef);
    }
  }
  if (md.weather || md.terrain) {
    recognised = true;
    const kind = md.weather || md.terrain;
    const current = md.weather ? A.c.weather : A.c.terrain;
    if (current && current.kind === kind) return null;
    let synergy = 0;
    for (const m of A.c.moves) {
      const d = engine.getMoveData(m);
      if (!d || !(d.power > 0)) continue;
      if (kind === "rain" && d.type === "Water") synergy += 8;
      if (kind === "sun" && d.type === "Fire") synergy += 8;
    }
    score += 12 + synergy;
  }
  if (md.aquaRing) {
    recognised = true;
    if (!A.c.aquaRing) score += 22;
  }
  if (!recognised) score = 6;
  return score;
}

function scoreOnAlly(f, A, moveName, md, T) {
  const support = SUPPORT_EFFECTS[moveName];
  const need = 1 - T.c.hp / T.c.maxHp;
  if (support && support.kind === "heal") {
    if (!engine.canHeal(T.c)) return null;
    if (need < 0.3) return null;
    return need * 105;
  }
  if (support && support.kind === "cure") {
    const count = Array.isArray(T.c.ailments) ? T.c.ailments.length : 0;
    return count > 0 ? 55 : null;
  }
  if (support && support.kind === "boost") return 18;
  return 6;
}

function scoreOnTeam(f, A, moveName, md) {
  const support = SUPPORT_EFFECTS[moveName];
  const team = teamOf(f, A);
  if (support && support.kind === "cure") {
    let count = 0;
    for (const m of team) count += Array.isArray(m.c.ailments) && m.c.ailments.length > 0 ? 1 : 0;
    return count > 0 ? 45 + 12 * count : null;
  }
  if (support && support.kind === "heal") {
    let missing = 0;
    for (const m of team) missing += 1 - m.c.hp / m.c.maxHp;
    const avg = missing / Math.max(1, team.length);
    if (avg < 0.25) return null;
    return avg * 100 * Math.min(2, team.length * 0.7);
  }
  if (md.screen) {
    let uncovered = 0;
    for (const m of team) {
      if (!m.c.screens || !(m.c.screens[md.screen] > 0)) uncovered++;
    }
    return uncovered > 0 ? 34 : null;
  }
  let score = 0;
  let recognised = false;
  for (const ef of effectList(md)) {
    if (ef.stat && ef.stages > 0) {
      recognised = true;
      score += buffValue(A, ef) * 0.8 * Math.min(3, team.length);
    }
  }
  if (!recognised) score = 6;
  return score;
}

function planAlly(f, A) {
  const options = [];
  const team = teamOf(f, A);
  const foes = foesOf(f, A);
  for (const moveName of affordableMoves(A)) {
    const md = engine.getMoveData(moveName);
    const targetType = md.target || "enemy";
    const range = rangeOf(md);
    const candidates = [];
    if (targetType === "enemy") {
      for (const T of foes) candidates.push({ T: T, score: scoreOnEnemy(f, A, moveName, md, T) });
    } else if (targetType === "self") {
      candidates.push({ T: A, score: scoreOnSelf(f, A, moveName, md) });
    } else if (targetType === "all-allies") {
      candidates.push({ T: A, score: scoreOnTeam(f, A, moveName, md) });
    } else if (targetType === "ally") {
      for (const T of team) {
        if (T === A) continue;
        candidates.push({ T: T, score: scoreOnAlly(f, A, moveName, md, T) });
      }
    }
    for (const cand of candidates) {
      if (cand.score === null || cand.score === undefined) continue;
      const dist = cand.T === A ? 0 : actorDistance(A, cand.T);
      const gap = Math.max(0, dist - range);
      const reachable = gap <= A.steps;
      let score = cand.score - (md.mpCost || 0) * 1.2 + Math.random() * 3;
      if (!reachable) score -= 6 + 5 * gap;
      options.push({ moveName: moveName, T: cand.T, score: score, reachable: reachable, range: range, self: cand.T === A });
    }
  }
  options.sort((a, b) => b.score - a.score);
  return options;
}

function walkThenAct(f, A, moveName, T, selfCast, range) {
  const walk = () => {
    if (f.ended) return;
    const dist = selfCast ? 0 : actorDistance(A, T);
    if (selfCast || dist <= range) {
      if (!selfCast) faceToward(A, T);
      performAction(f, A, "move", moveName, selfCast ? A : T);
      return;
    }
    if (A.steps > 0 && stepToward(f, A, T)) {
      A.steps = A.steps - 1;
      schedule(f, ENEMY_STEP_MS, walk);
      return;
    }
    finishTurn(f, A, false);
  };
  walk();
}

function runAllyTurn(f, A) {
  const options = planAlly(f, A);
  if (options.length === 0) {
    const foe = nearestFoe(f, A);
    if (foe && A.c.mp >= A.c.maxMp) {
      const closer = () => {
        if (f.ended) return;
        if (A.steps > 0 && actorDistance(A, foe) > 1 && stepToward(f, A, foe)) {
          A.steps = A.steps - 1;
          schedule(f, ENEMY_STEP_MS, closer);
          return;
        }
        finishTurn(f, A, false);
      };
      closer();
      return;
    }
    performAction(f, A, "rest", null, null);
    return;
  }
  const best = options[0];
  let pick = best;
  if (!best.reachable) {
    const alt = options.find((o) => o.reachable && o.score > 0 && o.score >= best.score * 0.55);
    if (alt) pick = alt;
  }
  if (pick.score <= 3 && A.c.mp < A.c.maxMp * 0.6) {
    performAction(f, A, "rest", null, null);
    return;
  }
  walkThenAct(f, A, pick.moveName, pick.T, pick.self, pick.range);
}

function notice(p, text) {
  ctx.sendPlayer(p, { type: "c_notice", text: text });
}

function handleAttack(f, A, data) {
  const idx = parseInt(data.move, 10);
  const moveName = A.c.moves[idx];
  if (!moveName) {
    notice(A.ref, "That move isn't available.");
    return;
  }
  if (UNSUPPORTED_MOVES[moveName]) {
    notice(A.ref, `${moveName} can't be used in the open world yet.`);
    return;
  }
  const md = engine.getMoveData(moveName);
  if (!md) {
    notice(A.ref, "That move has no data.");
    return;
  }
  let cost = md.mpCost || 0;
  if (A.c.hasDietRibbon) cost = Math.max(0, cost - 1);
  if (A.c.mp < cost) {
    notice(A.ref, `Not enough MP for ${moveName}.`);
    return;
  }
  const restriction = getMoveRestriction(A.c, null, moveName, md.category, A.c.lastMoveUsed);
  if (restriction) {
    notice(A.ref, restriction);
    return;
  }
  const targetType = md.target || "enemy";
  let T = null;
  if (targetType === "self" || targetType === "all-allies") {
    T = A;
  } else {
    T = actorById(f, data.target);
    if (!T || T.c.hp <= 0) {
      notice(A.ref, "Pick a valid target.");
      return;
    }
    if (targetType === "ally") {
      if (sideOf(T) !== sideOf(A)) {
        notice(A.ref, "That move needs an ally as the target.");
        return;
      }
    } else if (sideOf(T) === sideOf(A)) {
      notice(A.ref, "That move needs an enemy as the target.");
      return;
    }
    const dist = actorDistance(A, T);
    if (dist > rangeOf(md)) {
      notice(A.ref, `${T.c.name} is out of range (${dist} tiles, range ${rangeOf(md)}).`);
      return;
    }
    faceToward(A, T);
    ctx.broadcastFacing(A.ref);
  }
  performAction(f, A, "move", moveName, T);
}

function invOf(ref) {
  if (Array.isArray(ref._inv)) return ref._inv;
  if (Array.isArray(ref.loot)) return ref.loot;
  return [];
}

function removeOneFromInventory(ref, name) {
  const list = invOf(ref);
  for (let i = 0; i < list.length; i++) {
    if (list[i].name !== name) continue;
    list[i].count = list[i].count - 1;
    if (list[i].count <= 0) list.splice(i, 1);
    return true;
  }
  return false;
}

function inventoryHas(ref, name) {
  for (const entry of ref._inv) {
    if (entry.name === name && entry.count > 0) return true;
  }
  return false;
}

function arenaFor(f, A) {
  return {
    foes: foesOf(f, A),
    allies: teamOf(f, A),
    pos: (X) => actorPos(X),
    direction: (X) => X.ref.direction || "down",
    sameSideAs: (X) => livingSide(f, sideOf(X))
  };
}

function handleItem(f, A, data) {
  if (A.kind !== "player") return;
  const name = String(data.name || "");
  if (!inventoryHas(A.ref, name)) {
    notice(A.ref, "You don't have that item.");
    return;
  }
  const cls = worldItems.classify(name);
  if (!cls) {
    notice(A.ref, `${name} can't be used.`);
    return;
  }
  if (cls.unsupported) {
    notice(A.ref, cls.unsupported);
    return;
  }
  const mode = data.mode === "throw" ? "throw" : "use";
  if (mode === "use" && !cls.canUse) {
    notice(A.ref, `${name} has to be thrown at a target.`);
    return;
  }
  if (mode === "throw" && !cls.canThrow) {
    notice(A.ref, `${name} can only be used on yourself.`);
    return;
  }
  if (worldItems.getCooldown(A.ref._sheet, name) > 0) {
    notice(A.ref, `${name} is on cooldown | ${worldItems.getCooldown(A.ref._sheet, name)} more turn(s).`);
    return;
  }
  if (mode === "use" && cls.cone && typeof data.dir === "string" && ctx.DELTAS[data.dir]) {
    A.ref.direction = data.dir;
    ctx.broadcastFacing(A.ref);
  }
  let T = null;
  if (mode === "throw") {
    T = actorById(f, data.target);
    if (!T || T.c.hp <= 0 || T.gone) {
      notice(A.ref, "Pick a valid target.");
      return;
    }
    const sameSide = sideOf(T) === sideOf(A);
    if (cls.rule === "enemy" && sameSide) {
      notice(A.ref, `${name} has to be thrown at an enemy.`);
      return;
    }
    if ((cls.rule === "ally" || cls.rule === "self") && !sameSide) {
      notice(A.ref, `${name} has to be thrown at an ally.`);
      return;
    }
    const dist = actorDistance(A, T);
    if (dist > worldItems.THROW_RANGE) {
      notice(A.ref, `${T.c.name} is too far to throw at (${dist} tiles, max ${worldItems.THROW_RANGE}).`);
      return;
    }
    if (T !== A) {
      faceToward(A, T);
      ctx.broadcastFacing(A.ref);
    }
  }

  const before = {};
  for (const id in f.actors) {
    const X = f.actors[id];
    before[id] = { hp: X.c.hp, mp: X.c.mp };
  }
  const res = worldItems.resolveInCombat(cls, A, mode, T, arenaFor(f, A));
  if (!res.success) {
    notice(A.ref, res.log);
    return;
  }
  if (!cls.relic) removeOneFromInventory(A.ref, name);
  if (cls.cooldown) worldItems.setCooldown(A.ref._sheet, name, cls.cooldown);
  if (cls.userMp) A.c.mp = Math.min(A.c.maxMp, A.c.mp + cls.userMp);
  ctx.sendPlayer(A.ref, { type: "itemused", name: name, consumed: !cls.relic });

  const changes = [];
  for (const id in f.actors) {
    const X = f.actors[id];
    const b = before[id];
    if (!b) continue;
    if (X.c.hp !== b.hp || X.c.mp !== b.mp) changes.push({ id: X.id, hp: Math.max(0, X.c.hp), mp: Math.max(0, X.c.mp), dhp: X.c.hp - b.hp });
  }

  f.busy = true;
  if (f.timer) {
    clearTimeout(f.timer);
    f.timer = null;
  }
  A.acted = true;
  syncAllVitals(f);
  const fireType = /blast|firebomb|bomb/i.test(name) ? "Fire" : null;
  const payload = {
    type: "c_act",
    fight: f.id,
    actor: A.id,
    target: T ? T.id : A.id,
    kind: "item",
    move: null,
    item: name,
    moveType: fireType,
    category: null,
    anim: mode === "throw" && T && T !== A ? "ranged" : "self",
    lines: [res.log],
    changes: changes,
    cone: res.cone || null,
    ms: ACTION_MS
  };
  f.log.push(res.log);
  while (f.log.length > LOG_KEEP) f.log.shift();
  emit(f, payload);
  schedule(f, ACTION_MS, () => {
    f.busy = false;
    emitState(f);
    finishTurn(f, A, false);
  });
}

function itemResult(p, ok, text) {
  ctx.sendPlayer(p, { type: "item_result", ok: ok, text: text });
}

function useItemOutside(p, data) {
  if (p._fight) {
    itemResult(p, false, "Use items from the battle menu during a fight.");
    return;
  }
  const name = String(data.name || "");
  if (!inventoryHas(p, name)) {
    itemResult(p, false, "You don't have that item.");
    return;
  }
  const cls = worldItems.classify(name);
  if (!cls) {
    itemResult(p, false, `${name} can't be used.`);
    return;
  }
  if (cls.unsupported) {
    itemResult(p, false, cls.unsupported);
    return;
  }
  if (!cls.outside) {
    itemResult(p, false, `${name} can only be used in battle.`);
    return;
  }
  const mode = data.mode === "throw" ? "throw" : "use";
  if (mode === "use" && !cls.canUse) {
    itemResult(p, false, `${name} has to be thrown at someone.`);
    return;
  }
  if (mode === "throw" && !cls.canThrow) {
    itemResult(p, false, `${name} can only be used on yourself.`);
    return;
  }
  if (worldItems.getCooldown(p._sheet, name) > 0) {
    itemResult(p, false, `${name} is on cooldown | ${worldItems.getCooldown(p._sheet, name)} more battle turn(s).`);
    return;
  }
  let targetRef = p;
  if (mode === "throw") {
    targetRef = null;
    const wanted = String(data.target === undefined || data.target === null ? "" : data.target);
    if (ctx.worldSession.players[wanted]) targetRef = ctx.worldSession.players[wanted];
    else if (ctx.entities[wanted] && ctx.entities[wanted].kind === "companion") targetRef = ctx.entities[wanted];
    if (!targetRef || targetRef.layer !== p.layer || targetRef.down) {
      itemResult(p, false, "Pick a valid target.");
      return;
    }
    if (chebyshev(p.col, p.row, targetRef.col, targetRef.row) > worldItems.THROW_RANGE) {
      itemResult(p, false, `${targetRef.name} is too far to throw at (max ${worldItems.THROW_RANGE} tiles).`);
      return;
    }
  }
  const c = buildPlayerCombatant(targetRef);
  const res = worldItems.resolveOutside(cls, name, c, p.name);
  if (!res.success) {
    itemResult(p, false, res.log);
    return;
  }
  targetRef.hp = Math.max(1, Math.min(targetRef.maxHp, c.hp));
  targetRef.mp = Math.max(0, Math.min(targetRef.maxMp, c.mp));
  targetRef._sheet.ailments = JSON.parse(JSON.stringify(c.ailments || []));
  if (!cls.relic) removeOneFromInventory(p, name);
  if (cls.cooldown) worldItems.setCooldown(p._sheet, name, cls.cooldown);
  if (cls.userMp) p.mp = Math.min(p.maxMp, p.mp + cls.userMp);
  ctx.sendPlayer(p, { type: "itemused", name: name, consumed: !cls.relic });
  const intro = mode === "throw" && targetRef !== p ? `${p.name} tossed the ${name} to ${targetRef.name}. ` : "";
  itemResult(p, true, intro + res.log);
  if (targetRef.kind !== "companion") {
    ctx.sendPlayer(targetRef, { type: "vitals", hp: targetRef.hp, mp: targetRef.mp, maxHp: targetRef.maxHp, maxMp: targetRef.maxMp });
    if (targetRef !== p) ctx.sendPlayer(targetRef, { type: "item_result", ok: true, text: `${p.name} tossed you a ${name}. ${res.log}` });
    ctx.sendGms(null, { type: "gm_player", player: ctx.publicPlayer(targetRef) });
  }
}

function handleMessage(p, data) {
  if (!data || typeof data.type !== "string" || data.type.charAt(0) !== "c") return false;
  if (data.type.indexOf("c_") !== 0) return false;
  const f = p._fight ? fights[p._fight] : null;
  if (!f) {
    notice(p, "You are not in a battle.");
    return true;
  }
  const A = actorById(f, p.id);
  if (!A) return true;

  if (data.type === "c_flee") {
    if (f.turnActor !== A || f.busy) {
      notice(p, "You can only try to flee on your turn.");
      return true;
    }
    if (f.timer) {
      clearTimeout(f.timer);
      f.timer = null;
    }
    if (Math.random() >= FLEE_CHANCE) {
      pushLog(f, `${A.c.name} tried to flee, but couldn't get away!`);
      finishTurn(f, A, false);
      return true;
    }
    pushLog(f, `${A.c.name} got away!`);
    const spot = findFleeSpot(f, p);
    releasePlayer(f, A, FLEE_COOLDOWN_MS);
    ctx.sendPlayer(p, { type: "c_end", fight: f.id, result: "fled", hp: p.hp, mp: p.mp });
    if (spot) {
      ctx.teleportPlayer(p, p.layer, spot.col, spot.row);
    } else {
      ctx.sendGms(null, { type: "gm_player", player: ctx.publicPlayer(p) });
    }
    f.turnActor = null;
    if (settleAfterLeave(f)) return true;
    emitState(f);
    schedule(f, BETWEEN_TURNS_MS, () => nextTurn(f));
    return true;
  }

  if (f.turnActor !== A || f.busy) {
    notice(p, "It isn't your turn.");
    return true;
  }

  if (data.type === "c_attack") {
    handleAttack(f, A, data);
  } else if (data.type === "c_item") {
    handleItem(f, A, data);
  } else if (data.type === "c_rest") {
    performAction(f, A, "rest", null, null);
  } else if (data.type === "c_end") {
    if (f.timer) clearTimeout(f.timer);
    pushLog(f, `${A.c.name} waits.`);
    finishTurn(f, A, false);
  }
  return true;
}

function canPlayerMove(p) {
  if (!p._fight) return { ok: true };
  const f = fights[p._fight];
  if (!f) return { ok: true };
  const A = actorById(f, p.id);
  if (!A) return { ok: true };
  if (f.turnActor !== A || f.busy) return { ok: false, reason: "It isn't your turn." };
  if (A.acted) return { ok: false, reason: "You already acted this turn." };
  if (A.steps <= 0) return { ok: false, reason: "No steps left this turn." };
  return { ok: true, fight: f, actor: A };
}

function afterPlayerMove(p) {
  if (!p._fight) return;
  const f = fights[p._fight];
  if (!f) return;
  const A = actorById(f, p.id);
  if (!A) return;
  if (f.turnActor === A) A.steps = Math.max(0, A.steps - 1);
  emit(f, { type: "c_pos", id: p.id, kind: "player", col: p.col, row: p.row, direction: p.direction });
  emit(f, { type: "c_steps", actor: p.id, steps: A.steps });
}

function onPlayerLeave(p) {
  if (!p._fight) return;
  const f = fights[p._fight];
  p._fight = null;
  if (!f) return;
  const A = f.actors[String(p.id)];
  if (!A || A.gone) return;
  syncPlayerVitals(A);
  A.gone = true;
  releaseAllies(f, p);
  pushLog(f, `${A.c.name} left the battle.`);
  if (settleAfterLeave(f)) return;
  emitState(f);
  if (f.turnActor === A) {
    if (f.timer) clearTimeout(f.timer);
    f.turnActor = null;
    f.busy = false;
    schedule(f, BETWEEN_TURNS_MS, () => nextTurn(f));
  }
}

function onEntityRemoved(e) {
  if (!e._fight) return;
  const f = fights[e._fight];
  e._fight = null;
  if (!f) return;
  const A = f.actors[String(e.id)];
  if (!A || A.gone) return;
  A.gone = true;
  pushLog(f, `${A.c.name} vanished!`);
  if (A.kind === "enemy" && livingSide(f, "enemies").length === 0) {
    endFight(f, "win");
    return;
  }
  emitState(f);
  if (f.turnActor === A) {
    if (f.timer) clearTimeout(f.timer);
    f.turnActor = null;
    f.busy = false;
    schedule(f, BETWEEN_TURNS_MS, () => nextTurn(f));
  }
}

function tick() {
  for (const id in ctx.entities) {
    const e = ctx.entities[id];
    if (e.kind !== "enemy" || e._fight || e.down) continue;
    if (e.state !== "alert") continue;
    let target = null;
    let bestDist = Infinity;
    for (const pid in ctx.worldSession.players) {
      const p = ctx.worldSession.players[pid];
      if (p.layer !== e.layer || p._fight || p.hp <= 0) continue;
      if (p._noFightUntil && Date.now() < p._noFightUntil) continue;
      const dist = chebyshev(p.col, p.row, e.col, e.row);
      if (dist <= sensorOf(e) && dist < bestDist) {
        bestDist = dist;
        target = p;
      }
    }
    if (target) startFight(e.layer, e);
  }
}

function fightOf(p) {
  return p._fight ? fights[p._fight] || null : null;
}

function isInFight(p) {
  return !!(p._fight && fights[p._fight]);
}

function shutdown() {
  for (const id of Object.keys(fights)) endFight(fights[id], "shutdown");
}

module.exports = { init, startDuel, dummyAttack, sheetMoveInfo, tick, handleMessage, canPlayerMove, afterPlayerMove, onPlayerLeave, onEntityRemoved, fightOf, isInFight, shutdown, useItemOutside, RESPAWN_MS };