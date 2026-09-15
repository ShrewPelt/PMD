const fs = require("fs");
const path = require("path");
const https = require("https");

const REPO_BASE = "https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master/sprite";
const OUTPUT_ROOT = path.join(__dirname, "public", "sprites");

const SPECIES = ["0004", "0025", "0133", "0495"];

const ANIMATIONS = ["Walk", "Idle"];

const ALWAYS_FETCH = ["AnimData.xml", "credits.txt"];

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlinkSync(destination);
        download(response.headers.location, destination).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destination);
        reject(new Error("HTTP " + response.statusCode));
        return;
      }
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    }).on("error", (err) => {
      file.close();
      if (fs.existsSync(destination)) fs.unlinkSync(destination);
      reject(err);
    });
  });
}

async function fetchSpecies(dex) {
  const folder = path.join(OUTPUT_ROOT, dex);
  fs.mkdirSync(folder, { recursive: true });

  const files = [];
  for (const name of ALWAYS_FETCH) {
    files.push(name);
  }
  for (const anim of ANIMATIONS) {
    files.push(anim + "-Anim.png");
    files.push(anim + "-Offsets.png");
    files.push(anim + "-Shadow.png");
  }

  for (const file of files) {
    const url = REPO_BASE + "/" + dex + "/" + file;
    const destination = path.join(folder, file);
    if (fs.existsSync(destination)) {
      console.log("skip  " + dex + "/" + file);
      continue;
    }
    try {
      await download(url, destination);
      console.log("saved " + dex + "/" + file);
    } catch (err) {
      console.log("FAIL  " + dex + "/" + file + " | " + err.message);
    }
  }
}

async function run() {
  for (const dex of SPECIES) {
    console.log("fetching " + dex);
    await fetchSpecies(dex);
  }
  console.log("done");
}

run();