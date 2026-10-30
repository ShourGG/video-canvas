(() => {
"use strict";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const imgUrl = (name, file) => `/img/${encodeURIComponent(name)}/${encodeURIComponent(file)}`;
const mediaUrl = (job, file) => `/video-media/${job.id}/${encodeURIComponent(file)}`;
const LABELS = { queued: "排队中", running: "生成中", waiting: "等待续查", paused: "已暂停", needs_review: "提交待核对", completed: "已完成", failed: "失败" };
const PENDING = new Set(["queued", "running", "waiting", "paused", "needs_review"]);
const COLORS = { yellow: "#fff3a8", blue: "#cfe6ff", green: "#d4f5d0", pink: "#ffd6e2" };
const VIEWS = ["正面半身像", "全身像", "侧面半身像", ""];
const REF_HINT = "参考图中是同一个人物，保持脸型和五官长相一致";
const ROW = 340, CHAR_GAP = 330, SHOT_X = 420, FRAME_DX = 420, VIDEO_DX = 840, SCENE_X = -420, SCENE_GAP = 280;
const SCENE_PREFIX = "真人古装电视剧场景设定图，写实摄影，电影感画面，自然光，高清";
const SCENE_NEGATIVE = "字幕、文字、水印、动漫、卡通、3D渲染、游戏CG";
const isScene = c => c?.kind === "scene";

const viewport = $("viewport"), world = $("world"), nodesLayer = $("nodes");
let state = { config: {} }, chars = [], latest = {}, shots = [], jobs = [];
let board = { pos: {}, frameChoice: {}, videoChoice: {}, notes: [], links: [] };
let view = JSON.parse(localStorage.getItem("canvasView") || "null") || { x: 80, y: 80, z: 0.6 };
const selection = new Set();
const els = new Map(), sigs = new Map();
const charRunning = new Set();
let inspected = null, saveChain = Promise.resolve(), gesture = null;

async function api(path, body) {
  const opts = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || res.statusText); e.status = res.status; throw e; }
  return data;
}

function toast(msg, isError) {
  const t = $("toast");
  t.textContent = msg;
  t.className = isError ? "error" : "";
  t.style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.style.display = "none"; }, isError ? 7000 : 3000);
}

let boardTimer = 0;
function saveBoard() {
  clearTimeout(boardTimer);
  boardTimer = setTimeout(() => api("/api/canvas", board).catch(e => toast("画布保存失败：" + e.message, true)), 500);
}

const saveChars = () => api("/api/characters", chars).catch(e => toast("角色保存失败：" + e.message, true));

function saveShot(shot) {
  // 串行保存，避免较早的保存覆盖较新的修改
  const op = saveChain.catch(() => {}).then(() => api("/api/shots", { shot }));
  saveChain = op;
  return op.then(({ shot: saved }) => {
    const i = shots.findIndex(s => s.id === saved.id);
    if (i < 0) shots.push(saved); else shots[i] = saved;
    renderAll();
    return saved;
  }, e => { toast("保存分镜失败：" + e.message, true); throw e; });
}

const shotById = id => shots.find(s => s.id === id);
const charByName = name => chars.find(c => c.name === name);
const keyOf = id => id.slice(id.indexOf(":") + 1);
const shotJobs = id => jobs.filter(j => j.shot_id === id);
const framesOf = id => shotJobs(id).filter(j => j.frame_file && !j.stages?.frame?.source_job);
const videosOf = id => shotJobs(id).filter(j => j.video_file);
const pendingOf = id => shotJobs(id).find(j => PENDING.has(j.status));
const pick = (list, key, id) => list.find(j => j.id === board[key][id]) || list[0];
const noteOf = id => board.notes.find(n => "note:" + n.id === id);

function nodeList() {
  const used = new Set(shots.flatMap(s => [...(s.characters || []), ...(s.scenes || [])]));
  const list = [];
  for (const c of chars) if (used.has(c.name) || board.pos["char:" + c.name]) list.push({ id: "char:" + c.name, type: isScene(c) ? "scene" : "char", c });
  for (const s of [...shots].sort((a, b) => a.number - b.number)) {
    list.push({ id: "shot:" + s.id, type: "shot", s }, { id: "frame:" + s.id, type: "frame", s }, { id: "video:" + s.id, type: "video", s });
  }
  for (const n of board.notes) list.push({ id: "note:" + n.id, type: "note", n });
  return list;
}

function getPos(id) {
  if (id.startsWith("note:")) { const n = noteOf(id); return n ? [n.x, n.y] : null; }
  return board.pos[id] || null;
}

function setPos(id, x, y) {
  if (id.startsWith("note:")) { const n = noteOf(id); if (n) { n.x = x; n.y = y; } }
  else board.pos[id] = [x, y];
}

function ensurePositions(list) {
  const ysOf = type => list.filter(n => n.type === type && board.pos[n.id]).map(n => board.pos[n.id][1]);
  const shotYs = ysOf("shot"), charYs = ysOf("char"), sceneYs = ysOf("scene");
  let shotY = shotYs.length ? Math.max(...shotYs) + ROW : 0;
  let charY = charYs.length ? Math.max(...charYs) + CHAR_GAP : 0;
  let sceneY = sceneYs.length ? Math.max(...sceneYs) + SCENE_GAP : 0;
  let changed = false;
  for (const n of list) {
    if (n.type === "char" && !board.pos[n.id]) { board.pos[n.id] = [0, charY]; charY += CHAR_GAP; changed = true; }
    if (n.type === "scene" && !board.pos[n.id]) { board.pos[n.id] = [SCENE_X, sceneY]; sceneY += SCENE_GAP; changed = true; }
    if (n.type !== "shot") continue;
    if (!board.pos[n.id]) { board.pos[n.id] = [SHOT_X, shotY]; shotY += ROW; changed = true; }
    const [x, y] = board.pos[n.id];
    if (!board.pos["frame:" + n.s.id]) { board.pos["frame:" + n.s.id] = [x + FRAME_DX, y]; changed = true; }
    if (!board.pos["video:" + n.s.id]) { board.pos["video:" + n.s.id] = [x + VIDEO_DX, y]; changed = true; }
  }
  if (changed) saveBoard();
}

