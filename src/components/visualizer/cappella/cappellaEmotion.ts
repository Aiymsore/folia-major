import type { CappellaEmojiImage } from '../../../types';

// src/components/visualizer/cappella/cappellaEmotion.ts
// Cappella 表情反应的情绪提示层：把歌词行文本 / 表情文件名映射到情绪标签
// （`happy | love | normal | sleepy | vibe`，与 `emo/` 资源的文件名前缀约定一致）。
//
// 全部是只看输入的纯函数：`buildCappellaMessages` 的选图是按曲目 seeded 的确定性选择，
// 情绪提示必须同样确定 —— 同一首歌每次渲染给出同一个 hint、同一张图。

export type CappellaEmotionTag = 'happy' | 'love' | 'normal' | 'sleepy' | 'vibe';

export const CAPPELLA_EMOTION_TAGS: readonly CappellaEmotionTag[] = ['happy', 'love', 'normal', 'sleepy', 'vibe'];

/**
 * 情绪关键词表：关键词 → 规范标签。同时服务两个入口 ——
 * 歌词文本扫描（findEmotionInText）与自由文本/文件名前缀的精确归一（resolveEmotionTag）。
 * 同义词、英文词、上下位词都收在这里；声明顺序只在「同位命中」时生效，长词放在短词前
 * （例如 `爱你` 在 `爱` 之前，两词命中同一位置时取长词的标签）。
 */
const EMOTION_KEYWORDS: Array<[string, CappellaEmotionTag]> = [
    // happy —— 开心 / 兴奋 / 明亮
    ['开心', 'happy'], ['快乐', 'happy'], ['高兴', 'happy'], ['欢乐', 'happy'], ['幸福', 'happy'],
    ['阳光', 'happy'], ['晴天', 'happy'], ['微笑', 'happy'], ['笑容', 'happy'], ['哈哈', 'happy'], ['笑', 'happy'], ['甜', 'happy'],
    ['happy', 'happy'], ['joy', 'happy'], ['cheerful', 'happy'], ['smile', 'happy'], ['laugh', 'happy'], ['sunshine', 'happy'],
    // love —— 心动 / 甜蜜
    ['爱你', 'love'], ['想你', 'love'], ['喜欢', 'love'], ['心动', 'love'], ['心跳', 'love'], ['拥抱', 'love'], ['亲吻', 'love'],
    ['浪漫', 'love'], ['心上人', 'love'], ['爱', 'love'],
    ['love', 'love'], ['heart', 'love'], ['kiss', 'love'], ['crush', 'love'], ['baby', 'love'], ['honey', 'love'], ['romance', 'love'],
    // sleepy —— 困倦 / 伤感 / 安静（同一组内置资源承载这两种低唤醒状态）
    ['晚安', 'sleepy'], ['夜深', 'sleepy'], ['寂寞', 'sleepy'], ['孤独', 'sleepy'], ['失落', 'sleepy'], ['心碎', 'sleepy'],
    ['离开', 'sleepy'], ['想念', 'sleepy'], ['遗憾', 'sleepy'], ['雨天', 'sleepy'], ['安静', 'sleepy'],
    ['困', 'sleepy'], ['累', 'sleepy'], ['疲', 'sleepy'], ['睡', 'sleepy'], ['梦', 'sleepy'], ['伤', 'sleepy'], ['哭', 'sleepy'], ['泪', 'sleepy'],
    ['sad', 'sleepy'], ['tired', 'sleepy'], ['sleepy', 'sleepy'], ['sleep', 'sleepy'], ['dream', 'sleepy'], ['cry', 'sleepy'],
    ['lonely', 'sleepy'], ['blue', 'sleepy'], ['heartbreak', 'sleepy'], ['broken', 'sleepy'], ['miss', 'sleepy'], ['rain', 'sleepy'],
    // vibe —— 律动 / 摇摆
    ['摇摆', 'vibe'], ['律动', 'vibe'], ['节奏', 'vibe'], ['鼓点', 'vibe'], ['狂欢', 'vibe'], ['派对', 'vibe'],
    ['嗨', 'vibe'], ['舞', 'vibe'], ['蹦', 'vibe'],
    ['vibe', 'vibe'], ['dance', 'vibe'], ['rock', 'vibe'], ['beat', 'vibe'], ['party', 'vibe'], ['shake', 'vibe'], ['groove', 'vibe'],
    // normal 没有关键词：它是「无信号」的默认值，不是一类词。
];

