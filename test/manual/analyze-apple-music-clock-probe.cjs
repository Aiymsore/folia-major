// Apple Music 歌词时钟的探针分析器。
//
// 用法（在 Folia 里开启探针、播放一段、然后把 localStorage 里的日志贴进一个文件）：
//
//   1. 在 Folia 的 DevTools console 里执行：
//        localStorage.setItem('folia_apple_music_clock_probe', '1'); location.reload();
//   2. 切到 Apple Music 后端，让它播一首有人声进出的曲子，至少放 60 秒。
//   3. 把日志导出成文件：
//        copy(JSON.stringify(JSON.parse(localStorage.getItem('folia_apple_music_clock_probe_log')), null, 2))
//      或者直接复制控制台里那串 [AM clock] 输出。
//   4. node test/manual/analyze-apple-music-clock-probe.cjs <导出的文件>
//
// 它回答两个问题，并把「固定相位」与「周期内斜坡」分开：
//
//   * 固定相位 = phaseMs 的均值。这是 lead 应当补偿的量：为负说明我们显示得比报告值早（会偏早），
//     为正说明偏晚。若均值稳定，它就是一个常数，应当交给用户可调的歌词偏移，而不是硬编码。
//   * 周期内斜坡 = phaseMs 在相邻锚点之间的变化幅度。锚点每约 1 秒到一次，若相位在周期内单调
//     下滑然后又跳回，说明「锚点年龄」没有被外推吸收 —— 那是结构问题，不是参数问题。
const fs = require('node:fs');

const path = process.argv[2];
if (!path) {
  console.error('用法: node test/manual/analyze-apple-music-clock-probe.cjs <探针导出的 JSON 文件>');
  process.exit(2);
}

const raw = fs.readFileSync(path, 'utf8');

/** 兼容两种输入：JSON 数组，或控制台里那串 `[AM clock] ...` 文本。 */
const parseSamples = (text) => {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed).map((s) => ({
      atMs: s.atMs,
      observedMs: s.observedMs,
      estimatedMs: s.estimatedMs,
      phaseMs: s.phaseMs,
      anchorAgeMs: s.anchorAgeMs,
      stampSource: s.stampSource === 'measured' ? 'measured' : 'assumed',
      playbackStatus: s.playbackStatus ?? null,
    }));
  }

  const out = [];
  const re = /\[AM clock\] pos=([\d.]+)s est=([\d.]+)s phase=(-?[\d.]+)ms anchorAge=([\d.]+)ms(?: stamp=(\w+))?/g;
  let m;
  while ((m = re.exec(text))) {
    out.push({
      atMs: out.length * 1000,
      observedMs: Number(m[1]) * 1000,
      estimatedMs: Number(m[2]) * 1000,
      phaseMs: Number(m[3]),
      anchorAgeMs: Number(m[4]),
      stampSource: m[5] === 'measured' ? 'measured' : 'assumed',
      playbackStatus: null,
    });
  }
  return out;
};

const samples = parseSamples(raw).filter((s) => s.playbackStatus === null || s.playbackStatus === 'Playing');
if (samples.length < 5) {
  console.error(`样本太少（${samples.length} 条）。至少需要 5 条 Playing 状态的采样。`);
  process.exit(1);
}

const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const stdev = (arr) => {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((v) => (v - m) ** 2)));
};
const q = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

const phases = samples.map((s) => s.phaseMs);
const ages = samples.map((s) => s.anchorAgeMs);

console.log(`样本数: ${samples.length}`);
console.log(`观察时长: ${((samples[samples.length - 1].atMs - samples[0].atMs) / 1000).toFixed(1)}s`);

const measured = samples.filter((s) => s.stampSource === 'measured').length;
const assumed = samples.length - measured;
console.log(`锚点年龄来源: measured=${measured} assumed=${assumed}`);
if (assumed > 0) {
  console.log('  ⚠ 有 assumed 采样 ⇒ 那些帧的相位里含一段**未补偿**的发布滞后，');
  console.log('    判读均值时必须把它们与 measured 分开看（helper 是否已重建？时间轴是否读不到？）');
}
console.log('');

