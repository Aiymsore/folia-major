# Apple Music 歌词时钟（Phase 4）——时基评估与外推设计

本文件只回答一个问题：**Apple Music 通过 SMTC 提供的时间信息，能做到什么精度，以及要做到下一档精度必须改什么。**

> 2026-09 重构后的口径：观察层默认看的是 **Chrome 的 SMTC 会话**（`--match Chrome`，网页播放器
> 出声，见 `docs/external-media-backend.md`）。下述实测是在**当时的桌面版 Apple Music 会话**上
> 采得的；Chrome 的量化/发布行为未经同等测量，因此时钟校正层按已确认的决定**保留**
> （"先保留 smtc 时钟矫正层"），其参数按 SMTC 的已知保守事实取值。

结论先行：

1. **歌词高亮（行级）现在就能做，而且之前根本没做** —— 读取歌词时钟的分支从未更新歌词读头，这是缺陷不是取舍，已修（见「已落地」）。
2. **不需要速率校正。** 实测整段速率是 **1.0015x**（120 秒位置跨度 / 119.82 秒墙钟），120 秒里残差只漂移 **179ms**。曾经怀疑的「~10% 比例差」是**测量方法造成的伪影**：把「上一次看到旧值的时刻」当成区间起点，会凭空多出约一个采样周期加相位差。用「变化事件之间的墙钟间隔」重算即得 1.0015x。
3. **真正需要补偿的是发布滞后**：位置被量化到最后**已经走完**的整秒，并且只在操作系统重新发布 timeline 时才更新（发布周期 ~250ms 的量子）。因此读到新位置的那一刻，真实播放时间已经比它多出 **0~150ms（中位数 ~99ms）**。这一项不需要改协议就能补偿，已实现（见「已落地」）。
4. **字级精度的前置条件因此大幅缩小**：不再需要 `receivedAtMs` 才能做任何外推（第一版评估高估了这一点）。当时剩余的唯一可选项 —— 把 `LastUpdatedTime` 送到 renderer，把「锚点年龄」从「≤一个发布周期」收紧到「≤一个采样延迟」—— **现已落地**（见第四节）。

---

## 一、实测事实（来自 `test-results/` 里 9/15 的真实采样）

样本：`smtc-jumps-20260915-193158.csv`，3799 帧、31.6ms 采样间隔、121 次位置变化事件，session AUMID `AppleInc.AppleMusicWin_nzyj5cx40ttqa!App`。可用 `node test/manual/analyze-smtc-rate.cjs` 复现。

| 量 | 实测值 | 含义 |
| --- | --- | --- |
| 位置步长 | **恒为 1000ms**，无例外 | Apple Music 把位置量化到整秒 |
| 相邻位置变化的墙钟间隔 | 两个峰：**~850ms** 与 **~1100ms**（差 250ms） | 发布周期量子的结果，不是速率错误 |
| 整段速率 | **1.0015x**（120000ms / 119820.6ms） | 长程没有比例差 |
| 残差漂移 | 120 秒内 **−179ms** | 同上；`−179/119820 ≈ 0.15%` |
| 每次位置变化是否伴随新的 `LastUpdatedTime` | **121/121** | 位置变化与 timeline 重新发布是同一事件 |
| 每次位置变化携带的发布周期数 | ~3.59 | 一秒被约 3.6 个发布周期覆盖 |
| 读到新位置时的滞后 | **0~150ms，中位数 ~99ms** | 需要补偿的系统量 |
| helper 轮询间隔 | 500ms（`watch --interval` 当时的默认；现为 250ms） | 与 ~250ms 的发布周期相比会漏采，但不影响滞后补偿 |

`smTc-timeline-*.csv` 那几份（`Microsoft.ZuneMusic`）只有 3~4 个 distinct position，用来评估 Apple Music 会得出错误结论，**不要引用**。

### 曾经的两个错误结论（留档，避免重犯）

1. **「位置变化间隔中位数 1100ms ⇒ 存在 ~10% 比例差」** —— 错。间隔在 850/1100 两个峰之间分布，是发布量子的结果；把两个峰混起来取中位数会得到 1100，但整段平均恰好是 1000。判别方法：看**整段**位置跨度与**整段**墙钟之比（1.0015），而不是单步间隔。
2. **「没有 `receivedAtMs` 就无法外推」** —— 过强。滞后上界可以由发布周期直接给出（~250ms），本地接收时刻就足以构造锚点。该字段能把上界收紧到采样延迟（几十毫秒量级），属于优化项。

---

## 二、已落地（本轮）

