#!/usr/bin/env node
// test_homecare_receptor.mjs
// 在宅内訳の取込の「受け皿」が店舗単位で閉じていないことを機械的に検証する（2026-10-20 INC-620）。
//
// 背景（山内さん指摘）:
//   「かってに、るーるつくんなよ　外来店舗だって在宅やることあるから」
//   「在宅は個人宅1件でもやってるでしょ」「前提から受け皿間違ってる」
// 在宅の患者さんがいるかどうかは月ごとの事実であって店舗の属性ではない。したがって
// 取込の入口を「対象店舗の列挙」で絞ってはいけない。判定軸はその店舗のレセコン（帳票の形式）だけで、
// 店舗→レセコンは STORE_PROFILE（売上側と共通の正本）を使う。
// 改修前は _getHomecareProfileForStore が HOMECARE_CSV_PROFILES[*].stores.includes(store) で判定しており、
// 店舗台帳で柏・我孫子と同じ「モイネット ファーミー」のさくら台(ST-002)まで「未対応」で弾いていた。
//
// 実行: node test_homecare_receptor.mjs
// 抽出方式: index.html から定義ブロックと選択関数を括弧カウントで切り出し、new Function で評価する
// （実装のコピーではなく実コードを検証するため。test_pharmy_parse.mjs と同型）。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, 'index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? ' -- ' + extra : '')); }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}

/** startMarker（末尾が"{"）から対応する閉じ括弧までを、クォート／行コメント／ブロックコメントを認識して切り出す */
function extractBraceBlock(src, startMarker) {
  const markerIdx = src.indexOf(startMarker);
  if (markerIdx === -1) throw new Error('marker not found: ' + startMarker);
  const openIdx = markerIdx + startMarker.length - 1;
  if (src[openIdx] !== '{') throw new Error('startMarker must end with "{": ' + startMarker);
  let depth = 0, inStr = null, inLine = false, inBlock = false;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i], next = src[i + 1], prev = src[i - 1];
    if (inLine) { if (ch === '\n') inLine = false; continue; }
    if (inBlock) { if (ch === '*' && next === '/') { inBlock = false; i++; } continue; }
    if (inStr) { if (ch === inStr && prev !== '\\') inStr = null; continue; }
    if (ch === '/' && next === '/') { inLine = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(markerIdx, i + 1); }
  }
  throw new Error('unbalanced braces for: ' + startMarker);
}

// 定義ブロックが評価時に参照する定数（parse()本体の中ではなくプロパティ値として使われるもの）
const PRELUDE = [
  (SRC.match(/^const HOMECARE_KAIGO_UNIT_YEN = .*$/m) || [''])[0],
  (SRC.match(/^const TECH_INCLUDE_TIME_ADD = .*$/m) || [''])[0],
].filter(Boolean).join(String.fromCharCode(10));

const blocks = [
  PRELUDE,
  extractBraceBlock(SRC, 'const STORE_PROFILE = {') + ';',
  extractBraceBlock(SRC, 'const RECEIPT_PROFILES = {') + ';',
  extractBraceBlock(SRC, 'const HOMECARE_PDF_PROFILES = {') + ';',
  extractBraceBlock(SRC, 'const HOMECARE_CSV_PROFILES = {') + ';',
  extractBraceBlock(SRC, 'function _getHomecarePdfProfileForStore(store) {'),
  extractBraceBlock(SRC, 'function _getHomecareProfileForStore(store) {'),
];

const body = blocks.join('\n') + `
return {
  STORE_PROFILE, RECEIPT_PROFILES, HOMECARE_CSV_PROFILES, HOMECARE_PDF_PROFILES,
  csvFor: _getHomecareProfileForStore,
  pdfFor: _getHomecarePdfProfileForStore,
  csvIdFor: (s) => { const p = _getHomecareProfileForStore(s); return p ? (Object.keys(HOMECARE_CSV_PROFILES).find(k => HOMECARE_CSV_PROFILES[k] === p) || null) : null; },
  pdfIdFor: (s) => { const p = _getHomecarePdfProfileForStore(s); return p ? (Object.keys(HOMECARE_PDF_PROFILES).find(k => HOMECARE_PDF_PROFILES[k] === p) || null) : null; },
};`;

let M;
try {
  M = new Function(body)();
} catch (e) {
  console.error('抽出コードの評価に失敗: ' + e.message);
  process.exit(1);
}

// 画面の店舗セレクタ（<select id="homecareStore">）の value を正本として全店を取る
const selectBlock = SRC.slice(SRC.indexOf('<select id="homecareStore"'));
const selectEnd = selectBlock.indexOf('</select>');
const STORES_IN_UI = [...selectBlock.slice(0, selectEnd).matchAll(/<option value="([a-z_]+)"/g)].map(m => m[1]);

