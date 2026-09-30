/* fsrs / createEmptyCard / Rating / State 由 js/fsrs.js 以经典脚本方式提供。
   刻意不用 ES 模块 —— 浏览器在 file:// 下会按 CORS 拦截 type="module"，
   那样就必须起本地服务才能用；经典脚本没有这个限制，双击 index.html 即可运行。 */

/* ============================ 存储（IndexedDB，失败降级 localStorage） ============================ */
const DB_NAME = "jpvocab", DB_VER = 1;
const LSK = { cards: "jpvocab:cards", log: "jpvocab:log", kv: "jpvocab:kv", mode: "jpvocab:mode" };
let _db = null, _mode = null;

function openIDB() {
  return new Promise((res, rej) => {
    let done = false;
    let r;
    try { r = indexedDB.open(DB_NAME, DB_VER); } catch (e) { return rej(e); }
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("cards")) d.createObjectStore("cards", { keyPath: "id" });
      if (!d.objectStoreNames.contains("log")) d.createObjectStore("log", { autoIncrement: true });
      if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
    };
    r.onsuccess = () => { if (!done) { done = true; res(r.result); } };
    r.onerror = () => { if (!done) { done = true; rej(r.error || new Error("idb error")); } };
    r.onblocked = () => { if (!done) { done = true; rej(new Error("idb blocked")); } };
    // 冷启动首次建库在部分机器上会超过 3 秒；超时判死会让本会话静默降级 localStorage，
    // 而下个会话 IDB 又正常 → 两个库各存一份、互相看不见。所以超时给足 10 秒。
    setTimeout(() => { if (!done) { done = true; try { r.cancel && r.cancel(); } catch (e) { } rej(new Error("idb timeout")); } }, 10000);
  });
}
async function ensureStore() {
  if (_mode) return _mode;
  // 存储模式记忆：一旦某次真正用过 localStorage（IDB 被禁用/损坏），
  // 之后所有会话直接走 localStorage，避免「这会写 A 库、下会读 B 库」的数据分裂
  const remembered = lsGet(LSK.mode, null);
  if (remembered === "ls") { _mode = "ls"; return _mode; }
  try { _db = await openIDB(); _mode = "idb"; }
  catch (e) { _mode = "ls"; }
  lsSet(LSK.mode, _mode);
  if (_mode === "idb") await rescueFromLS();
  return _mode;
}
// 一次性救援：旧版本在 IDB 超时降级时可能把数据写进了 localStorage，
// 而 IDB 恢复后这些进度会"消失"。启动时把 ls 里的存量搬进 IDB。
async function rescueFromLS() {
  if (lsGet("jpvocab:migrated", 0)) return;
  lsSet("jpvocab:migrated", 1);
  try {
    const oldCards = lsGet(LSK.cards, null);
    const oldKV = lsGet(LSK.kv, null);
    const oldLog = lsGet(LSK.log, null);
    if (!oldCards || !Object.keys(oldCards).length) return;   // ls 里没有存量，无需搬
    const have = await tx("cards", "readonly", s => s.count());
    if (have > 0) return;                                     // IDB 里已有数据，不覆盖
    await tx("cards", "readwrite", s => { for (const c of Object.values(oldCards)) s.put(fixCard(c)); });
    if (oldKV && typeof oldKV === "object") await tx("kv", "readwrite", s => { for (const [k, v] of Object.entries(oldKV)) s.put(v, k); });
    if (Array.isArray(oldLog) && oldLog.length) await tx("log", "readwrite", s => { for (const r of oldLog) s.add(r); });
    setTimeout(() => toast("已找回之前存在浏览器里的学习进度"), 1500);
  } catch (e) { /* 救援失败不阻塞启动 */ }
}
function tx(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = _db.transaction(store, mode), s = t.objectStore(store), out = fn(s);
    // 必须统一返回 out.result（可能是 undefined）。之前写成
    // `out.result !== undefined ? out.result : out`，没查到时会把 IDBRequest 本身交出去，
    // 调用方拿它当真值用，既让 getKV 永远"读到了东西"，又会把它写回库里触发 DataCloneError。
    t.oncomplete = () => res(out && typeof out === "object" && "result" in out ? out.result : out);
    t.onerror = () => rej(t.error);
  });
}
const lsGet = (k, d) => { try { const s = localStorage.getItem(k); return s == null ? d : JSON.parse(s); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } };
// localStorage 里 Date 会退化成字符串，读回时还原，否则 FSRS 拿不到 due
const fixCard = c => {
  if (c && typeof c.due === "string") c.due = new Date(c.due);
  if (c && typeof c.last_review === "string") c.last_review = new Date(c.last_review);
  return c;
};

const Store = {
  async allCards() {
    if (await ensureStore() === "idb") return (await tx("cards", "readonly", s => s.getAll()) || []).map(fixCard);
    return Object.values(lsGet(LSK.cards, {})).map(fixCard);
  },
  async putCard(c) {
    if (await ensureStore() === "idb") return tx("cards", "readwrite", s => s.put(c));
    const o = lsGet(LSK.cards, {}); o[c.id] = c; lsSet(LSK.cards, o);
  },
  async delCard(id) {
    if (await ensureStore() === "idb") return tx("cards", "readwrite", s => s.delete(id));
    const o = lsGet(LSK.cards, {}); delete o[id]; lsSet(LSK.cards, o);
  },
  async addLog(r) {
    if (await ensureStore() === "idb") return tx("log", "readwrite", s => s.add(r));
    const a = lsGet(LSK.log, []); a.push(r); lsSet(LSK.log, a);
    return a.length - 1;
  },
  async popLog(key) {
    if (await ensureStore() === "idb") return tx("log", "readwrite", s => s.delete(key));
    const a = lsGet(LSK.log, []); a.pop(); lsSet(LSK.log, a);
  },
  async allLog() {
    if (await ensureStore() === "idb") return await tx("log", "readonly", s => s.getAll()) || [];
    return lsGet(LSK.log, []);
  },
  async getKV(k) {
    if (await ensureStore() === "idb") return await tx("kv", "readonly", s => s.get(k));
    return lsGet(LSK.kv, {})[k];
  },
  async setKV(k, v) {
    if (await ensureStore() === "idb") return tx("kv", "readwrite", s => s.put(v, k));
    const o = lsGet(LSK.kv, {}); o[k] = v; lsSet(LSK.kv, o);
  },
  async reset() {
    if (await ensureStore() === "idb") {
      await new Promise(r => {
        const t = _db.transaction(["cards", "log"], "readwrite");
        t.objectStore("cards").clear(); t.objectStore("log").clear(); t.oncomplete = r;
      });
    } else {
      try { localStorage.removeItem(LSK.cards); localStorage.removeItem(LSK.log); } catch (e) { }
    }
  },
};

