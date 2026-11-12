#!/usr/bin/env node

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const START = Buffer.from('// ===SALES_PERIOD_GUARD_START===', 'ascii');
const END = Buffer.from('// ===SALES_PERIOD_GUARD_END===', 'ascii');

function argumentValue(name) {
  const position = process.argv.indexOf(name);
  return position === -1 ? null : process.argv[position + 1] || null;
}

function fail(message) {
  console.error('ERROR: ' + message);
  process.exit(1);
}

function markerBlock(buffer, label) {
  const start = buffer.indexOf(START);
  const endMarker = start === -1 ? -1 : buffer.indexOf(END, start + START.length);
  if (start === -1 || endMarker === -1) {
    fail(label + ' に SALES_PERIOD_GUARD の開始・終了マーカーがそろっていません');
  }
  const end = endMarker + END.length;
  if (buffer.indexOf(START, start + START.length) !== -1 || buffer.indexOf(END, end) !== -1) {
    fail(label + ' に SALES_PERIOD_GUARD マーカーが複数あります');
  }
  return { start, end, bytes: buffer.subarray(start, end) };
}

function lineNumberAt(buffer, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (buffer[i] === 0x0a) line++;
  return line;
}

function lineDifferenceCount(before, after) {
  const beforeLines = before.toString('utf8').split(/\r?\n/);
  const afterLines = after.toString('utf8').split(/\r?\n/);
  const rows = Array.from(
    { length: beforeLines.length + 1 },
    () => new Uint16Array(afterLines.length + 1)
  );
  for (let i = 1; i <= beforeLines.length; i++) {
    for (let j = 1; j <= afterLines.length; j++) {
      rows[i][j] = beforeLines[i - 1] === afterLines[j - 1]
        ? rows[i - 1][j - 1] + 1
        : Math.max(rows[i - 1][j], rows[i][j - 1]);
    }
  }
  const common = rows[beforeLines.length][afterLines.length];
  const changed = beforeLines.length + afterLines.length - (2 * common);
  return { changed, before: beforeLines.length, after: afterLines.length };
}

const indexArg = argumentValue('--index');
const fromArg = argumentValue('--from');
const shouldApply = process.argv.includes('--apply');

if (!indexArg || !fromArg) fail('--index と --from の両方を指定してください');
const indexPath = path.resolve(indexArg);
const fromPath = path.resolve(fromArg);

let indexBytes;
let fromBytes;
try {
  indexBytes = readFileSync(indexPath);
  fromBytes = readFileSync(fromPath);
} catch (error) {
  fail('ファイルを読み込めません: ' + error.message);
}

const target = markerBlock(indexBytes, '--index');
const source = markerBlock(fromBytes, '--from');

if (target.bytes.equals(source.bytes)) {
  console.log('変更なし: SALES_PERIOD_GUARD ブロックは同一です');
  process.exit(0);
}

const diff = lineDifferenceCount(target.bytes, source.bytes);
const startLine = lineNumberAt(indexBytes, target.start);
const endLine = lineNumberAt(indexBytes, target.end - 1);
console.log(`差分行数: ${diff.changed}（置換前 ${diff.before} 行 / 置換後 ${diff.after} 行）`);
console.log(`置換位置: ${startLine}〜${endLine} 行（byte ${target.start}〜${target.end - 1}）`);

if (!shouldApply) {
  console.log('dry-run: --apply 未指定のためファイルは変更していません');
  process.exit(0);
}

const now = new Date();
const dateStamp = String(now.getFullYear())
  + String(now.getMonth() + 1).padStart(2, '0')
  + String(now.getDate()).padStart(2, '0');
const backupPath = indexPath + `.bak-${dateStamp}-task086`;
const replaced = Buffer.concat([
  indexBytes.subarray(0, target.start),
  source.bytes,
  indexBytes.subarray(target.end),
]);

try {
  copyFileSync(indexPath, backupPath);
  writeFileSync(indexPath, replaced);
} catch (error) {
  fail('バックアップ作成または置換に失敗しました: ' + error.message);
}

console.log('バックアップ: ' + backupPath);
console.log('適用完了: SALES_PERIOD_GUARD マーカーブロックのみ置換しました');
