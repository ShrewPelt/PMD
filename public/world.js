const WORLD_COLS = 256;
const WORLD_ROWS = 256;
const CHUNK = 32;
const TOOL_CHARS = { floor: ".", wall: "#", barrier: "x", void: " " };
const TOOL_PREVIEW = { floor: 0x5a5a88, wall: 0x8a6a4a, barrier: 0xc0392b, void: 0x000000, tile: 0x4a9a4a, tileclear: 0x888888, object: 0xd8a840, objerase: 0xc0392b };
const worldArtPool = {};
const worldObjectPool = {};
const worldAssetState = {};
let worldAssetsDirty = false;
let worldLastView = null;
let worldViewOverGfx = null;
let worldAssetList = { tiles: [], objects: [], blocking: [] };

let worldPlayerMode = false;
let worldGmMode = false;
let worldViewGfx = null;
let gmSpaceDown = false;

const WG = {
  layer: 0,
  name: "",
  rows: [],
  portals: {},
  spawn: null,
  layers: [],
  players: {},
  tool: "floor",
  shape: "pencil",
  portalSource: null,
  tpTarget: null,
  undo: [],
  strokeUndo: null,
  stroke: null,
  pan: null,
  chunks: {},
  overlays: {},
  art: [],
  palette: {},
  objects: {},
  tileName: "",
  objName: "",
  viewKey: "",
  artDirty: true,
  gridGfx: null,
  markerGfx: null,
  previewGfx: null,
  hoverCol: 0,
  hoverRow: 0,
  panel: null
};

function blankRows() {
  const rows = [];
  const blank = " ".repeat(WORLD_COLS);
  for (let r = 0; r < WORLD_ROWS; r++) rows.push(blank);
  return rows;
}

function worldDrawBase(g, c, r, ch) {
  if (ch === " " || ch === "#") return;
  g.fillStyle(0x3a3a55, 1);
  g.fillRect(c * TILE, r * TILE, TILE - 2, TILE - 2);
}

function worldDrawOverlay(g, c, r, ch, forPlayers) {
  const x = c * TILE;
  const y = r * TILE;
  if (ch === "#") {
    g.fillStyle(0x6b4f3a, 1);
    g.fillRect(x, y, TILE - 2, TILE - 2);
    g.lineStyle(2, 0x8a6a4a, 1);
    g.strokeRect(x + 1, y + 1, TILE - 4, TILE - 4);
    return;
  }
  if (ch === "x" && !forPlayers) {
    g.fillStyle(0xc0392b, 0.45);
    g.fillRect(x, y, TILE - 2, TILE - 2);
    g.lineStyle(2, 0xff6b5b, 1);
    g.lineBetween(x + 6, y + 6, x + TILE - 8, y + TILE - 8);
    g.lineBetween(x + TILE - 8, y + 6, x + 6, y + TILE - 8);
    return;
  }
  if (ch === "P") {
    g.fillStyle(0x9b59b6, 1);
    g.fillCircle(x + TILE / 2 - 1, y + TILE / 2 - 1, 15);
    g.fillStyle(0xd7b8ee, 1);
    g.fillCircle(x + TILE / 2 - 1, y + TILE / 2 - 1, 7);
  }
}

function worldAssetUrl(kind, name) {
  return "assets/" + (kind === "tile" ? "tilemap" : "objects") + "/" + encodeURIComponent(name) + ".png";
}

function worldEnsureAsset(scene, kind, name) {
  const key = kind + "_" + name;
  if (scene.textures.exists(key)) return key;
  if (worldAssetState[key]) return null;
  worldAssetState[key] = "loading";
  scene.load.once("filecomplete-image-" + key, () => {
    worldAssetState[key] = "ready";
    worldAssetsDirty = true;
  });
  scene.load.image(key, worldAssetUrl(kind, name));
  if (!scene.load.isLoading()) scene.load.start();
  return null;
}

function worldSyncPool(scene, pool, wanted, kind) {
  for (const key in pool) {
    if (!wanted[key]) {
      pool[key].destroy();
      delete pool[key];
    }
  }
  for (const key in wanted) {
    const w = wanted[key];
    const tex = worldEnsureAsset(scene, kind, w.name);
    if (!tex) continue;
    let sp = pool[key];
    if (sp && sp.texKey !== tex) {
      sp.destroy();
      sp = null;
      delete pool[key];
    }
    if (!sp) {
      if (kind === "tile") {
        sp = scene.add.image(w.c * TILE, w.r * TILE, tex);
        sp.setOrigin(0, 0);
        sp.setDisplaySize(TILE - 2, TILE - 2);
        sp.setDepth(1);
      } else {
        sp = scene.add.image(w.c * TILE + TILE / 2 - 1, w.r * TILE + TILE / 2 - 1, tex);
        const scale = (TILE - 2) / Math.max(sp.width, sp.height);
        sp.setScale(scale);
        sp.setDepth(3);
      }
      sp.texKey = tex;
      pool[key] = sp;
    }
    sp.setAlpha(w.alpha === undefined ? 1 : w.alpha);
  }
}

function worldSyncItems(scene, items) {
  floorItems = items || [];
  const wanted = {};
  for (const it of floorItems) wanted[it.col + "," + it.row] = true;
  for (const key in floorItemSprites) {
    if (!wanted[key]) {
      floorItemSprites[key].destroy();
      delete floorItemSprites[key];
    }
  }
  renderAllFloorItems(scene);
  updatePlayerLift();
}