/* ============================ 数据（classic script 按需注入，替代 fetch） ============================ */
const LEVELS = ["N5", "N4", "N3", "N2", "N1"];
// 分级方式：JLPT 等级 / 新标准日本语教材（初级上~高级下共 6 册、104 课）
const GRADINGS = [["jlpt", "JLPT 等级"], ["biaori", "新标日教材"]];
let WORDS = [], FAM = [], PAIRS = [], META = null, BR = null;
let famByKanji = new Map(), pairByWord = new Map();
let settings = {
  levels: ["N5", "N4", "N3", "N2", "N1"], vols: [0, 1, 2, 3, 4, 5], grading: "jlpt",
  newPerDay: 20, retention: 0.9, day: "", newDone: 0, mode: "recog", autoSpeak: "answer"
};
let OV = {};      // 用户自己改过的释义，覆盖词库默认值
const MODES = [["recog", "认读（日→中）"], ["listen", "听力（听→中）"], ["prod", "产出（中→日）"]];
// 自动朗读时机：认读时卡片一出现就读，等于把读音提前告诉你了，所以默认「翻面后读」
const SPEAKS = [["answer", "翻面后读"], ["always", "出现就读"], ["off", "不自动读"]];
const autoSpeak = () => settings.autoSpeak || "answer";

const KANJI_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const toHira = s => s.replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));

function loadDataFile(name) {
  const JV = window.JV || (window.JV = {});
  if (JV[name]) return Promise.resolve(JV[name]);
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "data/" + name + ".js";
    s.charset = "utf-8";
    s.onload = () => JV[name] ? res(JV[name]) : rej(new Error("数据为空: " + name));
    s.onerror = () => rej(new Error("无法加载 data/" + name + ".js"));
    document.head.appendChild(s);
  });
}

async function loadData() {
  // 两种分级方式共用同一份词库，所以一次性全加载（经典脚本注入，本地无请求开销）：
  // 5 个 JLPT 等级 + 教材数据（课号映射 + 词库缺、按教材补出来的词）+ 词族/动词对
  const [meta, br, extra, fam, pairs, ...parts] = await Promise.all([
    loadDataFile("meta"), loadDataFile("biaori"), loadDataFile("biaori-extra"),
    loadDataFile("families"), loadDataFile("pairs"),
    ...LEVELS.map(l => loadDataFile("vocab-" + l.toLowerCase())),
  ]);
  META = meta; BR = br; FAM = fam; PAIRS = pairs;
  WORDS = [];
  for (const p of parts) WORDS.push(...p);
  WORDS.push(...extra);      // 教材补词排在最后；教材模式会按课号重排，JLPT 模式不选它们
  famByKanji = new Map(FAM.map(f => [f.c, f]));
  for (const p of PAIRS) { pairByWord.set(p.vi, p); pairByWord.set(p.vt, p); }
}

/* ---------- 分级 / 教材范围 ---------- */
const grading = () => settings.grading === "biaori" ? "biaori" : "jlpt";
// 教材补词（JLPT 词库里没有、按新标日词表补进来的）id 统一带 br- 前缀
const isExtra = w => w.id.slice(0, 3) === "br-";
// 全书 104 课 → 第几册（vols 里是 [册名, 首课, 末课]）
function volIndexOf(lesson) {
  for (let i = 0; i < BR.vols.length; i++) if (lesson <= BR.vols[i][2]) return i;
  return BR.vols.length - 1;
}
// 卡片角标：教材模式显示「初级上·第5课」，JLPT 模式显示 N5
function lessonLabel(id) {
  const L = BR.m[id];
  if (!L) return "";
  const vi = volIndexOf(L);
  return BR.vols[vi][0] + "·第" + (L - BR.vols[vi][1] + 1) + "课";
}
// 当前词是否在本次学习范围内
function inPool(w) {
  if (grading() === "biaori") {
    const L = BR.m[w.id];
    return !!L && settings.vols.includes(volIndexOf(L));
  }
  return !isExtra(w) && settings.levels.includes(w.lv);
}

/* ============================ FSRS ============================ */
let f = null;
const scheduler = () => (f ||= fsrs({ request_retention: settings.retention, enable_fuzz: true }));

function fmtInterval(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return m <= 1 ? "1 分" : m + " 分";
  const h = Math.round(m / 60);
  if (h < 24) return h + " 小时";
  const d = Math.round(h / 24);
  if (d < 30) return d + " 天";
  if (d < 365) return (d / 30).toFixed(1) + " 月";
  return (d / 365).toFixed(1) + " 年";
}

/* ============================ 声调 ============================ */
const SMALL = "ゃゅょぁぃぅぇぉゎァィゥェォヮ";
function moras(kana) {
  const out = [];
  for (let i = 0; i < kana.length; i++) {
    const c = kana[i];
    if (SMALL.includes(c) && out.length) { out[out.length - 1] += c; continue; }
    out.push(c);
  }
  return out;
}
function pitchSVG(kana, accent) {
  const ms = moras(kana);
  if (accent < 0 || !ms.length) return "";
  // 手机端读图为主，步距和假名都放大（30→34 / 14→16）
  const N = ms.length, W = 20 + N * 34 + 34, hi = 14, lo = 38;
  const isHigh = i => accent === 0 ? i >= 2 : (accent === 1 ? i === 1 : i >= 2 && i <= accent);
  let p = "";
  for (let i = 1; i <= N; i++) {
    const x = 16 + (i - 1) * 34, y = isHigh(i) ? hi : lo;
    if (i > 1) {
      const px = 16 + (i - 2) * 34, py = isHigh(i - 1) ? hi : lo;
      p += `<line x1="${px}" y1="${py}" x2="${x}" y2="${y}" stroke="#1d9e75" stroke-width="2"/>`;
    }
    p += `<circle cx="${x}" cy="${y}" r="5" fill="${isHigh(i) ? "#1d9e75" : "#fff"}" stroke="#1d9e75" stroke-width="2"/>`;
    p += `<text x="${x}" y="${y + 23}" text-anchor="middle" font-size="16" fill="#6b6a65">${ms[i - 1]}</text>`;
  }
  const px = 16 + (N - 1) * 34, py = isHigh(N) ? hi : lo;
  const ax = 16 + N * 34, ay = accent === 0 ? hi : lo;
  p += `<line x1="${px}" y1="${py}" x2="${ax}" y2="${ay}" stroke="#1d9e75" stroke-width="2" stroke-dasharray="3 3"/>`;
  p += `<circle cx="${ax}" cy="${ay}" r="5" fill="none" stroke="#1d9e75" stroke-width="2" stroke-dasharray="2 2"/>`;
  return `<svg viewBox="0 0 ${W} 70" width="${W}" height="70" role="img" aria-label="声调型 ${accent}">${p}</svg>`;
}

/* ============================ 发音 ============================ */
let voice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices().filter(v => (v.lang || "").toLowerCase().startsWith("ja"));
  voice = vs.find(v => /google|apple|kyoko|otoya|ayumi|nanami/i.test(v.name)) || vs[0] || null;
}
if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ja-JP"; u.rate = 0.85;
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

