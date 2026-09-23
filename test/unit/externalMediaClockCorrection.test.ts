import { describe, expect, it } from 'vitest';
import {
    EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS,
    APPLE_MUSIC_CLOCK_STALL_MS,
    externalMediaClockPositionSec,
    createExternalMediaClockState,
    tickExternalMediaClock,
    type ExternalMediaClockState,
} from '../../src/utils/externalMediaClockCorrection';

// test/unit/externalMediaClockCorrection.test.ts
// 「SMTC 粗锚点 + 单调时钟 + 低增益校正」的规则锁定。
//
// 参数来自实测（docs/apple-music-lyric-clock.md）：位置整秒量化、操作系统每 ~250ms 重新发布一次
// timeline，于是相邻位置变化的墙钟间隔落在 ~850ms 与 ~1100ms 两个峰上；读到新位置时真实播放时间
// 已经多出 0~150ms（中位数 ~99ms）。整段平均速率是 1.0015x，所以**不需要速率校正**，需要的是
// 抹平台阶 + 补偿发布滞后。
//
// 这个状态机不读时钟，`nowMs` 由调用方给，因此下面的场景全部是确定性的。
//
// 约定：`LEAD` 是发布滞后补偿。因此「观测到 P」意味着真实时间约为 P + LEAD。

const TICK_MS = 16;
const LEAD = EXTERNAL_MEDIA_CLOCK_DEFAULT_LEAD_MS;

type TickResult = { state: ExternalMediaClockState; positionMs: number };

const tick = (
    state: ExternalMediaClockState,
    nowMs: number,
    observedPositionMs: number | null,
    playbackStatus: string | null = 'Playing',
): TickResult => {
    const next = tickExternalMediaClock({ ...state }, { nowMs, observedPositionMs, playbackStatus, backend: 'external-media' });
    return { state: next, positionMs: next.positionMs };
};

describe('首个锚点', () => {
    it('adopts the first observation, compensated for publish lag, without smoothing', () => {
        const { state, positionMs } = tick(createExternalMediaClockState(), 1000, 10_000);

        expect(positionMs).toBe(10_000 + LEAD);
        expect(state.rate).toBe(1);
        expect(state.pendingCorrectionMs).toBe(0);
        expect(state.anchorAtMs).toBe(1000);
    });

    it('stays at zero when the first snapshot has no position', () => {
        const { positionMs, state } = tick(createExternalMediaClockState(), 1000, null);
        expect(positionMs).toBe(0);
        expect(state.anchorAtMs).toBeNull();
    });
});