function shotStatus(id) {
  const j = shotJobs(id)[0];
  if (j && PENDING.has(j.status)) {
    const pct = typeof j.progress === "number" ? ` ${j.progress}%` : "";
    return { cls: "run", text: `${LABELS[j.status]} · ${j.stage === "video" ? "视频" : "首帧"}${pct}` };
  }
  if (j?.status === "failed") return { cls: "err", text: "上次失败", title: j.error };
  if (videosOf(id).length) return { cls: "ok", text: "已出视频" };
  if (framesOf(id).length) return { cls: "", text: "已出首帧" };
  return { cls: "", text: "待制作" };
}

function overlayText(n) {
  if (n.type === "char" || n.type === "scene") return charRunning.has(n.c.name) ? "生成中…" : "";
  if (n.type !== "frame" && n.type !== "video") return "";
  const p = pendingOf(n.s.id);
  if (!p) return "";
  const pct = typeof p.progress === "number" ? ` ${p.progress}%` : "";
  const stage = p.stage === "video" ? "video" : "frame";
  if (stage === n.type) return LABELS[p.status] + pct;
  return n.type === "video" && p.action !== "frame" ? "等首帧完成" : "";
}

function nodeHTML(n) {
  if (n.type === "scene") {
    const c = n.c, thumb = c.portrait || latest[c.name];
    return `<div class="node-head"><span class="tag">场景</span><span class="grow">${esc(c.name)}</span></div>
      <div class="media-box">${thumb ? `<img src="${imgUrl(c.name, thumb)}" draggable="false" loading="lazy">` : `<div class="placeholder">还没有图</div>`}</div>
      <div class="node-sub">${c.portrait ? esc(c.role) : `<span class="warn">未选场景图</span> · 双击生成`}</div>`;
  }
  if (n.type === "char") {
    const c = n.c, thumb = c.portrait || latest[c.name];
    return `<div class="node-head"><span class="tag">角色</span><span class="grow">${esc(c.name)}</span></div>
      ${thumb ? `<img class="portrait" src="${imgUrl(c.name, thumb)}" draggable="false" loading="lazy">` : `<div class="portrait empty">还没有图</div>`}
      <div class="node-sub">${c.portrait ? esc(c.role) : `<span class="warn">未设定妆照</span> · 双击生成`}</div>`;
  }
  if (n.type === "shot") {
    const s = n.s, st = shotStatus(s.id), busy = pendingOf(s.id) ? "disabled" : "";
    return `<div class="node-head"><span class="tag">镜 ${esc(s.number)}</span><span class="grow">${esc(s.title)}</span><span class="dur">${esc(s.duration)}秒</span></div>
      <span class="badge ${st.cls}" title="${esc(st.title || "")}">${esc(st.text)}</span>
      <div class="node-text">${esc(s.frame_prompt || "（还没写首帧画面，双击编辑）")}</div>
      ${s.dialogue ? `<div class="node-dialog">${esc(s.dialogue)}</div>` : ""}
      <div class="node-actions"><button data-act="frame" ${busy}>生成首帧</button><button class="primary" data-act="both" ${busy}>首帧→视频</button></div>`;
  }
  if (n.type === "frame") {
    const s = n.s, frames = framesOf(s.id), f = pick(frames, "frameChoice", s.id), busy = pendingOf(s.id);
    return `<div class="node-head"><span class="tag">首帧</span><span class="grow">镜 ${esc(s.number)}${f ? ` · 第 ${frames.indexOf(f) + 1}/${frames.length} 版` : ""}</span></div>
      <div class="media-box">${f ? `<img src="${mediaUrl(f, f.frame_file)}" draggable="false" loading="lazy">` : `<div class="placeholder">还没有首帧</div>`}</div>
      <div class="node-actions">${frames.length > 1 ? `<button data-act="prevFrame">‹</button><button data-act="nextFrame">›</button>` : ""}
        <button data-act="frame" ${busy ? "disabled" : ""}>${f ? "再出一版" : "生成首帧"}</button>
        <button class="primary" data-act="video" ${!f || busy ? "disabled" : ""}>用这版生成视频</button></div>`;
  }
  if (n.type === "video") {
    const s = n.s, videos = videosOf(s.id), v = pick(videos, "videoChoice", s.id);
    return `<div class="node-head"><span class="tag">视频</span><span class="grow">镜 ${esc(s.number)}${v ? ` · 第 ${videos.indexOf(v) + 1}/${videos.length} 版` : ""}</span></div>
      <div class="media-box">${v ? `<video controls playsinline preload="none" poster="${v.frame_file ? mediaUrl(v, v.frame_file) : ""}" src="${mediaUrl(v, v.video_file)}"></video>` : `<div class="placeholder">还没有视频</div>`}</div>
      <div class="node-actions">${videos.length > 1 ? `<button data-act="prevVideo">‹</button><button data-act="nextVideo">›</button>` : ""}
        ${v ? `<a href="${mediaUrl(v, v.video_file)}" download="${esc(s.id)}.mp4">下载</a>` : `<span class="muted">首帧确定后生成</span>`}</div>`;
  }
  return `<div class="node-head">便签</div><div class="note-text" contenteditable="true" spellcheck="false">${esc(n.n.text)}</div>
    <div class="note-colors">${Object.entries(COLORS).map(([k, c]) => `<i data-color="${k}" style="background:${c}"></i>`).join("")}</div>`;
}
function renderAll() {
  const list = nodeList();
  ensurePositions(list);
  const alive = new Set();
  for (const n of list) {
    alive.add(n.id);
    let el = els.get(n.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "node " + n.type;
      el.dataset.id = n.id;
      el.innerHTML = `<div class="body"></div><div class="overlay"></div><div class="port in"></div><div class="port out"></div>`;
      nodesLayer.append(el);
      els.set(n.id, el);
    }
    const [x, y] = getPos(n.id);
    el.style.left = x + "px";
    el.style.top = y + "px";
    el.classList.toggle("selected", selection.has(n.id));
    if (n.type === "note") el.style.background = COLORS[n.n.color] || COLORS.yellow;
    const html = nodeHTML(n);
    const editing = n.type === "note" && el.contains(document.activeElement);
    if (sigs.get(n.id) !== html && !editing) { el.firstElementChild.innerHTML = html; sigs.set(n.id, html); }
    el.children[1].textContent = overlayText(n);
  }
  for (const [id, el] of els) if (!alive.has(id)) { el.remove(); els.delete(id); sigs.delete(id); selection.delete(id); }
  drawEdges();
  updateToolbar();
}

