import type { CappellaEmojiImage } from '../../../types';
import { getImageEmotionTag, resolveEmotionTag } from './cappellaEmotion';

// src/components/visualizer/cappella/emoImages.ts
// Loads emoji images from the `emo` directory via Vite's import.meta.glob
// and picks one by emotionHint（情绪标签 = 文件名前缀，见 `emo/README.md` 与 `cappellaEmotion.ts`）。

const emoModules = import.meta.glob<{ default: string }>(
    './emo/*.{png,jpg,jpeg,gif,webp,svg}',
    { eager: true },
);

const builtinEmoImages: CappellaEmojiImage[] = Object.entries(emoModules).map(
    ([path, mod]) => {
        const filename = path.split('/').pop() ?? '';
        const name = filename.replace(/\.[^.]+$/, '');
        return {
            id: `builtin-${name}`,
            url: mod.default,
            name,
        };
    },
);

/**
 * 按情绪提示筛选表情子集（精细筛选）。
 *
 * 规则：
 *   * hint 认不出（无同义词、词典也扫不到）→ 不猜，返回全集；
 *   * 名称不带情绪前缀的图（多为自定义表情包）是**通配项**，任何 hint 下都保留；
 *   * 匹配出的子集为空 → fallback 全集（与旧 TODO 承诺的语义一致）。
 */
export const filterEmoImagesByEmotion = (
    images: CappellaEmojiImage[],
    emotionHint?: string | null,
): CappellaEmojiImage[] => {
    const tag = resolveEmotionTag(emotionHint);
    // `normal` 是中性（无倾向）而不是一类情绪：收窄到 normal 子集会让默认态永远只出一张图，
    // 与「无信号时平滑退化为旧的全集随机」冲突 —— 中性不筛，四个表达性标签才收窄。
    if (!tag || tag === 'normal' || images.length === 0) {
        return images;
    }

    const subset = images.filter(image => {
        const imageTag = getImageEmotionTag(image);
        return imageTag === null || imageTag === tag;
    });

    return subset.length > 0 ? subset : images;
};

/**
 * 从 emo 目录的内置表情中随机挑选一张。
 *
 * @param emotionHint 情绪提示（`happy` / `sad` / `开心` 等自由文本亦可）。
 *   先经 `filterEmoImagesByEmotion` 缩小到匹配子集再随机；子集为空回退全集。
 */
export const pickRandomEmoImage = (
    emotionHint?: string,
): CappellaEmojiImage | null => {
    const pool = filterEmoImagesByEmotion(builtinEmoImages, emotionHint);
    if (pool.length === 0) {
        return null;
    }

    const index = Math.floor(Math.random() * pool.length);
    return pool[index];
};

export { builtinEmoImages };