describe('外推', () => {
    it('advances with the wall clock between anchors', () => {
        let state = createExternalMediaClockState();
        ({ state } = tick(state, 0, 10_000));
        const anchored = state.positionMs;

        // 500ms 没有新锚点：外推推进 500ms，相位误差被修正上限吃掉一部分，因此落在两者之间。
        // 边界写成相对锚点的形式，避免与 LEAD 的具体取值绑死（LEAD 是待实机确认的估计值）。
        ({ state } = tick(state, 500, 10_000));
        const afterFirst = state.positionMs;
        expect(afterFirst).toBeGreaterThan(anchored);
        expect(afterFirst).toBeLessThanOrEqual(anchored + 500);

        // 再 500ms：时钟继续前进，没有出现「停住等下一个整秒」的台阶。
        ({ state } = tick(state, 1000, 10_000));
        expect(state.positionMs).toBeGreaterThan(afterFirst);
    });

    it('does not jump a whole second when a stale anchor arrives', () => {
        // 实测场景：位置整秒量化且发布晚 0~150ms。朴素读取会在这里跳 1000ms；
        // 校正层只允许单帧 120ms 的修正，因此台阶被摊开。
        let state = createExternalMediaClockState();
        ({ state } = tick(state, 0, 10_000));
        ({ state } = tick(state, 850, 11_000));

        const perFrameMove = state.positionMs - (10_000 + LEAD);
        // 850ms 的真实推进 + 至多 120ms 的修正。
        expect(perFrameMove).toBeGreaterThan(850);
        expect(perFrameMove).toBeLessThanOrEqual(850 + 120 + 1);
    });

    it('keeps advancing at 1:1 while the reported position stays put', () => {
        // 这是本轮修掉斜坡的核心契约：helper 每 250ms 轮询，而位置每秒才变一次，
        // 所以绝大多数 tick 拿到的是**同一个**报告值。那些帧必须继续按墙钟前进 ——
        // 停在锚点上等下一次刷新，就是「周期内相位下滑」的来源。
        let state = createExternalMediaClockState();
        ({ state } = tick(state, 0, 10_000));
        const anchored = state.positionMs;

        // 2 秒内报告值一次都没变（真实场景里最多 1 秒，这里用 2 秒留出余量，
        // 且刻意不超过停滞阈值 2500ms，否则会走冻结分支）。
        for (let t = TICK_MS; t <= 2000; t += TICK_MS) {
            ({ state } = tick(state, t, 10_000));
        }

        // 推进量应当等于真实经过的墙钟时间，而不是收敛回锚点。
        expect(state.positionMs - anchored).toBeCloseTo(2000, -1);
    });

    it('pulls back toward a jumped report instead of letting the drift accumulate', () => {
        // 报告值跳了一整秒之后，估计值要被拉回它附近（而不是继续按自己的节奏跑）。
        let state = createExternalMediaClockState();
        ({ state } = tick(state, 0, 10_000));
        for (let t = TICK_MS; t <= 1000; t += TICK_MS) {
            ({ state } = tick(state, t, 10_000));
        }

        // 位置前进一整秒：这是新的观测值，会触发校正。
        ({ state } = tick(state, 1016, 11_000));
        const target = 11_000 + LEAD;
        expect(state.positionMs).toBeGreaterThan(target - 600);
        expect(state.positionMs).toBeLessThan(target + 600);
    });

    it('never moves the estimate backwards while playing', () => {
        let state = createExternalMediaClockState();
        ({ state } = tick(state, 0, 10_000));
        let previous = state.positionMs;

        // 锚点反复回落到更小的值：位置不允许倒退，否则歌词读头会来回跳。
        for (let t = TICK_MS; t <= 600; t += TICK_MS) {
            ({ state } = tick(state, t, 9_000));
            expect(state.positionMs).toBeGreaterThanOrEqual(previous);
            previous = state.positionMs;
        }
    });

    it('keeps the rate inside the allowed band', () => {
        let state = createExternalMediaClockState();
        ({ state } = tick(state, 0, 0));
        for (let t = TICK_MS; t <= 3000; t += TICK_MS) {
            ({ state } = tick(state, t, 1000 + Math.round(t / 1000) * 1000));
        }

        expect(state.rate).toBeGreaterThanOrEqual(0.98);
        expect(state.rate).toBeLessThanOrEqual(1.02);
    });
});

describe('暂停', () => {
    it('freezes the estimate while the player is not playing', () => {
        let state = createExternalMediaClockState();
        ({ state } = tick(state, 0, 10_000));
        ({ state } = tick(state, 200, 10_000, 'Paused'));

        const frozen = state.positionMs;
        ({ state } = tick(state, 1200, 10_000, 'Paused'));
        ({ state } = tick(state, 2200, 10_000, 'Paused'));

        expect(state.positionMs).toBeCloseTo(frozen, 0);
    });

    it('resumes from the reported position when playback restarts', () => {
        let state = createExternalMediaClockState();
        ({ state } = tick(state, 0, 10_000));
        ({ state } = tick(state, 500, 10_000, 'Paused'));
        // 用户在别处拖了进度并恢复播放：位置跳了一大截。
        ({ state } = tick(state, 10_000, 40_000, 'Playing'));

        expect(state.positionMs).toBe(40_000 + LEAD);
    });

    it('treats Stopped and Closed as not playing', () => {
        for (const status of ['Stopped', 'Closed', 'Opened', 'Changing', 'Unknown(9)', null]) {
            let state = createExternalMediaClockState();
            ({ state } = tick(state, 0, 10_000));
            ({ state } = tick(state, 1000, 10_000, status));
            expect(state.positionMs).toBe(10_000 + LEAD);
        }
    });
});