function edgeList() {
  const list = [];
  for (const s of shots) {
    for (const name of s.characters || []) list.push({ id: `edge:c:${name}|${s.id}`, from: "char:" + name, to: "shot:" + s.id, kind: "data", cls: "data", field: "characters", shot: s.id, name });
    for (const name of s.scenes || []) list.push({ id: `edge:s:${name}|${s.id}`, from: "char:" + name, to: "shot:" + s.id, kind: "data", cls: "data scene", field: "scenes", shot: s.id, name });
    list.push({ id: "edge:sf:" + s.id, from: "shot:" + s.id, to: "frame:" + s.id, kind: "flow" });
    list.push({ id: "edge:fv:" + s.id, from: "frame:" + s.id, to: "video:" + s.id, kind: "flow" });
  }
  for (const l of board.links) list.push({ id: "edge:l:" + l.id, from: l.from, to: l.to, kind: "free", link: l });
  return list;
}

function anchor(id, side) {
  const el = els.get(id), p = getPos(id);
  if (!el || !p) return null;
  return [p[0] + (side === "out" ? el.offsetWidth : 0), p[1] + el.offsetHeight / 2];
}

function curve(a, b) {
  const dx = Math.max(60, Math.abs(b[0] - a[0]) / 2);
  return `M${a[0]},${a[1]} C${a[0] + dx},${a[1]} ${b[0] - dx},${b[1]} ${b[0]},${b[1]}`;
}

function drawEdges() {
  let html = "";
  for (const e of edgeList()) {
    const a = anchor(e.from, "out"), b = anchor(e.to, "in");
    if (!a || !b) continue;
    const d = curve(a, b);
    const cls = `edge ${e.cls || e.kind}${selection.has(e.from) || selection.has(e.to) ? " hl" : ""}${selection.has(e.id) ? " sel" : ""}`;
    html += `<path class="${cls}" d="${d}" marker-end="url(#arrow)"/>`;
    if (e.kind !== "flow") html += `<path class="hit" d="${d}" data-edge="${esc(e.id)}"/>`;
  }
  $("edgeLayer").innerHTML = html;
}

let edgeFrame = 0;
const scheduleEdges = () => { if (!edgeFrame) edgeFrame = requestAnimationFrame(() => { edgeFrame = 0; drawEdges(); }); };

function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  const g = 24 * view.z;
  viewport.style.backgroundSize = `${g}px ${g}px`;
  viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
  $("zoomLabel").textContent = Math.round(view.z * 100) + "%";
  clearTimeout(applyView.timer);
  applyView.timer = setTimeout(() => localStorage.setItem("canvasView", JSON.stringify(view)), 300);
}

function zoomAt(sx, sy, z) {
  z = Math.min(2.5, Math.max(0.08, z));
  const wx = (sx - view.x) / view.z, wy = (sy - view.y) / view.z;
  view = { x: sx - wx * z, y: sy - wy * z, z };
  applyView();
}

const toWorld = (sx, sy) => [(sx - view.x) / view.z, (sy - view.y) / view.z];

function fitTo(ids, maxZ = 1) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const id of ids) {
    const el = els.get(id), p = getPos(id);
    if (!el || !p) continue;
    x1 = Math.min(x1, p[0]); y1 = Math.min(y1, p[1]);
    x2 = Math.max(x2, p[0] + el.offsetWidth); y2 = Math.max(y2, p[1] + el.offsetHeight);
  }
  if (x1 === Infinity) return;
  const pad = 70, w = innerWidth - (inspected ? 400 : 0), h = innerHeight;
  const z = Math.max(0.08, Math.min(maxZ, (w - pad * 2) / (x2 - x1), (h - pad * 2) / (y2 - y1)));
  view = { z, x: (w - (x2 - x1) * z) / 2 - x1 * z, y: (h - (y2 - y1) * z) / 2 - y1 * z };
  applyView();
}