console.log('\n[1] 画面の店舗セレクタと STORE_PROFILE（店舗→レセコン）の整合');
eq(STORES_IN_UI.length, 8, '在宅内訳タブの店舗セレクタに8店ある');
for (const s of STORES_IN_UI) {
  ok(!!M.STORE_PROFILE[s], `${s}: STORE_PROFILE にレセコンが登録されている（未登録=入口が閉じる穴）`,
    'STORE_PROFILE[' + s + ']=' + M.STORE_PROFILE[s]);
}

console.log('\n[2] 入口判定が「店舗の列挙」ではなく「レセコン」になっている');
const csvSel = extractBraceBlock(SRC, 'function _getHomecareProfileForStore(store) {');
const pdfSel = extractBraceBlock(SRC, 'function _getHomecarePdfProfileForStore(store) {');
ok(!/\.stores\b/.test(csvSel), 'CSV選択関数が .stores を参照していない');
ok(!/\.stores\b/.test(pdfSel), 'PDF選択関数が .stores を参照していない');
ok(/STORE_PROFILE\[store\]/.test(csvSel), 'CSV選択関数が STORE_PROFILE（店舗→レセコン）を正本にしている');
ok(/STORE_PROFILE\[store\]/.test(pdfSel), 'PDF選択関数が STORE_PROFILE（店舗→レセコン）を正本にしている');
for (const s of STORES_IN_UI) {
  const p = M.csvFor(s);
  const expectReceptor = M.STORE_PROFILE[s];
  ok(p === null || p.receptor === expectReceptor,
    `${s}: 返るプロファイルのレセコンが台帳のレセコンと一致（または帳票未実装でnull）`,
    'got=' + (p ? p.receptor : 'null') + ' expected=' + expectReceptor);
}

console.log('\n[3] 取り落ちだった店が開いたこと（帳票形式は柏・我孫子と同じ）');
eq(M.csvIdFor('sakuradai'), 'pharmy', 'さくら台（店舗台帳ST-002=モイネット ファーミー）が pharmy で取込できる');
eq(M.csvIdFor('koshigaya'), 'pharmy', '越谷（ST-007=モイネット Pharmy Connect）が pharmy で取込できる');
eq(M.csvIdFor('kiyose'), 'pharmy', '清瀬（ST-008=モイネット Pharmy Connect）が pharmy で取込できる');
ok(M.csvFor('sakuradai').confirmed === true, 'さくら台は confirmed=true（未対応表示にならない）');

console.log('\n[4] 既存の挙動が変わっていない（回帰）');
eq(M.csvIdFor('kashiwa'), 'pharmy', '柏は従来どおり pharmy');
eq(M.csvIdFor('abiko'), 'pharmy', '我孫子は従来どおり pharmy');
eq(M.csvIdFor('adachi'), 'elysia_kaigo', '足立のCSVは elysia_kaigo（旧 elysia は legacy で選ばれない）');
eq(M.pdfIdFor('adachi'), 'elysia_r', '足立のPDFは elysia_r');
ok(M.HOMECARE_CSV_PROFILES.elysia.legacy === true, '旧 elysia プロファイルは legacy 印がある');
for (const s of STORES_IN_UI) {
  if (s === 'adachi') continue;
  eq(M.pdfIdFor(s), null, `${s}: PDF受付は足立だけに限定されたまま（2026-10-14 山内さん指示）`);
}

console.log('\n[5] まだ読み取れない帳票は「店舗が対象外」ではなく「帳票が未実装」として落ちる');
const nagareyama = M.csvFor('nagareyama');
ok(nagareyama !== null, 'ながれやま: レセコン（ウィーメックス pharnes V-EX）までは解決できる');
eq(nagareyama && nagareyama.confirmed, false, 'ながれやま: confirmed=false（帳票のサンプル待ち）');
eq(M.csvIdFor('ai_chozai'), null, 'アイ調剤: pharma-Seed の在宅内訳帳票は未実装のため null');
ok(!!M.RECEIPT_PROFILES[M.STORE_PROFILE['ai_chozai']],
  'アイ調剤: 帳票が未実装でも「どのレセコンか」はレセコンマスタから言える（店舗のせいにしない表示用）');

console.log('\n[6] 提出対象を店舗で区切る分岐が復活していないこと');
ok(!/HOMECARE_TARGET_STORES/.test(SRC), 'HOMECARE_TARGET_STORES（店舗単位の提出対象リスト）が存在しない');
ok(!/提出対象外/.test(SRC), '「提出対象外」という文言が存在しない');
ok(!/この店舗の帳票形式/.test(SRC), '「この店舗の帳票形式は未対応」という店舗主語の文言が存在しない');
ok(/提出が不要という意味ではありません/.test(SRC), '未実装時の文言に「提出が不要という意味ではありません」がある');

console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail === 0 ? 0 : 1);
