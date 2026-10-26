# blindspot

專抓思考不完全：動手前展開需求的各種解讀、站不住的前提、沒考慮的情境、替代做法與失敗原因，讓第一版就走對方向。只在 prompt 打觸發字串時啟用，沒打就零成本。程式寫得對不對交給姊妹工具 [crosscheck](../crosscheck)。

## 摘要
- 觸發：prompt 任意位置打 `^^1`–`^^3`（前後要空白），只打 `^^` 等於 `^^2`。
- 時機：實作前。主對話先寫一份草稿計畫，盲的子代理只看原始需求與專案現況、不看計畫，先寫自己的想法，再拿去比對計畫。
- `^^1` 主對話照 12 條覆蓋軸自查；`^^2` 一個全面視角子代理；`^^3` 四個互不重疊的視角平行（解讀反方、替代設計、事前驗屍、使用者情境），實作後再叫子代理做缺口複查。
- 產出是覆蓋表，每條標「納入／假設／問使用者／刻意不做／駁回」，不是對錯判定。
- 問使用者最多一輪、預設 4 題；其餘自己選預設並寫成假設，回報時列出讓你推翻。
- 實作後缺口複查：覆蓋表說要做的，逐條找成品裡做到的位置。

## 為什麼和 crosscheck 分開
- 思考不完全要在實作前抓；做完才抓，已經被成品框住，重做成本也高。
- 要的是發散：多個低相關視角比同一份清單多跑幾次有用，跟抓粗心剛好相反。
- 結果多半要取捨或問使用者，「成立／駁回」的帳本裝不下「刻意不做」「記為假設」。
- 不需要快照、worktree、diff，比 crosscheck 輕；也適用於文件、計畫、研究這類非程式碼任務。

## 檔位
- `^^1`：不叫子代理；主對話對草稿計畫逐軸自查，再寫第二種解讀、未確認前提、事前驗屍 3 條、1 個替代做法。缺口複查自己做。
- `^^2`：一個 broad 子代理（解讀、前提、12 軸覆蓋、事前驗屍、替代做法）。缺口複查自己做。
- `^^3`：四個視角子代理平行：interpret（需求解讀與前提反方）、alt（2–3 個獨立替代設計，含「不做或用現成」）、premortem（失敗情境與生命週期）、user（誰在用、各種情境、回饋與說明）。缺口複查交子代理。

## 流程
1. UserPromptSubmit：偵測觸發字串（跟 iter-chain 並用時只看第一段），建立 job：`request.md`（去掉觸發字串與 `stripTokens` 的原文）、`meta.json`；注入約 100 token 的短指令。
   - 主對話與子代理要寫的檔放在專案裡的 `.blindspot/<job>/`（上層有內容為 `*` 的 `.gitignore`，git 看不到）；`~/.claude` 底下會被 Claude Code 當成敏感位置擋下寫入。done 或 cancel 時搬到 `~/.claude/blindspot/state/jobs/<job>/work/`，專案裡的目錄刪掉。
2. 主對話先不改專案檔，寫 `plan.md`（做法、改動範圍、假設、不做），執行 `cli.js prep`，平行叫出視角子代理，背景跑 `cli.js wait` 保溫。
3. 子代理盲階段寫完才讀 `plan.md`，在 `lens-<視角>.md` 列出計畫沒處理或處理有問題的發現。
4. 主對話合併成 `map.md`（覆蓋表），問使用者最多一輪，在 `plan.md` 加「修訂」，執行 `cli.js go` 後才動手實作。
5. 實作與驗證完執行 `cli.js gap`，寫 `gap.md`（每條：做到／部分／沒做到＋證據），補做沒做到的。
6. `cli.js done`：執行過 go 卻還沒有 `gap.md` 就不結算；統計 token（想、做、子代理分開）、寫 history；主對話回報覆蓋表統計、計畫改了什麼、自己選的假設、刻意不做與未解決的。
7. Stop：流程沒走完就停下時擋一次；等子代理或任何背景工作時、`stop_hook_active` 時、已擋過時都放行；使用者回新訊息後重設次數。