function selectOnly(id) { selection.clear(); if (id) selection.add(id); }

viewport.addEventListener("pointerdown", e => {
  if (e.button === 1) { e.preventDefault(); beginPan(e, false); return; }
  if (e.button !== 0) return;
  const port = e.target.closest(".port.out");
  if (port) { beginLink(e, port.parentElement.dataset.id); return; }
  const hit = e.target.closest("[data-edge]");
  if (hit) {
    if (!e.shiftKey) selection.clear();
    selection.add(hit.dataset.edge);
    renderAll();
    return;
  }
  const nodeEl = e.target.closest(".node");
  if (nodeEl) {
    const id = nodeEl.dataset.id;
    if (e.target.closest(".note-text")) { if (!selection.has(id)) { selectOnly(id); renderAll(); } return; }
    if (e.target.closest("button, a, input, textarea, select, video, .note-colors")) return;
    if (e.shiftKey) { if (selection.has(id)) selection.delete(id); else selection.add(id); }
    else if (!selection.has(id)) selectOnly(id);
    renderAll();
    beginMove(e);
    return;
  }
  if (e.shiftKey) beginBox(e); else beginPan(e, true);
});

function capture(e, g) { viewport.setPointerCapture(e.pointerId); gesture = { sx: e.clientX, sy: e.clientY, moved: false, ...g }; }

function beginPan(e, clickClears) {
  viewport.classList.add("panning");
  capture(e, { type: "pan", vx: view.x, vy: view.y, clickClears });
}

function beginMove(e) {
  const start = {};
  for (const id of selection) { const p = getPos(id); if (p) start[id] = [...p]; }
  capture(e, { type: "move", start });
}

function beginBox(e) {
  capture(e, { type: "box", base: new Set(selection) });
  Object.assign($("box").style, { left: e.clientX + "px", top: e.clientY + "px", width: "0px", height: "0px" });
  $("box").hidden = false;
}

function beginLink(e, from) { capture(e, { type: "link", from, target: null }); }

viewport.addEventListener("pointermove", e => {
  const g = gesture;
  if (!g) return;
  const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
  if (Math.abs(dx) + Math.abs(dy) > 3) g.moved = true;
  if (g.type === "pan") {
    view.x = g.vx + dx;
    view.y = g.vy + dy;
    applyView();
  } else if (g.type === "move") {
    for (const [id, [x, y]] of Object.entries(g.start)) {
      const nx = Math.round(x + dx / view.z), ny = Math.round(y + dy / view.z);
      setPos(id, nx, ny);
      const el = els.get(id);
      if (el) { el.style.left = nx + "px"; el.style.top = ny + "px"; }
    }
    scheduleEdges();
  } else if (g.type === "box") {
    const x = Math.min(e.clientX, g.sx), y = Math.min(e.clientY, g.sy), w = Math.abs(dx), h = Math.abs(dy);
    Object.assign($("box").style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
    const [wx1, wy1] = toWorld(x, y), [wx2, wy2] = toWorld(x + w, y + h);
    selection.clear();
    g.base.forEach(id => selection.add(id));
    for (const [id, el] of els) {
      const p = getPos(id);
      if (p && p[0] < wx2 && p[0] + el.offsetWidth > wx1 && p[1] < wy2 && p[1] + el.offsetHeight > wy1) selection.add(id);
    }
    for (const [id, el] of els) el.classList.toggle("selected", selection.has(id));
    scheduleEdges();
    updateToolbar();
  } else if (g.type === "link") {
    $("tempLink").setAttribute("d", curve(anchor(g.from, "out"), toWorld(e.clientX, e.clientY)));
    const t = document.elementFromPoint(e.clientX, e.clientY)?.closest(".node");
    const target = t && t.dataset.id !== g.from ? t : null;
    if (target !== g.target) { g.target?.classList.remove("link-target"); g.target = target; target?.classList.add("link-target"); }
  }
});

viewport.addEventListener("pointerup", () => {
  const g = gesture;
  gesture = null;
  viewport.classList.remove("panning");
  if (!g) return;
  if (g.type === "pan" && !g.moved && g.clickClears && selection.size) { selection.clear(); renderAll(); }
  if (g.type === "move" && g.moved) saveBoard();
  if (g.type === "box") $("box").hidden = true;
  if (g.type === "link") {
    $("tempLink").setAttribute("d", "");
    g.target?.classList.remove("link-target");
    if (g.target) connect(g.from, g.target.dataset.id);
  }
});

viewport.addEventListener("wheel", e => {
  e.preventDefault();
  if (e.shiftKey) { view.x -= e.deltaY; applyView(); return; }
  zoomAt(e.clientX, e.clientY, view.z * Math.exp(-e.deltaY * 0.0015));
}, { passive: false });

viewport.addEventListener("dblclick", e => {
  // 拖动时设置了指针捕获，dblclick 的 target 会变成 viewport，只能按坐标取真实元素
  const target = document.elementFromPoint(e.clientX, e.clientY) || e.target;
  if (target.closest("[data-edge]")) return;
  const el = target.closest(".node");
  if (!el) { const [x, y] = toWorld(e.clientX, e.clientY); addNote(x, y); return; }
  if (el.classList.contains("note") || target.closest("button, a, video, input, textarea, select")) return;
  openInspector(el.dataset.id);
});
nodesLayer.addEventListener("click", e => {
  const el = e.target.closest(".node");
  if (!el) return;
  const id = el.dataset.id;
  const color = e.target.closest("[data-color]");
  if (color) { noteOf(id).color = color.dataset.color; renderAll(); saveBoard(); return; }
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) return;
  const shotId = keyOf(id);
  if (["frame", "both", "video"].includes(act)) submit(shotId, act);
  else if (act === "prevFrame" || act === "nextFrame") cycle("frameChoice", framesOf(shotId), shotId, act === "prevFrame" ? -1 : 1);
  else if (act === "prevVideo" || act === "nextVideo") cycle("videoChoice", videosOf(shotId), shotId, act === "prevVideo" ? -1 : 1);
});