function enterPlayerWorld(scene) {
  worldPlayerMode = true;
  if (mapGraphics) mapGraphics.clear();
  scene.cameras.main.removeBounds();
  const exitBtn = document.getElementById("exitWorld");
  exitBtn.classList.remove("hidden");
  exitBtn.addEventListener("click", () => {
    if (!window.confirm("Exit the world? Your character will be saved and logged out.")) return;
    gmSend({ type: "exit" });
  });
  if (!worldViewGfx) {
    worldViewGfx = scene.add.graphics();
    worldViewGfx.setDepth(0);
  }
}

function drawPlayerView(scene, data) {
  if (!worldViewGfx) {
    worldViewGfx = scene.add.graphics();
    worldViewGfx.setDepth(0);
  }
  if (!worldViewOverGfx) {
    worldViewOverGfx = scene.add.graphics();
    worldViewOverGfx.setDepth(2);
  }
  worldLastView = data;
  worldViewGfx.clear();
  worldViewOverGfx.clear();
  const wantedArt = {};
  const wantedObjs = {};
  for (let r = 0; r < data.rows.length; r++) {
    const line = data.rows[r];
    const artLine = data.art && data.art[r] ? data.art[r] : "";
    for (let c = 0; c < line.length; c++) {
      const col = data.c0 + c;
      const row = data.r0 + r;
      worldDrawBase(worldViewGfx, col, row, line[c]);
      worldDrawOverlay(worldViewOverGfx, col, row, line[c], true);
      const artChar = artLine[c];
      if (artChar && artChar !== " " && line[c] !== " " && line[c] !== "#" && data.palette && data.palette[artChar]) {
        wantedArt[col + "," + row] = { name: data.palette[artChar], c: col, r: row };
      }
    }
  }
  for (const o of data.objects || []) {
    wantedObjs[o.col + "," + o.row] = { name: o.name, c: o.col, r: o.row };
  }
  worldSyncPool(scene, worldArtPool, wantedArt, "tile");
  worldSyncPool(scene, worldObjectPool, wantedObjs, "object");
  worldSyncItems(scene, data.items);
}

function gmRedrawChunk(scene, cx, cy) {
  const key = cx + "," + cy;
  let g = WG.chunks[key];
  let over = WG.overlays[key];
  if (!g) {
    g = scene.add.graphics();
    g.setDepth(0);
    WG.chunks[key] = g;
    over = scene.add.graphics();
    over.setDepth(2);
    WG.overlays[key] = over;
  }
  g.clear();
  over.clear();
  const rMax = Math.min(WORLD_ROWS, (cy + 1) * CHUNK);
  const cMax = Math.min(WORLD_COLS, (cx + 1) * CHUNK);
  for (let r = cy * CHUNK; r < rMax; r++) {
    const line = WG.rows[r];
    for (let c = cx * CHUNK; c < cMax; c++) {
      worldDrawBase(g, c, r, line[c]);
      worldDrawOverlay(over, c, r, line[c], false);
    }
  }
}

function gmRedrawAll(scene) {
  for (let cy = 0; cy < WORLD_ROWS / CHUNK; cy++) {
    for (let cx = 0; cx < WORLD_COLS / CHUNK; cx++) {
      gmRedrawChunk(scene, cx, cy);
    }
  }
}

function gmSyncArt(scene) {
  const cam = scene.cameras.main;
  const wv = cam.worldView;
  const c0 = Math.max(0, Math.floor(wv.x / TILE) - 1);
  const c1 = Math.min(WORLD_COLS - 1, Math.floor((wv.x + wv.width) / TILE) + 1);
  const r0 = Math.max(0, Math.floor(wv.y / TILE) - 1);
  const r1 = Math.min(WORLD_ROWS - 1, Math.floor((wv.y + wv.height) / TILE) + 1);
  const key = c0 + "," + c1 + "," + r0 + "," + r1;
  if (key === WG.viewKey && !WG.artDirty && !worldAssetsDirty) return;
  WG.viewKey = key;
  WG.artDirty = false;
  worldAssetsDirty = false;
  const wantedArt = {};
  const wantedObjs = {};
  for (let r = r0; r <= r1; r++) {
    const artLine = WG.art[r];
    const logicLine = WG.rows[r];
    for (let c = c0; c <= c1; c++) {
      const ch = artLine[c];
      if (ch !== " " && logicLine[c] !== " " && logicLine[c] !== "#" && WG.palette[ch]) {
        wantedArt[c + "," + r] = { name: WG.palette[ch], c: c, r: r };
      }
      const obj = WG.objects[c + "," + r];
      if (obj) wantedObjs[c + "," + r] = { name: obj.name, c: c, r: r, alpha: obj.solid ? 1 : 0.7 };
    }
  }
  worldSyncPool(scene, worldArtPool, wantedArt, "tile");
  worldSyncPool(scene, worldObjectPool, wantedObjs, "object");
}

function worldFrame(scene) {
  if (worldGmMode) {
    gmSyncArt(scene);
    return;
  }
  if (worldPlayerMode && worldAssetsDirty && worldLastView) {
    worldAssetsDirty = false;
    drawPlayerView(scene, worldLastView);
  }
}

