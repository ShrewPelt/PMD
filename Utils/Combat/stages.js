const DEFAULT_BUFF_TURNS = 3;

function emptyStages() {
  return { attack: 0, defense: 0, spAtk: 0, spDef: 0, speed: 0, accuracy: 0, evasion: 0 };
}

function statLabel(stat) {
  const map = { attack: "Attack", defense: "Defense", spAtk: "Sp. Atk", spDef: "Sp. Def", speed: "Speed", accuracy: "Accuracy", evasion: "Evasion" };
  return map[stat] || stat;
}

function stageMultiplier(stage) {
  const s = Math.max(-6, Math.min(6, stage));
  return s >= 0 ? (2 + s) / 2 : 2 / (2 - s);
}

function effectiveStat(combatant, stat) {
  const base = combatant[stat] || 0;
  const stage = (combatant.stages && combatant.stages[stat]) || 0;
  return Math.max(1, Math.floor(base * stageMultiplier(stage)));
}

function applyStage(combatant, stat, delta, turns) {
  if (!combatant.stages) combatant.stages = emptyStages();
  if (!combatant.stageTurns) combatant.stageTurns = emptyStages();
  const before = combatant.stages[stat] || 0;
  let after = before + delta;
  if (after > 6) after = 6;
  if (after < -6) after = -6;
  combatant.stages[stat] = after;
  if (after === 0) {
    combatant.stageTurns[stat] = 0;
  } else {
    combatant.stageTurns[stat] = turns || DEFAULT_BUFF_TURNS;
  }
  return after - before;
}

function tickStages(combatant) {
  const expired = [];
  if (combatant.tauntTurns > 0) {
    combatant.tauntTurns -= 1;
    if (combatant.tauntTurns <= 0) {
      combatant.tauntTurns = 0;
      expired.push(`${combatant.name} is no longer taunted.`);
    }
  }
  if (combatant.disabledTurns > 0) {
    combatant.disabledTurns -= 1;
    if (combatant.disabledTurns <= 0) {
      combatant.disabledTurns = 0;
      expired.push(`${combatant.name}'s ${combatant.disabledMove} is no longer disabled.`);
      combatant.disabledMove = null;
    }
  }
  if (combatant.encoreTurns > 0) {
    combatant.encoreTurns -= 1;
    if (combatant.encoreTurns <= 0) {
      combatant.encoreTurns = 0;
      expired.push(`${combatant.name}'s encore ended.`);
      combatant.encoreMove = null;
    }
  }
  if (combatant.bagLocked > 0) {
    combatant.bagLocked -= 1;
    if (combatant.bagLocked <= 0) {
      combatant.bagLocked = 0;
      expired.push(`${combatant.name}'s bag is no longer corrupted.`);
    }
  }
  if (!combatant.stageTurns) return expired.length ? expired.join("\n") : null;
  for (const stat of ["attack", "defense", "spAtk", "spDef", "speed", "accuracy", "evasion"]) {
    if (combatant.stageTurns[stat] > 0) {
      combatant.stageTurns[stat] -= 1;
      if (combatant.stageTurns[stat] <= 0) {
        combatant.stageTurns[stat] = 0;
        if (combatant.stages && combatant.stages[stat] !== 0) {
          const dir = combatant.stages[stat] > 0 ? "boost" : "drop";
          expired.push(`${combatant.name}'s ${statLabel(stat)} ${dir} wore off!`);
          combatant.stages[stat] = 0;
        }
      }
    }
  }
  return expired.length ? expired.join("\n") : null;
}

module.exports = { DEFAULT_BUFF_TURNS, emptyStages, statLabel, stageMultiplier, effectiveStat, applyStage, tickStages };