nodesLayer.addEventListener("focusout", e => {
  if (!e.target.classList?.contains("note-text")) return;
  const n = noteOf(e.target.closest(".node").dataset.id);
  const text = e.target.innerText.replace(/\n+$/, "");
  if (n && n.text !== text) { n.text = text; sigs.delete("note:" + n.id); saveBoard(); }
});

document.addEventListener("keydown", e => {
  if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelection(); }
  else if (e.key === "Escape") { selection.clear(); closeInspector(); renderAll(); }
});

function cycle(key, list, shotId, step) {
  if (!list.length) return;
  const i = (list.indexOf(pick(list, key, shotId)) + step + list.length) % list.length;
  board[key][shotId] = list[i].id;
  saveBoard();
  renderAll();
}

function addNote(x, y) {
  const n = { id: "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), x: Math.round(x), y: Math.round(y), text: "", color: "yellow" };
  board.notes.push(n);
  selectOnly("note:" + n.id);
  renderAll();
  saveBoard();
  els.get("note:" + n.id).querySelector(".note-text").focus();
}

async function connect(from, to) {
  if (from.startsWith("char:") && to.startsWith("shot:")) {
    const s = shotById(keyOf(to)), name = keyOf(from), scene = isScene(charByName(name));
    const field = scene ? "scenes" : "characters", list = s[field] || [];
    if (list.includes(name)) return;
    await saveShot({ ...s, [field]: [...list, name] }).catch(() => {});
    toast(scene ? `镜 ${s.number} 会用「${name}」的场景图作参考` : `已把 ${name} 加入镜 ${s.number}，生成时会用 ta 的定妆照作参考`);
    if (inspected === to) renderInspector();
    return;
  }
  if (board.links.some(l => l.from === from && l.to === to)) return;
  board.links.push({ id: "l" + Date.now().toString(36), from, to });
  saveBoard();
  renderAll();
}

async function deleteSelection() {
  const edges = edgeList();
  for (const id of [...selection]) {
    if (id.startsWith("note:")) {
      board.notes = board.notes.filter(n => "note:" + n.id !== id);
      board.links = board.links.filter(l => l.from !== id && l.to !== id);
    } else if (id.startsWith("edge:")) {
      const e = edges.find(x => x.id === id);
      if (e?.kind === "free") board.links = board.links.filter(l => l !== e.link);
      if (e?.kind === "data") {
        const s = shotById(e.shot);
        await saveShot({ ...s, [e.field]: (s[e.field] || []).filter(c => c !== e.name) }).catch(() => {});
        if (inspected === "shot:" + s.id) renderInspector();
      }
    } else if (id.startsWith("char:")) {
      const name = keyOf(id);
      if (shots.some(s => s.characters.includes(name) || (s.scenes || []).includes(name))) { toast(`${name} 还连着分镜，先删掉它连到分镜的线`, true); continue; }
      delete board.pos[id];
      board.links = board.links.filter(l => l.from !== id && l.to !== id);
    } else {
      toast("分镜、首帧、视频卡片不能从画布删除", true);
      continue;
    }
    selection.delete(id);
  }
  saveBoard();
  renderAll();
}

async function submit(shotId, action) {
  const f = pick(framesOf(shotId), "frameChoice", shotId);
  const payload = { shot_id: shotId, action, request_id: crypto.randomUUID() };
  if (action !== "frame" && f) payload.frame_job_id = f.id;
  try {
    const { job } = await api("/api/video/jobs", payload);
    jobs = [job, ...jobs.filter(j => j.id !== job.id)];
    renderAll();
    renderJobs();
    return true;
  } catch (e) {
    toast(`镜 ${shotById(shotId)?.number}：${e.message}`, true);
    return false;
  }
}

const selectedShotIds = () => [...new Set([...selection].filter(id => /^(shot|frame|video):/.test(id)).map(keyOf))];

function updateToolbar() {
  const n = selectedShotIds().length;
  $("btnBatch").disabled = !n;
  $("btnBatch").textContent = n ? `生成选中分镜（${n}）` : "生成选中分镜";
  const onCanvas = new Set([...els.keys()].filter(k => k.startsWith("char:")).map(keyOf));
  const opts = `<option value="">＋ 角色/场景…</option>` + chars.filter(c => !onCanvas.has(c.name)).map(c => `<option value="${esc(c.name)}">${isScene(c) ? "场景 · " : ""}${esc(c.name)}</option>`).join("");
  if ($("addChar").dataset.sig !== opts) { $("addChar").innerHTML = opts; $("addChar").dataset.sig = opts; }
}

$("btnBatch").onclick = async () => {
  const todo = selectedShotIds().filter(id => !pendingOf(id)).sort((a, b) => shotById(a).number - shotById(b).number);
  if (!todo.length) { toast("选中的分镜都在生成中", true); return; }
  if (!confirm(`将为 ${todo.length} 个分镜提交「首帧→视频」任务（已有首帧的会复用选定的那版）。\n后台按顺序生成，每个约 2 分钟，会消耗生成额度。确定吗？`)) return;
  $("btnBatch").disabled = true;
  let ok = 0;
  for (const id of todo) if (await submit(id, "both")) ok++;
  toast(`已提交 ${ok}/${todo.length} 个分镜，后台按顺序生成`, ok < todo.length);
  updateToolbar();
};

$("btnNote").onclick = () => { const [x, y] = toWorld(innerWidth / 2 - 115, innerHeight / 2 - 60); addNote(x, y); };

$("btnScene").onclick = async () => {
  const name = window.prompt("场景名（例如：山间驿站）")?.trim();
  if (!name) return;
  if (charByName(name)) { toast("已经有同名的角色或场景", true); return; }
  chars.push({ group: "场景", name, role: "场景", desc: "", portrait: "", kind: "scene" });
  await saveChars();
  const [x, y] = toWorld(innerWidth / 2 - 160, innerHeight / 2 - 120);
  board.pos["char:" + name] = [Math.round(x), Math.round(y)];
  selectOnly("char:" + name);
  saveBoard();
  renderAll();
  openInspector("char:" + name);
};

$("btnShot").onclick = async () => {
  const last = [...shots].sort((a, b) => b.number - a.number)[0];
  const saved = await saveShot({ title: "新分镜", chapter: last?.chapter || "新章节", duration: 5, size: "16:9", characters: [],
    scene: last?.scene || "", frame_prompt: "", video_prompt: "", dialogue: "", notes: "" }).catch(() => null);
  if (!saved) return;
  selectOnly("shot:" + saved.id);
  openInspector("shot:" + saved.id);
  fitTo(["shot:" + saved.id, "frame:" + saved.id, "video:" + saved.id], 0.9);
  renderAll();
};

$("addChar").onchange = () => {
  const name = $("addChar").value;
  if (!name) return;
  const [x, y] = toWorld(innerWidth / 2 - 85, innerHeight / 2 - 150);
  board.pos["char:" + name] = [Math.round(x), Math.round(y)];
  selectOnly("char:" + name);
  saveBoard();
  renderAll();
};

$("search").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  const q = $("search").value.trim();
  if (!q) return;
  const list = nodeList();
  const n = list.find(n => n.type === "shot" && String(n.s.number) === q) || list.find(n =>
    n.type === "shot" ? `${n.s.title} ${n.s.dialogue} ${n.s.frame_prompt}`.includes(q) :
    n.type === "char" || n.type === "scene" ? n.c.name.includes(q) : n.type === "note" ? n.n.text.includes(q) : false);
  if (!n) { toast("没找到：" + q, true); return; }
  selectOnly(n.id);
  renderAll();
  fitTo(n.type === "shot" ? [n.id, "frame:" + n.s.id, "video:" + n.s.id] : [n.id], 1);
});

