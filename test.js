// blindspot 測試：觸發解析、各檔位的 prep、階段流轉、Stop 擋停、覆蓋表統計
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blindspot-test-'));
process.env.BLINDSPOT_STATE_DIR = path.join(tmp, 'state');
const L = require('./lib');
const HOOK = path.join(__dirname, 'hook.js');
const CLI = path.join(__dirname, 'cli.js');
const cfg = L.loadConfig();
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✔ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✘ ${name}\n  ${e.message}`);
  }
}

function hook(input, conf = {}) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, BLINDSPOT_CONFIG_JSON: JSON.stringify(conf) } });
  return r.stdout ? JSON.parse(r.stdout) : null;
}

const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: process.env }).stdout;
const put = (job, file, text) => fs.writeFileSync(path.join(L.jobDir(job), file), text);
const newJob = (tier, sid) => L.createJob({ tier, request: '做 X', cwd: tmp, sessionId: sid, transcriptPath: '', source: 'test' });
const stop = (sid, extra = {}) => hook({ hook_event_name: 'Stop', session_id: sid, ...extra });

test('觸發：^^ 預設檔位 2，前後要空白，超過 3 視同 3', () => {
  assert.deepStrictEqual(L.parseTrigger('想清楚再做 ^^', cfg), { tier: 2, request: '想清楚再做' });
  assert.strictEqual(L.parseTrigger('a^^b', cfg), null);
  assert.strictEqual(L.parseTrigger('^^x 做', cfg), null);
  assert.strictEqual(L.parseTrigger('^^5 做', cfg).tier, 3);
});

test('觸發：crosscheck 的 %% 從需求原文去掉', () => {
  assert.strictEqual(L.parseTrigger('%%3 做 X ^^1', cfg).request, '做 X');
  assert.strictEqual(L.parseTrigger('打 50%% 折 ^^', cfg).request, '打 50%% 折');
});

test('UserPromptSubmit：有觸發才建 job 並注入，沒觸發不輸出', () => {
  const r = hook({ hook_event_name: 'UserPromptSubmit', session_id: 's-u', cwd: tmp, prompt: '^^3 加功能 Y', transcript_path: '' });
  const ctx = r.hookSpecificOutput.additionalContext;
  assert.match(ctx, /檔位 3/);
  assert.match(ctx, /go 之前除了 job 目錄不得修改專案檔案/);
  const job = L.jobOfSession('s-u');
  assert.strictEqual(fs.readFileSync(path.join(L.jobDir(job), 'request.md'), 'utf8').trim(), '加功能 Y');
  assert.strictEqual(hook({ hook_event_name: 'UserPromptSubmit', session_id: 's-none', cwd: tmp, prompt: '普通訊息' }), null);
});

test('prep：沒有 plan.md 不放行；檔位 1 自查、2 一個 broad、3 四個視角', () => {
  const j1 = newJob(1, 's-p1');
  assert.match(cli('prep', j1.id), /還沒有/);
  put(j1, 'plan.md', '## 做法\n- a\n');
  assert.match(cli('prep', j1.id), /不叫子代理/);
  const j2 = newJob(2, 's-p2');
  put(j2, 'plan.md', 'x');
  const o2 = cli('prep', j2.id);
  assert.match(o2, /視角：broad/);
  assert.deepStrictEqual(L.loadJob(j2.id).expect, ['lens-broad.md']);
  const j3 = newJob(3, 's-p3');
  put(j3, 'plan.md', 'x');
  cli('prep', j3.id);
  assert.deepStrictEqual(L.loadJob(j3.id).expect, ['lens-interpret.md', 'lens-alt.md', 'lens-premortem.md', 'lens-user.md']);
});

test('Stop：想階段擋一次；等子代理時不擋；產出到齊卻停下擋', () => {
  const j = newJob(2, 's-s');
  assert.strictEqual(stop('s-s').decision, 'block');
  assert.strictEqual(stop('s-s'), null);
  // 使用者回了新訊息後重設擋停次數
  hook({ hook_event_name: 'UserPromptSubmit', session_id: 's-s', cwd: tmp, prompt: '選 A' });
  assert.strictEqual(L.loadJob(j.id).blocks, 0);
  put(j, 'plan.md', 'x');
  cli('prep', j.id);
  assert.strictEqual(stop('s-s'), null);
  put(j, 'lens-broad.md', 'x');
  assert.strictEqual(stop('s-s').decision, 'block');
  assert.strictEqual(stop('s-s', { stop_hook_active: true }), null);
});

test('go 要先有 map.md；統計各處理；gap 依檔位分自查或子代理', () => {
  const j = newJob(2, 's-g');
  put(j, 'plan.md', 'x');
  cli('prep', j.id);
  assert.match(cli('go', j.id), /還沒有/);
  put(j, 'map.md', ['- B1｜lens-broad W1｜納入｜a｜b', '- B2｜lens-broad W2｜假設｜a｜b', '- B3｜lens-broad W3｜刻意不做｜a｜b', '- B4｜lens-broad W4｜駁回｜a｜b', '## 使用者回答', '- 無'].join('\n'));
  assert.match(cli('go', j.id), /覆蓋表 4 項｜納入 1｜假設 1｜問使用者 0｜刻意不做 1｜駁回 1/);
  assert.strictEqual(L.loadJob(j.id).phase, 'build');
  assert.match(cli('gap', j.id), /自己對 map\.md/);
  put(j, 'gap.md', '## 判定\n- B1｜做到｜a.js:3\n- B2｜部分｜b.js:9\n');
  assert.match(cli('done', j.id), /缺口 1/);
  const row = JSON.parse(fs.readFileSync(L.HISTORY_FILE, 'utf8').trim().split('\n').pop());
  assert.strictEqual(row['納入'], 1);
  assert.strictEqual(L.loadJob(j.id).status, 'done');
  const j3 = newJob(3, 's-g3');
  put(j3, 'plan.md', 'x');
  put(j3, 'map.md', '- B1｜x｜納入｜a｜b');
  cli('prep', j3.id);
  cli('go', j3.id);
  assert.match(cli('gap', j3.id), /prompts\/gap\.md/);
  assert.deepStrictEqual(L.loadJob(j3.id).expect, ['gap.md']);
});

test('Stop：在等背景工作時不擋，Claude Code 自己的背景工作不算', () => {
  newJob(2, 's-w');
  assert.strictEqual(stop('s-w', { background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }] }), null);
  assert.strictEqual(stop('s-w', { background_tasks: [{ id: 'd', type: 'dream', status: 'running' }] }).decision, 'block');
});

test('工作目錄：放在專案的 .blindspot，git 看不到；done 後搬回 state 並清掉', () => {
  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: proj });
  const job = L.createJob({ tier: 1, request: '做 X', cwd: proj, sessionId: 's-wd', transcriptPath: '', source: 'test' });
  assert.strictEqual(path.dirname(job.work), path.join(proj, '.blindspot'));
  assert.ok(fs.existsSync(path.join(job.work, 'meta.json')));
  assert.strictEqual(spawnSync('git', ['status', '--porcelain'], { cwd: proj, encoding: 'utf8' }).stdout.trim(), '');
  put(job, 'plan.md', 'x');
  put(job, 'map.md', '- B1｜self｜納入｜a｜b');
  cli('prep', job.id);
  cli('go', job.id);
  cli('done', job.id);
  assert.ok(!fs.existsSync(path.join(proj, '.blindspot')));
  assert.ok(fs.existsSync(path.join(L.stateDir(job.id), 'work', 'map.md')));
  assert.strictEqual(L.loadJob(job.id).status, 'done');
});

test('cancel 後 Stop 不再擋', () => {
  newJob(1, 's-c');
  cli('cancel', 'all');
  assert.strictEqual(stop('s-c'), null);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `${failed} 個失敗` : '全部通過');
process.exit(failed ? 1 : 0);