console.log('— 固定相位（phaseMs = 估计值 - 报告值）—');
console.log(`  均值   ${mean(phases).toFixed(0)}ms`);
console.log(`  中位数 ${q(phases, 0.5).toFixed(0)}ms`);
console.log(`  标准差 ${stdev(phases).toFixed(0)}ms   ← 越小越说明它是一个稳定常数`);
console.log(`  范围   ${q(phases, 0).toFixed(0)} .. ${q(phases, 1).toFixed(0)}ms`);
console.log('');

console.log('— 锚点年龄（距上次报告值变化的真实经过时间）—');
console.log(`  中位数 ${q(ages, 0.5).toFixed(0)}ms   最大 ${q(ages, 1).toFixed(0)}ms`);
console.log('');

// 相位与锚点年龄的相关性：强负相关说明「锚点越老、我们越落后」= 周期内斜坡。
const n = Math.min(phases.length, ages.length);
const mp = mean(phases.slice(0, n));
const ma = mean(ages.slice(0, n));
let cov = 0;
let varP = 0;
let varA = 0;
for (let i = 0; i < n; i += 1) {
  const dp = phases[i] - mp;
  const da = ages[i] - ma;
  cov += dp * da;
  varP += dp * dp;
  varA += da * da;
}
const corr = varP > 0 && varA > 0 ? cov / Math.sqrt(varP * varA) : 0;

console.log('— 相位 vs 锚点年龄 —');
console.log(`  相关系数 ${corr.toFixed(2)}`);
console.log('');

console.log('— 判读 —');
if (measured > 0 && assumed === 0) {
  console.log('  全部采样都带 measured 戳 ⇒ 锚点年龄是算出来的，`leadMs` 不参与补偿。');
  console.log('  此时的相位均值应当接近 0；若仍明显为正/负，那是**音频链路**的固定延迟，');
  console.log('  应当交给用户可调的歌词偏移，而不是继续加大 lead。');
} else if (assumed > 0 && measured === 0) {
  console.log('  全部采样都是 assumed ⇒ 快照没带 lastUpdatedAt。');
  console.log('  确认 helper 是否已按新协议重建（npm run build:apple-music-smtc-helper）。');
} else {
  console.log('  measured 与 assumed 混合 ⇒ 时间轴间歇性读不到，先查 helper 日志再判读相位。');
}
console.log('');

if (Math.abs(corr) > 0.5) {
  console.log('  相位与锚点年龄强相关 ⇒ 存在**周期内斜坡**：锚点越老我们越落后。');
  console.log('  若这些采样是 assumed，那是预期的（没有戳就只能估）；若已是 measured 仍然相关，');
  console.log('  说明时间戳折算或锚点推进有问题，需要看代码而不是调参数。');
} else {
  console.log('  相位与锚点年龄基本无关 ⇒ 主要是**固定相位**，可以用一个常数 lead 补偿。');
}
console.log('');

if (mean(phases) < -150) {
  console.log(`  均值 ${mean(phases).toFixed(0)}ms 为负：我们显示得比报告值**早**。若听感偏早，减小 lead。`);
} else if (mean(phases) > 150) {
  console.log(`  均值 ${mean(phases).toFixed(0)}ms 为正：我们显示得比报告值**晚**。若听感偏晚，增大 lead。`);
} else {
  console.log('  均值接近 0：相对报告值已对齐，剩余偏差应来自音频链路本身，交给用户可调的歌词偏移。');
}
console.log('');
console.log('  当前默认 lead：1250ms（见 src/utils/externalMediaClockCorrection.ts 的注释）');
console.log("  运行时覆盖：localStorage.setItem('folia_apple_music_clock_lead_ms', '<毫秒>') 然后刷新页面");