const TAG_BY_KEYWORD = new Map<string, CappellaEmotionTag>(
    EMOTION_KEYWORDS.map(([keyword, tag]) => [keyword.toLowerCase(), tag]),
);

const asciiWordRegexCache = new Map<string, RegExp>();

// ASCII 关键词按词边界匹配（`cry` 不命中 `acrylic`），CJK 关键词直接包含匹配。
const findKeywordIndex = (text: string, keyword: string): number => {
    if (/^[\x20-\x7e]+$/.test(keyword)) {
        let regex = asciiWordRegexCache.get(keyword);
        if (!regex) {
            regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            asciiWordRegexCache.set(keyword, regex);
        }
        return regex.exec(text)?.index ?? -1;
    }
    return text.indexOf(keyword);
};

/** 文本情绪扫描：多个关键词命中时取出现位置最早的（同位取表序靠前的）。无命中返回 null。 */
export const findEmotionInText = (text: string): CappellaEmotionTag | null => {
    const input = text ?? '';
    let best: { index: number; order: number; tag: CappellaEmotionTag } | null = null;

    for (let order = 0; order < EMOTION_KEYWORDS.length; order += 1) {
        const [keyword, tag] = EMOTION_KEYWORDS[order];
        const index = findKeywordIndex(input, keyword);
        if (index < 0) continue;
        if (!best || index < best.index || (index === best.index && order < best.order)) {
            best = { index, order, tag };
        }
    }

    return best ? best.tag : null;
};

/**
 * 自由文本 hint（设置值、文件名前缀、整句歌词）→ 规范标签。
 * 规范标签本身、精确同义词优先，否则按词典扫一遍；都认不出返回 null —— 调用方的语义是「不猜」。
 */
export const resolveEmotionTag = (rawHint: string | null | undefined): CappellaEmotionTag | null => {
    const normalized = (rawHint ?? '').trim().toLowerCase();
    if (!normalized) return null;
    if ((CAPPELLA_EMOTION_TAGS as readonly string[]).includes(normalized)) {
        return normalized as CappellaEmotionTag;
    }
    const exact = TAG_BY_KEYWORD.get(normalized);
    if (exact) return exact;
    return findEmotionInText(rawHint ?? '');
};

/**
 * 表情文件名前缀 → 情绪标签（`happy1` → happy、`sad1` → sleepy）。
 * 名称不带可识别前缀（自定义表情包的任意文件名）返回 null —— 语义是通配项。
 */
export const getImageEmotionTag = (image: Pick<CappellaEmojiImage, 'name'>): CappellaEmotionTag | null => {
    const prefix = /^([a-z]+)/i.exec((image.name ?? '').trim().toLowerCase())?.[1] ?? '';
    if ((CAPPELLA_EMOTION_TAGS as readonly string[]).includes(prefix)) {
        return prefix as CappellaEmotionTag;
    }
    return TAG_BY_KEYWORD.get(prefix) ?? null;
};

/**
 * 歌词行的情绪提示：词典命中取命中标签；没命中的新行**继承上一行**（情绪有惯性）；
 * 全曲无信号时默认 `normal`。间奏文本（`......`）天然不命中，会继承上一行。
 */
export const resolveEmotionHintForLine = (
    text: string,
    prevHint?: CappellaEmotionTag,
): CappellaEmotionTag => (
    findEmotionInText(text) ?? prevHint ?? 'normal'
);
