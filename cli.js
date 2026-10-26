// blindspot 管理指令：主對話照 playbook 呼叫 prep、wait、go、gap、usage、done；使用者用 status、log、cancel、clean
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const maxSec = Number(flag('--max', 0));
const [cmd = 'status', arg, ...rest] = argv;
const cfg = L.loadConfig();
const when = (t) => (t ? new Date(t).toLocaleString('zh-TW', { hour12: false }) : '-');
const CLI = L.slash(path.join(L.ROOT, 'cli.js'));
const prompt = (name) => L.slash(path.join(L.ROOT, 'prompts', `${name}.md`));
const AGENT_RULE = '叫法：subagent_type general-purpose，effort "high"，不傳 model；能選背景執行就選背景。';

function need() {
  const job = L.loadJob(arg);
  if (!job) {
    console.log(`找不到 job ${arg}`);
    process.exit(1);
  }
  return job;
}

// 階段不對時提醒但照做，避免主對話卡住
function phaseNote(job, want) {
  if (job.phase !== want) console.log(`注意：job 目前階段是 ${job.phase}，這個指令預期在 ${want} 階段執行`);
}

// plan.md 寫完後呼叫：印出要叫的視角子代理（檔位 1 改為自查）
function prep() {
  const job = need();
  const dir = L.jobDir(job);
  if (!fs.existsSync(path.join(dir, 'plan.md'))) return console.log(`還沒有 ${L.slash(path.join(dir, 'plan.md'))}，先照 playbook 寫好再執行 prep`);
  phaseNote(job, 'think');
  const lenses = L.TIERS[job.tier].lenses;
  job.phase = 'review';
  job.prepAt = job.prepAt || Date.now();
  job.expect = lenses.map((l) => `lens-${l}.md`);
  L.saveJob(job);
  L.log(`[${job.id}] prep：視角 ${lenses.join('、') || '無（自查）'}`);
  if (!lenses.length) return console.log(`job ${job.id}｜檔位 1｜不叫子代理：照 playbook「自查」一節做，接著寫 map.md`);
  console.log(`job ${job.id}｜檔位 ${job.tier}｜請在同一回合平行叫出以下子代理。${AGENT_RULE}`);
  for (const l of lenses) console.log(`- description「blindspot ${l}」，prompt：讀 ${prompt('lens')} 照做。job 目錄：${L.slash(dir)}。檔位：${job.tier}。視角：${l}。`);
  console.log(`叫出後用 Bash 背景執行（run_in_background）：node ${CLI} wait ${job.id}`);
}