/* ============================ 队列 ============================ */
let cards = new Map();      // id -> fsrs card
let queue = [], qi = 0, cur = null, shown = false;
let qTotal = 0;             // 本次队列的原始长度。撤销会把卡片塞回队列，直接读 queue.length 会虚加一张
// 本次（进学习页到现在）的统计，跑完队列时用来出小结
let session = null;
let welcomed = false;       // 首次使用那张说明卡是否已经关掉过
let appReady = false;       // 词库是否加载完毕（欢迎层跳转、开始按钮都要等它）
const newSession = () => ({ at: Date.now(), n: 0, by: { 1: 0, 2: 0, 3: 0, 4: 0 } });

/* 「一天」从凌晨 4 点算起，而不是 0 点 —— 和 Anki 一样。
   凌晨 1 点背完、2 点再打开，不该被当成新的一天，否则连续天数会断、每日新词上限会重置。
   另外一律用本地日期：toISOString() 是 UTC，东八区早上 8 点之前会算成前一天。 */
const DAY_START_H = 4;
function dayKey(v) {
  const t = (v instanceof Date ? v.getTime() : new Date(v).getTime()) - DAY_START_H * 3600e3;
  const d = new Date(t);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function today() { return dayKey(new Date()); }

async function refreshCards() {
  const arr = await Store.allCards();
  cards = new Map(arr.map(c => [c.id, c]));
}

function buildQueue() {
  const now = new Date();
  const due = [], fresh = [];
  for (const w of WORDS) {
    if (!inPool(w)) continue;
    const c = cards.get(w.id);
    if (!c) { fresh.push(w); continue; }
    if (c.state === State.New) { fresh.push(w); continue; }
    if (new Date(c.due) <= now) due.push({ w, due: new Date(c.due) });
  }
  due.sort((a, b) => a.due - b.due);
  // 教材模式：新词按课文顺序出（第1课→第104课），跟着教材走
  if (grading() === "biaori") fresh.sort((a, b) => (BR.m[a.id] || 9999) - (BR.m[b.id] || 9999));
  const budget = Math.max(0, settings.newPerDay - (settings.day === today() ? settings.newDone : 0));
  queue = [...due.map(x => ({ w: x.w, isNew: false })), ...fresh.slice(0, budget).map(w => ({ w, isNew: true }))];
  qi = 0;
}

function nextCard() {
  cur = queue[qi] || null;
  shown = false;
  if (!cur) { renderDone().catch(() => { }); return; }
  paintCard();
}

/* ============================ 学习界面 ============================ */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function familyHTML(w) {
  const out = [];
  for (const k of w.kj || []) {
    const fam = famByKanji.get(k);
    if (!fam) continue;
    const hit = fam.g.find(g => w.k.includes(toHira(g.on))) || fam.g[0];
    if (!hit) continue;
    const others = hit.ws.filter(x => x !== w.w).slice(0, 7);
    out.push(`<div class="famline"><b>${esc(k)}</b>（${esc(hit.on)}）${esc(fam.zh ? "· " + fam.zh : "")} → ${others.map(o => `<span class="w">${esc(o)}</span>`).join(" ")}</div>`);
  }
  return out.join("");
}
function pairHTML(w) {
  const p = pairByWord.get(w.w);
  if (!p) return "";
  return `<div class="prow">
    <div class="vi"><span class="lb">自动</span><span class="w2">${esc(p.vi)}</span><span class="k2">${esc(p.vik)}</span></div>
    <div class="ar">／</div>
    <div class="vt"><span class="lb">他动</span><span class="w2">${esc(p.vt)}</span><span class="k2">${esc(p.vtk)}</span></div>
  </div>`;
}

const gloss = w => OV[w.id] || w.zh || w.en || "";
// 产出练习需要一个中文提示；没有释义的词自动退回认读，否则正面会是空的
const effMode = w => (settings.mode === "prod" && !gloss(w)) ? "recog" : settings.mode;

// 把卡片正面恢复成「显示日语」的样子（产出/听力模式翻面后要补上）
function revealFront(w) {
  const el = $("cWord");
  el.classList.remove("prod");
  el.textContent = w.w;
  $("cKana").textContent = w.w === w.k ? "" : w.k;
  $("cKana").classList.toggle("hidden", w.w === w.k);
  $("cPitch").innerHTML = pitchSVG(w.k, w.a);
}

function paintCard() {
  const w = cur.w;
  const mode = effMode(w);
  const wordEl = $("cWord");
  const lvTag = grading() === "biaori" ? (lessonLabel(w.id) || w.lv) : w.lv;
  $("cLevel").textContent = lvTag + (cur.isNew ? " · 新词" : " · 复习") + " · " +
    (MODES.find(m => m[0] === mode) || MODES[0])[1].replace(/（.*/, "");
  $("cHint").classList.remove("hidden");   // showAnswer 里藏过，新卡要恢复

  if (mode === "prod") {
    wordEl.classList.add("prod");
    wordEl.textContent = gloss(w);
    $("cKana").classList.add("hidden");
    $("cPitch").innerHTML = "";
    $("cHint").textContent = "看中文，回忆日语怎么读、怎么写";
  } else if (mode === "listen") {
    wordEl.classList.remove("prod");
    wordEl.textContent = "";
    $("cKana").classList.add("hidden");
    $("cPitch").innerHTML = `<button class="play" id="btnPlayBig">播放发音</button>`;
    $("btnPlayBig").onclick = () => speak(w.w);
    $("cHint").textContent = "听发音，回忆意思";
    // 听力模式下正面没别的信息，只有把音放出来这个练习才成立
    if (autoSpeak() !== "off") setTimeout(() => speak(w.w), 280);
  } else {
    wordEl.classList.remove("prod");
    wordEl.textContent = w.w;
    $("cKana").textContent = w.w === w.k ? "" : w.k;
    $("cKana").classList.toggle("hidden", w.w === w.k);
    $("cPitch").innerHTML = pitchSVG(w.k, w.a);
    $("cHint").textContent = w.w === w.k ? "只看假名，回忆意思" : "看汉字，回忆读音和意思";
    if (!shown && autoSpeak() === "always") speak(w.w);
  }

  $("answer").classList.add("hidden");
  $("ratings").classList.add("hidden");
  $("actions").classList.remove("hidden");
  paintProgress();
  const c = cards.get(w.id);
  $("cardState").textContent = c ? stateLabel(c) : "未学";
}

function paintProgress() {
  // 总数用本次队列的原始长度；「剩余」必须按 queue.length - qi 算，
  // 因为撤销是往队列里插回一张卡，而不是把 qi 退回去
  const total = qTotal || queue.length || 1;
  const left = Math.max(0, queue.length - qi);
  $("queueInfo").textContent = `剩余 ${left} / 共 ${total}`;
  $("progFill").style.width = (100 * Math.min(1, (total - left) / total)).toFixed(1) + "%";
}
function stateLabel(c) {
  if (c.state === State.New) return "新";
  const iv = Math.round(c.scheduled_days || 0);
  return ({ 1: "学习中", 2: "复习", 3: "重学" })[c.state] + (iv ? " · " + (iv < 30 ? iv + "天" : (iv / 30).toFixed(1) + "月") : "");
}

function renderZh(w) {
  const mine = OV[w.id];
  const txt = gloss(w) || "（这个词两个中文源都没有，你可以自己补一个）";
  $("cZh").innerHTML = `<span>${esc(txt)}</span>${mine ? `<span class="mine">已自定义</span>` : ""}`
    + `<button class="mini ghost" id="btnEditZh">${mine ? "改" : "补一个"}</button>`;
  $("btnEditZh").onclick = () => startEditZh(w);
}
function startEditZh(w) {
  $("cZh").innerHTML = `<input class="edit" id="zhIn" value="${esc(OV[w.id] ?? w.zh ?? "")}">
    <button class="mini" id="zhSave">保存</button>
    <button class="mini ghost" id="zhCancel">取消</button>
    ${OV[w.id] ? `<button class="mini ghost" id="zhDel">恢复默认</button>` : ""}`;
  $("zhIn").focus();
  $("zhSave").onclick = async () => {
    const v = $("zhIn").value.trim();
    if (v) OV[w.id] = v; else delete OV[w.id];
    await Store.setKV("override", OV);
    toast(v ? "已保存，以后都按你这个显示" : "已清空");
    showAnswer();
  };
  $("zhCancel").onclick = () => showAnswer();
  if ($("zhDel")) $("zhDel").onclick = async () => {
    delete OV[w.id]; await Store.setKV("override", OV); toast("已恢复词库释义"); showAnswer();
  };
}

function showAnswer() {
  shown = true;
  const w = cur.w;
  const mode = effMode(w);
  $("answer").classList.remove("hidden");
  $("actions").classList.add("hidden");
  // 提示语是翻面前的任务说明，翻面后没用了还占一行 —— 小屏上正是这一行把卡片顶溢出
  $("cHint").classList.add("hidden");
  // 听力/产出模式正面没给日语，翻面时补回来，否则看完还是不知道长什么样
  if (mode === "prod" || mode === "listen") revealFront(w);
  if (autoSpeak() !== "off") speak(w.w);
  renderZh(w);
  $("cPos").innerHTML = (w.pos || []).map(p => `<span class="chip sm">${esc(p)}</span>`).join("");
  const fh = familyHTML(w);
  $("bFam").classList.toggle("hidden", !fh); $("cFam").innerHTML = fh;
  const ph = pairHTML(w);
  $("bPair").classList.toggle("hidden", !ph); $("cPair").innerHTML = ph;
  const ex = w.ex;
  $("bEx").classList.toggle("hidden", !ex);
  if (ex) { $("cExJa").textContent = ex.ja; $("cExZh").textContent = ex.en || ""; }
  $("bEn").classList.toggle("hidden", !!gloss(w));
  $("cEn").textContent = w.en || "";
  paintRatings();
}

function paintRatings() {
  const w = cur.w;
  const card = cards.get(w.id) || createEmptyCard(new Date());
  const now = new Date();
  let previews;
  try { previews = scheduler().repeat(card, now); }
  catch (e) { previews = null; }
  const labels = { 1: "重来", 2: "困难", 3: "良好", 4: "简单" };
  const box = $("ratings");
  box.innerHTML = "";
  for (const r of [1, 2, 3, 4]) {
    let iv = "—";
    if (previews && previews[r]) iv = fmtInterval(new Date(previews[r].card.due) - now);
    const b = document.createElement("button");
    b.className = "rate"; b.dataset.r = r;
    b.innerHTML = `<span class="rt">${labels[r]}</span><span class="ri">${iv}</span>`;
    b.onclick = () => grade(r);
    box.appendChild(b);
  }
  box.classList.remove("hidden");
}

let lastAct = null;   // 上一次评分的快照，用于撤销

async function grade(r) {
  const w = cur.w, now = new Date();
  const card = cards.get(w.id) || createEmptyCard(now);
  const wasNew = card.state === State.New;
  const prev = cards.has(w.id) ? Object.assign({}, card) : null;
  const out = scheduler().next(card, now, r);
  const nc = out.card; nc.id = w.id;
  cards.set(w.id, nc);
  await Store.putCard(nc);
  const logKey = await Store.addLog({ t: now.toISOString(), id: w.id, r, wasNew });
  if (wasNew) { settings.newDone = (settings.day === today() ? settings.newDone : 0) + 1; settings.day = today(); await saveSettings(); }
  if (session) { session.n++; session.by[r]++; }
  lastAct = { id: w.id, prev, wasNew, logKey, r };
  qi++; nextCard();
}

async function undo() {
  if (!lastAct) return toast("没有可撤销的操作");
  const a = lastAct; lastAct = null;
  if (a.prev) { const c = fixCard(a.prev); cards.set(a.id, c); await Store.putCard(c); }
  else { cards.delete(a.id); await Store.delCard(a.id); }
  await Store.popLog(a.logKey);
  if (session && a.r) { session.n = Math.max(0, session.n - 1); session.by[a.r] = Math.max(0, session.by[a.r] - 1); }
  if (a.wasNew) {
    settings.newDone = Math.max(0, (settings.day === today() ? settings.newDone : 0) - 1);
    settings.day = today(); await saveSettings();
  }
  const w = WORDS.find(x => x.id === a.id);
  if (w) queue.splice(qi, 0, { w, isNew: a.wasNew });
  nextCard();
  toast("已撤销，这张卡回到刚才");
}

// 中途想停就体面地停 —— 已经评过的卡早就落盘了，剩下的明天照旧出现，不会丢
function finishSession() {
  if (!session || session.n === 0) return toast("还没开始呢");
  session.stopped = true;
  qi = queue.length;
  nextCard();
}

async function bury() {
  if (!cur) return;
  const w = cur.w, now = new Date();
  const c = cards.get(w.id) || createEmptyCard(now);
  c.due = new Date(now.getTime() + 864e5); c.id = w.id;
  cards.set(w.id, c); await Store.putCard(c);
  qi++; nextCard(); toast("已推迟到明天");
}

// 空手进来（今天没有到期的、新词额度也用完了）不该摆一个「本次 0 张」的小结，
// 那看起来像出错了。这里说清楚「为什么没得学」和「下一张什么时候来」。
async function renderEmpty() {
  const now = Date.now();
  let next = Infinity, freshLeft = 0;
  for (const w of WORDS) {
    if (!inPool(w)) continue;
    const c = cards.get(w.id);
    if (!c || c.state === State.New) { freshLeft++; continue; }
    const t = new Date(c.due).getTime();
    if (t > now && t < next) next = t;
  }
  const budget = Math.max(0, settings.newPerDay - (settings.day === today() ? settings.newDone : 0));
  let line;
  if (budget === 0 && freshLeft)
    line = `今天 ${settings.newPerDay} 个新词的额度用完了。<br>想加量就回首页把上限调高，明天再来也一样。`;
  else if (next < Infinity) {
    const min = Math.round((next - now) / 60000);
    line = min < 60 ? `下一批大约 ${min} 分钟后到期。`
      : min < 60 * 20 ? `下一批大约 ${Math.round(min / 60)} 小时后到期。`
        : "今天剩下的时间不会有卡到期了，明天见。";
  } else
    line = "还没有开始学。回首页点「开始」就行。";
  $("card").innerHTML = `<div class="done">
    <div class="dt">现在没有要学的</div>
    <div class="ds">${line}</div>
  </div>`;
  $("actions").classList.add("hidden");
  $("ratings").classList.add("hidden");
  $("answer").classList.add("hidden");
  $("btnBur").classList.add("hidden");
  $("btnSkip").classList.add("hidden");
  $("btnStop").classList.add("hidden");
  $("queueInfo").textContent = "队列是空的";
  $("progFill").style.width = "0%";
  $("cardState").textContent = "空闲";
}

async function renderDone() {
  const s = session || { n: 0, by: { 1: 0, 2: 0, 3: 0, 4: 0 }, at: Date.now() };
  if (!s.n) return renderEmpty();
  const mins = Math.max(1, Math.round((Date.now() - s.at) / 60000));
  const okRate = s.n ? Math.round(100 * (s.by[3] + s.by[4]) / s.n) : 0;
  // 24 小时内还要见面几张，让用户对明天的工作量心里有数
  const soon = Date.now() + 864e5;
  let due24 = 0;
  for (const c of cards.values()) if (c.state !== State.New && new Date(c.due).getTime() <= soon) due24++;
  let streak = 0;
  try { streak = (await stats()).streak; } catch (e) { }
  const hard = s.by[1] + s.by[2];
  const bits = [
    `本次 ${s.n} 张`, `用时 ${mins} 分`,
    s.n ? `一遍就过 ${okRate}%` : "",
    s.n ? `难/重来 ${hard} 张` : "",
    `连续 ${streak} 天`
  ].filter(Boolean);
  // 不夸也不贬，只描述事实；卡得多的时候说清「卡住才是有效学习」
  const mood = !s.n ? "" :
    okRate >= 85 ? "记得挺牢。" : okRate >= 60 ? "节奏正常。" :
      "今天卡住的这些，恰恰是还没长牢的部分——明天它们还会来。";
  const left = Math.max(0, qTotal - s.n);
  const body = s.stopped
    ? `剩下的 ${left} 张留到明天，<br>已经评过的都存好了，不会有任何损失。`
    : (due24 ? `明天之前还有 <b>${due24}</b> 张要复习。` : "接下来一天没有到期的卡了。")
      + `<br>想加量就再来一组，不然明天见。`;

  // 一半以上都点「重来/困难」时，主动建议减量 —— 而不是明天照样给你排满
  const tooHard = s.n >= 8 && hard > s.n / 2;
  const suggest = Math.max(5, Math.round(settings.newPerDay * 0.6 / 5) * 5);
  const advice = tooHard && suggest < settings.newPerDay
    ? `<div class="advice">今天有一半以上都卡住了。与其硬扛，不如把每日新词降到 <b>${suggest}</b> 个，
       先把已学的消化掉。<button class="mini" id="btnEase">好，降到 ${suggest}</button></div>` : "";

  $("card").innerHTML = `<div class="done">
    <div class="dt">${s.stopped ? "先到这儿" : "今天的队列跑完了"}</div>
    <div class="ds">${mood}${mood ? "<br>" : ""}${body}</div>
    <div class="dg">${bits.map(b => `<span>${esc(b)}</span>`).join("")}</div>
    <div class="foot" style="margin-top:16px">
      <button class="mini" id="btnMore">再学 10 个新词</button>
    </div>
    ${advice}
  </div>`;
  $("btnMore").onclick = async () => {
    settings.newPerDay = Math.min(200, settings.newPerDay + 10);
    await saveSettings(); toast("每日新词上限调到 " + settings.newPerDay); startStudy();
  };
  if ($("btnEase")) $("btnEase").onclick = async () => {
    settings.newPerDay = suggest; await saveSettings();
    toast("降到 " + suggest + " 个，先把学过的消化掉"); startStudy();
  };
  $("actions").classList.add("hidden");
  $("ratings").classList.add("hidden");
  $("answer").classList.add("hidden");
  $("btnBur").classList.add("hidden");   // 队列空了，这三个没有意义还容易误点
  $("btnSkip").classList.add("hidden");
  $("btnStop").classList.add("hidden");
  $("queueInfo").textContent = s.stopped ? `本次 ${s.n} 张 · 剩余 ${left} 张留着` : `剩余 0 / 共 ${qTotal}`;
  $("progFill").style.width = s.stopped ? (100 * s.n / (qTotal || 1)).toFixed(1) + "%" : "100%";
  $("cardState").textContent = "已完成";
}

/* ============================ 统计 ============================ */
async function stats() {
  const log = await Store.allLog();
  const byDay = new Map();
  for (const r of log) { const d = dayKey(r.t); byDay.set(d, (byDay.get(d) || 0) + 1); }
  let streak = 0;
  const base = Date.now();
  for (let i = 0; i < 400; i++) {
    const k = dayKey(base - i * 864e5);
    if ((byDay.get(k) || 0) > 0) streak++;
    else if (i === 0) continue;      // 今天还没学不算断，接着看昨天
    else break;
  }
  // 曾经学过、但现在连续天数为 0 —— 用来决定要不要说「欢迎回来」
  const lastDay = [...byDay.keys()].sort().pop() || "";
  const gap = lastDay && lastDay !== today() ? Math.round((Date.parse(today()) - Date.parse(lastDay)) / 864e5) : 0;
  return { byDay, streak, total: log.length, lastDay, gap };
}
/* 首页那句问候。原则：不说教、不打鸡血、不因为断签指责你。
   断签是这类应用最大的流失点，所以回来的时候只欢迎，不提「你断了」。 */
function helloText(s, due, fresh) {
  const h = new Date().getHours();
  const doneToday = s.byDay.get(today()) || 0;
  if (s.streak === 0 && s.lastDay && s.gap >= 2)
    return { t: `欢迎回来。中间空了一段<br>完全没关系，今天从少量开始就行。`, warm: true };
  if (due === 0 && fresh === 0) return { t: "今天该做的都做完了，明天见。", warm: false };
  if (doneToday > 0 && due === 0 && fresh > 0)
    return { t: `今天已经动过了，想再来几张也行，不加也完全可以。`, warm: false };
  if (s.streak >= 30) return { t: `连续 ${s.streak} 天。这已经是习惯了。`, warm: false };
  if (s.streak >= 7) return { t: `连续 ${s.streak} 天了，稳。`, warm: false };
  if (h >= 1 && h < 5) return { t: "夜深了，学几张就去睡吧。", warm: true };
  if (h < 9) return { t: "早上记忆力最好，来一组？", warm: false };
  return null;
}

async function renderHome() {
  await refreshCards();
  const s = await stats();
  $("streakBox").textContent = s.streak > 0 ? `连续 ${s.streak} 天` : "";
  const now = new Date();
  let due = 0, freshAvail = 0, started = 0, poolSize = 0;
  for (const w of WORDS) {
    if (!inPool(w)) continue;
    poolSize++;
    const c = cards.get(w.id);
    if (c) started++;
    if (!c || c.state === State.New) { freshAvail++; continue; }
    if (new Date(c.due) <= now) due++;
  }
  const budget = Math.max(0, settings.newPerDay - (settings.day === today() ? settings.newDone : 0));
  const fresh = Math.min(budget, freshAvail);   // 别承诺实际拿不出来的数量

  // 按钮直接说清今天要做什么、大概多久（复习一张≈9秒，新词一张≈17秒）
  const btn = $("btnStart");
  if (due + fresh === 0) {
    btn.textContent = "今天没有要学的了";
    btn.disabled = true;
  } else {
    const bits = [];
    if (due) bits.push(`复习 ${due} 张`);
    if (fresh) bits.push(`新词 ${fresh} 个`);
    const min = Math.max(1, Math.round((due * 9 + fresh * 17) / 60));
    btn.textContent = `开始 · ${bits.join(" + ")} · 约 ${min} 分钟`;
    btn.disabled = false;
  }

  const hi = helloText(s, due, fresh);
  const hel = $("hello");
  hel.classList.toggle("hidden", !hi);
  if (hi) { hel.innerHTML = hi.t; hel.classList.toggle("warm", !!hi.warm); }

  // 全新用户：把「为什么这样设计」讲一遍，只出现一次
  const isNewbie = !welcomed && !cards.size && !s.total;
  $("welcome").classList.toggle("hidden", !isNewbie);

  $("metrics").innerHTML = `
    <div class="metric hl"><div class="n">${due}</div><div class="l">待复习</div></div>
    <div class="metric"><div class="n">${fresh}</div><div class="l">可学新词</div></div>
    <div class="metric"><div class="n">${started}</div><div class="l">已开始</div></div>
    <div class="metric"><div class="n">${s.streak}</div><div class="l">连续天数</div></div>`;
  // 掌握度（只统计当前学习范围，和上面的数字口径一致）
  const b = { un: 0, learn: 0, short: 0, solid: 0 };
  for (const w of WORDS) {
    if (!inPool(w)) continue;
    const c = cards.get(w.id);
    if (!c || c.state === State.New) { b.un++; continue; }
    if (c.state === State.Learning || c.state === State.Relearning) { b.learn++; continue; }
    (c.scheduled_days >= 21 ? b.solid++ : b.short++);
  }
  const tot = poolSize || 1;
  const rows = [["未学", b.un, "var(--line2)"], ["学习中", b.learn, "var(--warn)"], ["短期 <21天", b.short, "var(--info)"], ["稳固 ≥21天", b.solid, "var(--accent)"]];
  $("mastery").innerHTML = rows.map(([l, n, c]) =>
    `<div class="bar"><div class="bl">${l}</div><div class="bt"><div class="bf" style="width:${(100 * n / tot).toFixed(1)}%;background:${c}"></div></div><div class="bv">${n}</div></div>`).join("");
}
async function renderStats() {
  await refreshCards();
  const s = await stats();
  const cells = [];
  // 用中午当锚点，避开「本地午夜换算成 UTC 差一天」和夏令时的坑
  const anchor = new Date(); anchor.setHours(12, 0, 0, 0);
  const start = new Date(anchor);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - 15 * 7);  // 15 周前的周一
  for (let i = 0; i < 112; i++) {
    const cur = new Date(start); cur.setDate(cur.getDate() + i);
    const k = dayKey(cur);
    const n = s.byDay.get(k) || 0;
    const l = n === 0 ? 0 : n < 10 ? 1 : n < 30 ? 2 : n < 60 ? 3 : 4;
    cells.push(`<i data-l="${l}" title="${k}: ${n}"></i>`);
  }
  $("heat").innerHTML = cells.join("");
  $("statsMetrics").innerHTML = `
    <div class="metric"><div class="n">${s.total}</div><div class="l">累计复习</div></div>
    <div class="metric"><div class="n">${s.byDay.size}</div><div class="l">学习天数</div></div>
    <div class="metric"><div class="n">${s.streak}</div><div class="l">连续天数</div></div>
    <div class="metric"><div class="n">${cards.size}</div><div class="l">卡数</div></div>`;
  // ---- 未来 7 天到期预测 ----
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const a = new Date(d0); a.setDate(a.getDate() + i);
    const b = new Date(a); b.setDate(b.getDate() + 1);
    days.push({
      label: i === 0 ? "今天" : i === 1 ? "明天" : (a.getMonth() + 1) + "/" + a.getDate(),
      lo: a.getTime(), hi: b.getTime(), n: 0, today: i === 0
    });
  }
  for (const c of cards.values()) {
    if (c.state === State.New) continue;
    const t = new Date(c.due).getTime();
    if (t < days[0].lo) { days[0].n++; continue; }        // 逾期的算在今天，否则今天永远是 0
    for (const d of days) if (t >= d.lo && t < d.hi) { d.n++; break; }
  }
  const fmax = Math.max(1, ...days.map(d => d.n));
  $("forecast").innerHTML = days.map(d => `
    <div class="col${d.n === 0 ? " zero" : ""}${d.today ? " today" : ""}">
      <b>${d.n || ""}</b>
      <i style="height:${d.n ? Math.max(3, Math.round(80 * d.n / fmax)) : 2}px"></i>
      <em>${d.label}</em>
    </div>`).join("");
  const fsum = days.reduce((a, d) => a + d.n, 0);
  $("fcNote").textContent = fsum
    ? `7 天合计 ${fsum} 张，日均 ${Math.round(fsum / 7)} 张。柱高按这一周的最大值等比缩放。`
    : "还没有排上日程的卡，先去学几张。";

  // ---- 最难记住的词 ----
  const leech = [...cards.values()].filter(c => c.state !== State.New)
    .sort((a, b) => ((b.lapses || 0) - (a.lapses || 0)) || ((b.difficulty || 0) - (a.difficulty || 0))
      || ((a.stability || 0) - (b.stability || 0)))
    .slice(0, 10);
  $("leech").innerHTML = leech.length ? leech.map((c, i) => {
    const w = WORDS.find(x => x.id === c.id);
    if (!w) return "";
    return `<button class="lk" data-w="${esc(w.w)}">
      <span class="n">${i + 1}</span>
      <span class="w3">${esc(w.w)}</span>
      <span class="k3">${esc(w.k)}</span>
      <span class="z3">${esc(w.zh || w.en || "")}</span>
      <span class="badge">忘 ${c.lapses || 0} 次</span>
    </button>`;
  }).join("") : `<p class="note" style="margin:0">还没有复习记录。学几张之后，这里会挑出最让你头疼的词。</p>`;
  for (const b of $("leech").querySelectorAll(".lk")) b.onclick = () => { pin = b.dataset.w; show("study"); };

  const md = await ensureStore();
  $("srcNote").innerHTML = `词库 ${WORDS.length} 词（JLPT ${META.total} + 新标日补 ${WORDS.length - META.total}）· 词族 ${META.families} · 自他动词 ${META.pairs} 对。<br>
    运行环境：${location.protocol === "file:" ? "本地文件直开" : "网页服务"}　·　进度存于本机 ${md === "idb" ? "IndexedDB" : "localStorage"}，不上传服务器。<br>
    来源：OpenJLPT（CC BY-SA 4.0）、JMdict/EDRDG、kanjium 声调库、Japanese-Chinese-thesaurus、新标日词表 smartsl/biaori（MIT）。`;
}

