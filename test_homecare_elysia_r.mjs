#!/usr/bin/env node
// test_homecare_elysia_r.mjs
// 足立（シグマ エリシア）「施設集計 R」PDF（医療保険 患者別調剤報酬明細）取込の単体テスト
// （依存ゼロ・index.htmlから関数本体を抽出して実行。pdf.js非依存の純関数parseElysiaRLinesのみを対象とする）。
//
// 対象PDF: 月次「施設集計」（患者番号|漢字氏名|基本料|調製料|(加算)|管理料|薬剤料|材料料|報酬点数|管理名|件数）。
// 既存HOMECARE_CSV_PROFILES.elysia（介護保険 居宅療養管理指導CSV）とは別勘定・別入口（HOMECARE_PDF_PROFILES.elysia_r）。
//
// フィクスチャは実PDFのレイアウト（列順・トークン構成）だけを写した合成データ（施設名・金額・患者番号・氏名は架空。
// 実データはリポに入れない）。実PDFでの検算は別便（scratchpad内の一時スクリプト）で実施し、本テストには含めない。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');

function extractBraceBlock(src, startMarker, fromIndex = 0) {
  const markerIdx = src.indexOf(startMarker, fromIndex);
  if (markerIdx === -1) throw new Error('marker not found: ' + startMarker);
  const openIdx = markerIdx + startMarker.length - 1;
  if (src[openIdx] !== '{') throw new Error('startMarker must end with "{"');
  let depth = 0, inStr = null, i = openIdx;
  for (; i < src.length; i++) {
    const ch = src[i], prev = src[i - 1];
    if (inStr) { if (ch === inStr && prev !== '\\') inStr = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) throw new Error('matching closing brace not found for: ' + startMarker);
  return { full: src.slice(openIdx, i), markerIdx };
}

function extractElysiaR() {
  const src = readFileSync(INDEX_HTML_PATH, 'utf8');

  const headerConstMatch = src.match(/const\s+HOMECARE_ROWS_HEADER_PHARMY\s*=\s*(\[[\s\S]*?\]);/);
  if (!headerConstMatch) throw new Error('HOMECARE_ROWS_HEADER_PHARMY 定数が見つかりません');
  const headerConstSrc = 'const HOMECARE_ROWS_HEADER_PHARMY = ' + headerConstMatch[1] + ';';

  const computeBlock = extractBraceBlock(src, 'function computeHomecareTotalsFromRows(header, rows, _profile) {');
  const computeFull = 'function computeHomecareTotalsFromRows(header, rows, _profile) ' + computeBlock.full;

  const techConstMatch = src.match(/const\s+TECH_INCLUDE_TIME_ADD\s*=\s*(true|false)\s*;/);
  if (!techConstMatch) throw new Error('TECH_INCLUDE_TIME_ADD 定数が見つかりません');
  const techConstSrc = 'const TECH_INCLUDE_TIME_ADD = ' + techConstMatch[1] + ';';

  const sectionStart = src.indexOf('// ===HOMECARE_PDF_ELYSIA_R_START===');
  if (sectionStart === -1) throw new Error('===HOMECARE_PDF_ELYSIA_R_START=== マーカーが見つかりません');
  const sectionEnd = src.indexOf('// ===HOMECARE_PDF_ELYSIA_R_END===', sectionStart);
  if (sectionEnd === -1) throw new Error('===HOMECARE_PDF_ELYSIA_R_END=== マーカーが見つかりません');

  const tokenFnBlock = extractBraceBlock(src, 'function _elysiaRIsNumericToken(t) {', sectionStart);
  const tokenFnFull = 'function _elysiaRIsNumericToken(t) ' + tokenFnBlock.full;

  const maxVisitsMatch = src.slice(sectionStart).match(/const\s+ELYSIA_R_MAX_VISITS_PER_PATIENT\s*=\s*(\d+)\s*;/);
  if (!maxVisitsMatch) throw new Error('ELYSIA_R_MAX_VISITS_PER_PATIENT 定数が見つかりません');
  const maxVisitsConstSrc = 'const ELYSIA_R_MAX_VISITS_PER_PATIENT = ' + maxVisitsMatch[1] + ';';

  const parseBlock = extractBraceBlock(src, 'function parseElysiaRLines(lines) {', sectionStart);
  const parseFull = 'function parseElysiaRLines(lines) ' + parseBlock.full;
  if (parseBlock.markerIdx > sectionEnd) throw new Error('parseElysiaRLines がHOMECARE_PDF_ELYSIA_Rセクション外で見つかりました');
  if (!parseFull.includes('perPatient') || !parseFull.includes('footerTotalVisits')) {
    throw new Error('抽出したparseElysiaRLines本体が想定と一致しません（index.html構造変更の疑い）');
  }

  // HOMECARE_PDF_PROFILES.elysia_r の属性（techBreakdown/confirmed/stores）も実物から読む
  const profilesStart = src.indexOf('const HOMECARE_PDF_PROFILES = {', sectionStart);
  if (profilesStart === -1) throw new Error('HOMECARE_PDF_PROFILES 定数が見つかりません');
  const elysiaRStart = src.indexOf('elysia_r: {', profilesStart);
  if (elysiaRStart === -1) throw new Error('HOMECARE_PDF_PROFILES.elysia_r ブロックが見つかりません');
  const attrsBlock = src.slice(elysiaRStart, elysiaRStart + 800);
  const confirmedMatch = attrsBlock.match(/confirmed:\s*(true|false)/);
  const techBreakdownMatch = attrsBlock.match(/techBreakdown:\s*(true|false)/);
  const storesMatch = attrsBlock.match(/stores:\s*(\[[^\]]*\])/);
  if (!confirmedMatch || !techBreakdownMatch || !storesMatch) throw new Error('HOMECARE_PDF_PROFILES.elysia_r の属性抽出に失敗');

  const combinedSrc = techConstSrc + '\n' + headerConstSrc + '\n' + computeFull + '\n' + tokenFnFull + '\n' +
    maxVisitsConstSrc + '\n' +
    parseFull + '\n' +
    'this.parseElysiaRLines = parseElysiaRLines;\n' +
    'this.computeHomecareTotalsFromRows = computeHomecareTotalsFromRows;\n' +
    'this.HOMECARE_ROWS_HEADER_PHARMY = HOMECARE_ROWS_HEADER_PHARMY;\n';

  const sandbox = {};
  const vmFn = new Function(combinedSrc);
  vmFn.call(sandbox);
  return {
    parseElysiaRLines: sandbox.parseElysiaRLines,
    computeHomecareTotalsFromRows: sandbox.computeHomecareTotalsFromRows,
    HOMECARE_ROWS_HEADER_PHARMY: sandbox.HOMECARE_ROWS_HEADER_PHARMY,
    confirmed: confirmedMatch[1] === 'true',
    techBreakdown: techBreakdownMatch[1] === 'true',
    stores: JSON.parse(storesMatch[1].replace(/'/g, '"')),
  };
}

// ===== 検証ユーティリティ =====
let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log('PASS - ' + label); pass++; }
  else { console.log('FAIL - ' + label + ' (actual=' + a + ', expected=' + e + ')'); fail++; }
}
function assertOk(cond, label) {
  if (cond) { console.log('PASS - ' + label); pass++; }
  else { console.log('FAIL - ' + label); fail++; }
}