function gmDrawGrid(scene) {
  if (WG.gridGfx) return;
  const g = scene.add.graphics();
  g.setDepth(-1);
  g.lineStyle(1, 0xffffff, 0.06);
  for (let c = 0; c <= WORLD_COLS; c++) {
    g.lineBetween(c * TILE, 0, c * TILE, WORLD_ROWS * TILE);
  }
  for (let r = 0; r <= WORLD_ROWS; r++) {
    g.lineBetween(0, r * TILE, WORLD_COLS * TILE, r * TILE);
  }
  g.lineStyle(3, 0x6666aa, 0.8);
  g.strokeRect(0, 0, WORLD_COLS * TILE, WORLD_ROWS * TILE);
  WG.gridGfx = g;
}

function gmDrawMarkers() {
  if (!WG.markerGfx) return;
  const g = WG.markerGfx;
  g.clear();
  if (WG.spawn) {
    g.lineStyle(4, 0x3ec13e, 1);
    g.strokeCircle(WG.spawn.col * TILE + TILE / 2 - 1, WG.spawn.row * TILE + TILE / 2 - 1, 19);
  }
  if (WG.portalSource && WG.portalSource.layer === WG.layer) {
    g.lineStyle(4, 0xffd23f, 1);
    g.strokeCircle(WG.portalSource.c * TILE + TILE / 2 - 1, WG.portalSource.r * TILE + TILE / 2 - 1, 21);
  }
}

function gmCellFromPointer(scene, pointer) {
  const wp = scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
  return { c: Math.floor(wp.x / TILE), r: Math.floor(wp.y / TILE) };
}

function gmInBounds(c, r) {
  return c >= 0 && c < WORLD_COLS && r >= 0 && r < WORLD_ROWS;
}

function lineCells(c0, r0, c1, r1) {
  const cells = [];
  let x = c0;
  let y = r0;
  const dx = Math.abs(c1 - c0);
  const dy = Math.abs(r1 - r0);
  const sx = c0 < c1 ? 1 : -1;
  const sy = r0 < r1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    cells.push([x, y]);
    if (x === c1 && y === r1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return cells;
}

function snapLineEnd(sc, sr, ec, er, free) {
  if (free) return { c: ec, r: er };
  const dx = Math.abs(ec - sc);
  const dy = Math.abs(er - sr);
  if (dx >= 2 * dy) return { c: ec, r: sr };
  if (dy >= 2 * dx) return { c: sc, r: er };
  const m = Math.max(dx, dy);
  return { c: sc + (ec >= sc ? 1 : -1) * m, r: sr + (er >= sr ? 1 : -1) * m };
}

function rectCells(c0, r0, c1, r1, outline) {
  const cells = [];
  const cMin = Math.min(c0, c1);
  const cMax = Math.max(c0, c1);
  const rMin = Math.min(r0, r1);
  const rMax = Math.max(r0, r1);
  for (let r = rMin; r <= rMax; r++) {
    for (let c = cMin; c <= cMax; c++) {
      if (outline && c !== cMin && c !== cMax && r !== rMin && r !== rMax) continue;
      cells.push([c, r]);
    }
  }
  return cells;
}

function gmShapeCells(stroke, endC, endR, shiftKey) {
  if (WG.shape === "line") {
    const end = snapLineEnd(stroke.c0, stroke.r0, endC, endR, shiftKey);
    return lineCells(stroke.c0, stroke.r0, end.c, end.r);
  }
  if (WG.shape === "rect") return rectCells(stroke.c0, stroke.r0, endC, endR, false);
  if (WG.shape === "outline") return rectCells(stroke.c0, stroke.r0, endC, endR, true);
  return lineCells(stroke.lastC, stroke.lastR, endC, endR);
}

function gmSend(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
  }
}

function gmSnapshotCell(c, r) {
  const key = c + "," + r;
  if (!WG.strokeUndo || WG.strokeUndo.cells[key]) return;
  const artChar = WG.art[r][c];
  const obj = WG.objects[key];
  WG.strokeUndo.cells[key] = {
    c: c,
    r: r,
    logic: WG.rows[r][c],
    art: artChar === " " ? "" : (WG.palette[artChar] || ""),
    obj: obj ? obj.name : "",
    solid: obj ? obj.solid : true
  };
}

function gmSendEdit(cells) {
  const tool = WG.tool;
  const logicOps = [];
  const artOps = [];
  const objOps = [];
  const solid = document.getElementById("wgSolid").checked ? 1 : 0;
  for (const cell of cells) {
    const c = cell[0];
    const r = cell[1];
    if (!gmInBounds(c, r)) continue;
    gmSnapshotCell(c, r);
    if (TOOL_CHARS[tool] !== undefined) logicOps.push([c, r, TOOL_CHARS[tool]]);
    else if (tool === "tile") artOps.push([c, r, WG.tileName]);
    else if (tool === "tileclear") artOps.push([c, r, ""]);
    else if (tool === "object") objOps.push([c, r, WG.objName, solid]);
    else if (tool === "objerase") objOps.push([c, r, "", 0]);
  }
  if (logicOps.length > 0) gmSend({ type: "gm_edit", layer: WG.layer, ops: logicOps });
  if (artOps.length > 0 && (tool !== "tile" || WG.tileName)) gmSend({ type: "gm_art", layer: WG.layer, ops: artOps });
  if (objOps.length > 0 && (tool !== "object" || WG.objName)) gmSend({ type: "gm_obj", layer: WG.layer, ops: objOps });
}

