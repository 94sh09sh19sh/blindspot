// blindspot 共用函式：路徑、設定、觸發解析、job、token 統計
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
// BLINDSPOT_STATE_DIR 只給測試用，避免弄髒正式狀態
const STATE = process.env.BLINDSPOT_STATE_DIR || path.join(ROOT, 'state');
const DIRS = {
  jobs: path.join(STATE, 'jobs'),
  sessions: path.join(STATE, 'sessions'),
  debug: path.join(STATE, 'debug'),
};
const LOG_FILE = path.join(STATE, 'blindspot.log');
const HISTORY_FILE = path.join(STATE, 'history.jsonl');
const ITER_CHAIN_DIR = path.join(os.homedir(), '.claude', 'iter-chain');

const DEFAULT_CONFIG = {
  enabled: true,
  trigger: '^^',
  defaultTier: 2,
  maxQuestions: 4,
  keepAliveSec: 3000,
  stopBlockMax: 1,
  stripTokens: ['%%'],
  outputWeight: 5,
  debug: false,
};

// 各檔位要叫出的視角子代理；檔位 1 只有主對話自查。檔位 3 的四個視角刻意互不重疊
const MAX_TIER = 3;
const TIERS = {
  1: { lenses: [], gapAgent: false },
  2: { lenses: ['broad'], gapAgent: false },
  3: { lenses: ['interpret', 'alt', 'premortem', 'user'], gapAgent: true },
};

function ensureDirs() {
  for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

// 先寫暫存檔再改名，避免多個 hook 同時寫入時讀到半個檔案
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function loadConfig() {
  // BLINDSPOT_CONFIG_JSON 只給測試用，可以臨時覆寫設定
  let env = {};
  try {
    env = JSON.parse(process.env.BLINDSPOT_CONFIG_JSON || '{}');
  } catch {}
  // config.json 是 repo 的預設值；config.local.json 是本機個人設定，部署不會覆蓋
  return { ...DEFAULT_CONFIG, ...readJson(path.join(ROOT, 'config.json'), {}), ...readJson(path.join(ROOT, 'config.local.json'), {}), ...env };
}

function log(msg) {
  try {
    ensureDirs();
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

const slash = (p) => String(p).split(path.sep).join('/');
// 兩個目錄：stateDir 在 ~/.claude 底下，只有 node 寫（meta）；
// jobDir 是主對話與子代理要寫的工作目錄，放在專案裡的 .blindspot/<id>（~/.claude 被 Claude Code 當成敏感位置，寫入會被擋）
const WORK_NAME = '.blindspot';
const stateDir = (id) => path.join(DIRS.jobs, id);
const jobDir = (job) => job.work || stateDir(job.id);
const metaFile = (id) => path.join(stateDir(id), 'meta.json');
const sessionFile = (sid) => path.join(DIRS.sessions, `${sid}.json`);
const loadJob = (id) => (id ? readJson(metaFile(id)) : null);

// 工作目錄也放一份 meta.json，給子代理讀 cwd
function saveJob(job) {
  job.updatedAt = Date.now();
  writeJson(metaFile(job.id), job);
  if (job.work && fs.existsSync(job.work)) writeJson(path.join(job.work, 'meta.json'), job);
}

// 在專案裡建工作目錄；上層放內容為 * 的 .gitignore，git 看不到也不用改使用者的檔。建不了就退回 stateDir
function makeWork(cwd, id) {
  const base = path.join(cwd, WORK_NAME);
  try {
    fs.mkdirSync(path.join(base, id), { recursive: true });
    if (!fs.existsSync(path.join(base, '.gitignore'))) fs.writeFileSync(path.join(base, '.gitignore'), '*\n');
    return path.join(base, id);
  } catch {
    fs.mkdirSync(stateDir(id), { recursive: true });
    return null;
  }
}

function copyDir(src, dest) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) {
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(s, d);
    }
  }
}

