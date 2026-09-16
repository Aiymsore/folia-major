#!/usr/bin/env node
// Build the Windows Apple Music SMTC helper.
//
// Builds the Rust crate in packaging/windows/apple-music-smtc-helper/ with `cargo build --release`
// and copies folia-apple-music-smtc-helper.exe into build/ so electron-builder's win extraResources
// packages it as resources/folia-apple-music-smtc-helper.exe. Mirrors
// packaging/windows/build-wallpaper-helper.mjs: shared by local `npm run build:electron*` and the
// CI release workflow, and its output doubles as the dev-path override for
// FOLIA_APPLE_MUSIC_SMTC_HELPER_PATH (see resolveAppleMusicSmtcHelperPath in electron/main.cjs).
// No-op on non-Windows hosts (the Linux/macOS build must not depend on a Rust Windows toolchain).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_DIR = path.join(ROOT, 'packaging', 'windows', 'apple-music-smtc-helper');
const OUT_DIR = path.join(ROOT, 'build');
const OUT_BIN = path.join(OUT_DIR, 'folia-apple-music-smtc-helper.exe');

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit', cwd: SRC_DIR });
}

if (process.platform !== 'win32') {
  console.log('[apple-music-smtc-helper] non-Windows host, skipping build');
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
run('cargo', ['build', '--release']);
copyFileSync(path.join(SRC_DIR, 'target', 'release', 'folia-apple-music-smtc-helper.exe'), OUT_BIN);
console.log(`[apple-music-smtc-helper] built ${OUT_BIN}`);