function gmApplyTiles(scene, cells) {
  const touched = {};
  for (const cell of cells) {
    const c = cell[0];
    const r = cell[1];
    if (!gmInBounds(c, r)) continue;
    WG.rows[r] = WG.rows[r].substring(0, c) + cell[2] + WG.rows[r].substring(c + 1);
    touched[Math.floor(c / CHUNK) + "," + Math.floor(r / CHUNK)] = [Math.floor(c / CHUNK), Math.floor(r / CHUNK)];
  }
  for (const key in touched) gmRedrawChunk(scene, touched[key][0], touched[key][1]);
}

function gmApplyArt(scene, cells) {
  for (const cell of cells) {
    const c = cell[0];
    const r = cell[1];
    if (!gmInBounds(c, r)) continue;
    let ch = " ";
    if (cell[2]) {
      for (const k in WG.palette) {
        if (WG.palette[k] === cell[2]) { ch = k; break; }
      }
      if (ch === " ") {
        for (let i = 0; i < 62; i++) {
          const cand = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[i];
          if (!WG.palette[cand]) { WG.palette[cand] = cell[2]; ch = cand; break; }
        }
      }
    }
    WG.art[r] = WG.art[r].substring(0, c) + ch + WG.art[r].substring(c + 1);
  }
  WG.artDirty = true;
}

function gmApplyObjs(scene, cells) {
  for (const cell of cells) {
    const key = cell[0] + "," + cell[1];
    if (cell[2]) WG.objects[key] = { name: cell[2], solid: cell[3] !== 0 };
    else delete WG.objects[key];
  }
  WG.artDirty = true;
}

function gmDrawPreview(scene, cells, color) {
  if (!WG.previewGfx) return;
  const g = WG.previewGfx;
  g.clear();
  if (cells) {
    g.fillStyle(color, 0.55);
    for (const cell of cells) {
      g.fillRect(cell[0] * TILE, cell[1] * TILE, TILE - 2, TILE - 2);
    }
  }
  g.lineStyle(2, 0xffffff, 0.9);
  g.strokeRect(WG.hoverCol * TILE, WG.hoverRow * TILE, TILE - 2, TILE - 2);
}

function gmStatus(text) {
  const el = document.getElementById("wgStatus");
  if (el) el.textContent = text;
}

function gmUpdateHoverStatus() {
  if (!gmInBounds(WG.hoverCol, WG.hoverRow)) {
    gmStatus("Layer " + WG.layer + " | outside the editable area");
    return;
  }
  const ch = WG.rows[WG.hoverRow][WG.hoverCol];
  const names = { " ": "empty", ".": "floor", "#": "wall", "x": "barrier", "P": "portal" };
  let text = "Layer " + WG.layer + " | " + WG.hoverCol + ", " + WG.hoverRow + " | " + names[ch];
  const hoverArt = WG.art[WG.hoverRow][WG.hoverCol];
  if (hoverArt !== " " && WG.palette[hoverArt]) text += " | tile " + WG.palette[hoverArt];
  const hoverObj = WG.objects[WG.hoverCol + "," + WG.hoverRow];
  if (hoverObj) text += " | " + hoverObj.name + (hoverObj.solid ? " (solid)" : " (walk-through)");
  const portal = WG.portals[WG.hoverCol + "," + WG.hoverRow];
  if (portal) text += " to layer " + portal.layer + " (" + portal.col + ", " + portal.row + ")";
  if (WG.portalSource) text += "\nPortal start set on layer " + WG.portalSource.layer + ". Pick the destination.";
  if (WG.tpTarget && WG.players[WG.tpTarget]) text += "\nMoving " + WG.players[WG.tpTarget].name + ": click a tile.";
  gmStatus(text);
}

function gmHandleClickTool(scene, c, r) {
  if (!gmInBounds(c, r)) return;
  if (WG.tool === "portal") {
    if (!WG.portalSource) {
      WG.portalSource = { layer: WG.layer, c: c, r: r };
      gmDrawMarkers();
      gmUpdateHoverStatus();
      return;
    }
    const twoWay = document.getElementById("wgTwoWay").checked;
    gmSend({ type: "gm_portal", layer: WG.portalSource.layer, col: WG.portalSource.c, row: WG.portalSource.r, toLayer: WG.layer, toCol: c, toRow: r, twoWay: twoWay });
    WG.portalSource = null;
    gmDrawMarkers();
    return;
  }
  if (WG.tool === "spawn") {
    gmSend({ type: "gm_spawn", layer: WG.layer, col: c, row: r });
    return;
  }
  if (WG.tool === "item") {
    gmSend({ type: "gm_item", layer: WG.layer, col: c, row: r, name: document.getElementById("wgItem").value.trim() });
    return;
  }
  if (WG.tool === "teleport") {
    if (WG.tpTarget && WG.players[WG.tpTarget]) {
      gmSend({ type: "gm_tp", playerId: WG.tpTarget, layer: WG.layer, col: c, row: r });
      WG.tpTarget = null;
      gmRenderPlayers();
    }
  }
}