### 1. 歌词读头缺失（真实缺陷，已修）

`applyExternalMediaClockTick` 一直在正确写 `currentTime` / `lyricCurrentTime`，但 Apple Music 分支**从未更新 `currentLineIndex`**。四个 Folia 分支都在做：

```
usePlaybackVisualizerBridge.ts:232 / 248 / 283 / 299   findLatestActiveLineIndex(...)
```

后果：Apple Music 下进度条会动，但歌词高亮整首停在当前行不再前进 —— 时钟对、读头死。已补，公式与其他四支**完全一致**（`resolveExternalMediaLineIndex`）。

### 2. 后端排他性（顺带修掉的错配窗口）

`useDisplayLyrics()` 之前只对 Apple Music 那一侧做派发，folia 那一侧直接把 `selectDisplayLyrics(state)` 交出去 —— 而它在混音交接期返回的是 **outgoing deck 的歌词**。于是存在一个窄但真实的错配：交接期内 A 曲的歌词 + 由 SMTC 驱动的时钟，会一起进到读头里。

现在 `selectDisplayLyricsForBackend(backend, state)` 把「apple-music 后端下 folia 歌词恒为 null」变成一条可单测的纯函数规则（`src/utils/externalMediaLyricTrackKey.ts`）。修完之后 Apple Music 分支不需要再做曲目身份比对：**歌词属于谁与时钟属于谁在结构上一致**。

### 3. 歌词读头与候选行窗口（纯函数，已测）

`src/utils/externalMediaLyricClock.ts`：

- `resolveExternalMediaLineIndex(lines, lyricTimeSec)` —— 读头。
- `buildExternalMediaLyricWindow(lines, timeSec, lookaheadLines)` —— 候选行窗口。回看一行是刻意的：位置整秒量化 + 快照晚到最多 ~150ms，读头本来就会在边界处落在上一行，把上一行排除会让边界抖动变成「行消失」。
- `hasActiveExternalMediaLine(lyrics, timeSec)` —— 区分「前奏还没唱到」与「已经唱完」（两者都是 -1）。

窗口现在是纯函数、有测试、**还没有消费方**；它是逐字时间轴落地时的输入。这是有意的：先让规则可断言，再接线。

### 4. 校正状态机（纯函数 + 已接线）

`src/utils/externalMediaClockCorrection.ts`：