$("zoomIn").onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, view.z * 1.25);
$("zoomOut").onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, view.z / 1.25);
$("zoomFit").onclick = () => fitTo([...els.keys()]);
function openInspector(id) {
  inspected = id.startsWith("char:") ? id : "shot:" + keyOf(id);
  $("inspector").hidden = false;
  renderInspector();
}

function closeInspector() { inspected = null; $("inspector").hidden = true; }

function renderInspector() {
  if (!inspected) return;
  if (inspected.startsWith("char:")) { const c = charByName(keyOf(inspected)); return c ? renderCharInspector(c) : closeInspector(); }
  const s = shotById(keyOf(inspected));
  return s ? renderShotInspector(s) : closeInspector();
}

function renderShotInspector(s) {
  const durations = [...new Set([5, 6, 10, s.duration])].sort((a, b) => a - b);
  const sceneList = s.scenes || [];
  const others = chars.filter(c => !isScene(c) && !s.characters.includes(c.name));
  const otherScenes = chars.filter(c => isScene(c) && !sceneList.includes(c.name));
  const chipsOf = (names, field) => names.map(name => {
    const c = charByName(name);
    return `<span class="chip">${c?.portrait ? `<img src="${imgUrl(name, c.portrait)}">` : ""}${esc(name)}${c?.portrait ? "" : `<span class="warn">（${field === "scenes" ? "未选图" : "未定妆"}）</span>`}<b data-remove="${esc(name)}" data-field="${field}" title="移出这个分镜">×</b></span>`;
  }).join("");
  const chips = chipsOf(s.characters, "characters");
  $("inspector").innerHTML = `
    <header><h3>镜 ${esc(s.number)} · ${esc(s.title)}</h3><button id="iClose" title="关闭">×</button></header>
    <div class="muted">${esc(s.chapter)} · ${esc(s.id)}</div>
    <label>标题</label><input type="text" data-f="title" value="${esc(s.title)}">
    <div class="row"><span>时长</span><select data-f="duration">${durations.map(d => `<option value="${d}" ${d === s.duration ? "selected" : ""}>${d} 秒</option>`).join("")}</select>
      <span>画幅</span><select data-f="size">${["16:9", "9:16", "1:1", "4:3", "3:4"].map(v => `<option ${v === s.size ? "selected" : ""}>${v}</option>`).join("")}</select></div>
    <label>出场角色（用各自的定妆照作参考；也可以在画布上从角色卡拖线到分镜卡）</label>
    <div class="chips">${chips || '<span class="muted">无</span>'}</div>
    <div class="row"><select id="iAddChar" class="wide"><option value="">＋ 添加角色…</option>${others.map(c => `<option>${esc(c.name)}</option>`).join("")}</select></div>
    <label>场景参考（用场景图保持布景一致；也可以从场景卡拖线到分镜卡）</label>
    <div class="chips">${chipsOf(sceneList, "scenes") || '<span class="muted">无</span>'}</div>
    <div class="row"><select id="iAddScene" class="wide"><option value="">＋ 添加场景…</option>${otherScenes.map(c => `<option>${esc(c.name)}</option>`).join("")}</select></div>
    <label>场景</label><textarea data-f="scene" rows="2">${esc(s.scene)}</textarea>
    <label>首帧画面（静态构图：谁在哪、什么景别）</label><textarea data-f="frame_prompt" rows="3">${esc(s.frame_prompt)}</textarea>
    <label>视频动作与运镜</label><textarea data-f="video_prompt" rows="3">${esc(s.video_prompt)}</textarea>
    <label>对白（每行“角色：台词”）</label><textarea data-f="dialogue" rows="3">${esc(s.dialogue)}</textarea>
    <label>备注</label><textarea data-f="notes" rows="2">${esc(s.notes)}</textarea>
    <div class="row"><button id="iPreview">查看最终提示词</button></div>
    <div id="iPrompts" class="prompt-text" hidden></div>
    <label>任务记录</label><div id="iJobs"></div>`;
  const read = () => {
    const d = { ...shotById(s.id) };
    for (const el of $("inspector").querySelectorAll("[data-f]")) d[el.dataset.f] = el.dataset.f === "duration" ? Number(el.value) : el.value;
    return d;
  };
  const setField = (field, list) => saveShot({ ...read(), [field]: list }).then(renderInspector, () => {});
  $("iClose").onclick = closeInspector;
  for (const el of $("inspector").querySelectorAll("[data-f]")) el.onchange = () => saveShot(read()).catch(() => {});
  $("iAddChar").onchange = () => { if ($("iAddChar").value) setField("characters", [...shotById(s.id).characters, $("iAddChar").value]); };
  $("iAddScene").onchange = () => { if ($("iAddScene").value) setField("scenes", [...(shotById(s.id).scenes || []), $("iAddScene").value]); };
  for (const b of $("inspector").querySelectorAll("[data-remove]")) {
    b.onclick = () => setField(b.dataset.field, (shotById(s.id)[b.dataset.field] || []).filter(c => c !== b.dataset.remove));
  }
  $("iPreview").onclick = async () => {
    try {
      const p = await api("/api/shots/preview", { shot: read() });
      $("iPrompts").textContent = `【首帧】\n${p.frame}\n\n【视频】\n${p.video}`;
      $("iPrompts").hidden = false;
    } catch (e) { toast(e.message, true); }
  };
  renderJobs();
}

