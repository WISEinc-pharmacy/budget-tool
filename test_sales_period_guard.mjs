#!/usr/bin/env node
// test_sales_period_guard.mjs
// INC-598（2026-10-20）: 月計表(保険合計)PDF取込の集計期間照合ガード(_salesPeriodGuard)・
// 内部整合性チェック(_salesConsistencyCheck)の単体テスト。
// index.htmlを書き換えずにマーカーブロック(===SALES_PERIOD_GUARD_START/END===)をソース抽出して
// 直接実行する（test_homecare_rows.mjs/test_import_rows.mjsと同型）。
// HQ取込経路(tools/hq_backfill_sales_2026)のextractSalesPeriodGuard()も同じ結果を返すことを確認する。
// 公開リポジトリ対策（2026-10-20親ゲート指摘）: テスト中の数値はすべて架空の値。性質のみ実例に合わせる
// （genuine=技術料+薬剤料+材料料=保険合計が成立し受付回数≧レセ件数／corrupted=合算が保険合計から
// 20%以上ずれ、受付回数がレセ件数を下回る）。
// 実行: node test_sales_period_guard.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extractSalesPeriodGuard } from './tools/hq_backfill_sales_2026/sales_period_guard_extract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');
const src = readFileSync(INDEX_HTML_PATH, 'utf8');

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log('✅ PASS: ' + label); pass++; }
  else { console.log('❌ FAIL: ' + label); console.log('   expected: ' + e); console.log('   actual  : ' + a); fail++; }
}
function assertOk(cond, label) {
  if (cond) { console.log('✅ PASS: ' + label); pass++; }
  else { console.log('❌ FAIL: ' + label); fail++; }
}

// ===== index.html側から直接マーカーブロックを抽出(ブラウザ側と同一ロジックであることの確認用) =====
function extractIndexHtmlGuard() {
  const START = '// ===SALES_PERIOD_GUARD_START===';
  const END = '// ===SALES_PERIOD_GUARD_END===';
  const si = src.indexOf(START);
  const ei = src.indexOf(END);
  if (si === -1 || ei === -1) throw new Error('SALES_PERIOD_GUARDマーカーが見つかりません');
  const block = src.slice(si + START.length, ei);
  // eslint-disable-next-line no-new-func
  const factory = new Function(block + '\nreturn { _salesPeriodFromText, _salesPeriodGuard, _salesConsistencyCheck };');
  return factory();
}

const indexFns = extractIndexHtmlGuard();
const hqFns = extractSalesPeriodGuard(INDEX_HTML_PATH);

console.log('=== _salesPeriodGuard: 基本ケース ===');

// (a) 「2025年3月保険合計柏.pdf」+ 範囲R07/03 → 対象2026-03 で block
{
  const r = indexFns._salesPeriodGuard({ targetMonth: '2026-03', fileName: '2025年3月保険合計柏.pdf', pdfText: '保険合計\nR07/03/01〜R07/03/31' });
  assertEq(r.severity, 'block', '(a) 2025年3月ファイル×範囲R07/03 vs 対象2026-03 → block');
  assertOk(r.reason.includes('2025年3月') && r.reason.includes('2026年3月'), '(a) reasonに両方の年月が明記されている');
}

// (b) 「2026年2月保険合計柏.pdf」+ R08/02 → 対象2026-02 で ok
{
  const r = indexFns._salesPeriodGuard({ targetMonth: '2026-02', fileName: '2026年2月保険合計柏.pdf', pdfText: 'R08/02/01〜R08/02/28' });
  assertEq(r.severity, 'ok', '(b) 2026年2月ファイル×範囲R08/02 vs 対象2026-02 → ok');
}

// (c) ファイル名に年月なし + pdfText null → warn
{
  const r = indexFns._salesPeriodGuard({ targetMonth: '2026-05', fileName: '患者別調剤内訳.pdf', pdfText: null });
  assertEq(r.severity, 'warn', '(c) 期間なしファイル名+pdfText null → warn');
  assertOk(r.reason.includes('目で確認'), '(c) warnの文言に目視確認の指示が入っている');
}

// (d) 「2026.4月保険合計.我孫子」→ 対象2026-04 ok
{
  const r = indexFns._salesPeriodGuard({ targetMonth: '2026-04', fileName: '2026.4月保険合計.我孫子.pdf', pdfText: null });
  assertEq(r.severity, 'ok', '(d) 2026.4月表記ファイル名 vs 対象2026-04 → ok');
}

// (e) 範囲行だけ R08/03/01〜R08/03/31 → 2026-03 ok／2026-04 block
{
  const rOk = indexFns._salesPeriodGuard({ targetMonth: '2026-03', fileName: '保険合計.pdf', pdfText: '集計期間 R08/03/01〜R08/03/31' });
  assertEq(rOk.severity, 'ok', '(e-1) 範囲R08/03のみ vs 対象2026-03 → ok');
  const rBlock = indexFns._salesPeriodGuard({ targetMonth: '2026-04', fileName: '保険合計.pdf', pdfText: '集計期間 R08/03/01〜R08/03/31' });
  assertEq(rBlock.severity, 'block', '(e-2) 範囲R08/03のみ vs 対象2026-04 → block');
}

console.log('=== _salesPeriodGuard: 強い／弱い証拠（2026-10-20親ゲート修正） ===');