/* ============================ 词族 / 动词对 ============================ */
function renderFam(q) {
  const kw = (q || "").trim();
  const list = FAM.filter(x => !kw || x.c === kw || (x.zh || "").includes(kw));
  $("famList").innerHTML = list.slice(0, 60).map(x => `
    <div class="item">
      <div class="hd"><span class="kc">${esc(x.c)}</span>
        <span class="rd">${esc(x.lv)}</span>
        <span class="rd">音读 ${esc((x.on || []).join("・"))}</span>
        <span class="rd">训读 ${esc((x.kun || []).join("・"))}</span>
        <span class="mn">${esc(x.zh || "")}</span></div>
      ${x.g.map(g => `<div class="ws">${g.ws.slice(0, 12).map(w => `<span class="w">${esc(w)}<em>${esc(g.on)}</em></span>`).join("")}</div>`).join("")}
    </div>`).join("");
}
function renderPairs(q) {
  const kw = (q || "").trim();
  const list = PAIRS.filter(p => !kw || p.vi.includes(kw) || p.vt.includes(kw) || p.vik.includes(kw) || p.vtk.includes(kw) || (p.zh || "").includes(kw));
  $("pairList").innerHTML = list.map(p => `
    <div class="item">
      <div class="prow">
        <div class="vi"><span class="lb">自动</span><span class="w2">${esc(p.vi)}</span><span class="k2">${esc(p.vik)}</span></div>
        <div class="ar">／</div>
        <div class="vt"><span class="lb">他动</span><span class="w2">${esc(p.vt)}</span><span class="k2">${esc(p.vtk)}</span></div>
      </div>
      <div class="mn" style="margin-top:8px">${esc(p.zh || "")}</div>
    </div>`).join("") || `<p class="note">没有匹配的动词对。</p>`;
}