// 結束或取消時：工作目錄搬到 stateDir/work，刪掉專案裡的目錄（空了連 .blindspot 一起刪）
function archiveWork(job) {
  if (!job.work || !fs.existsSync(job.work) || job.work.startsWith(DIRS.jobs)) return;
  try {
    copyDir(job.work, path.join(stateDir(job.id), 'work'));
    fs.rmSync(job.work, { recursive: true, force: true });
    const base = path.dirname(job.work);
    if (fs.readdirSync(base).every((f) => f === '.gitignore')) fs.rmSync(base, { recursive: true, force: true });
    job.work = path.join(stateDir(job.id), 'work');
  } catch (e) {
    log(`[${job.id}] 搬移工作目錄失敗：${e.message || e}`);
  }
}

function listJobs() {
  try {
    return fs.readdirSync(DIRS.jobs).map((d) => readJson(metaFile(d))).filter(Boolean);
  } catch {
    return [];
  }
}

function jobOfSession(sid) {
  const s = sid && readJson(sessionFile(sid));
  return s ? loadJob(s.jobId) : null;
}

// 跟 iter-chain 並用時只看第一段；分隔字串從 iter-chain 的設定讀
function firstSegment(prompt) {
  const ic = { ...readJson(path.join(ITER_CHAIN_DIR, 'config.json'), {}), ...readJson(path.join(ITER_CHAIN_DIR, 'config.local.json'), {}) };
  const delim = ic.enabled === false ? '' : ic.delimiter || ';;;';
  const i = delim ? prompt.indexOf(delim) : -1;
  return i >= 0 ? prompt.slice(0, i) : prompt;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 找觸發字串：前後必須是空白或字串頭尾，`a^^b`、`^^x` 都不算；有多個時取第一個
// 檔位超過上限視同上限；stripTokens 是其他工具的觸發字串（例：crosscheck 的 %%），一併從需求原文去掉
function parseTrigger(text, cfg) {
  const m = new RegExp(`(^|\\s)${escRe(cfg.trigger)}([1-5])?(?=\\s|$)`).exec(String(text));
  if (!m) return null;
  const start = m.index + m[1].length;
  const end = start + cfg.trigger.length + (m[2] ? 1 : 0);
  let rest = `${text.slice(0, start)}${text.slice(end)}`;
  for (const t of cfg.stripTokens || []) rest = rest.replace(new RegExp(`(^|\\s)${escRe(t)}[1-5]?(?=\\s|$)`, 'g'), '$1');
  rest = rest.replace(/[ \t]{2,}/g, ' ').trim();
  return { tier: Math.min(m[2] ? Number(m[2]) : cfg.defaultTier, MAX_TIER), request: rest };
}

// hook 呼叫：建立 job、存原始需求、記住 session；實作前就跑，不需要快照
function createJob({ tier, request, cwd, sessionId, transcriptPath, source }) {
  ensureDirs();
  const id = `bs${Date.now().toString(36)}`;
  const work = makeWork(cwd, id);
  fs.writeFileSync(path.join(work || stateDir(id), 'request.md'), `${request}\n`);
  const job = { id, tier, cwd, work, sessionId, transcriptPath, source, status: 'running', phase: 'think', blocks: 0, expect: [], startedAt: Date.now() };
  saveJob(job);
  writeJson(sessionFile(sessionId), { jobId: id });
  log(`[${id}] 建立 job，檔位 ${tier}，來源 ${source}，${cwd}`);
  return job;
}

// 注入主對話的短指令
function contextFor(job, cfg) {
  return [
    `[blindspot] 本則指令啟用盲點檢查，檔位 ${job.tier}，job ${job.id}（${slash(jobDir(job))}）。觸發字串 ^^${job.tier} 是指令，不是需求內容。`,
    `動手前先讀 ${slash(path.join(ROOT, 'playbook.md'))} 照做：執行 go 之前除了 job 目錄不得修改專案檔案；問使用者最多 ${cfg.maxQuestions} 題；跑完 done 之前不要結束回覆。`,
  ].join('\n');
}

// 讀 transcript，同一個 message.id 會重複出現在每個內容區塊，只算一次
function readUsage(file, filter = () => true) {
  const msgs = new Map();
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== 'assistant' || !e.message?.usage || !filter(e)) continue;
    msgs.set(e.message.id || e.uuid, { ts: Date.parse(e.timestamp), model: e.message.model, effort: e.effort, usage: e.message.usage });
  }
  return [...msgs.values()];
}