// 等到預期產出都出現、job 被取消、或到時間；給主對話當保溫計時
async function wait() {
  let job = need();
  if (rest.length) {
    job.expect = rest;
    L.saveJob(job);
  }
  const dir = L.jobDir(job);
  const limit = Date.now() + (maxSec || cfg.keepAliveSec) * 1000;
  for (;;) {
    job = L.loadJob(job.id);
    const missing = job.expect.filter((f) => !fs.existsSync(path.join(dir, f)));
    if (job.status !== 'running') return console.log(`job 狀態是 ${job.status}，停止等待`);
    if (!missing.length) return console.log(`產出都到了：${job.expect.join('、') || '無'}`);
    if (Date.now() > limit) return console.log(`到時間，還缺 ${missing.join('、')}；子代理還在跑就再背景執行一次 wait`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

// map.md 與修訂後的 plan.md 寫好後呼叫：之後才可以改專案檔案
function go() {
  const job = need();
  const dir = L.jobDir(job);
  if (!fs.existsSync(path.join(dir, 'map.md'))) return console.log(`還沒有 ${L.slash(path.join(dir, 'map.md'))}，先照 playbook 合併成覆蓋表`);
  phaseNote(job, 'review');
  job.phase = 'build';
  job.goAt = job.goAt || Date.now();
  job.expect = [];
  L.saveJob(job);
  const st = L.mapStats(job);
  L.log(`[${job.id}] go：覆蓋表 ${st.items} 項`);
  console.log(`覆蓋表 ${st.items} 項｜${L.HANDLING.map((h) => `${h} ${st[h]}`).join('｜')}`);
  console.log(`現在可以照修訂後的 plan.md 實作；實作與驗證完執行：node ${CLI} gap ${job.id}`);
}

// 實作完呼叫：檢查覆蓋表裡要做的是否都做到（檔位 3 交給子代理）
function gap() {
  const job = need();
  phaseNote(job, 'build');
  job.phase = 'gap';
  const dir = L.jobDir(job);
  if (!L.TIERS[job.tier].gapAgent) {
    job.expect = [];
    L.saveJob(job);
    return console.log(`自己對 map.md 每個「納入」「假設」項找成品裡做到的位置，寫 ${L.slash(path.join(dir, 'gap.md'))}（每項一行 B<n>｜做到/部分/沒做到｜證據）；補完後執行 node ${CLI} done ${job.id}`);
  }
  job.expect = ['gap.md'];
  L.saveJob(job);
  console.log(`叫出缺口複查子代理。${AGENT_RULE}`);
  console.log(`- description「blindspot gap」，prompt：讀 ${prompt('gap')} 照做。job 目錄：${L.slash(dir)}。`);
  console.log(`叫出後背景執行：node ${CLI} wait ${job.id}`);
}

function fmt(u) {
  return `加權 ${u.weighted}｜輸入 ${u.input}｜快取讀 ${u.cacheRead}｜快取寫 ${u.cache5m}+${u.cache1h}(1h)｜輸出 ${u.output}｜${u.calls} 次`;
}

function usage(print = true) {
  const job = need();
  const u = L.usageOf(job, cfg);
  L.writeJson(path.join(L.jobDir(job), 'usage.json'), u);
  if (!print) return u;
  console.log(`主對話・想（觸發到 go）：${fmt(u.think)}`);
  console.log(`主對話・做（go 到 done）：${fmt(u.build)}`);
  for (const a of u.agents) console.log(`子代理 ${a.description}（${a.models || '?'}，effort ${a.efforts || '?'}）：${fmt(a)}`);
  if (u.toolUses !== u.agents.length) console.log(`注意：transcript 有 ${u.toolUses} 個子代理呼叫，只找到 ${u.agents.length} 個子代理紀錄`);
  console.log(`子代理合計 ${u.agentTotal}（API 計價口徑）`);
  return u;
}

function done() {
  const job = need();
  if (job.status !== 'running') return console.log(`job 狀態已經是 ${job.status}`);
  if (!job.goAt) console.log('注意：沒有執行過 go，想與做的花費無法分開');
  job.doneAt = Date.now();
  L.saveJob(job);
  const u = usage(false);
  const st = L.mapStats(job);
  L.archiveWork(job);
  job.status = 'done';
  job.phase = 'done';
  L.saveJob(job);
  const row = { id: job.id, tier: job.tier, source: job.source, cwd: job.cwd, startedAt: job.startedAt, doneAt: job.doneAt, think: u.think.weighted, build: u.build.weighted, agents: u.agents.map((a) => ({ d: a.description, w: a.weighted, model: a.models, effort: a.efforts })), ...st };
  fs.appendFileSync(L.HISTORY_FILE, `${JSON.stringify(row)}\n`);
  L.log(`[${job.id}] 完成：覆蓋表 ${st.items} 項、納入 ${st['納入']}、缺口 ${st.gapMissed}`);
  console.log(`job ${job.id} 完成｜覆蓋表 ${st.items} 項｜${L.HANDLING.map((h) => `${h} ${st[h]}`).join('｜')}｜缺口 ${st.gapMissed}｜想 ${u.think.weighted}｜做 ${u.build.weighted}｜子代理 ${u.agentTotal}`);
}

function cancel() {
  let n = 0;
  for (const job of L.listJobs()) {
    if (job.status !== 'running' || (arg !== 'all' && job.id !== arg)) continue;
    L.archiveWork(job);
    job.status = 'cancelled';
    L.saveJob(job);
    L.log(`[${job.id}] 已取消`);
    n++;
  }
  console.log(`已取消 ${n} 個 job`);
}

function clean() {
  const days = Number(arg ?? 7);
  const limit = Date.now() - days * 86400000;
  let n = 0;
  for (const job of L.listJobs()) {
    if (job.status === 'running' || (job.updatedAt || job.startedAt) > limit) continue;
    fs.rmSync(L.stateDir(job.id), { recursive: true, force: true });
    n++;
  }
  try {
    for (const f of fs.readdirSync(L.DIRS.sessions)) {
      const s = L.readJson(path.join(L.DIRS.sessions, f));
      if (!s || !L.loadJob(s.jobId)) fs.unlinkSync(path.join(L.DIRS.sessions, f));
    }
  } catch {}
  console.log(`已刪除 ${n} 個 ${days} 天前結束的 job（history.jsonl 保留）`);
}

function status() {
  console.log(`啟用：${cfg.enabled ? '是' : '否'}｜觸發字串：${cfg.trigger}1–${cfg.trigger}${L.MAX_TIER}（只打 ${cfg.trigger} 等於檔位 ${cfg.defaultTier}）｜問題上限 ${cfg.maxQuestions} 題｜保溫 ${cfg.keepAliveSec} 秒`);
  const jobs = L.listJobs().sort((a, b) => b.startedAt - a.startedAt).slice(0, 10);
  if (!jobs.length) return console.log('job：無');
  for (const j of jobs) console.log(`- ${j.id}｜${j.status}/${j.phase}｜檔位 ${j.tier}｜${when(j.startedAt)}｜${j.cwd}`);
}

function log() {
  const n = Number(arg) || 30;
  try {
    console.log(fs.readFileSync(L.LOG_FILE, 'utf8').trim().split('\n').slice(-n).join('\n'));
  } catch {
    console.log('還沒有紀錄');
  }
}

const cmds = { status, log, prep, wait, go, gap, usage, done, cancel, clean };
if (cmds[cmd]) Promise.resolve(cmds[cmd]()).catch((e) => console.log(`錯誤：${e.message || e}`));
else console.log('用法：node cli.js [status|log [行數]|prep <job>|wait <job> [檔名…] [--max 秒]|go <job>|gap <job>|usage <job>|done <job>|cancel <job|all>|clean [天數]]');