// (f) 印字日形式のファイル名「保険合計_2026-04-07.pdf」はパターン4(数字だけ)＝弱い証拠。
//     範囲行が無い場合は対象月と食い違ってもblockせずwarnにする（誤block防止）。
{
  const r = indexFns._salesPeriodGuard({ targetMonth: '2026-03', fileName: '保険合計_2026-04-07.pdf', pdfText: null });
  assertEq(r.severity, 'warn', '(f-1) 印字日形式ファイル名(弱い証拠)が対象月と不一致・範囲行なし → warn(blockしない)');
  assertOk(r.reason.includes('2026年4月') && r.reason.includes('2026年3月') && r.reason.includes('印字日'), '(f-1) warn文言に両方の年月と印字日の可能性が明記されている');
}
// (g) 同じ印字日形式ファイル名でも、PDF本文の範囲行(R08/03)が取れれば範囲行が決定権を持つ → ok
{
  const r = indexFns._salesPeriodGuard({ targetMonth: '2026-03', fileName: '保険合計_2026-04-07.pdf', pdfText: '集計期間 R08/03/01〜R08/03/31' });
  assertEq(r.severity, 'ok', '(g) 印字日形式ファイル名は不一致でも範囲行R08/03が対象月2026-03と一致 → ok（ファイル名の弱い証拠は無視）');
}
// (h) 「強い」証拠(年月明示)の不一致は従来通りblock（範囲行なし）
{
  const r = indexFns._salesPeriodGuard({ targetMonth: '2026-03', fileName: '2026年4月保険合計.pdf', pdfText: null });
  assertEq(r.severity, 'block', '(h) 強い証拠(2026年4月)の不一致・範囲行なし → block（従来通り）');
}

console.log('=== _salesPeriodFromText: パターン1の「.」区切り対応（Drive実例） ===');

// (i) 「✓2025年.3月保険合計.柏.pdf」のように年と月の間に「.」が入る表記を強い証拠として検出する
{
  const d = indexFns._salesPeriodFromText({ fileName: '✓2025年.3月保険合計.柏.pdf', pdfText: null });
  assertEq(d.fileYearMonth, '2025-03', '(i) 「2025年.3月」から2025-03を検出');
  assertEq(d.fileEvidence, 'strong', '(i) 「年」「月」明示のため強い証拠として分類');
}
// (j) 「2026年 3月」のように年と月の間に空白が入る表記も検出できる（従来からの回帰確認）
{
  const d = indexFns._salesPeriodFromText({ fileName: '2026年 3月保険合計.pdf', pdfText: null });
  assertEq(d.fileYearMonth, '2026-03', '(j) 「2026年 3月」(空白区切り)から2026-03を検出');
}

console.log('=== _salesConsistencyCheck（値はすべて架空。性質のみ実例に合わせる） ===');

// corrupted: 合算が保険合計から20%以上ずれ、受付回数(1)がレセ件数を下回る → issues 2件
const corrupted = { techFee: 3900000, drugFee: 4700000, materialFee: 0, totalInsurance: 12036340, visitCount: 1, rxCount: 520 };
// genuine: 技術料+薬剤料+材料料=保険合計が成立し、受付回数がレセ件数以上 → issues 0件
const genuine = { techFee: 5234560, drugFee: 6789440, materialFee: 12340, totalInsurance: 12036340, visitCount: 890, rxCount: 520 };

{
  const rCorrupted = indexFns._salesConsistencyCheck(corrupted);
  assertEq(rCorrupted.issues.length, 2, '(k-1) 架空の破損値(corrupted)で issues 2件');
  assertEq(rCorrupted.ok, false, '(k-1) 架空の破損値(corrupted)はok=false');

  const rGenuine = indexFns._salesConsistencyCheck(genuine);
  assertEq(rGenuine.issues.length, 0, '(k-2) 架空の正常値(genuine)は issues 0件');
  assertEq(rGenuine.ok, true, '(k-2) 架空の正常値(genuine)はok=true');
}

console.log('=== HQ取込経路(extractSalesPeriodGuard)がindex.html側と同じ結果を返すこと ===');
{
  const argsA = { targetMonth: '2026-03', fileName: '2025年3月保険合計柏.pdf', pdfText: '保険合計\nR07/03/01〜R07/03/31' };
  assertEq(hqFns._salesPeriodGuard(argsA), indexFns._salesPeriodGuard(argsA), 'HQ経路(a)がindex.html側と同一結果');

  const argsB = { targetMonth: '2026-02', fileName: '2026年2月保険合計柏.pdf', pdfText: 'R08/02/01〜R08/02/28' };
  assertEq(hqFns._salesPeriodGuard(argsB), indexFns._salesPeriodGuard(argsB), 'HQ経路(b)がindex.html側と同一結果');

  const argsF = { targetMonth: '2026-03', fileName: '保険合計_2026-04-07.pdf', pdfText: null };
  assertEq(hqFns._salesPeriodGuard(argsF), indexFns._salesPeriodGuard(argsF), 'HQ経路(f・弱い証拠warn)がindex.html側と同一結果');

  assertEq(hqFns._salesConsistencyCheck(corrupted), indexFns._salesConsistencyCheck(corrupted), 'HQ経路の_salesConsistencyCheckがindex.html側と同一結果');
}

console.log(`\n合計: ${pass + fail}件中 PASS=${pass} FAIL=${fail}`);
if (fail > 0) { console.log('FAIL が存在します'); process.exit(1); }
console.log('ALL OK');
process.exit(0);
