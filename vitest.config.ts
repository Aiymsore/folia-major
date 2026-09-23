import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';
import { commandPinyinPlugin } from './dev/pinyin/commandPinyinPlugin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // 命令面板的检索索引在单测里也要读到构建期生成的拼音字典。
  plugins: [commandPinyinPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    // 全量跑时 ~370 个文件互相争抢 CPU，几条重测试（源码树扫描、fake-IndexedDB 迁移、
    // 上千文件散列）在默认 5s 墙钟下会被拖超时——单跑都远低于 5s。放宽墙钟上限不改任何判据，
    // 只是不让并行度决定哪些测试红。
    testTimeout: 20000,
    hookTimeout: 20000,
  }
});
