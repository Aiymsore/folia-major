import { describe, expect, it } from 'vitest';
import { builtinEmoImages, filterEmoImagesByEmotion, pickRandomEmoImage } from '@/components/visualizer/cappella/emoImages';
import type { CappellaEmojiImage } from '@/types';

// test/unit/visualizer/emoImages.test.ts
// emotionHint 精细筛选规则：通配项恒可选、认不出的 hint 不猜、空子集 fallback 全集。

const fake = (name: string): CappellaEmojiImage => ({ id: `builtin-${name}`, name, url: `/${name}.png` });

const POOL: CappellaEmojiImage[] = [fake('happy1'), fake('love1'), fake('normal1'), fake('sleepy1'), fake('custom-meme')];

describe('filterEmoImagesByEmotion', () => {
    it('keeps matching tags plus wildcards', () => {
        expect(filterEmoImagesByEmotion(POOL, 'happy').map(image => image.name)).toEqual(['happy1', 'custom-meme']);
        expect(filterEmoImagesByEmotion(POOL, 'sleepy').map(image => image.name)).toEqual(['sleepy1', 'custom-meme']);
    });

    it('returns the full pool for an unrecognizable hint', () => {
        expect(filterEmoImagesByEmotion(POOL, 'xyzzy-unknown')).toEqual(POOL);
        expect(filterEmoImagesByEmotion(POOL, undefined)).toEqual(POOL);
        expect(filterEmoImagesByEmotion(POOL, '')).toEqual(POOL);
    });

    it('keeps the full pool for the neutral normal hint (no tendency, no narrowing)', () => {
        expect(filterEmoImagesByEmotion(POOL, 'normal')).toEqual(POOL);
    });

    it('falls back to the full pool when the subset would be empty', () => {
        const withoutLoveOrWildcards = [fake('happy1'), fake('sleepy1')];
        expect(filterEmoImagesByEmotion(withoutLoveOrWildcards, 'love')).toEqual(withoutLoveOrWildcards);
    });

    it('keeps only wildcards when they alone form a non-empty subset', () => {
        expect(filterEmoImagesByEmotion([fake('happy1'), fake('custom-meme')], 'vibe').map(image => image.name))
            .toEqual(['custom-meme']);
    });
});

describe('pickRandomEmoImage', () => {
    it('always answers from the hinted subset of builtins', () => {
        expect(builtinEmoImages.length).toBeGreaterThan(0);
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const picked = pickRandomEmoImage('sleepy');
            expect(picked).not.toBeNull();
            expect(picked?.name.startsWith('sleepy')).toBe(true);
        }
    });

    it('still answers without a hint (full-pool random)', () => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const picked = pickRandomEmoImage();
            expect(picked).not.toBeNull();
            expect(builtinEmoImages).toContainEqual(picked);
        }
    });
});