describe('跳变与停滞', () => {
    it('adopts a large jump immediately and resets the slope', () => {
        let state = createExternalMediaClockState();
        ({ state } = tick(state, 0, 10_000));
        ({ state } = tick(state, 500, 10_500));
        // 切歌：位置直接换个区间。
        ({ state } = tick(state, 600, 200_000));

        expect(state.positionMs).toBe(200_000 + LEAD);
        expect(state.rate).toBe(1);
        expect(state.pendingCorrectionMs).toBe(0);
    });

    it('does not advance when the anchor stream stalls', () => {
        // 桥接断了、helper 挂了：继续按未知速率外推会让进度条跑飞。
        let state = createExternalMediaClockState();
        ({ state } = tick(state, 0, 10_000));

        const before = state.positionMs;
        ({ state } = tick(state, APPLE_MUSIC_CLOCK_STALL_MS + 100, 10_000));

        expect(state.positionMs).toBeCloseTo(before, 0);
    });

    it('recovers after a stall by adopting the next anchor', () => {
        let state = createExternalMediaClockState();
        ({ state } = tick(state, 0, 10_000));
        ({ state } = tick(state, APPLE_MUSIC_CLOCK_STALL_MS + 100, 10_000));
        ({ state } = tick(state, APPLE_MUSIC_CLOCK_STALL_MS + 200, 12_000));

        expect(state.positionMs).toBe(12_000 + LEAD);
        expect(state.anchorAtMs).toBe(APPLE_MUSIC_CLOCK_STALL_MS + 200);
    });
});

describe('后端与输入健壮性', () => {
    it('resets and yields the clock back to Folia when the backend changes', () => {
        let state = createExternalMediaClockState();
        ({ state } = tick(state, 0, 10_000));

        const reset = tickExternalMediaClock(state, {
            nowMs: 100,
            observedPositionMs: 10_100,
            playbackStatus: 'Playing',
            backend: 'folia',
        });

        expect(reset).toEqual(createExternalMediaClockState());
    });

    it('ignores a non-finite observation instead of writing a broken position', () => {
        for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            let state = createExternalMediaClockState();
            ({ state } = tick(state, 0, 10_000));
            ({ state } = tick(state, 100, value));
            expect(Number.isFinite(state.positionMs)).toBe(true);
        }
    });

    it('clamps a negative observation to zero before applying the lead', () => {
        const state = tickExternalMediaClock(createExternalMediaClockState(), {
            nowMs: 0,
            observedPositionMs: -5000,
            playbackStatus: 'Playing',
            backend: 'external-media',
        });
        expect(externalMediaClockPositionSec(state)).toBeCloseTo(LEAD / 1000, 5);
    });
});

describe('测出来的锚点时刻（LastUpdatedTime）', () => {
    // 这一组锁的是本轮的核心修正：有操作系统的确立时刻时，锚点年龄是**算出来的**，
    // `leadMs` 不再叠加（叠加会把同一段滞后补偿两次，表现为歌词整体提前）。

    const tickStamped = (
        state: ExternalMediaClockState,
        nowMs: number,
        observedPositionMs: number,
        observedAtMs: number,
        playbackStatus: string | null = 'Playing',
    ) => tickExternalMediaClock(
        { ...state },
        { nowMs, observedPositionMs, playbackStatus, backend: 'external-media', observedAtMs },
        // 故意给一个大 lead：有戳时它必须**完全不生效**，这样断言才有区分度。
        { leadMs: 1000 },
    );

    it('does not apply the lead when the stamp is measured', () => {
        // 位置 10_000 在 nowMs=500 被确立，我们在 nowMs=600 读到它：
        // 真实播放时间就是 10_000 + 100（确立到现在），而不是 10_000 + 1000（lead）。
        const state = tickStamped(createExternalMediaClockState(), 600, 10_000, 500);
        expect(state.positionMs).toBe(10_100);
        expect(state.anchorAtMs).toBe(500);
    });

    it('still applies the lead when there is no stamp', () => {
        // 对照组：没有戳时退化成旧行为，lead 全额生效。
        const state = tickExternalMediaClock(
            createExternalMediaClockState(),
            { nowMs: 600, observedPositionMs: 10_000, playbackStatus: 'Playing', backend: 'external-media' },
            { leadMs: 1000 },
        );
        expect(state.positionMs).toBe(11_000);
    });

    it('advances from the stamp instead of from the moment we read it', () => {
        // 关键差异：同一个位置、同一个读取时刻，迟到的快照（戳更早）应当得到**更大**的位置，
        // 因为它已经更旧了。这正是周期内斜坡被消掉的地方。
        const fresh = tickStamped(createExternalMediaClockState(), 1000, 10_000, 950);
        const stale = tickStamped(createExternalMediaClockState(), 1000, 10_000, 200);

        expect(stale.positionMs).toBeGreaterThan(fresh.positionMs);
        expect(stale.positionMs - fresh.positionMs).toBe(750);
    });

    it('keeps the anchor age out of the correction when the stamp is present', () => {
        // 有了戳，两次 tick 之间的推进应当严格等于真实经过时间，不受读取延迟影响。
        let state = tickStamped(createExternalMediaClockState(), 0, 10_000, 0);
        const first = state.positionMs;
        state = tickStamped(state, 500, 10_000, 0);
        expect(state.positionMs - first).toBeCloseTo(500, 5);
    });

    it('ignores an implausible future stamp rather than starting ahead of now', () => {
        // 明显超前于「现在」的戳不可信：用它当锚点会让外推从未来起跑。
        // 运行时层负责拒绝它（wallClockToMonotonicMs 返回 null），校正层这一侧则要保证
        // 即便收到也不会把锚点推到 now 之后 —— 这里的钳制就是那道防线。
        const state = tickStamped(createExternalMediaClockState(), 1000, 10_000, 5000);
        expect(state.anchorAtMs).toBe(1000);
        expect(state.positionMs).toBe(10_000);
    });

    it('measures staleness for stall detection separately from anchor age', () => {
        // 锚点很旧但我们刚刚收到：这不是停滞，不该冻结。
        // 反过来，锚点很新但我们很久没收到，才是停滞。
        let state = tickStamped(createExternalMediaClockState(), 0, 10_000, 0);
        state = tickStamped(state, 100, 10_000, 0);
        expect(state.positionMs).toBeGreaterThan(10_000);

        // 距上次收到超过停滞阈值：保持不动。
        const before = state.positionMs;
        state = tickStamped(state, APPLE_MUSIC_CLOCK_STALL_MS + 200, 10_000, 0);
        expect(state.positionMs).toBeCloseTo(before, 5);
    });
});

