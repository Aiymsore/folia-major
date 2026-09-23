import { getOnlineMusicProvider } from '../../src/services/onlineMusic/providerRegistry';
import { omni } from '../../src/services/onlineMusic/omni';
import { buildPlaylistEntry, playlistEntryToSong } from '../../src/utils/playlistEntry';
import { parsePortablePlaylist, serializePortablePlaylist } from '../../src/utils/portablePlaylistFormat';
import type { SongResult } from '../../src/types';

// test/manual/minimal-replay-smoke.ts
// 跨来源歌单条目「最小可回放字段」的**真实服务**冒烟（netease / kugou / qq）。
//
// 回答打桩测试回答不了的问题：只带 entry 字段（sourceRef + 必需元数据 + 展示元数据）的
// 重建件，在真实服务上能不能真的拿到音频和歌词。每家流程：
//   搜索一首 → 记录原曲结果 → buildPlaylistEntry → 便携格式往返 → playlistEntryToSong 重建
//   → 对重建件再取音频/歌词 → 与原曲结果对齐。
//
// 运行（需要 .env.local 提供三家服务配置；匿名搜索/取曲不需要登录态）：
//   npx tsx test/manual/minimal-replay-smoke.ts
// 沙箱/CI 跑不了：真实凭证只存在于开发机的 .env.local 与 test-results/.dev-credentials。
// 可自动化的字段契约在 test/unit/onlineMusic/minimalReplayFields.test.ts（传输层打桩）。

let failures = 0;
let checks = 0;
const check = (label: string, condition: boolean, detail = '') => {
    checks += 1;
    if (condition) {
        console.log(`  ok   ${label}`);
        return;
    }
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
};

const lyricLineCount = (lyrics: { lyrics?: { lines?: unknown[] } | null } | null | undefined): number => (
    lyrics?.lyrics?.lines?.length ?? 0
);

const smokeProvider = async (providerId: 'netease' | 'kugou' | 'qq'): Promise<void> => {
    console.log(`\n[${providerId}]`);
    if (!getOnlineMusicProvider(providerId)) {
        check('provider registered', false, `${providerId} 未注册`);
        return;
    }

    const page = await omni.searchProviderSongs(providerId, '周杰伦 晴天', { limit: 3, offset: 0 });
    const original = page.items[0] as SongResult | undefined;
    if (!original) {
        check('search returns a song', false, '搜索无结果，无法冒烟');
        return;
    }
    console.log(`  song: ${original.name} - ${original.artists.map(artist => artist.name).join(', ')}`);

    const beforeAudio = await omni.getAudioSource(original as never, 'standard');
    const beforeLyrics = await omni.getLyrics(original as never);

    const entry = buildPlaylistEntry(original);
    check('entry persists (minimal fields only)', entry !== null);
    if (!entry) return;
    check('entry carries no URLs', !JSON.stringify(entry).includes('http'));

    const parsed = parsePortablePlaylist(serializePortablePlaylist('smoke', [entry]));
    check('portable round-trip keeps the entry', parsed.skippedCount === 0 && parsed.entries.length === 1);

    const rebuilt = playlistEntryToSong(parsed.entries[0]);
    check('rebuild produces a song', rebuilt !== null);
    if (!rebuilt) return;

    const afterAudio = await omni.getAudioSource(rebuilt as never, 'standard');
    const afterLyrics = await omni.getLyrics(rebuilt as never);

    check(
        'rebuilt song resolves an audio source like the original',
        Boolean(beforeAudio?.url) === Boolean(afterAudio?.url),
        `original=${Boolean(beforeAudio?.url)} rebuilt=${Boolean(afterAudio?.url)}`,
    );
    check(
        'rebuilt song resolves the same lyric payload as the original',
        lyricLineCount(beforeLyrics as never) === lyricLineCount(afterLyrics as never),
        `original=${lyricLineCount(beforeLyrics as never)} lines rebuilt=${lyricLineCount(afterLyrics as never)} lines`,
    );
};

const main = async () => {
    for (const providerId of ['netease', 'kugou', 'qq'] as const) {
        await smokeProvider(providerId);
    }
    console.log(`\n${checks - failures}/${checks} checks passed`);
    if (failures > 0) process.exitCode = 1;
};

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
