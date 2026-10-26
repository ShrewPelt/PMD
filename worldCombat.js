const engine = require("./Utils/combat");
const { getMoveRestriction } = require("./Utils/Combat/applyMove");
const { effectiveSpeed } = require("./Utils/Combat/turnOrder");
const { registerMove } = require("./Utils/Combat/moveData");

const MOVE_STEPS = 3;
const PLAYER_TURN_MS = 30000;
const ENEMY_STEP_MS = 320;
const ENEMY_THINK_MS = 700;
const ACTION_MS = 1500;
const BETWEEN_TURNS_MS = 500;
const MELEE_RANGE = 1;
const RANGED_RANGE = 5;
const FLEE_COOLDOWN_MS = 20000;
const DEFEAT_COOLDOWN_MS = 12000;
const WIN_COOLDOWN_MS = 3000;
const RESPAWN_MS = 90000;
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
  return A.kind === "player" ? "players" : "enemies";
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

function publicActor(A) {
  const c = A.c;
  const ailNames = [];
  for (const a of Array.isArray(c.ailments) ? c.ailments : []) ailNames.push(a.name);
  return {
    id: A.id,
    kind: A.kind,
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
  if (A.kind !== "player") return;
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
  const c = engine.makeWildPokemon(e.species, e.level);
  c.name = e.name;
  c.energy = 0;
  return c;
}

function addActor(f, kind, ref) {
  const id = String(ref.id);
  if (f.actors[id] && !f.actors[id].gone) return f.actors[id];
  const c = kind === "player" ? buildPlayerCombatant(ref) : buildEnemyCombatant(ref);
  const A = { id: ref.id, kind: kind, ref: ref, c: c, steps: 0, gone: false };
  f.actors[id] = A;
  if (kind === "player") {
    ref._fight = f.id;
  } else {
    ref._fight = f.id;
    ref.state = "alert";
  }
  return A;
}

function actorById(f, id) {
  const A = f.actors[String(id)];
  return A && !A.gone ? A : null;
}

function sensorOf(e) {
  return typeof e.sensor === "number" ? e.sensor : 10;
}

function expand(f) {
  let changed = false;
  let grew = true;
  let guard = 0;
  while (grew && guard < 8) {
    grew = false;
    guard++;
    const enemyActors = livingOfKind(f, "enemy");
    for (const id in ctx.worldSession.players) {
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
    const playerActors = livingOfKind(f, "player");
    for (const id in ctx.entities) {
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
  const players = livingOfKind(f, "player");
  const enemies = livingOfKind(f, "enemy");
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

function releasePlayer(f, A, cooldownMs) {
  A.gone = true;
  syncPlayerVitals(A);
  A.ref._fight = null;
  A.ref._noFightUntil = Date.now() + cooldownMs;
}

function defeatPlayer(f, A) {
  const p = A.ref;
  A.gone = true;
  p._fight = null;
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
  e.down = true;
  e._downUntil = Date.now() + RESPAWN_MS;
  e.state = "idle";
  ctx.hideEntity(e);
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
  for (const id in f.actors) {
    const A = f.actors[id];
    if (A.kind === "enemy") {
      if (A.c.hp <= 0) downEnemy(f, A);
      else resetEnemy(A);
    } else if (!A.gone) {
      syncPlayerVitals(A);
      A.ref._fight = null;
      A.ref._noFightUntil = Date.now() + (result === "win" ? WIN_COOLDOWN_MS : FLEE_COOLDOWN_MS);
      if (A.c.hp <= 0) {
        A.gone = false;
        defeatPlayer(f, A);
      } else {
        ctx.sendPlayer(A.ref, { type: "c_end", fight: f.id, result: result === "win" ? "win" : "over", hp: A.ref.hp, mp: A.ref.mp });
        ctx.sendGms(null, { type: "gm_player", player: ctx.publicPlayer(A.ref) });
      }
    }
  }
  ctx.sendGms(f.layer, { type: "c_end", fight: f.id, result: result });
}

function removeFainted(f) {
  const lines = [];
  for (const id in f.actors) {
    const A = f.actors[id];
    if (A.gone || A.c.hp > 0 || A.fainted) continue;
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
  const picked = engine.nextActorMulti(living.map((A) => A.c));
  if (!picked) {
    endFight(f, "error");
    return;
  }
  let A = null;
  for (const cand of living) {
    if (cand.c === picked) A = cand;
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
    schedule(f, ENEMY_THINK_MS, () => runEnemyTurn(f, A));
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
  return livingOfKind(f, A.kind);
}

function foesOf(f, A) {
  return livingOfKind(f, A.kind === "player" ? "enemy" : "player");
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
  emit(f, { type: "c_pos", id: e.id, kind: "enemy", col: e.col, row: e.row, direction: e.direction });
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
      if (T.kind !== A.kind) {
        notice(A.ref, "That move needs an ally as the target.");
        return;
      }
    } else if (T.kind === A.kind) {
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
    if (f.busy && f.turnActor !== A) {
      notice(p, "Wait for the current action to finish.");
      return true;
    }
    const wasTurn = f.turnActor === A;
    pushLog(f, `${A.c.name} fled from battle!`);
    releasePlayer(f, A, FLEE_COOLDOWN_MS);
    ctx.sendPlayer(p, { type: "c_end", fight: f.id, result: "fled", hp: p.hp, mp: p.mp });
    ctx.sendGms(null, { type: "gm_player", player: ctx.publicPlayer(p) });
    if (livingOfKind(f, "player").length === 0) {
      endFight(f, "fled");
      return true;
    }
    emitState(f);
    if (wasTurn && !f.busy) {
      if (f.timer) clearTimeout(f.timer);
      f.turnActor = null;
      schedule(f, BETWEEN_TURNS_MS, () => nextTurn(f));
    }
    return true;
  }

  if (f.turnActor !== A || f.busy) {
    notice(p, "It isn't your turn.");
    return true;
  }

  if (data.type === "c_attack") {
    handleAttack(f, A, data);
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
  pushLog(f, `${A.c.name} left the battle.`);
  if (livingOfKind(f, "player").length === 0) {
    endFight(f, "fled");
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

function onEntityRemoved(e) {
  if (!e._fight) return;
  const f = fights[e._fight];
  e._fight = null;
  if (!f) return;
  const A = f.actors[String(e.id)];
  if (!A || A.gone) return;
  A.gone = true;
  pushLog(f, `${A.c.name} vanished!`);
  if (livingOfKind(f, "enemy").length === 0) {
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

module.exports = { init, tick, handleMessage, canPlayerMove, afterPlayerMove, onPlayerLeave, onEntityRemoved, fightOf, isInFight, shutdown, RESPAWN_MS };