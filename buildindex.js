const fs = require("fs");
const path = require("path");

const CANDIDATES = [
  path.join(__dirname, "StorageData", "Items"),
  path.join(__dirname, "public", "StorageData", "Items"),
  path.join(__dirname, "..", "StorageData", "Items")
];

let ITEMS_ROOT = null;
for (const candidate of CANDIDATES) {
  if (fs.existsSync(candidate)) {
    ITEMS_ROOT = candidate;
    break;
  }
}

if (ITEMS_ROOT === null) {
  console.log("Could not find StorageData/Items. Looked in:");
  for (const candidate of CANDIDATES) {
    console.log("  " + candidate);
  }
  console.log("Make sure buildindex.js is inside PMD-Web and StorageData/Items exists next to it.");
  process.exit(1);
}

console.log("using items root: " + ITEMS_ROOT);

const OUTPUT = path.join(__dirname, "public", "items-index.json");
const index = {};

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.name.toLowerCase().endsWith(".png")) {
      const name = entry.name.slice(0, -4);
      const rel = path.relative(ITEMS_ROOT, full).split(path.sep).join("/");
      index[name] = "/items/" + rel;
    }
  }
}

walk(ITEMS_ROOT);

const keys = Object.keys(index).sort();
const lines = keys.map((k) => "  " + JSON.stringify(k) + ": " + JSON.stringify(index[k]));
fs.writeFileSync(OUTPUT, "{\n" + lines.join(",\n") + "\n}\n");
console.log("indexed " + keys.length + " item icons -> public/items-index.json");