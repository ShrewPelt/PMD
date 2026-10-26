const { canHeal } = require("./ailments");
function tickScreens(combatant) {
  if (!combatant.screens) return null;
  const sc = combatant.screens;
  const gone = [];
  if (sc.reflect > 0) { sc.reflect -= 1; if (sc.reflect === 0) gone.push("Reflect"); }
  if (sc.lightScreen > 0) { sc.lightScreen -= 1; if (sc.lightScreen === 0) gone.push("Light Screen"); }
  if (sc.auroraVeil > 0) { sc.auroraVeil -= 1; if (sc.auroraVeil === 0) gone.push("Aurora Veil"); }
  if (sc.corruptedScreen > 0) { sc.corruptedScreen -= 1; if (sc.corruptedScreen === 0) gone.push("Corrupted Screen"); }
  if (gone.length) return `${combatant.name}'s ${gone.join(" and ")} wore off!`;
  return null;
}

function tickField(combatant) {
  const logs = [];
  if (combatant.weather) {
    const w = combatant.weather.kind;
    if (combatant.hp > 0 && w === "sand" && !["Rock", "Ground", "Steel"].some(t => combatant.types.includes(t))) {
      const d = Math.max(1, Math.floor(combatant.maxHp / 16));
      combatant.hp = Math.max(0, combatant.hp - d);
      logs.push(`${combatant.name} is buffeted by the sandstorm! (-${d})`);
    } else if (combatant.hp > 0 && w === "hail" && !combatant.types.includes("Ice")) {
      const d = Math.max(1, Math.floor(combatant.maxHp / 16));
      combatant.hp = Math.max(0, combatant.hp - d);
      logs.push(`${combatant.name} is pelted by hail! (-${d})`);
    }
    combatant.weather.turns -= 1;
    if (combatant.weather.turns <= 0) { logs.push("The weather cleared up."); combatant.weather = null; }
  }
  if (combatant.terrain) {
    const t = combatant.terrain.kind;
    if (combatant.hp > 0 && t === "grassy" && !combatant.types.includes("Flying")) {
      const h = Math.max(1, Math.floor(combatant.maxHp / 16));
      const before = combatant.hp;
      combatant.hp = canHeal(combatant) ? Math.min(combatant.maxHp, combatant.hp + h) : combatant.hp;
      const g = combatant.hp - before;
      if (g > 0) logs.push(`${combatant.name} was healed by the grassy terrain! (+${g})`);
    }
    combatant.terrain.turns -= 1;
    if (combatant.terrain.turns <= 0) { logs.push("The terrain returned to normal."); combatant.terrain = null; }
  }
  if (combatant.darkBoost) {
    combatant.darkBoost.turns -= 1;
    if (combatant.darkBoost.turns <= 0) { logs.push(`${combatant.name}'s dark-type empowerment fades.`); combatant.darkBoost = null; }
  }
  if (combatant.spAtkDebuff) {
    combatant.spAtkDebuff.turns -= 1;
    if (combatant.spAtkDebuff.turns <= 0) { logs.push(`${combatant.name}'s Sp. Atk returns to normal.`); combatant.spAtkDebuff = null; }
  }
  return logs.length ? logs.join("\n") : null;
}

function tickCradle(combatant) {
  if (!combatant.hasCradle || combatant.hp <= 0) return null;
  const add = Math.max(1, Math.floor(combatant.maxHp * 0.10));
  combatant.maxHp += add;
  return `The Cradle churns... ${combatant.name}'s max HP swells by ${add} (now ${combatant.maxHp})`;
}

module.exports = { tickScreens, tickField, tickCradle };