function renderJobs() {
  if (!inspected?.startsWith("shot:") || !$("iJobs")) return;
  const list = shotJobs(keyOf(inspected));
  const kind = j => j.action === "frame" ? "只出首帧" : j.action === "video" ? "视频" : "首帧→视频";
  const html = list.length ? list.map(j => `<div class="job"><strong>${esc(LABELS[j.status] || j.status)}</strong> · ${kind(j)}${PENDING.has(j.status) && typeof j.progress === "number" ? ` · ${j.progress}%` : ""}
      <div class="muted">${esc(j.created_at)}${j.imported ? " · 恢复样片" : ""}</div>
      ${Object.entries(j.stages || {}).filter(([, st]) => st.task_id).map(([k, st]) => `<div class="muted">${k === "frame" ? "图片" : "视频"}任务：<code>${esc(st.task_id)}</code></div>`).join("")}
      ${j.error ? `<div class="job-error">${esc(j.error)}</div>` : ""}
      <div class="row">${["queued", "running", "waiting"].includes(j.status) ? `<button data-pause="${j.id}">暂停本机查询</button>` : ""}${["paused", "needs_review"].includes(j.status) ? `${j.status === "needs_review" ? `<input type="text" data-task-for="${j.id}" placeholder="原任务 ID（task_…）">` : ""}<button data-resume="${j.id}">续查原任务</button>` : ""}</div></div>`).join("")
    : '<div class="muted">还没有任务。</div>';
  const box = $("iJobs");
  if (box.dataset.sig === html || box.contains(document.activeElement)) return;
  box.dataset.sig = html;
  box.innerHTML = html;
}

$("inspector").addEventListener("click", async e => {
  const b = e.target.closest("[data-pause], [data-resume]");
  if (!b) return;
  const id = b.dataset.pause || b.dataset.resume;
  b.disabled = true;
  try {
    const taskId = $("inspector").querySelector(`[data-task-for="${id}"]`)?.value.trim() || "";
    await api(`/api/video/jobs/${id}/${b.dataset.pause ? "pause" : "resume"}`, { task_id: taskId });
    await refreshJobs();
  } catch (err) { toast(err.message, true); b.disabled = false; }
});