- `tickExternalMediaClock(state, { nowMs, observedPositionMs, playbackStatus, backend })` —— 不读时钟（`nowMs` 由调用方给），因此全部场景可确定性断言。
- 语义：首个锚点直接采纳；两帧之间按真实经过的墙钟推进（斜率恒为 1）；新锚点的相位误差按 `gain=0.25` 分批吃掉，单帧上限是**本帧真实经过时间的 `APPLE_MUSIC_CLOCK_MAX_CORRECTION_FACTOR = 2` 倍`；`Paused` 冻结；超过 2500ms 无锚点则停滞不动；观测值与外推值相差超过 `APPLE_MUSIC_CLOCK_JUMP_MS = 1500ms` 视为切歌，直接采纳。
- **发布滞后补偿 `leadMs`**：加在观测值上，因此外推的起点就是听感时间的无偏估计。默认值 `1250ms` 由两段构成，**必须区分**：
  1. **可离线测得的部分 ≈ 100ms** —— 位置量化到「最后一个走完的整秒」+ ~250ms 的发布量子（第一节的采样）。
  2. **只能实测的部分 ≈ 1150ms** —— 实机听感报告「比原曲慢 1~1.5s，取 1.25s」。这段包含 SMTC 报告链路之外的音频输出/解码延迟，**离线采样看不到它**。

  因此默认值是**待确认的估计**，不是已知量。运行时可用 `localStorage['folia_apple_music_clock_lead_ms']` 覆盖（非法值、负值、localStorage 抛错都回落到默认值），以便「改一个数、刷新页面、再听一遍」而不必重新构建。

`src/utils/externalMediaClockRuntime.ts` 是接线层：持有模块级单例状态（不是 React state —— 它每帧都变），把校正后的位置写进 `currentTime` / `lyricCurrentTime`，并导出 `resolveCurrentExternalMediaLineIndex()` 供读头使用（返回待写入的离散值，由调用方比较后再 setState）。

`usePlaybackVisualizerBridge.ts` 的 `applyExternalMediaClockTick` 保留原签名并委托给运行时，多了一个可选的 `now` 注入点（测试用）。

三条约束来自踩过的坑，都写进了注释：

1. **斜率不参与修正，恒为 1。** 用单次相位误差反推速率会 windup —— 相位误差主要来自整秒量化而非速率差，实测把斜率顶到 0.98 下限后恢复的锚点再也拉不回来。收敛交给相位修正（每次乘 `1 - gain`）。
2. **修正上限必须是「时间的倍数」，不是固定毫秒数。** 第一版用固定 120ms，配上约 1 秒的锚点周期意味着一个整秒台阶要爬约 8 个周期，估计值长期落后报告值数百毫秒（读头系统性偏早）。改成「本帧最多按真实经过时间的 2 倍推进」后，台阶在它所属的那一秒里被消化掉。
3. **跳变阈值不能复用停滞阈值。** 曾经两者都用 2500ms，结果一次恰好 2000ms 的切歌跳变被当成普通锚点，被上限慢慢拖过去 —— 表现是「切歌后进度条爬十几秒才到位」。现在按「正常播放解释不了这么大的前向差」判定（> 1500ms）。

接线时还修掉一个自己引入的缺陷：`Math.max(0, -Infinity)` 会得到 `0`，于是「非有限位置」被伪装成合法的 0 并让 `Infinity - position = Infinity` 通过跳变判定，把估计值永久打成 `Infinity`。现在归一化层显式拒绝非有限值。

### 5. 诊断探针（`src/utils/externalMediaClockProbe.ts`）

实机听感报告「比原曲慢 1~1.5s」之后加的这一层。它存在的理由是**听感分不清两件事**：

- **固定相位**：我们稳定地比报告值早/晚一个常数。表现为 `phaseMs` 的均值稳定、标准差小。修法是调 `leadMs`，或者更好——把它交给用户可调的歌词偏移。
- **周期内斜坡**：锚点每约 1 秒刷新，两次刷新之间我们没有新信息，于是相位在周期内单调下滑、到锚点时又跳回。表现为 `phaseMs` 与 `anchorAgeMs` 强负相关。**这是结构问题，光调 lead 只能挪动均值，摆动还在。**

探针记录 `{ atMs, observedMs, estimatedMs, phaseMs, anchorAgeMs, playbackStatus }`，只在**报告值变化时**采样（约 1Hz，不是每帧），默认关闭：

```js
// Folia DevTools console
localStorage.setItem('folia_apple_music_clock_probe', '1'); location.reload();
// 播一段后导出
copy(JSON.stringify(JSON.parse(localStorage.getItem('folia_apple_music_clock_probe_log')), null, 2))
```

`node test/manual/analyze-apple-music-clock-probe.cjs <导出的文件>` 给出相位均值/标准差、锚点年龄分布、两者的相关系数，并据此判读是固定相位还是斜坡（也接受直接粘贴控制台的 `[AM clock]` 文本）。

---

## 三、架构裁决：校正层放在哪

校正层需要两样 RAF 循环没有的东西：**锚点的本地时刻**与**跨帧状态**。而 `frontend-runtime-guardrails` 明确禁止以每秒一次的频率重建动画循环依赖（快照约 1Hz 到达，若把它放进依赖数组，`useEffect` 会每秒拆建一次循环）。

因此它是**独立的、按事件驱动的状态机**，RAF 只读它的输出：

```
helper stdout（每次真正变化时发 snapshot）
  → electron/externalMediaSmtcBridge.cjs
  → ElectronExternalMediaStatus
  → useExternalMediaStore（唯一状态源）
  → tickExternalMediaClock（纯函数 + 本地单调时钟 performance.now()）
  → motionSignals.currentTime / lyricCurrentTime
  → RAF 循环读 lyricCurrentTime 算读头（已是现状）
