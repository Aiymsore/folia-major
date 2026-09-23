import { describe, expect, it } from 'vitest';
import {
    findEmotionInText,
    getImageEmotionTag,
    resolveEmotionHintForLine,
    resolveEmotionTag,
} from '@/components/visualizer/cappella/cappellaEmotion';

// test/unit/visualizer/cappellaEmotion.test.ts
// Cappella 情绪提示层的纯函数契约：标签归一、词典扫描择先规则、行级继承与默认值。

describe('resolveEmotionTag', () => {
    it('maps exact tags and synonyms to canonical tags', () => {
        expect(resolveEmotionTag('happy')).toBe('happy');
        expect(resolveEmotionTag('SAD')).toBe('sleepy');
        expect(resolveEmotionTag('开心')).toBe('happy');
        expect(resolveEmotionTag('  vibe  ')).toBe('vibe');
        // 规范标签本身（含中性的 normal）直接归一
        expect(resolveEmotionTag('normal')).toBe('normal');
    });

    it('falls back to the lexicon for free text', () => {
        expect(resolveEmotionTag('我们开心的笑了')).toBe('happy');
        expect(resolveEmotionTag('dance all night')).toBe('vibe');
    });

    it('returns null when nothing is recognizable (the filter then keeps the full pool)', () => {
        expect(resolveEmotionTag(undefined)).toBeNull();
        expect(resolveEmotionTag('')).toBeNull();
        expect(resolveEmotionTag('xyzzy-unknown')).toBeNull();
    });
});

describe('getImageEmotionTag', () => {
    it('reads the emotion tag from the filename prefix convention', () => {
        expect(getImageEmotionTag({ name: 'happy1' })).toBe('happy');
        expect(getImageEmotionTag({ name: 'sleepy2' })).toBe('sleepy');
        expect(getImageEmotionTag({ name: 'vibe3' })).toBe('vibe');
        expect(getImageEmotionTag({ name: 'love1' })).toBe('love');
        // `normal` 是规范标签之一（中性），normal1 不是通配项
        expect(getImageEmotionTag({ name: 'normal1' })).toBe('normal');
    });

    it('routes synonym prefixes through the same alias table', () => {
        expect(getImageEmotionTag({ name: 'sad1' })).toBe('sleepy');
    });

    it('treats unrecognized names as wildcards (custom packs stay untouched)', () => {
        expect(getImageEmotionTag({ name: 'IMG_20240101' })).toBeNull();
        expect(getImageEmotionTag({ name: '微信截图' })).toBeNull();
        expect(getImageEmotionTag({ name: '' })).toBeNull();
    });
});

describe('findEmotionInText', () => {
    it('matches CJK words and ASCII words with word boundaries', () => {
        expect(findEmotionInText('今天真的很开心')).toBe('happy');
        expect(findEmotionInText('I will love you')).toBe('love');
        // `cry` 不该命中 acrylic 这种词内字母串
        expect(findEmotionInText('acrylic paint')).toBeNull();
        expect(findEmotionInText("don't cry tonight")).toBe('sleepy');
    });

    it('prefers the earliest keyword position on mixed lines', () => {
        // `伤感` 在位置 0 命中 sleepy，`快乐` 在其后 → 取 sleepy
        expect(findEmotionInText('伤感快乐的歌')).toBe('sleepy');
        expect(findEmotionInText('快乐伤感的歌')).toBe('happy');
    });
});

describe('resolveEmotionHintForLine', () => {
    it('uses the lexicon hit when there is one', () => {
        expect(resolveEmotionHintForLine('在舞池里摇摆', 'sleepy')).toBe('vibe');
    });

    it('inherits the previous hint on unhit lines (decision: emotion has inertia)', () => {
        expect(resolveEmotionHintForLine('啦啦啦啦啦', 'love')).toBe('love');
        // 间奏文本天然不命中 → 也继承
        expect(resolveEmotionHintForLine('......', 'happy')).toBe('happy');
    });

    it('defaults to normal when the song carries no signal at all', () => {
        expect(resolveEmotionHintForLine('......')).toBe('normal');
        expect(resolveEmotionHintForLine('没有任何词的行')).toBe('normal');
    });
});