describe('运动连续性（对抗整秒台阶）', () => {
    it('tracks real elapsed time over a long run under measured anchor cadence', () => {
        // 复现实测节律：位置每 1000ms 跳一次，但到达时刻交替为 850ms 与 1100ms
        // （发布周期 ~250ms 的量子化结果）。
        const arrivals = [850, 1100];
        let state = createExternalMediaClockState();
        let nowMs = 0;

        ({ state } = tick(state, nowMs, 10_000));
        const startPositionMs = state.positionMs;
        const startWallMs = nowMs;

        let arrivalIndex = 0;
        let nextArrival = arrivals[0];
        let observed = 10_000;

        while (nowMs < 20_000) {
            nowMs += TICK_MS;
            if (nowMs >= nextArrival) {
                observed += 1000;
                ({ state } = tick(state, nowMs, observed));
                nextArrival = nowMs + arrivals[arrivalIndex % arrivals.length];
                arrivalIndex += 1;
            } else {
                ({ state } = tick(state, nowMs, observed));
            }
        }

        // 20 秒墙钟应当只产生约 20 秒的位置推进：斜率没有因为整秒台阶被放大。
        const ratio = (state.positionMs - startPositionMs) / (nowMs - startWallMs);
        expect(ratio).toBeGreaterThan(0.97);
        expect(ratio).toBeLessThan(1.03);
    });

    it('moves smoothly frame to frame instead of stepping a whole second', () => {
        // 核心断言：在两个锚点之间，每一帧的位移都应该贴近 1 帧的时间（16ms），
        // 而不是「不动很久、然后跳 1000ms」。这就是进度条与歌词不再一顿一顿的机器可读形式。
        let state = createExternalMediaClockState();
        ({ state } = tick(state, 0, 0));

        let previous = state.positionMs;
        let maxFrameMove = 0;
        for (let t = TICK_MS; t <= 3000; t += TICK_MS) {
            // 每 1000ms 才有一个新锚点，且晚到 200ms（比实测的 0~150ms 更苛刻）。
            const observed = Math.floor(Math.max(0, t - 200) / 1000) * 1000;
            ({ state } = tick(state, t, observed));
            maxFrameMove = Math.max(maxFrameMove, state.positionMs - previous);
            previous = state.positionMs;
        }

        // 16ms 的真实推进 + 至多 120ms 的修正上限。
        expect(maxFrameMove).toBeLessThanOrEqual(140);
    });
});