// ===== 合成データ構築（実PDFのレイアウト=列順・トークン構成だけを再現。施設名・金額・患者番号・氏名は架空） =====
// 行の形: 患者番号 姓 名 基本料 調製料 (加算) 管理料 薬剤料 材料料 報酬点数 [管理名(任意)] 件数
const HEADER_LINE = '患者番号       漢字氏名       基本料       調製料       (加算)       管理料     薬剤料       材料料       報酬点数         管理名   件数';
const PAGE_FOOTER_LINE = 'R08/07/01～R08/07/31                                                                                          作成日 R08/08/12';
const PAGE_TITLE_LINE = '                                                                        施設集計                                           1頁';

const IDENTIFIER_KANJI_SURNAME = '個人情報';
const IDENTIFIER_KANJI_GIVEN = '太郎';
const IDENTIFIER_ID = '999001';

// 施設A（架空）: 患者1が月2回訪問（同一患者・複数行→1行へ事前集約されるはず）、患者2が月1回、施設名の記載あり
const A1_V1 = `    ${IDENTIFIER_ID} ${IDENTIFIER_KANJI_SURNAME} ${IDENTIFIER_KANJI_GIVEN}           219        76             8      20      198           0      521 施設A         1`;
const A1_V2 = `    ${IDENTIFIER_ID} ${IDENTIFIER_KANJI_SURNAME} ${IDENTIFIER_KANJI_GIVEN}           119        24             0     105       60           0      308 施設A         1`;
const A2_V1 = `    999002 テスト 次郎           119        38             4      55       18           0      234 施設A         1`;