function gmPointerDown(scene, pointer) {
  const cell = gmCellFromPointer(scene, pointer);
  WG.hoverCol = cell.c;
  WG.hoverRow = cell.r;
  if (pointer.rightButtonDown() || pointer.middleButtonDown() || WG.tool === "pan" || gmSpaceDown) {
    const cam = scene.cameras.main;
    WG.pan = { x: pointer.x, y: pointer.y, sx: cam.scrollX, sy: cam.scrollY };
    return;
  }
  if (!pointer.leftButtonDown()) return;
  const paintTool = TOOL_PREVIEW[WG.tool] !== undefined;
  if (!paintTool) {
    gmHandleClickTool(scene, cell.c, cell.r);
    return;
  }
  WG.strokeUndo = { layer: WG.layer, cells: {} };
  WG.stroke = { c0: cell.c, r0: cell.r, lastC: cell.c, lastR: cell.r };
  if (WG.shape === "pencil") {
    gmSendEdit([[cell.c, cell.r]]);
  } else {
    gmDrawPreview(scene, gmShapeCells(WG.stroke, cell.c, cell.r, pointer.event.shiftKey), TOOL_PREVIEW[WG.tool]);
  }
}

function gmPointerMove(scene, pointer) {
  const cell = gmCellFromPointer(scene, pointer);
  WG.hoverCol = cell.c;
  WG.hoverRow = cell.r;
  if (WG.pan) {
    const cam = scene.cameras.main;
    cam.scrollX = WG.pan.sx - (pointer.x - WG.pan.x) / cam.zoom;
    cam.scrollY = WG.pan.sy - (pointer.y - WG.pan.y) / cam.zoom;
    return;
  }
  if (WG.stroke && pointer.leftButtonDown()) {
    if (WG.shape === "pencil") {
      if (cell.c !== WG.stroke.lastC || cell.r !== WG.stroke.lastR) {
        gmSendEdit(lineCells(WG.stroke.lastC, WG.stroke.lastR, cell.c, cell.r));
        WG.stroke.lastC = cell.c;
        WG.stroke.lastR = cell.r;
      }
      gmDrawPreview(scene, null, 0);
    } else {
      gmDrawPreview(scene, gmShapeCells(WG.stroke, cell.c, cell.r, pointer.event.shiftKey), TOOL_PREVIEW[WG.tool]);
    }
  } else {
    gmDrawPreview(scene, null, 0);
  }
  gmUpdateHoverStatus();
}

function gmPointerUp(scene, pointer) {
  if (WG.pan) {
    WG.pan = null;
    return;
  }
  if (!WG.stroke) return;
  const cell = gmCellFromPointer(scene, pointer);
  if (WG.shape !== "pencil") {
    gmSendEdit(gmShapeCells(WG.stroke, cell.c, cell.r, pointer.event.shiftKey));
  }
  if (WG.strokeUndo && Object.keys(WG.strokeUndo.cells).length > 0) {
    WG.undo.push(WG.strokeUndo);
    if (WG.undo.length > 60) WG.undo.shift();
  }
  WG.strokeUndo = null;
  WG.stroke = null;
  gmDrawPreview(scene, null, 0);
}

function gmUndo() {
  const entry = WG.undo.pop();
  if (!entry) return;
  const logicOps = [];
  const artOps = [];
  const objOps = [];
  for (const key in entry.cells) {
    const cell = entry.cells[key];
    logicOps.push([cell.c, cell.r, cell.logic]);
    artOps.push([cell.c, cell.r, cell.art]);
    objOps.push([cell.c, cell.r, cell.obj, cell.solid ? 1 : 0]);
  }
  gmSend({ type: "gm_edit", layer: entry.layer, ops: logicOps });
  gmSend({ type: "gm_art", layer: entry.layer, ops: artOps });
  gmSend({ type: "gm_obj", layer: entry.layer, ops: objOps });
}

function gmGoLayer(n) {
  const layer = parseInt(n, 10);
  if (isNaN(layer) || layer < -999 || layer > 999) {
    gmStatus("Layers go from -999 to 999.");
    return;
  }
  gmSend({ type: "gm_layer", layer: layer });
}

function gmRenderLayers() {
  const box = document.getElementById("wgLayerList");
  if (!box) return;
  box.innerHTML = "";
  for (const entry of WG.layers) {
    const btn = document.createElement("button");
    btn.className = "wgBtn" + (entry.layer === WG.layer ? " on" : "");
    btn.textContent = "L" + entry.layer + (entry.name ? " " + entry.name : "") + (entry.players ? " (" + entry.players + ")" : "");
    btn.addEventListener("click", () => gmGoLayer(entry.layer));
    box.appendChild(btn);
  }
}

function gmRenderPlayers() {
  const box = document.getElementById("wgPlayers");
  if (!box) return;
  box.innerHTML = "";
  const ids = Object.keys(WG.players);
  if (ids.length === 0) {
    box.textContent = "Nobody is in the world.";
    return;
  }
  for (const id of ids) {
    const p = WG.players[id];
    const row = document.createElement("div");
    row.className = "wgPlayer";
    const label = document.createElement("span");
    label.textContent = p.name + " | L" + p.layer;
    const view = document.createElement("button");
    view.className = "wgBtn";
    view.textContent = "View";
    view.addEventListener("click", () => {
      if (p.layer !== WG.layer) gmGoLayer(p.layer);
      sceneRef.cameras.main.centerOn(p.col * TILE + TILE / 2, p.row * TILE + TILE / 2);
    });
    const move = document.createElement("button");
    move.className = "wgBtn" + (WG.tpTarget === p.id ? " on" : "");
    move.textContent = "Move";
    move.addEventListener("click", () => {
      WG.tpTarget = p.id;
      gmSetTool("teleport");
      gmRenderPlayers();
      gmUpdateHoverStatus();
    });
    row.appendChild(label);
    row.appendChild(view);
    row.appendChild(move);
    box.appendChild(row);
  }
}