```

**注入点已经存在**：`applyExternalMediaClockTick(backend, positionMs, lyricTimelineOffsetMs, playbackStatus)` 是全局播放时钟的唯一写者（`usePlaybackVisualizerBridge.ts`），现在它委托给 `externalMediaClockRuntime.ts`。不存在第二个时钟所有者。

RAF 循环只做三件事：读快照、调用上面这个函数、把读头离散值写进 store（且只在真的换行时写）。连续时间全程留在 MotionValue 里，符合 `frontend-runtime-guardrails` 对高频路径的要求。

**仍然需要实机验证的是参数而不是结构**：`EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS = 1250`（构成见第二节第 4 条）与 `MAX_CORRECTION_FACTOR = 2` 是从实测数据推出的，但「听感上偏早还是偏晚」只能实机判断（实测项见第四节末尾）。

---

## 四、锚点年龄收紧：`LastUpdatedTime` 已送到 renderer（已落地）

原「可选优化」已经落地，不再是待做项。它把「锚点年龄上界」从「一个发布周期（~250ms）」收紧到「一个采样延迟（几十毫秒）」。字段缺席时（老 helper、时间轴读不到）校正层自动退回「本地接收时刻 + leadMs 估计」，行为与落地前一致。

对照原计划的 4 层，现状如下：

| 层 | 文件 | 现状 |
| --- | --- | --- |
| Rust helper 事件 | `packaging/windows/apple-music-smtc-helper/src/events.rs` | snapshot 携带 `lastUpdatedMs`（`TimelineProperties.LastUpdatedTime` 转 Unix ms，不可得为 null）。协议是定长键集，README 与快照测试已同步。 |
| Electron bridge | `electron/externalMediaSmtcBridge.cjs` | 归一化成 `lastUpdatedAt`（非有限值落 null）交给渲染层。 |
| 类型 | `src/vite-env.d.ts`（`ElectronExternalMediaStatus`） | `lastUpdatedAt`（number 或 null）。 |
| 校正层 | `src/utils/externalMediaClockRuntime.ts` | 用 `lastUpdatedAtMs` 换算单调时钟锚点（`wallClockToMonotonicMs`）；缺席时回落 `nowMs`。探针据此把样本标成 `measured` / `assumed`。 |

轮询也已放宽：`watch` 默认间隔从 500ms 落到 **250ms**（`DEFAULT_INTERVAL_MS`，理由在 `cli.rs` 顶部：500ms 会漏掉约一半的 OS 重新发布，转发出去的 `lastUpdatedMs` 会旧到 ~750ms）。

### 仍然值得实测的两项

| 问题 | 方法 | 判据 |
| --- | --- | --- |
| `EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS`（1250，其中 ~1150 是听感段）是否合适 | 实机播放，肉眼比对歌词行点亮时刻与听感；用第二节第 5 条的诊断探针导出 `phaseMs` / `anchorAgeMs` 配对 | 若整体偏早则调小、偏晚则调大；合适值应让偏差在 ±100ms 内且不出现「行还没唱到就点亮」 |
| 轮询 250ms 的 CPU 代价（放宽已落地，代价未测） | 用 `test/manual/probe-smtc.ps1` 改间隔采样，观察 helper CPU 与快照频率 | CPU 无显著上升 |

`test/manual/analyze-smtc-rate.cjs` 已可复现第一节的全部数字；实机复测同一首曲子应当得到同样的 1.0015x 与同样的双峰间隔。

---

## 五、验收标准

**行级（当前阶段，可立即验收）**

- Apple Music 播放中，歌词高亮随位置前进，不再停在一行。
- 每一行的点亮时刻与听感偏差不超过约 0.3s（`leadMs` 补偿后的目标量级）；边界处允许落在上一行。
- 前奏期间无高亮；曲末最后一行结束后读头回到无高亮 —— 与 Folia 行为一致。
- 切歌时读头原子地跟随新曲目（不出现「新歌标题 + 旧歌高亮」）。

**接线后的时钟（本轮交付的状态机接进 `applyExternalMediaClockTick` 之后）**

- 进度条与歌词连续移动，不再每约 1 秒停一下再跳一格。
- 暂停时进度条与读头一起冻结。
- 切歌时位置直接落到新曲目，不从上一首爬过去。
- 长曲（≥4 分钟）不出现累积漂移：实测长程速率 1.0015x，全程偏差应保持在亚秒级。

**字级（需要逐字时间轴，尚不在范围内）**

- 目标：与听感偏差 p95 ≤ 100ms。
- 当前数据（整秒位置 + ~99ms 已补偿滞后）只能支撑行级；逐字需要在第四节的基础上再评估。

---

## 六、明确不在本轮范围

- **不做 seek 补偿**：Apple Music 的 `IsPlaybackPositionEnabled === False`，seek 不生效（结论与注释在 `useTransportDispatcher.handleExternalMediaSeek` 与 `session.rs`）。校正层把大幅前向差一律当切歌处理，不做乐观跳转。
- **不引入第二个时钟所有者**：`applyExternalMediaClockTick` 保持唯一写者。
- **不动 Folia 的时钟路径**：四个 Folia/Stage 分支与它们的优先级顺序完全不变。
- **不做速率校正**：实测长程速率 1.0015x，斜率恒为 1 是正确选择而非简化。
- **不做逐字时间轴**：当前数据（整秒位置 + ~100ms 已补偿滞后）支撑的是行级；逐字需要在第四节的基础上重新评估。