// 施設B（架空）: 患者3が月1回
const B1_V1 = `    999003 テスト 花子           219       100             8     132      532           0      991 施設B         1`;

// 管理名が空欄の行（実データのpage1-2で確認済みのパターン=管理料のみで他が0）→（未分類）バケットへ
const BLANK_V1 = `    999004 テスト 三郎               0         0          0     320         0         0      320                  1`;

const lines = [
  PAGE_FOOTER_LINE, PAGE_TITLE_LINE, HEADER_LINE,
  A1_V1, A1_V2, A2_V1, B1_V1, BLANK_V1,
];
// 合計行（氏名トークンが無く数値のみ。実PDFと同じ桁区切りカンマ表記）
const FOOTER_TOTALS_LINE = '                      795   238    20    632   808   0   2374             5';
const linesWithFooter = lines.concat([PAGE_FOOTER_LINE, '                                                                          施設集計                                          2 頁', HEADER_LINE, FOOTER_TOTALS_LINE]);

// ===== 実行 =====
const { parseElysiaRLines, computeHomecareTotalsFromRows, HOMECARE_ROWS_HEADER_PHARMY, confirmed, techBreakdown, stores } = extractElysiaR();

assertOk(confirmed === true, 'HOMECARE_PDF_PROFILES.elysia_r.confirmed === true（未対応エラーが出ない設定になっている）');
assertEq(techBreakdown, true, 'HOMECARE_PDF_PROFILES.elysia_r.techBreakdown === true（医療保険の技術料内訳あり）');
assertOk(stores.includes('adachi'), 'HOMECARE_PDF_PROFILES.elysia_r.stores に adachi が含まれる');

const result = parseElysiaRLines(linesWithFooter);
if (!result.rows) { console.log('FAIL - parseElysiaRLines() が rows=null を返しました'); process.exit(1); }
const { header, rows, footerTotalVisits, warnings } = result;

// ---- header/識別子除去 ----
assertEq(header, HOMECARE_ROWS_HEADER_PHARMY, 'headerはHOMECARE_ROWS_HEADER_PHARMYを再利用');
const rowsJson = JSON.stringify(rows);
assertOk(!rowsJson.includes(IDENTIFIER_KANJI_SURNAME), '患者氏名(姓)がrowsに含まれない');
assertOk(!rowsJson.includes(IDENTIFIER_KANJI_GIVEN), '患者氏名(名)がrowsに含まれない');
assertOk(!rowsJson.includes(IDENTIFIER_ID), '患者番号がrowsに含まれない');

// ---- 事前集約（同一患者の複数訪問行→1行） ----
const agg = computeHomecareTotalsFromRows(header, rows, 'elysia_r');
assertOk(!!agg, 'computeHomecareTotalsFromRowsがnullを返さない');
const { sorted, totals } = agg;
assertEq(sorted.length, 3, '施設数=3（施設A・施設B・（未分類）)');
const byName = {}; sorted.forEach(([name, g]) => { byName[name] = g; });

assertEq(byName['施設A'].patients, 2, '施設A patients=2（同一患者の複数行が1人に事前集約されている・来院回数ではない）');
assertEq(byName['施設A'].times, 3, '施設A times=3（件数列の合計=1+1+1）');
assertEq(byName['施設A'].base, 219 + 119 + 119, '施設A base=457（基本料の合計）');
assertEq(byName['施設A'].dispensing, 76 + 24 + 38, '施設A dispensing=138（調製料の合計）');
assertEq(byName['施設A'].guidance, 20 + 105 + 55, '施設A guidance=180（管理料の合計）');
assertEq(byName['施設A'].drugFee, 198 + 60 + 18, '施設A drugFee=276（薬剤料の合計・材料料0）');
assertEq(byName['施設A'].insTotal, (521 + 308 + 234) * 10, '施設A insTotal=報酬点数合計×10（pharmy互換の円相当単位）');