function renderCharInspector(c) {
  const scene = isScene(c);
  const withPortrait = chars.filter(x => x.portrait && isScene(x) === scene);
  const running = charRunning.has(c.name);
  $("inspector").innerHTML = `
    <header><h3>${esc(c.name)}</h3><button id="iClose" title="关闭">×</button></header>
    <div class="muted">${esc(c.group)} · ${esc(c.role)}</div>
    <label>${scene ? "场景描述（建筑、道具、时间、光线，改完点别处自动保存）" : "外貌描述（改完点别处自动保存）"}</label><textarea id="cDesc" rows="4">${esc(c.desc)}</textarea>
    <div class="row"><select id="cView" ${scene ? "hidden" : ""}>${VIEWS.map(v => `<option value="${v}">${v || "不指定视角"}</option>`).join("")}</select>
      <select id="cRef"><option value="">不用参考图</option>${withPortrait.map(x => `<option value="${esc(x.name)}" ${x.name === c.name ? "selected" : ""}>参考：${esc(x.name)}</option>`).join("")}</select></div>
    <div class="row"><span>数量</span><input id="cCount" type="number" min="1" max="4" value="2" style="width:64px">
      <button class="primary" id="cGen" ${running ? "disabled" : ""}>${scene ? "生成场景图" : "生成定妆照"}</button></div>
    <div id="cStatus">${running ? "正在生成，每张约 1 分钟…" : ""}</div>
    <div class="gallery" id="cGallery"></div>`;
  $("iClose").onclick = closeInspector;
  $("cDesc").onchange = () => { c.desc = $("cDesc").value.trim(); saveChars(); };
  $("cGen").onclick = () => genPortraits(c);
  $("cGallery").onclick = async e => {
    if (e.target.dataset.portrait) {
      c.portrait = e.target.dataset.portrait;
      await saveChars();
      renderAll();
      loadCharGallery(c);
    } else if (e.target.dataset.open) window.open(imgUrl(c.name, e.target.dataset.open));
  };
  loadCharGallery(c);
}

async function loadCharGallery(c) {
  const imgs = await api("/api/images?name=" + encodeURIComponent(c.name)).catch(() => []);
  if (inspected !== "char:" + c.name || !$("cGallery")) return;
  const label = isScene(c) ? "场景图" : "定妆照";
  $("cGallery").innerHTML = imgs.map(i => `<div class="card ${i.file === c.portrait ? "on" : ""}">
      <img src="${imgUrl(c.name, i.file)}" data-open="${esc(i.file)}" title="${esc(i.prompt)}" loading="lazy">
      <button data-portrait="${esc(i.file)}">${i.file === c.portrait ? "★ " + label : "设为" + label}</button></div>`).join("")
    || `<div class="muted">还没有图片，点「生成${label}」</div>`;
}

async function genPortraits(c) {
  const cfg = state.config, scene = isScene(c);
  const ref = charByName($("cRef").value);
  c.desc = $("cDesc").value.trim();
  const hint = ref ? (scene ? "参考图是同一个场景，保持建筑布局和陈设一致" : REF_HINT) : "";
  const negative = scene ? SCENE_NEGATIVE : cfg.negative;
  const prompt = [scene ? SCENE_PREFIX : cfg.prefix, scene ? "" : $("cView").value, hint, c.desc].filter(Boolean).join("，") + (negative ? "。画面中不要出现：" + negative : "");
  const count = Math.max(1, Math.min(4, parseInt($("cCount").value) || 1));
  const references = ref ? [{ name: ref.name, file: ref.portrait }] : [];
  const payload = { name: c.name, prompt, references, ...(scene ? { size: "16:9" } : {}) };
  await saveChars();
  charRunning.add(c.name);
  renderAll();
  if (inspected === "char:" + c.name) renderCharInspector(c);
  let done = 0;
  const errors = [];
  await Promise.all(Array.from({ length: count }, () => api("/api/generate", payload)
    .then(r => { done++; latest[c.name] = r.files[0]; renderAll(); if (inspected === "char:" + c.name) loadCharGallery(c); })
    .catch(e => errors.push(e.message))));
  charRunning.delete(c.name);
  renderAll();
  if (inspected === "char:" + c.name) renderCharInspector(c);
  const label = scene ? "场景图" : "定妆照";
  toast(errors.length ? `${c.name}：完成 ${done} 张，失败 ${errors.length} 张：${errors[0]}` : `${c.name}：生成完成 ${done} 张，去右侧挑一张设为${label}`, errors.length > 0);
}

async function refreshJobs() {
  try {
    jobs = (await api("/api/video/jobs")).jobs;
    renderAll();
    renderJobs();
  } catch (e) { /* 下一轮轮询会重试 */ }
}

async function reloadData() {
  try {
    const [st, sh] = await Promise.all([api("/api/state"), api("/api/shots")]);
    state = st; chars = st.characters; latest = st.latest || {}; shots = sh.shots;
    renderAll();
  } catch (e) { toast("刷新数据失败：" + e.message, true); }
}

(async () => {
  try {
    const [st, sh, jb, bd] = await Promise.all([api("/api/state"), api("/api/shots"), api("/api/video/jobs"), api("/api/canvas")]);
    state = st; chars = st.characters; latest = st.latest || {}; shots = sh.shots; jobs = jb.jobs;
    board = { pos: {}, frameChoice: {}, videoChoice: {}, notes: [], links: [], ...bd };
    applyView();
    renderAll();
    if (!localStorage.getItem("canvasView")) {
      const first = [...shots].sort((a, b) => a.number - b.number).slice(0, 3).flatMap(s => ["shot:", "frame:", "video:"].map(p => p + s.id));
      fitTo([...[...els.keys()].filter(k => k.startsWith("char:")), ...first], 0.9);
    }
    setInterval(refreshJobs, 3000);
    window.addEventListener("focus", reloadData);
  } catch (e) { toast("加载失败：" + e.message, true); }
})();
})();