/* ============================ 视图切换 ============================ */
let view = "home";
function show(v) {
  view = v;
  for (const b of document.querySelectorAll(".tabbar button")) b.classList.toggle("on", b.dataset.v === v);
  for (const id of ["home", "study", "fam", "pairs", "stats"]) $("view-" + id).classList.toggle("hidden", id !== v);
  if (v === "home") renderHome();
  if (v === "stats") renderStats();
  if (v === "study") startStudy();
  if (v === "fam") renderFam($("famSearch").value);
  if (v === "pairs") renderPairs($("pairSearch").value);
}
let pin = null;
const hashWord = () => { const m = /[#&]w=([^&]+)/.exec(location.hash); return m ? decodeURIComponent(m[1]) : null; };

async function startStudy() {
  await refreshCards();
  session = newSession();
  const p = pin || hashWord();
  pin = null;                       // 深链接只生效一次，之后恢复正常队列
  if (p) {
    const w = WORDS.find(x => x.w === p || x.k === p);
    queue = w ? [{ w, isNew: !cards.has(w.id) }] : [];
    qi = 0;
    if (!w) toast("词库中没有「" + p + "」");
  } else buildQueue();
  restoreCardEl();
  $("btnBur").classList.remove("hidden");
  $("btnSkip").classList.remove("hidden");
  $("btnStop").classList.remove("hidden");
  qTotal = queue.length;
  nextCard();
}
function restoreCardEl() {
  const el = $("card");
  if (!el.querySelector("#cWord")) {
    el.innerHTML = `<div class="card-top"><span class="tag" id="cLevel"></span><button class="mini" id="btnSpeak">朗读</button></div>
      <div class="word" id="cWord"></div><div class="kana" id="cKana"></div>
      <div class="pitch" id="cPitch"></div><div class="hint" id="cHint"></div>`;
    $("btnSpeak").onclick = () => cur && speak(cur.w.w);
  }
}

/* ============================ 设置 ============================ */
async function saveSettings() { await Store.setKV("settings", settings); }
async function loadSettings() {
  const s = await Store.getKV("settings");
  if (s) Object.assign(settings, s);
}

/* ============================ UI ============================ */
let tmr = null;
function toast(m) {
  const t = $("toast"); t.textContent = m; t.classList.remove("hidden");
  clearTimeout(tmr); tmr = setTimeout(() => t.classList.add("hidden"), 1800);
}

async function exportProgress() {
  const data = { v: 1, t: new Date().toISOString(), settings, override: OV,
                 cards: await Store.allCards(), log: await Store.allLog() };
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "jpvocab-progress-" + today() + ".json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("已导出 " + data.cards.length + " 张卡");
}
async function importProgress(file) {
  try {
    const d = JSON.parse(await file.text());
    if (!d || !Array.isArray(d.cards)) throw new Error("文件里没有卡片数据");
    await Store.reset();
    for (const c of d.cards) await Store.putCard(fixCard(c));
    for (const r of (d.log || [])) await Store.addLog(r);
    OV = d.override || {}; await Store.setKV("override", OV);
    if (d.settings) Object.assign(settings, d.settings);
    await saveSettings();
    f = null;                       // 保留率可能变了，重建调度器
    syncSettingsUI();               // 否则输入框还显示旧值，和实际生效的设置不一致
    await refreshCards();
    toast("已导入 " + d.cards.length + " 张卡");
    show("home");
  } catch (e) { toast("导入失败：" + (e && e.message || e)); }
}

function renderModePick() {
  $("modePick").innerHTML = MODES.map(([k, l]) =>
    `<button class="chip ${settings.mode === k ? "on" : ""}" data-m="${k}">${esc(l)}</button>`).join("");
  for (const b of $("modePick").querySelectorAll("button")) b.onclick = async () => {
    settings.mode = b.dataset.m; await saveSettings(); renderModePick();
    toast(view === "study" ? "已切换，下一张卡生效" : "已切换练习方向");
  };
}

function renderSpeakPick() {
  const cur0 = autoSpeak();
  $("speakPick").innerHTML = SPEAKS.map(([k, l]) =>
    `<button class="chip ${cur0 === k ? "on" : ""}" data-s="${k}">${esc(l)}</button>`).join("");
  for (const b of $("speakPick").querySelectorAll("button")) b.onclick = async () => {
    settings.autoSpeak = b.dataset.s; await saveSettings(); renderSpeakPick();
    if (b.dataset.s !== "off") speak(cur && cur.w ? cur.w.w : "日本語");
  };
}

function doSearch() {
  const q = ($("homeSearch").value || "").trim();
  if (!q) return;
  const w = WORDS.find(x => x.w === q) || WORDS.find(x => x.k === q) ||
            WORDS.find(x => x.w.includes(q)) || WORDS.find(x => x.k.includes(q));
  if (!w) return toast("词库里没有「" + q + "」");
  pin = w.w; show("study");
}

function syncSettingsUI() {
  // 桌面宽屏默认展开设置面板；手机屏默认收起，把首页留给状态和开始按钮
  $("setupPanel").open = window.innerWidth >= 720;
  $("newPerDay").value = settings.newPerDay;
  $("retention").value = Math.round(settings.retention * 100);
  $("retentionVal").textContent = Math.round(settings.retention * 100) + "%";
  renderGradingPick();
  renderLevelPick();
  renderModePick();
  renderSpeakPick();
}

function renderGradingPick() {
  $("gradingPick").innerHTML = GRADINGS.map(([k, l]) =>
    `<button class="chip ${grading() === k ? "on" : ""}" data-g="${k}">${esc(l)}</button>`).join("");
  for (const b of $("gradingPick").querySelectorAll("button")) b.onclick = async () => {
    if (grading() === b.dataset.g) return;
    settings.grading = b.dataset.g; await saveSettings();
    renderGradingPick(); renderLevelPick(); renderHome();
  };
}

function renderLevelPick() {
  const box = $("levelPick");
  if (grading() === "biaori") {
    box.innerHTML = BR.vols.map((v, i) =>
      `<button class="chip ${settings.vols.includes(i) ? "on" : ""}" data-v="${i}">${esc(v[0])}</button>`).join("");
    for (const b of box.querySelectorAll("button")) b.onclick = async () => {
      const i = +b.dataset.v, k = settings.vols.indexOf(i);
      if (k >= 0) { if (settings.vols.length === 1) return toast("至少保留一册"); settings.vols.splice(k, 1); }
      else { settings.vols.push(i); settings.vols.sort((a, c) => a - c); }
      await saveSettings(); renderLevelPick(); renderHome();
    };
  } else {
    box.innerHTML = LEVELS.map(l =>
      `<button class="chip ${settings.levels.includes(l) ? "on" : ""}" data-l="${l}">${l}</button>`).join("");
    for (const b of box.querySelectorAll("button")) b.onclick = async () => {
      const l = b.dataset.l;
      const i = settings.levels.indexOf(l);
      if (i >= 0) { if (settings.levels.length === 1) return toast("至少保留一个等级"); settings.levels.splice(i, 1); }
      else settings.levels.push(l);
      settings.levels.sort((a, c) => LEVELS.indexOf(a) - LEVELS.indexOf(c));
      await saveSettings(); renderLevelPick(); renderHome();
    };
  }
  // 范围下一行小字：让人立刻看到这次到底圈了多少词
  let n = 0;
  for (const w of WORDS) if (inPool(w)) n++;
  $("poolNote").textContent = grading() === "biaori"
    ? `已选 ${settings.vols.length} 册：共 ${n} 词，新词按课次顺序（第 1 课 → 第 104 课）出。学过的词两种分级通用，进度不丢。`
    : `已选 ${settings.levels.length} 个等级：共 ${n} 词，新词从低等级开始出。`;
  // 折叠条上的摘要：设置收起来时也一眼看到当前圈定的范围
  $("setupHint").textContent = (grading() === "biaori"
    ? `新标日 · ${settings.vols.length} 册`
    : `JLPT · ${settings.levels.length} 级`) + ` · ${n} 词`;
}

async function main() {
  await loadSettings();
  OV = await Store.getKV("override") || {};
  welcomed = !!(await Store.getKV("welcomed"));
  // 首次访问不等词库：欢迎层立刻出现，别让新用户对着骨架屏干等
  if (!welcomed) {
    $("welcome").classList.remove("hidden");
    $("btnWelcomeOk").onclick = async () => {
      welcomed = true; await Store.setKV("welcomed", 1);
      $("welcome").classList.add("hidden");
      if (appReady) show("study");   // 数据还没就绪就留在首页，加载完自然能点
      else toast("词库马上就好，稍等一下");
    };
  }
  let ready = false; appReady = false;
  try { await loadData(); }
  catch (e) {
    // 别静默挂掉：把错误直接摆到页面上
    document.querySelector("main").innerHTML =
      `<div class="panel"><h2>词库没加载起来</h2><p class="note">
        ${esc(String(e && e.message || e))}<br><br>
        请确认 <b>data/</b> 与 <b>js/</b> 两个文件夹和 <b>index.html</b> 在一起、没有缺失或改名。<br>
        网页版先刷新重试；本地版请整个 <b>app/</b> 文件夹一起移动，不要单独挪 index.html。</p></div>`;
    return;
  }
  appReady = true;
  $("btnStart").disabled = false;
  $("btnStart").textContent = "开始学习";
  syncSettingsUI();
  $("btnUndo").onclick = undo;
  $("btnExport").onclick = exportProgress;
  $("btnImport").onclick = () => $("fileImport").click();
  $("fileImport").onchange = e => { const f = e.target.files && e.target.files[0]; if (f) importProgress(f); e.target.value = ""; };
  $("btnSearch").onclick = doSearch;
  $("homeSearch").onkeydown = e => { if (e.key === "Enter") doSearch(); };
  for (const b of document.querySelectorAll(".tabbar button")) b.onclick = () => show(b.dataset.v);
  $("btnStart").onclick = () => show("study");
  $("btnShow").onclick = showAnswer;
  $("btnSpeak").onclick = () => cur && speak(cur.w.w);
  $("btnSpeakEx").onclick = () => { const e = cur && cur.w.ex; if (e) speak(e.ja); };
  $("btnBur").onclick = bury;
  $("btnSkip").onclick = () => { qi++; nextCard(); };
  $("btnStop").onclick = finishSession;
  $("newPerDay").onchange = async e => { settings.newPerDay = +e.target.value || 0; await saveSettings(); renderHome(); };
  $("retention").oninput = async e => {
    settings.retention = +e.target.value / 100; f = null;
    $("retentionVal").textContent = e.target.value + "%"; await saveSettings();
  };
  $("famSearch").oninput = e => renderFam(e.target.value);
  $("pairSearch").oninput = e => renderPairs(e.target.value);
  $("btnReset").onclick = async () => {
    if (!confirm("清空全部学习进度？此操作不可撤销。")) return;
    await Store.reset();
    cards.clear(); toast("已清空"); show("home");
  };
  document.addEventListener("keydown", e => {
    if (view !== "study") return;
    if (e.code === "Space") { e.preventDefault(); shown ? (queue[qi] && grade(3)) : showAnswer(); }
    if (e.code === "Enter" && !shown) showAnswer();
    if (shown && ["1", "2", "3", "4"].includes(e.key)) grade(+e.key);
  });
  renderHome();
  if (hashWord()) show("study");
  window.addEventListener("hashchange", () => { if (hashWord()) show("study"); });
}
main();