function gmSyncPlayerSprites(scene) {
  for (const id in otherPlayers) {
    const p = WG.players[id];
    if (!p || p.layer !== WG.layer) removeOtherPlayer(id);
  }
  for (const id in WG.players) {
    const p = WG.players[id];
    if (p.layer === WG.layer && !otherPlayers[id]) addOtherPlayer(scene, p);
  }
}

function gmUpdatePlayer(scene, p) {
  WG.players[p.id] = p;
  gmRenderPlayers();
  const sprite = otherPlayers[p.id];
  if (p.layer !== WG.layer) {
    if (sprite) removeOtherPlayer(p.id);
    return;
  }
  if (!sprite) {
    addOtherPlayer(scene, p);
    return;
  }
  if (sprite === "loading") return;
  sprite.direction = p.direction;
  sprite.play(sprite.dex + "_walk_" + p.direction);
  scene.tweens.add({ targets: sprite, x: tilePixelX(p.col), y: tilePixelY(p.row), duration: 110, onComplete: () => { if (sprite.active) sprite.play(sprite.dex + "_idle_" + sprite.direction); } });
  sprite.hp = p.hp;
  sprite.maxHp = p.maxHp;
  sprite.mp = p.mp;
  sprite.maxMp = p.maxMp;
}

function gmRefreshAssetHighlight() {
  document.querySelectorAll("[data-wgasset]").forEach((b) => {
    const parts = b.getAttribute("data-wgasset").split(":");
    const on = (parts[0] === "tile" && WG.tool === "tile" && WG.tileName === parts[1]) || (parts[0] === "object" && WG.tool === "object" && WG.objName === parts[1]);
    b.classList.toggle("on", on);
  });
}

function gmSetTool(tool) {
  WG.tool = tool;
  const buttons = document.querySelectorAll("[data-wgtool]");
  buttons.forEach((b) => b.classList.toggle("on", b.getAttribute("data-wgtool") === tool));
  gmRefreshAssetHighlight();
  if (tool !== "portal") {
    WG.portalSource = null;
    gmDrawMarkers();
  }
}

function gmSetShape(shape) {
  WG.shape = shape;
  const buttons = document.querySelectorAll("[data-wgshape]");
  buttons.forEach((b) => b.classList.toggle("on", b.getAttribute("data-wgshape") === shape));
}