function sumUsage(list, cfg) {
  const t = { calls: list.length, input: 0, cacheRead: 0, cache5m: 0, cache1h: 0, output: 0 };
  for (const { usage: u } of list) {
    t.input += u.input_tokens || 0;
    t.cacheRead += u.cache_read_input_tokens || 0;
    t.output += u.output_tokens || 0;
    const cc = u.cache_creation;
    if (cc) {
      t.cache5m += cc.ephemeral_5m_input_tokens || 0;
      t.cache1h += cc.ephemeral_1h_input_tokens || 0;
    } else t.cache5m += u.cache_creation_input_tokens || 0;
  }
  // API 計價口徑：輸入 1、快取讀 0.1、5 分鐘快取寫 1.25、1 小時快取寫 2、輸出依設定（預設 5）
  t.weighted = Math.round(t.input + t.cacheRead * 0.1 + t.cache5m * 1.25 + t.cache1h * 2 + t.output * cfg.outputWeight);
  return t;
}

// 主對話：觸發到 go 算「想」，go 到 done 算「做」；子代理：prompt 含 job id 的 Agent 呼叫
function usageOf(job, cfg) {
  const end = job.doneAt || Date.now();
  const cut = job.goAt || end;
  const main = readUsage(job.transcriptPath, (e) => {
    const ts = Date.parse(e.timestamp);
    return ts >= job.startedAt && ts <= end;
  });
  const toolIds = new Set();
  try {
    for (const line of fs.readFileSync(job.transcriptPath, 'utf8').split('\n')) {
      if (!line.includes(job.id) || !line.includes('"tool_use"')) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      for (const c of e.message?.content || []) if (c.type === 'tool_use' && /^(Agent|Task)$/.test(c.name) && JSON.stringify(c.input).includes(job.id)) toolIds.add(c.id);
    }
  } catch {}
  const agents = [];
  const subDir = path.join(path.dirname(job.transcriptPath || ''), job.sessionId, 'subagents');
  let metas = [];
  try {
    metas = fs.readdirSync(subDir).filter((f) => f.endsWith('.meta.json'));
  } catch {}
  for (const f of metas) {
    const m = readJson(path.join(subDir, f), {});
    if (!toolIds.has(m.toolUseId)) continue;
    const list = readUsage(path.join(subDir, f.replace(/\.meta\.json$/, '.jsonl')));
    const u = sumUsage(list, cfg);
    u.description = m.description;
    u.models = [...new Set(list.map((x) => x.model).filter(Boolean))].join(',');
    u.efforts = [...new Set(list.map((x) => x.effort).filter(Boolean))].join(',');
    agents.push(u);
  }
  const res = { think: sumUsage(main.filter((m) => m.ts < cut), cfg), build: sumUsage(main.filter((m) => m.ts >= cut), cfg), agents };
  res.agentTotal = agents.reduce((s, a) => s + a.weighted, 0);
  res.toolUses = toolIds.size;
  return res;
}

// 覆蓋表每項一行：「- B1｜lens-alt A2｜納入｜…」；只數處理欄
const HANDLING = ['納入', '假設', '問使用者', '刻意不做', '駁回'];
function mapStats(job) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(jobDir(job), 'map.md'), 'utf8');
  } catch {}
  const rows = text.split('\n').filter((l) => /^-\s*B\d+/.test(l));
  const st = { items: rows.length };
  for (const h of HANDLING) st[h] = rows.filter((l) => l.split('｜')[2]?.trim() === h).length;
  let gap = '';
  try {
    gap = fs.readFileSync(path.join(jobDir(job), 'gap.md'), 'utf8');
  } catch {}
  st.gapMissed = gap.split('\n').filter((l) => /｜\s*(沒做到|部分)\s*｜/.test(l)).length;
  return st;
}

module.exports = {
  ROOT, STATE, DIRS, LOG_FILE, HISTORY_FILE, DEFAULT_CONFIG, TIERS, MAX_TIER, HANDLING,
  ensureDirs, readJson, writeJson, loadConfig, log, readStdin, slash,
  stateDir, jobDir, archiveWork, metaFile, sessionFile, loadJob, saveJob, listJobs, jobOfSession,
  firstSegment, parseTrigger, createJob, contextFor, usageOf, mapStats,
};
