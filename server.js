"use strict";
// Celestial Troll Bot — troll auto-reply + assistant commands + GC name cycle.
// Built to stay logged in and never die: errors back off and retry, they never end the process.

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { sendBanatReplyWithTyping } = require("./banat-human");
const { pickBanatReply, rememberBanatReply } = require("./banat-memory");
const { chooseSocialResponse } = require("./banat-social");
const { startTyping, stopTyping, stopAllTyping } = require("./human-typing");
const { createGcCycle } = require("./gcname");
const commands = require("./commands");
const economy = require("./economy");
const moderation = require("./moderation");
const groupControls = require("./group-controls");   // Lock GC name + Set ALL nicknames (dashboard only)

// ============================================================
// Phobia integration modules
// ============================================================
const { createLockStore } = require("./lock-store");
const { createGroupTitleGuard } = require("./group-title-guard");
const { createNicknameLockGuard } = require("./nickname-lock-guard");
const { executeMassSetNickname } = require("./mass-setnn");
const { isDuplicateMessage } = require("./message-dedupe");
const { extractMessageID, dispatchMessageReaction } = require("./message-reactions");
const { createSpamMode } = require("./spam-mode");

const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || __dirname; // everything lives in the project root by default
fs.mkdirSync(DATA, { recursive: true });
economy.init(DATA, (who, msg) => console.log(`[${who}] ${msg}`));