function gmBuildPanel() {
  const style = document.createElement("style");
  style.textContent = "#wgPanel{position:fixed;top:8px;right:8px;width:280px;max-height:96vh;overflow-y:auto;background:rgba(20,20,34,0.94);border:1px solid #3a3a55;border-radius:8px;padding:10px;color:#fff;font-size:13px;z-index:20}"
    + "#wgPanel h4{margin:10px 0 6px 0;color:#ffd23f;font-size:13px}"
    + "#wgPanel h4:first-child{margin-top:0}"
    + ".wgBtn{background:#2d2d44;color:#fff;border:1px solid #55557a;border-radius:5px;padding:5px 8px;margin:2px;cursor:pointer;font-size:12px}"
    + ".wgBtn.on{background:#4a6cff;border-color:#fff}"
    + "#wgPanel input[type=text],#wgPanel input[type=number]{background:#2d2d44;color:#fff;border:1px solid #55557a;border-radius:5px;padding:5px;width:70px}"
    + "#wgPanel input#wgName,#wgPanel input#wgItem{width:150px}"
    + ".wgAsset{display:inline-flex;flex-direction:column;align-items:center;width:62px;margin:2px;padding:4px 2px;background:#2d2d44;border:1px solid #55557a;border-radius:5px;color:#fff;font-size:10px;cursor:pointer}"
    + ".wgAsset.on{background:#4a6cff;border-color:#fff}"
    + ".wgAsset img{width:36px;height:36px;object-fit:contain;image-rendering:pixelated;margin-bottom:2px}"
    + ".wgPlayer{display:flex;gap:4px;align-items:center;margin:3px 0}.wgPlayer span{flex:1}"
    + "#wgStatus{white-space:pre-wrap;font-family:monospace;font-size:12px;color:#c8c8ff;margin-top:6px}"
    + "#wgHelp{color:#8888aa;font-size:11px;margin-top:6px;line-height:1.4}";
  document.head.appendChild(style);

  const panel = document.createElement("div");
  panel.id = "wgPanel";
  panel.innerHTML = ""
    + "<h4>Layer</h4>"
    + "<div><button class='wgBtn' id='wgPrev'>&lt;</button><input type='number' id='wgLayerNum' min='-999' max='999' value='0'><button class='wgBtn' id='wgGo'>Go</button><button class='wgBtn' id='wgNext'>&gt;</button></div>"
    + "<div style='margin-top:6px'><input type='text' id='wgName' placeholder='Layer name'><button class='wgBtn' id='wgSetName'>Set</button></div>"
    + "<div id='wgLayerList' style='margin-top:6px'></div>"
    + "<h4>Tools</h4>"
    + "<div id='wgTools'>"
    + "<button class='wgBtn on' data-wgtool='floor'>Floor</button>"
    + "<button class='wgBtn' data-wgtool='wall'>Wall</button>"
    + "<button class='wgBtn' data-wgtool='barrier'>Barrier</button>"
    + "<button class='wgBtn' data-wgtool='void'>Erase</button>"
    + "<button class='wgBtn' data-wgtool='portal'>Portal</button>"
    + "<button class='wgBtn' data-wgtool='spawn'>Spawn</button>"
    + "<button class='wgBtn' data-wgtool='item'>Item</button>"
    + "<button class='wgBtn' data-wgtool='teleport'>Move player</button>"
    + "<button class='wgBtn' data-wgtool='tileclear'>Clear tile art</button>"
    + "<button class='wgBtn' data-wgtool='objerase'>Remove object</button>"
    + "<button class='wgBtn' data-wgtool='pan'>Pan</button>"
    + "</div>"
    + "<h4>Tile art</h4><div id='wgTileList'>Loading...</div>"
    + "<h4>Objects</h4><div id='wgObjList'>Loading...</div>"
    + "<div style='margin-top:6px'><label><input type='checkbox' id='wgSolid' checked> Objects block movement</label></div>"
    + "<h4>Shape</h4>"
    + "<div>"
    + "<button class='wgBtn on' data-wgshape='pencil'>Pencil</button>"
    + "<button class='wgBtn' data-wgshape='line'>Straight line</button>"
    + "<button class='wgBtn' data-wgshape='rect'>Filled box</button>"
    + "<button class='wgBtn' data-wgshape='outline'>Box outline</button>"
    + "</div>"
    + "<div style='margin-top:6px'><label><input type='checkbox' id='wgTwoWay' checked> Portals work both ways</label></div>"
    + "<div style='margin-top:6px'>Item name: <input type='text' id='wgItem' placeholder='empty = remove item'></div>"
    + "<div style='margin-top:6px'><button class='wgBtn' id='wgUndo'>Undo (Ctrl+Z)</button></div>"
    + "<h4>Players</h4><div id='wgPlayers'></div>"
    + "<div id='wgStatus'></div>"
    + "<div id='wgHelp'>Right-drag, middle-drag or hold Space to pan. Mouse wheel zooms. Lines snap straight; hold Shift for any angle. Portal: click the start tile, switch layer if needed, then click the destination. The green ring is the layer's spawn point. Red crossed tiles are invisible barriers that players cannot see.</div>";
  document.body.appendChild(panel);
  WG.panel = panel;

  document.getElementById("wgGo").addEventListener("click", () => gmGoLayer(document.getElementById("wgLayerNum").value));
  document.getElementById("wgPrev").addEventListener("click", () => gmGoLayer(WG.layer - 1));
  document.getElementById("wgNext").addEventListener("click", () => gmGoLayer(WG.layer + 1));
  document.getElementById("wgSetName").addEventListener("click", () => gmSend({ type: "gm_layername", layer: WG.layer, name: document.getElementById("wgName").value }));
  document.getElementById("wgUndo").addEventListener("click", gmUndo);
  document.querySelectorAll("[data-wgtool]").forEach((b) => b.addEventListener("click", () => gmSetTool(b.getAttribute("data-wgtool"))));
  document.querySelectorAll("[data-wgshape]").forEach((b) => b.addEventListener("click", () => gmSetShape(b.getAttribute("data-wgshape"))));
  panel.querySelectorAll("input[type=text],input[type=number]").forEach((input) => {
    input.addEventListener("focus", () => { chatActive = true; });
    input.addEventListener("blur", () => { chatActive = false; });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.id === "wgLayerNum") gmGoLayer(input.value);
    });
  });
}

function gmBuildAssetButtons(list) {
  worldAssetList = list;
  const tileBox = document.getElementById("wgTileList");
  const objBox = document.getElementById("wgObjList");
  tileBox.innerHTML = "";
  objBox.innerHTML = "";
  const build = (box, kind, names) => {
    if (names.length === 0) {
      box.textContent = "No pictures found in assets/" + (kind === "tile" ? "tilemap" : "objects") + ".";
      return;
    }
    for (const name of names) {
      const btn = document.createElement("button");
      btn.className = "wgAsset";
      btn.setAttribute("data-wgasset", kind + ":" + name);
      const img = document.createElement("img");
      img.src = worldAssetUrl(kind, name);
      const label = document.createElement("span");
      label.textContent = name;
      btn.appendChild(img);
      btn.appendChild(label);
      btn.addEventListener("click", () => {
        if (kind === "tile") WG.tileName = name;
        else WG.objName = name;
        gmSetTool(kind);
      });
      box.appendChild(btn);
    }
  };
  build(tileBox, "tile", list.tiles || []);
  build(objBox, "object", list.objects || []);
  gmRefreshAssetHighlight();
}

