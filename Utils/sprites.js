const fs = require("fs");
const path = require("path");

const SPRITE_ROOT = path.join(__dirname, "..", "StorageData", "Sprites");
const DEX_PATH = path.join(__dirname, "..", "StorageData", "SpeciesDex.json");
const CDN_BASE = "https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master/portrait";
const CUSTOM_ROOT = path.join(__dirname, "..", "StorageData", "CustomExpressions");
const CUSTOM_NPC_ROOT = path.join(__dirname, "..", "StorageData", "CustomNpcSprites");
const FORMS_PATH = path.join(__dirname, "..", "StorageData", "SpeciesForms.json");

let dexMap = null;
function loadDexMap() {
  if (dexMap) return dexMap;
  try {
    dexMap = JSON.parse(fs.readFileSync(DEX_PATH, "utf8"));
  } catch {
    dexMap = {};
  }
  return dexMap;
}

let formsMap = null;
function loadForms() {
  if (formsMap) return formsMap;
  try {
    formsMap = JSON.parse(fs.readFileSync(FORMS_PATH, "utf8"));
  } catch {
    formsMap = {};
  }
  return formsMap;
}

function formPath(species, formName) {
  if (!formName) return null;
  const map = loadForms();
  let forms = map[species];
  if (!forms) {
    const lower = species.toLowerCase();
    for (const k of Object.keys(map)) {
      if (k.toLowerCase() === lower) { forms = map[k]; break; }
    }
  }
  if (!forms) return null;
  const key = formName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return forms[key] || null;
}

function dexFor(species) {
  const map = loadDexMap();
  if (map[species]) return map[species];
  const target = normSpeciesKey(species);
  for (const k of Object.keys(map)) {
    if (normSpeciesKey(k) === target) return map[k];
  }
  return null;
}

function normSpeciesKey(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findSpeciesDir(dir, species) {
  if (!fs.existsSync(dir)) return null;
  const target = normSpeciesKey(species);
  let fallback = null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (normSpeciesKey(entry.name) === target) {
      if (fs.existsSync(path.join(full, "Normal.png"))) return full;
      if (!fallback) fallback = full;
    }
    const nested = findSpeciesDir(full, species);
    if (nested) return nested;
  }
  return fallback;
}

function speciesDir(species) {
  return findSpeciesDir(SPRITE_ROOT, species);
}

function localOverrideUrl(species, expression) {
  const dir = speciesDir(species);
  if (!dir) return null;
  const canonical = path.basename(dir);
  const jsonPath = path.join(dir, `${canonical}.json`);
  if (!fs.existsSync(jsonPath)) return null;
  try {
    const map = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    if (map[expression]) return map[expression];
    if (map["Normal"]) return map["Normal"];
  } catch {}
  return null;
}

function customFolderName(name) {
  return String(name || "").replace(/[^\w \-]/g, "").replace(/\s+/g, " ").trim();
}

function characterCustomDir(userId, charName) {
  const folder = customFolderName(charName);
  if (!folder) return null;
  return path.join(CUSTOM_ROOT, String(userId), folder);
}

function legacyBelongsTo(userId, charName) {
  try {
    const storage = require("./storage");
    const first = storage.readCharacterSlot(userId, 1);
    if (!first) return false;
    return customFolderName(first.name || first.species).toLowerCase() === customFolderName(charName).toLowerCase();
  } catch {
    return false;
  }
}

function localCustomPath(userId, expression, charName) {
  if (!userId) return null;
  if (charName) {
    const dir = characterCustomDir(userId, charName);
    if (dir) {
      const own = path.join(dir, `${expression}.png`);
      if (fs.existsSync(own)) return own;
    }
    if (legacyBelongsTo(userId, charName)) {
      const legacy = path.join(CUSTOM_ROOT, String(userId), `${expression}.png`);
      if (fs.existsSync(legacy)) return legacy;
    }
    return null;
  }
  const p = path.join(CUSTOM_ROOT, String(userId), `${expression}.png`);
  return fs.existsSync(p) ? p : null;
}

function localNpcCustomPath(name, expression) {
  if (!name) return null;
  const folder = String(name).replace(/[^\w \-]/g, "").replace(/\s+/g, " ").trim() || "npc";
  const p = path.join(CUSTOM_NPC_ROOT, folder, `${expression}.png`);
  return fs.existsSync(p) ? p : null;
}

function portraitUrl(species, expression = "Normal", customMap, form) {
  if (form) {
    const fp = formPath(species, form);
    const dex = dexFor(species);
    if (fp && dex) return `${CDN_BASE}/${dex}/${fp}/${expression}.png`;
  }
  if (customMap && customMap[expression]) return customMap[expression];
  const override = localOverrideUrl(species, expression);
  if (override) return override;
  const dex = dexFor(species);
  if (dex) return `${CDN_BASE}/${dex}/${expression}.png`;
  return null;
}

function expressionUrl(species, expression, customMap, form) {
  return portraitUrl(species, expression || "Normal", customMap, form);
}

function canonicalSpecies(species) {
  const dir = speciesDir(species);
  if (dir) return path.basename(dir);
  const map = loadDexMap();
  if (map[species]) return species;
  const target = normSpeciesKey(species);
  for (const k of Object.keys(map)) {
    if (normSpeciesKey(k) === target) return k;
  }
  return null;
}

function pickExpression(character) {
  if (character.stunned || character.hp <= 0) return "Dizzy";
  const pct = character.maxHp > 0 ? character.hp / character.maxHp : 1;
  if (pct <= 0.25) return "Pain";
  if (character.ailments && character.ailments.length > 0) return "Worried";
  if (character.mood && character.mood !== "Neutral") return character.mood;
  return "Normal";
}

function portraitFor(character) {
  return portraitUrl(character.species, pickExpression(character));
}

module.exports = { SPRITE_ROOT, CUSTOM_ROOT, customFolderName, characterCustomDir, speciesDir, canonicalSpecies, portraitUrl, expressionUrl, pickExpression, portraitFor, localCustomPath, localNpcCustomPath, formPath };