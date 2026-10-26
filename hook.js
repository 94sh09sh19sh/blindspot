// blindspot 的 hook 入口：UserPromptSubmit、Stop
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const out = (obj) => process.stdout.write(JSON.stringify(obj));

// 主對話在等背景工作（子代理、指令；例如 crosscheck 的子代理）時不擋；Claude Code 自己的背景工作不算
const OWN_TASKS = ['dream', 'auto-mode scan', 'memory import'];
const waiting = (input) => (input.background_tasks || []).some((t) => !OWN_TASKS.includes(t.type));

// 有觸發字串就建立 job、注入短指令；沒有的話，若這個 session 有進行中的 job（例：使用者回答了問題）就重設擋停次數
function onUserPromptSubmit(input, cfg) {
  const t = L.parseTrigger(L.firstSegment(String(input.prompt || '')), cfg);
  if (!t) {
    const job = L.jobOfSession(input.session_id);
    if (job?.status === 'running' && job.blocks) {
      job.blocks = 0;
      L.saveJob(job);
    }
    return;
  }
  if (!input.cwd) return;
  const job = L.createJob({ tier: t.tier, request: t.request, cwd: input.cwd, sessionId: input.session_id, transcriptPath: input.transcript_path, source: 'prompt' });
  out({
    systemMessage: `blindspot：檔位 ${job.tier}，job ${job.id}`,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: L.contextFor(job, cfg) },
  });
}

// 流程還沒走完就停下時擋一次；子代理還在跑（等待中）不擋
function onStop(input, cfg) {
  const job = L.jobOfSession(input.session_id);
  if (!job || job.status !== 'running' || input.stop_hook_active || waiting(input) || job.blocks >= cfg.stopBlockMax) return;
  if (job.phase === 'review' || job.phase === 'gap') {
    const dir = L.jobDir(job);
    if (!job.expect.length || !job.expect.every((f) => fs.existsSync(path.join(dir, f)))) return;
  }
  job.blocks++;
  L.saveJob(job);
  L.log(`[${job.id}] Stop 擋下第 ${job.blocks} 次（階段 ${job.phase}）`);
  out({ decision: 'block', reason: `blindspot job ${job.id} 還沒跑完（階段 ${job.phase}）：讀 ${L.slash(path.join(L.ROOT, 'playbook.md'))} 繼續；如果你停下是在等使用者回答，再停一次即可。` });
}

function main() {
  const cfg = L.loadConfig();
  const input = L.readStdin();
  if (!cfg.enabled || !input.session_id) return;
  if (cfg.debug) L.writeJson(path.join(L.DIRS.debug, `${input.hook_event_name}.json`), input);
  switch (input.hook_event_name) {
    case 'UserPromptSubmit':
      return onUserPromptSubmit(input, cfg);
    case 'Stop':
      return onStop(input, cfg);
  }
}

try {
  main();
} catch (e) {
  L.log(`hook 錯誤：${e.stack || e}`);
}