function enterGmWorld(scene) {
  worldGmMode = true;
  isGM = true;
  window.worldGmActive = true;
  player.setVisible(false);
  const cam = scene.cameras.main;
  cam.stopFollow();
  cam.removeBounds();
  cam.setZoom(0.5);
  if (mapGraphics) mapGraphics.clear();
  WG.rows = blankRows();
  WG.art = blankRows();
  WG.previewGfx = scene.add.graphics();
  WG.previewGfx.setDepth(60);
  WG.markerGfx = scene.add.graphics();
  WG.markerGfx.setDepth(55);
  gmDrawGrid(scene);
  gmBuildPanel();
  fetch("/api/world/assets").then((r) => r.json()).then(gmBuildAssetButtons).catch(() => {
    document.getElementById("wgTileList").textContent = "Could not load the picture list.";
    document.getElementById("wgObjList").textContent = "";
  });
  scene.input.mouse.disableContextMenu();
  scene.input.on("pointerdown", (pointer) => gmPointerDown(scene, pointer));
  scene.input.on("pointermove", (pointer) => gmPointerMove(scene, pointer));
  scene.input.on("pointerup", (pointer) => gmPointerUp(scene, pointer));
  scene.input.on("wheel", (pointer, over, dx, dy) => {
    let z = cam.zoom * (dy > 0 ? 0.9 : 1.1);
    if (z < 0.12) z = 0.12;
    if (z > 2.5) z = 2.5;
    cam.setZoom(z);
  });
  window.addEventListener("keydown", (e) => {
    if (chatActive) return;
    if (e.code === "Space") { gmSpaceDown = true; e.preventDefault(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { gmUndo(); e.preventDefault(); }
    if (e.key === "Escape") {
      WG.portalSource = null;
      WG.tpTarget = null;
      gmDrawMarkers();
      gmRenderPlayers();
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") gmSpaceDown = false;
  });
  updateReadout("World editor");
}

function gmLoadLayer(scene, data) {
  const firstLoad = !WG.loaded;
  WG.loaded = true;
  WG.layer = data.layer;
  WG.name = data.name || "";
  WG.rows = blankRows();
  for (let r = 0; r < WORLD_ROWS && r < data.rows.length; r++) {
    WG.rows[r] = String(data.rows[r]).padEnd(WORLD_COLS, " ").slice(0, WORLD_COLS);
  }
  WG.art = blankRows();
  for (let r = 0; r < WORLD_ROWS && data.art && r < data.art.length; r++) {
    WG.art[r] = String(data.art[r]).padEnd(WORLD_COLS, " ").slice(0, WORLD_COLS);
  }
  WG.palette = data.palette || {};
  WG.objects = {};
  for (const o of data.objects || []) {
    WG.objects[o[0] + "," + o[1]] = { name: o[2], solid: o[3] !== 0 };
  }
  WG.artDirty = true;
  WG.portals = data.portals || {};
  WG.spawn = data.spawn || null;
  WG.layers = data.layers || WG.layers;
  gmRedrawAll(scene);
  gmDrawMarkers();
  worldSyncItems(scene, data.floorItems);
  gmSyncPlayerSprites(scene);
  document.getElementById("wgLayerNum").value = WG.layer;
  document.getElementById("wgName").value = WG.name;
  gmRenderLayers();
  gmRenderPlayers();
  if (firstLoad) {
    const target = WG.spawn || { col: 32, row: 22 };
    scene.cameras.main.centerOn(target.col * TILE + TILE / 2, target.row * TILE + TILE / 2);
  }
  gmUpdateHoverStatus();
}

window.worldHook = function (scene, data) {
  if (data.type === "init" && data.world) {
    if (data.role === "gm") {
      enterGmWorld(scene);
      return true;
    }
    enterPlayerWorld(scene);
    return false;
  }

  if (worldPlayerMode) {
    if (data.type === "view") {
      drawPlayerView(scene, data);
      return true;
    }
    if (data.type === "teleport") {
      player.col = data.col;
      player.row = data.row;
      player.direction = data.direction || player.direction;
      player.x = tilePixelX(player.col);
      player.y = playerRestingY(player.col, player.row);
      player.play(DEX + "_idle_" + player.direction);
      for (const id of Object.keys(otherPlayers)) removeOtherPlayer(id);
      for (const p of data.players) {
        if (p.id !== myId) addOtherPlayer(scene, p);
      }
      state = "input";
      updateReadout("layer " + data.layer);
      return true;
    }
    return false;
  }

  if (worldGmMode) {
    if (data.type === "gm_layer") {
      gmLoadLayer(scene, data);
      return true;
    }
    if (data.type === "gm_tiles") {
      if (data.layer === WG.layer) {
        gmApplyTiles(scene, data.cells);
        gmUpdateHoverStatus();
      }
      return true;
    }
    if (data.type === "gm_art") {
      if (data.layer === WG.layer) {
        gmApplyArt(scene, data.cells);
        gmUpdateHoverStatus();
      }
      return true;
    }
    if (data.type === "gm_objs") {
      if (data.layer === WG.layer) {
        gmApplyObjs(scene, data.cells);
        gmUpdateHoverStatus();
      }
      return true;
    }
    if (data.type === "gm_layers") {
      WG.layers = data.layers;
      gmRenderLayers();
      return true;
    }
    if (data.type === "gm_players") {
      WG.players = {};
      for (const p of data.players) WG.players[p.id] = p;
      gmRenderPlayers();
      gmSyncPlayerSprites(scene);
      return true;
    }
    if (data.type === "gm_player") {
      gmUpdatePlayer(scene, data.player);
      return true;
    }
    if (data.type === "gm_player_leave") {
      delete WG.players[data.id];
      removeOtherPlayer(data.id);
      gmRenderPlayers();
      return true;
    }
    return false;
  }

  return false;
};