assertEq(byName['施設B'].patients, 1, '施設B patients=1');
assertEq(byName['施設B'].insTotal, 991 * 10, '施設B insTotal=991×10');

assertOk(!!byName['（未分類）'], '管理名が空欄の行は（未分類）バケットに入る');
assertEq(byName['（未分類）'].guidance, 320, '（未分類）guidance=320');

// ---- 合計行の件数検算（タスク要件: 合計行の件数とrows集計visitsの一致確認） ----
assertEq(footerTotalVisits, 5, '合計行から件数=5を抽出（実PDFでは1,476。本テストは合成データのため5）');
assertEq(totals.times, 5, '集計結果のtimes合計=5（合計行の件数と一致＝検算OK）');
assertEq(totals.times, footerTotalVisits, '検算: Σvisits(rows) === footerTotalVisits');

assertEq(warnings.length, 0, '警告なし（全行が正しく解析できる構成のため）');

// ---- ノイズ行（患者番号が数値でない・列不足）は安全にスキップされる ----
{
  const noisyLines = [HEADER_LINE, '不正な行です', '    123 名前だけ 不足   1'];
  const r2 = parseElysiaRLines(noisyLines);
  assertEq(r2.rows, null, 'データ行が1件も無い場合はrows=nullを返す');
}

// ---- 合計行が患者行に結合したケース（2026-10-14・サンドボックスのXpdf変換で実際に観測した現象を合成再現）----
// 実PDFでは「2039 上野 節子 ... 1,403 在宅                            1,476」のように、独立した合計行の数値列が
// 直前の患者行へそのまま連結され、件数(visits)列に合計行の件数(1,476)が入ってしまう。本番pdfjs-dist実機検証では
// 発生しなかったが、ELYSIA_R_MAX_VISITS_PER_PATIENT上限ガードが正しく働くことを合成データで確認する。
{
  const MERGED_V1 = '    999005 テスト 五郎           219       102            0     148      930           0     1,403 施設C                            1,476';
  const NORMAL_C_V1 = '    999006 テスト 六郎           219        24             0      10       40           0      293 施設C         1';
  const mergedLines = [HEADER_LINE, MERGED_V1, NORMAL_C_V1];
  const r3 = parseElysiaRLines(mergedLines);
  assertOk(!!r3.rows, '合計行結合ケースでも他の正常行がありrows!=null');
  assertEq(r3.mergeSuspectCount, 1, 'mergeSuspectCount=1（上限60超の1行を検知）');
  assertOk(r3.warnings.some(w => w.includes('合計行結合の疑い') && w.includes('施設C')), '警告メッセージに「合計行結合の疑い」と施設名が含まれる');
  const idx3 = {}; r3.header.forEach((h, i) => { idx3[h] = i; });
  assertEq(r3.rows.length, 1, '除外後のrowsは1件のみ（正常な六郎の行だけ残る）');
  assertEq(r3.rows[0][idx3.visits], 1, '残った行の件数=1（結合疑いの999005行は除外され999006行だけ残る)');
  // 全行が上限超のときはrows=null（validEntries.length===0の分岐）になることも確認
  const r4 = parseElysiaRLines([HEADER_LINE, MERGED_V1]);
  assertEq(r4.rows, null, '正常行が1件も無い（全行が上限超）場合はrows=nullを返す');
  assertEq(r4.mergeSuspectCount, 1, '全除外ケースでもmergeSuspectCountは1を返す');
}

console.log('---');
if (fail === 0) { console.log('ALL PASS (test_homecare_elysia_r.mjs) — ' + pass + ' assertions'); process.exit(0); }
else { console.log('FAILED: ' + fail + ' assertion(s) / PASS ' + pass); process.exit(1); }