## 和 crosscheck 一起用
- 同一則 prompt 打 `^^ %%`：先走 blindspot 到 `go`，實作後跑 crosscheck 的 handoff 與檢查，再做 blindspot 的 gap 與 done。
- 兩邊會互相從需求原文去掉對方的觸發字串（`stripTokens`）；一邊在等背景子代理時，另一邊的 Stop 不會擋。

## 設定（config.json）
- 個人設定寫在同目錄的 `config.local.json`，只寫要改的鍵，會蓋過 `config.json`；更新工具時不會被覆蓋，也不會進 repo。
- `enabled`：總開關。
- `trigger`：觸發前綴（預設 `^^`）；`defaultTier`：只打前綴時的檔位。
- `maxQuestions`：一輪最多問幾題（預設 4）。
- `keepAliveSec`：`wait` 最長等多久（預設 3000 秒）。
- `stopBlockMax`：每則使用者訊息之後 Stop 最多擋幾次（預設 1）。
- `stripTokens`：其他工具的觸發字串，從 `request.md` 去掉（預設 `["%%"]`，crosscheck）。
- `outputWeight`：加權 token 的輸出倍率（預設 5）。
- `debug`：把 hook 輸入存到 `state/debug/`。

## 指令（`node ~/.claude/blindspot/cli.js …`）
- `status`、`log [行數]`：最近 10 個 job、事件紀錄。
- `prep <job>`、`wait <job> [檔名…] [--max 秒]`、`go <job>`、`gap <job>`、`usage <job>`、`done <job>`：主對話照 playbook 用。
- `cancel <job|all>`：停止 job。
- `clean [天數]`：刪掉 N 天前（預設 7）結束的 job 目錄；history 保留。

## 安裝與停用
- toolkeeper：`node ~/.claude/toolkeeper/cli.js deploy blindspot`，會掛上 UserPromptSubmit 與 Stop 兩個 hook。
- 手動：把檔案放到 `~/.claude/blindspot/`，`~/.claude/settings.json` 的 UserPromptSubmit 與 Stop 各加 `node ~/.claude/blindspot/hook.js`（Windows 上 `~` 不一定會展開，請換成絕對路徑），timeout 10。
- 暫停：`config.local.json` 寫 `{"enabled": false}`；移除：刪掉兩個 hook。

## 現成方案比較
- 必要需求：R1 只在觸發時啟用、平常零成本；R2 實作前由看不到計畫的獨立視角先想；R3 每條考量都有明確處理（納入、假設、刻意不做）；R4 問使用者最多一輪；R5 實作後核對計畫說要做的；R6 Windows＋Claude Code。
- Fission-AI/OpenSpec（73k 星，MIT）：規格先行的提案流程（proposal、specs、tasks）；✘ R2（沒有盲的獨立視角，由同一個 agent 寫規格）、部分 R3。吸收：每條需求寫成可核對的情境，對應到這裡的覆蓋軸「驗證」與缺口複查。
- OthmanAdi/planning-with-files（27.7k 星，MIT）：計畫寫在磁碟、每回合 hook 注入；✘ R1（每回合都注入）、✘ R2、✘ R3。吸收：計畫與覆蓋表放在 job 目錄的檔案裡，壓縮或中斷後還能接著做；不採用每回合注入，太花 token。
- mattpocock-skills 的 grilling（合集，星數屬於整個合集）：不停追問使用者直到計畫清楚；✘ R4。吸收：問題要附建議選項與後果；不採用無上限追問。
- 其他命中的是大型 skill 合集或不相關工具（spec 框架、記憶、瀏覽器），沒有「盲視角＋覆蓋表＋單輪提問」的組合，所以自建。

## 測試
- `node test.js`：觸發解析、各檔位的 prep、階段流轉、Stop 擋停與等待放行、覆蓋表統計；狀態寫在系統暫存目錄，不動正式狀態。

## 已知限制
- 「go 之前不改專案檔」靠 playbook 約束，沒有 hook 強制。
- iter-chain 第 2 輪之後的指令走 SessionStart，不會經過 UserPromptSubmit，所以只有第一段能觸發；iter-chain 裡不問使用者，全部記為假設。
- 子代理 effort、model 以 `usage` 印出的 transcript 欄位為準。
- 端到端只用單元測試與 hook 模擬驗證過，互動模式的等待與喚醒以實際使用為準。