// ---------- tiny helpers ----------
function safeRead(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } }
function writeAtomic(f, obj) {                       // never leave a half-written cookie file behind
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
const rnd = (a, b) => a + Math.random() * (b - a);
const num = (v, min, max, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; };

// ---------- dashboard access ----------
// Walang password by default. Kung gusto mong i-lock, mag-set lang ng ADMIN_PASSWORD sa Railway Variables.
const hasAdmin = () => !!process.env.ADMIN_PASSWORD;
function safeEq(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
const checkPw = (pw) => hasAdmin() && safeEq(pw || "", process.env.ADMIN_PASSWORD);

// ---------- config ----------
const CFG_FILE = path.join(DATA, "config.json");
const DEFAULTS = {
  appState: null, savedAt: null, stateRefreshedAt: null,
  autoReply: false, threadId: null, threads: [], running: false,   // threads = every GC the bot is turned ON in
  speed: "fast", selfReact: true, selfReactRate: 0.15, markRead: true,
  skipMax: 4, senderCooldownS: 0, hourlyMax: 0, dailyMax: 0, threadMax: 0, threadWindowS: 300,   // 0 = walang limit   // skipMax: most messages in a row that may be skipped (0 = reply to everything)
  awayBreaks: false,           // random 20-90 min "away" pauses (off: replies never go quiet by themselves)
  quiet: { on: false, start: "00:30", end: "07:30" }, tz: process.env.BOT_TZ || "Asia/Manila",
  openers: ["hello", "uy"],
  profile: "unlimited-v1",
  // assistant / commands
  troll: true,                 // random troll replies on/off (commands work either way)
  prefix: "!",
  admins: [],                  // extra admin user IDs (the bot account itself is always admin)
  cmdCooldownS: 2, cmdHourlyMax: 0,
  fcaPackage: null,            // name of the fca library to load (or env FCA_PACKAGE)
  reminders: [],
};
// Low-footprint profile for long runs. Applied ONCE to an older saved config.json
// (so the Railway volume gets updated too); after that, dashboard changes are respected.
const STEALTH_V1 = ["speed", "selfReact", "selfReactRate", "skipMax", "senderCooldownS", "hourlyMax", "dailyMax", "threadMax", "threadWindowS", "openers"];
const cfg = Object.assign({}, DEFAULTS, safeRead(CFG_FILE));
cfg.quiet = Object.assign({}, DEFAULTS.quiet, cfg.quiet);
if (cfg.profile !== DEFAULTS.profile) {
  for (const k of STEALTH_V1) cfg[k] = DEFAULTS[k];
  cfg.quiet = Object.assign({}, DEFAULTS.quiet); cfg.profile = DEFAULTS.profile;   // quiet hours OFF: replies run non-stop
  try { writeAtomic(CFG_FILE, cfg); } catch {}
}
// Multi-GC: the bot only chats in the GCs listed in cfg.threads (turned ON with !on or the dashboard).
cfg.threads = (Array.isArray(cfg.threads) ? cfg.threads : []).map(String);
if (cfg.threadId && !cfg.threads.includes(String(cfg.threadId))) cfg.threads.push(String(cfg.threadId));   // old single-GC config
cfg.threadId = null;
const save = () => { try { writeAtomic(CFG_FILE, cfg); } catch (e) { console.error("[save]", e.message); } };

const envAdmins = new Set(String(process.env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean));
const isAdminId = (id) => String(id) === S.uid || envAdmins.has(String(id)) || (cfg.admins || []).map(String).includes(String(id));

// Owner = the bot account + OWNER_IDS (env, comma-separated) + cfg.owners.
// If no extra owner is set at all, the admins count as owners (so !setbal works out of the box).
const envOwners = new Set(String(process.env.OWNER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean));
const isOwnerId = (id) => {
  const cfgOwners = (cfg.owners || []).map(String);
  if (String(id) === S.uid || envOwners.has(String(id)) || cfgOwners.includes(String(id))) return true;
  return !envOwners.size && !cfgOwners.length && isAdminId(id);
};
moderation.init(DATA, (who, msg) => console.log(`[${who}] ${msg}`), { isAdminId, isOwnerId });

// ---------- reply pools (replies.json: array OR { type: [..], default: [..] }) ----------
const RAW_POOL = JSON.parse(fs.readFileSync(path.join(__dirname, "replies.json"), "utf8"));
const POOLS = Array.isArray(RAW_POOL) ? { default: RAW_POOL } : RAW_POOL;
const ALL_REPLIES = [...new Set(Object.values(POOLS).flat())];
const poolKey = (type) => (Array.isArray(POOLS[type]) && POOLS[type].length ? type : "default");
const poolFor = (type) => (Array.isArray(POOLS[poolKey(type)]) && POOLS[poolKey(type)].length ? POOLS[poolKey(type)] : ALL_REPLIES);

// ---------- runtime state ----------
const S = {
  api: null, uid: null, online: false, running: false, logging: false, stopListen: null, manualOff: false,
  authDead: false, started: Date.now(), botSince: null, lastConnected: null, lastDisconnected: null,
  attempts: 0, nextRetry: null, timer: null, listenTimer: null, listenFails: 0, pingFails: 0,
  lastEventAt: null, lastPing: null, nextPing: 0, lastStateJson: cfg.appState ? JSON.stringify(cfg.appState) : null,
  lastError: null, replies: [], daily: [], suppressed: 0, awayUntil: 0, fcaName: null,
  senders: new Map(), threads: new Map(), busy: new Set(), log: [], skipRun: new Map(),
  cmdSenders: new Map(), cmdHour: [],
};

function log(who, msg) {
  S.log.unshift({ t: Date.now(), who, msg: String(msg).slice(0, 300) });
  S.log.length = Math.min(S.log.length, 80);
  console.log(`[${who}] ${msg}`);
}

// ============================================================
// Phobia: lock store + guards + spam instance
// ============================================================
const lockStore = createLockStore({ dataDir: DATA });

let titleGuard = null;
let nicknameGuard = null;

function initGuards() {
  if (!titleGuard) {
    titleGuard = createGroupTitleGuard({ store: lockStore, getApi: () => S.api });
    titleGuard.start();
  }
  if (!nicknameGuard) {
    nicknameGuard = createNicknameLockGuard({ store: lockStore, getApi: () => S.api });
    nicknameGuard.start();
  }
}

// Shared spam instance — dashboard routes at chat commands pareho ito
const spamMode = createSpamMode({
  getApi: () => S.api,
  sendMessage: (api, msg, tid) => new Promise((ok, fail) =>
    api.sendMessage(msg, tid, (e) => (e ? fail(e) : ok()))
  ),
  isAuthorized: () => !!S.api,
});

// Expose spam instance sa commands.js para magamit ng !spam
if (typeof commands.setSpamModeInstance === "function") {
  commands.setSpamModeInstance(spamMode);
}

// ---------- session ----------
function parseCookie(raw) {
  raw = String(raw || "").trim();
  const arr = raw.startsWith("[")
    ? JSON.parse(raw)
    : raw.split(";").map((p) => p.trim()).filter(Boolean).map((p) => {
        const i = p.indexOf("=");
        return { key: p.slice(0, i), value: p.slice(i + 1), domain: "facebook.com", path: "/", hostOnly: false };
      });
  const keys = new Set(arr.map((c) => c.key || c.name));
  if (!keys.has("c_user") || !keys.has("xs")) throw new Error("missing c_user / xs");
  return arr;
}

// First boot with no saved cookie: accept APPSTATE env or an appstate.json next to server.js.
if (!cfg.appState) {
  try {
    const raw = process.env.APPSTATE || (fs.existsSync(path.join(DATA, "appstate.json")) ? fs.readFileSync(path.join(DATA, "appstate.json"), "utf8") : "");
    if (raw) {
      cfg.appState = parseCookie(raw); cfg.savedAt = Date.now(); S.lastStateJson = JSON.stringify(cfg.appState); save();
      console.log("[system] cookie loaded from " + (process.env.APPSTATE ? "APPSTATE env" : "appstate.json"));
    }
  } catch (e) { console.error("[system] bad APPSTATE / appstate.json:", e.message); }
}

// ---------- quiet hours ----------
function localMinutes() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: cfg.tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour").value) % 24;
  const m = Number(parts.find((p) => p.type === "minute").value);
  return h * 60 + m;
}
const toMin = (s) => { const [h, m] = String(s || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
function inQuiet() {
  if (!cfg.quiet.on) return false;
  try {
    const n = localMinutes(), a = toMin(cfg.quiet.start), b = toMin(cfg.quiet.end);
    return a <= b ? n >= a && n < b : n >= a || n < b;
  } catch { return false; }
}

// ---------- session keep-alive ----------
const AUTH_RE = /checkpoint|not logged in|login[_ ]?(approval|blocked)|expired|appstate|retrieving userid|unknown location|suspended|disabled|locked|invalid.*(cookie|session)/i;
const isAuthError = (e) => AUTH_RE.test(String((e && (e.error || e.message)) || e || ""));

function captureState(reason) {
  if (!S.api || typeof S.api.getAppState !== "function") return;
  try {
    const st = S.api.getAppState();
    if (!Array.isArray(st) || !st.length) return;
    const json = JSON.stringify(st);
    if (json === S.lastStateJson) return;
    if (cfg.appState) { try { writeAtomic(path.join(DATA, "appstate.backup.json"), cfg.appState); } catch {} }
    S.lastStateJson = json; cfg.appState = st; cfg.stateRefreshedAt = Date.now(); save();
    log("session", `cookie refreshed (${reason})`);
  } catch (e) { log("error", "getAppState: " + (e.message || e)); }
}

function stopListening() {
  const s = S.stopListen; S.stopListen = null;
  clearTimeout(S.listenTimer);
  try {
    if (typeof s === "function") s();
    else if (s && typeof s.stopListening === "function") s.stopListening();
    else if (s && typeof s.stop === "function") s.stop();
  } catch {}
}
function teardown() { stopListening(); stopAllTyping(); S.api = null; S.online = false; S.busy.clear(); }

function markAuthDead(e) {
  probeNet().then((up) => {
    if (up) return realMarkAuthDead(e);
    if (netUp) { netUp = false; netDownAt = Date.now(); netMiss = 2; }
    S.lastError = "Walang internet — nakaabang pa rin, kusang babalik.";
    log("watchdog", "error during internet outage, NOT a dead session: " + String((e && (e.error || e.message)) || e).slice(0, 80));
    if (S.api) drop(); else scheduleRetry();
  }).catch(() => realMarkAuthDead(e));
}
function realMarkAuthDead(e) {
  S.authDead = true;
  S.lastError = "Session expired / checkpoint — paste a fresh cookie. (" + String((e && (e.error || e.message)) || e).slice(0, 120) + ")";
  log("watchdog", "auth problem: fast retry paused, will probe again in 30 min");
  teardown(); S.lastDisconnected = Date.now(); clearTimeout(S.timer);
  S.nextRetry = Date.now() + 30 * 60e3;
  S.timer = setTimeout(() => { if (S.manualOff) return; S.authDead = false; connect(); }, 30 * 60e3);
}

function loadFca() {
  const names = [process.env.FCA_PACKAGE, cfg.fcaPackage, "@dongdev/fca-unofficial"].filter(Boolean);
  const tried = [];
  for (const name of [...new Set(names)]) {
    try {
      const mod = require(name);
      const login = typeof mod === "function" ? mod : mod && (mod.login || mod.default);
      if (typeof login === "function") { S.fcaName = name; return login; }
      tried.push(`${name} (no login export)`);
    } catch (e) { tried.push(`${name} (${String(e.message).split("\n")[0].slice(0, 80)})`); }
  }
  log("error", "fca library missing: " + tried.join(" | "));
  return null;
}

function connect() {
  if (S.logging || !cfg.appState || S.authDead) return;
  clearTimeout(S.timer); S.nextRetry = null; S.logging = true;
  const login = loadFca();
  if (!login) { S.logging = false; S.lastError = "fca library not installed (npm i, or set FCA_PACKAGE)"; return scheduleRetry(); }

  login({ appState: cfg.appState }, { online: true, selfListen: true, listenEvents: true, autoMarkRead: false, logLevel: "error" }, (err, api) => {
    S.logging = false;
    if (err) {
      S.lastError = String(err.message || err.error || err);
      log("error", "login: " + S.lastError);
      return isAuthError(err) ? markAuthDead(err) : scheduleRetry();
    }
    S.api = api; S.uid = String(api.getCurrentUserID()); S.online = true; S.attempts = 0; S.listenFails = 0; S.pingFails = 0;
    S.lastConnected = Date.now(); S.lastError = null; S.authDead = false; S.nextPing = Date.now() + rnd(10, 20) * 60e3;
    log("system", `Messenger connected as ${S.uid} (${S.fcaName})`);
    captureState("login");
    if (cfg.running && !S.running) { S.running = true; S.botSince = Date.now(); log("bot", "resumed after reconnect"); }

    // ===== Phobia: start guards + reconcile after login =====
    initGuards();
    if (titleGuard) titleGuard.reconcile().catch(() => {});
    if (nicknameGuard) nicknameGuard.reconcile("reconnect").catch(() => {});

    startListen();
    gc.resume();
  });
}

function startListen() {
  if (!S.api) return;
  stopListening();
  S.stopListen = S.api.listenMqtt((e, ev) => {
    if (e) return onListenError(e);
    S.listenFails = 0; S.lastEventAt = Date.now();

    // ===== Phobia: dedupe (reconnect/replay guard) =====
    if (ev && ev.messageID && isDuplicateMessage(ev.messageID)) return;

    // ===== Phobia: title + nickname guards =====
    if (ev && ev.threadID) {
      try { titleGuard?.handleEvent(ev).catch(() => {}); } catch {}
      try { nicknameGuard?.handleEvent(ev).catch(() => {}); } catch {}
    }

    onEvent(ev).catch((err) => log("error", "event: " + (err && err.message || err)));
  });
}
function onListenError(e) {
  log("error", "listen: " + (e.message || e.error || e));
  if (isAuthError(e)) return markAuthDead(e);
  S.listenFails++;
  if (S.listenFails <= 3) {
    clearTimeout(S.listenTimer);
    S.listenTimer = setTimeout(startListen, 4000 * S.listenFails + rnd(0, 2000));
    return;
  }
  drop();
}
function drop() { teardown(); S.lastDisconnected = Date.now(); scheduleRetry(); }
function scheduleRetry() {
  if (!cfg.appState || S.manualOff || S.authDead) return;
  S.attempts++;
  let s = Math.min(300, 8 * 2 ** (S.attempts - 1)) + rnd(0, 5);
  if (S.attempts > 10) { s = 1800; S.attempts = 0; log("watchdog", "10 tries failed. Will retry in 30 min"); }
  else log("watchdog", `reconnect #${S.attempts} in ${Math.round(s)}s`);
  S.nextRetry = Date.now() + s * 1000; clearTimeout(S.timer); S.timer = setTimeout(connect, s * 1000);
}
function disconnect() {
  S.manualOff = true; clearTimeout(S.timer); teardown();
  S.running = false; cfg.running = false; save(); S.lastDisconnected = Date.now(); S.nextRetry = null;
}

function ping() {
  if (!S.api) return;
  S.api.getThreadList(1, null, ["INBOX"], (e) => {
    if (!e) { S.pingFails = 0; S.lastPing = Date.now(); return; }
    if (isAuthError(e)) return markAuthDead(e);
    if (++S.pingFails >= 3) { log("watchdog", "health check failed 3x, reconnecting"); S.pingFails = 0; drop(); }
  });
}
setInterval(() => {
  if (!S.api) return;
  captureState("periodic");
  if (Date.now() >= S.nextPing) { S.nextPing = Date.now() + rnd(20, 40) * 60e3; ping(); }
}, 5 * 60e3);

let netUp = true, netDownAt = 0, netMiss = 0;
async function probeNet() {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
  try { await fetch("https://www.facebook.com/favicon.ico", { method: "HEAD", signal: ctl.signal }); return true; }
  catch { return false; } finally { clearTimeout(t); }
}
setInterval(async () => {
  if (!cfg.appState || S.manualOff) return;
  const up = await probeNet();
  if (!up) {
    if (++netMiss >= 2 && netUp) { netUp = false; netDownAt = Date.now(); S.lastError = "Walang internet — maghihintay, kusang babalik."; log("watchdog", "internet down"); }
    return;
  }
  netMiss = 0;
  if (netUp) return;
  netUp = true; S.lastError = null;
  log("watchdog", `internet back after ${Math.round((Date.now() - netDownAt) / 1000)}s — resuming`);
  if (S.authDead) return;
  if (S.api) { S.listenFails = 0; startListen(); S.nextPing = Date.now() + 5000; }
  else if (!S.logging) { S.attempts = 0; clearTimeout(S.timer); connect(); }
  gc.resume();
}, 30e3);

if (process.env.SELF_URL) {
  setInterval(() => { fetch(String(process.env.SELF_URL).replace(/\/+$/, "") + "/health").catch(() => {}); }, 4 * 60e3);
}

// ---------- sending ----------
const sendRaw = (api, text, tid, cb, replyTo) => api.sendMessage(text, tid, cb, replyTo || undefined);

function sendAssistant(threadID, message, replyTo = null, incomingText = "") {
  if (!S.api) return Promise.resolve(false);
  return sendBanatReplyWithTyping(S.api, message, threadID, replyTo, {
    trafficSendMessage: sendRaw, incomingText, speed: "fast", selfReact: false, humanize: false,
  });
}

// ---------- GC name cycle ----------
const gc = createGcCycle({ getApi: () => S.api, cfg, save, log, isAuthError, onAuthError: markAuthDead });

commands.startReminderLoop({ cfg, save, ready: () => !!S.api, send: (tid, text) => sendAssistant(tid, text) });

// ---------- Bot ----------
function allowed(ev) {
  const now = Date.now();
  S.replies = S.replies.filter((t) => now - t < 3600e3);
  S.daily = S.daily.filter((t) => now - t < 86400e3);
  if ((cfg.hourlyMax > 0 && S.replies.length >= cfg.hourlyMax) || (cfg.dailyMax > 0 && S.daily.length >= cfg.dailyMax)) return false;
  if (cfg.senderCooldownS > 0 && now - (S.senders.get(ev.senderID) || 0) < cfg.senderCooldownS * 1000) return false;
  const th = (S.threads.get(ev.threadID) || []).filter((t) => now - t < cfg.threadWindowS * 1000);
  S.threads.set(ev.threadID, th);
  if (S.senders.size > 2000) for (const [k, t] of S.senders) if (now - t > 3600e3) S.senders.delete(k);
  if (S.threads.size > 500) for (const [k, v] of S.threads) if (!v.length) S.threads.delete(k);
  return !(cfg.threadMax > 0) || th.length < cfg.threadMax;
}

const isTarget = (ev) => cfg.autoReply || cfg.threads.includes(String(ev.threadID));

async function handleCommand(ev, parsed) {
  const cmd = commands.resolve(parsed.name);
  if (!cmd) return;
  const admin = isAdminId(ev.senderID);
  if (cmd.admin && !admin) return;
  const owner = isOwnerId(ev.senderID);
  if (cmd.owner && !owner) return;
  if (!admin && moderation.isBanned(ev.threadID, ev.senderID)) return;

  if (!admin) {
    if (!S.running || !isTarget(ev)) return;
    const now = Date.now();
    S.cmdHour = S.cmdHour.filter((t) => now - t < 3600e3);
    if (cfg.cmdHourlyMax > 0 && S.cmdHour.length >= cfg.cmdHourlyMax) return;
    if (now - (S.cmdSenders.get(ev.senderID) || 0) < cfg.cmdCooldownS * 1000) return;
    S.cmdSenders.set(ev.senderID, now); S.cmdHour.push(now);
    if (S.cmdSenders.size > 1000) for (const [k, t] of S.cmdSenders) if (now - t > 3600e3) S.cmdSenders.delete(k);
  }

  const api = S.api;
  if (!api) return;
  if (cfg.markRead && typeof api.markAsRead === "function" && String(ev.senderID) !== S.uid) {
    try { api.markAsRead(ev.threadID, true, () => {}); } catch {}
  }

  startTyping(api, ev.threadID);
  let reply;
  try {
    reply = await cmd.run({
      args: parsed.args,
      ev,
      cfg,
      save,
      gc,
      S,
      prefix: cfg.prefix,
      isAdmin: admin,
      isOwner: owner,
      // ===== Phobia: extra ctx para sa lock / spam / react / massnn commands =====
      api,
      lockStore,
      spamMode,
    });
  } catch (e) {
    log("error", `cmd ${parsed.name}: ${e && e.message || e}`);
    reply = "May error sa command na yan 😭 subukan ulit mamaya.";
  }
  if (!reply) { stopTyping(api, ev.threadID); return; }

  const message = typeof reply === "string" ? { body: reply } : reply;
  const cleanup = message.cleanup; delete message.cleanup;
  const ok = await sendAssistant(ev.threadID, message, ev.messageID || null, ev.body);
  if (typeof cleanup === "function") cleanup();
  stopTyping(api, ev.threadID);
  log("cmd", `${cfg.prefix}${parsed.name} -> ${ev.threadID}${ok ? "" : " (send failed)"}`);
}

async function onEvent(ev) {
  if (ev && ev.type === "event") {
    try { groupControls.handleEvent(S.api, ev, S.uid); } catch {}
    if (S.api) await moderation.onEvent(S.api, ev, { S, isTarget }).catch(() => {});
    return;
  }
  if (!ev || (ev.type !== "message" && ev.type !== "message_reply") || !ev.body) return;

  const parsed = commands.parse(ev.body, cfg.prefix || "!");
  const isCmd = !!(parsed && commands.resolve(parsed.name));
  const own = String(ev.senderID) === S.uid;

  if (own && !isCmd) return;
  if (isCmd) return handleCommand(ev, parsed);

  if (!S.running || !cfg.troll) return;
  if (!isTarget(ev) || inQuiet()) return;
  if (Date.now() < S.awayUntil) return;
  const run = S.skipRun.get(ev.threadID) || 0;
  if (run < Math.min(4, Math.max(0, Number(cfg.skipMax) || 0)) && Math.random() < 0.5) { S.skipRun.set(ev.threadID, run + 1); return; }
  if (S.busy.has(ev.threadID)) return;
  if (!allowed(ev)) { S.suppressed++; return; }

  const api = S.api;
  if (!api) return;
  S.busy.add(ev.threadID);
  S.skipRun.set(ev.threadID, 0);
  if (S.skipRun.size > 500) S.skipRun.clear();
  try {
    const social = chooseSocialResponse(ev.body, "", { momentum: 1, recentMessages: 1 });
    const key = poolKey(social.type);
    const r = pickBanatReply(ev.threadID, poolFor(social.type), [], "reply-pool:" + key);
    const text = typeof r === "string" && r ? r : ALL_REPLIES[Math.floor(Math.random() * ALL_REPLIES.length)];

    const now = Date.now();
    S.replies.push(now); S.daily.push(now); S.senders.set(ev.senderID, now); S.threads.get(ev.threadID).push(now);

    if (cfg.markRead && typeof api.markAsRead === "function") {
      setTimeout(() => { try { api.markAsRead(ev.threadID, true, () => {}); } catch {} }, rnd(250, 1200));
    }

    const ok = await sendBanatReplyWithTyping(api, text, ev.threadID, null, {
      trafficSendMessage: sendRaw,
      incomingText: ev.body,
      speed: cfg.speed,
      selfReact: cfg.selfReact ? { rate: cfg.selfReactRate } : false,
    });
    if (ok) {
      rememberBanatReply(ev.threadID, text, ev.senderID); log("bot", `reply [${social.type}] -> ${ev.threadID}`);
      if (cfg.awayBreaks && Math.random() < 0.06) { S.awayUntil = Date.now() + rnd(20, 90) * 60e3; log("bot", `away break ${Math.round((S.awayUntil - Date.now()) / 60e3)} min`); }
    }
  } finally { S.busy.delete(ev.threadID); }
}

async function startBot() {
  if (!S.online) return log("error", "Connect first");
  S.running = true; cfg.running = true; save(); S.botSince = Date.now(); log("bot", "started");
  cfg.threads.forEach((tid, i) => {
    setTimeout(() => {
      if (!S.api || !S.running) return;
      const o = cfg.openers[Math.floor(Math.random() * cfg.openers.length)];
      sendBanatReplyWithTyping(S.api, o, tid, null, { trafficSendMessage: sendRaw, incomingText: "", speed: cfg.speed, selfReact: false });
    }, i * rnd(4000, 9000));
  });
}

// ---------- HTTP ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.get("/", (q, r) => r.sendFile(path.join(__dirname, "index.html")));

const PWA_FILES = {
  "/manifest.webmanifest": "application/manifest+json", "/sw.js": "application/javascript",
  "/icon.svg": "image/svg+xml", "/icon-192.png": "image/png", "/icon-512.png": "image/png",
  "/icon-maskable-512.png": "image/png", "/apple-touch-icon.png": "image/png",
};
for (const [route, type] of Object.entries(PWA_FILES)) {
  app.get(route, (q, r) => {
    r.type(type);
    if (route === "/sw.js") r.set("Cache-Control", "no-cache");
    r.sendFile(path.join(__dirname, route.slice(1)), (err) => { if (err && !r.headersSent) r.status(404).end(); });
  });
}
app.get("/health", (q, r) => r.json({ ok: true }));

app.get("/api/needsetup", (q, r) => r.json({ setup: false, open: !hasAdmin() }));

const fails = new Map();
app.use("/api", (req, res, next) => {
  if (!hasAdmin()) return next();
  const ip = req.ip, now = Date.now(), given = req.get("x-admin");
  const f = (fails.get(ip) || []).filter((t) => now - t < 900e3);
  if (f.length >= 10) return res.status(429).json({ error: "Too many wrong tries. Wait 15 min." });
  if (hasAdmin() && given !== undefined && checkPw(given)) { fails.delete(ip); return next(); }
  if (given !== undefined) { f.push(now); fails.set(ip, f); }
  if (fails.size > 500) for (const [k, v] of fails) if (!v.some((t) => now - t < 900e3)) fails.delete(k);
  res.status(401).json({ error
