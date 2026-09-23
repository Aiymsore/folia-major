# Cappella 聊天表情图片

此文件夹内存放供 Cappella 使用的内置聊天表情图片。

运行时由上级 `../emoImages.ts` 通过 Vite `import.meta.glob` 自动加载目录中的图片文件（png、jpg、jpeg、gif、webp、svg），文件名去掉扩展名后作为名称，并生成 `builtin-*` id。当前内置资源包括 `happy1`、`love1`、`normal1`、`sleepy1`、`sleepy2`、`sleepy3`、`vibe1`、`vibe2`、`vibe3` 等。

## 命名约定：文件名前缀 = 情绪标签

**文件名的情绪前缀就是标签约定**，共五类（取前缀字母段识别，`happy1` → `happy`）：

| 标签 | 含义 | 当前资源 |
| --- | --- | --- |
| `happy` | 开心 / 兴奋 | `happy1` |
| `love` | 心动 / 甜蜜 | `love1` |
| `normal` | 平静（默认） | `normal1` |
| `sleepy` | 困倦 / 伤感 / 安静 | `sleepy1`~`sleepy3` |
| `vibe` | 律动 / 摇摆 | `vibe1`~`vibe3` |

同义词前缀经 `../cappellaEmotion.ts` 的关键词表归一（例如 `sad1` 归入 `sleepy`）；识别不出前缀的名称视为**通配项**（任何情绪下都可选），自定义表情包的任意文件名天然属于此类。

## emotionHint 筛选规则

`pickRandomEmoImage(emotionHint)` / `filterEmoImagesByEmotion(images, emotionHint)` 的行为：

1. hint 经关键词表归一成规范标签（`happy`、`sad`、`开心` 等自由文本均可）；
2. **中性的 `normal` 不收窄**（无倾向 = 全集随机，避免默认态永远同一张）；其余四个表达性标签匹配「同标签 + 通配项」子集，子集非空就只从子集中选；
3. hint 认不出、或子集为空 → 回退全集随机。

情绪提示的来源是 `../cappellaEmotion.ts` 的 `resolveEmotionHintForLine`（歌词行词典扫描、未命中的行继承上一行、默认 `normal`）；`VisualizerCappella` 里间奏固定 `vibe`、无歌词 fallback 与 preview 固定 `normal`。所有选择保持按曲目 seeded 的确定性 —— 同一首歌每次渲染选图不变。

用户上传的自定义表情包不放入此目录，而是由 `src/services/cappellaEmojiPack.ts` 经 `src/services/db.ts` 保存到 IndexedDB，并通过 Cappella 设置面板选择或清空。

# disclaimer

文件夹中的图片人物为 Folia 拟人形象(folia-chan)，任何与已有人物的相似之处纯属巧合。

这些表情图片皆为 GPT Image2 模型生成，即AI生成的图片。

这些图片的版权不受本仓库代码的 AGPL-3.0 许可证的约束，任何人都可以自由地使用，修改和分发这些图片，因为这些图片是由 AI 模型生成的，而不是由人类艺术家创作的，因此不受传统版权法的保护。

向所有曾上传作品至互联网的艺术家们致敬，他们的作品使得这些图片的生成成为可能。我们鼓励用户尊重人类艺术家的创作，关注那些真正的艺术家和他们的作品。
