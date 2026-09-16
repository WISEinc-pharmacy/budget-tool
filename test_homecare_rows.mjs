#!/usr/bin/env node
// test_homecare_rows.mjs
// 在宅内訳CSV 行データ保存・再集計（homecareRows・INC-403・2026-09-16）の単体テスト（依存ゼロ）。
// index.htmlを書き換えずに、マーカー（===HOMECARE_ROWS_START/END===・===HOMECARE_ROWS_MERGE_START/END===）
// で囲まれたソースと pharmy.parse() 本体を抽出して直接実行し、以下を検証する:
//   (a) pharmy CSV → rows に患者名/患者ID/カナが含まれない（識別子除去の確認）
//   (b) 全数値列（copayRatio〜materialPoints）が保存される
//   (c) computeHomecareTotalsFromRows が既存parse()の集計結果と一致する（tech=col13-17・drugFee=col18-20）
//   (d) 500行超の行数を保存する際のチャンク分割ロジック（HOMECARE_ROWS_CHUNK_SIZE）が行を過不足なく分割する
//   (e) 保存済み行(header/rows)から再集計した facilities/totals が元のparse()結果と完全一致する（再集計ボタン/CLIの正しさ）
// 実行: node test_homecare_rows.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

// ===== 抽出ユーティリティ（test_pharmy_parse.mjsと同方式: クォート認識の括弧カウント） =====
function extractBraceBlock(s, startMarker) {
  const markerIdx = s.indexOf(startMarker);
  if (markerIdx === -1) throw new Error('marker not found: ' + startMarker);
  const openIdx = markerIdx + startMarker.length - 1;
  if (s[openIdx] !== '{') throw new Error('startMarker must end with "{"');
  let depth = 0, inStr = null, i = openIdx;
  for (; i < s.length; i++) {
    const ch = s[i], prev = s[i - 1];
    if (inStr) { if (ch === inStr && prev !== '\\') inStr = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) throw new Error('matching closing brace not found for: ' + startMarker);
  return { full: s.slice(openIdx, i), openIdx, endIdx: i };
}
function extractBetweenMarkers(s, startMarker, endMarker) {
  const si = s.indexOf(startMarker);
  const ei = s.indexOf(endMarker);
  if (si === -1 || ei === -1) throw new Error('marker not found: ' + startMarker + ' / ' + endMarker);
  return s.slice(si + startMarker.length, ei);
}

// TECH_INCLUDE_TIME_ADD
const techConstMatch = src.match(/const\s+TECH_INCLUDE_TIME_ADD\s*=\s*(true|false)\s*;/);
if (!techConstMatch) throw new Error('TECH_INCLUDE_TIME_ADD 定数が見つかりません');
const TECH_INCLUDE_TIME_ADD = techConstMatch[1] === 'true';

// ===HOMECARE_ROWS_START===〜END=== ブロック（HOMECARE_ROWS_HEADER_PHARMY定数 + computeHomecareTotalsFromRows）
const rowsBlockSrc = extractBetweenMarkers(src, '// ===HOMECARE_ROWS_START===', '// ===HOMECARE_ROWS_END===');

// ===HOMECARE_ROWS_MERGE_START===〜END=== ブロック（mergeHomecareRows）
const rowsMergeBlockSrc = extractBetweenMarkers(src, '// ===HOMECARE_ROWS_MERGE_START===', '// ===HOMECARE_ROWS_MERGE_END===');

// HOMECARE_ROWS_CHUNK_SIZE 定数
const chunkSizeMatch = src.match(/const\s+HOMECARE_ROWS_CHUNK_SIZE\s*=\s*(\d+)\s*;/);
if (!chunkSizeMatch) throw new Error('HOMECARE_ROWS_CHUNK_SIZE 定数が見つかりません');
const HOMECARE_ROWS_CHUNK_SIZE = parseInt(chunkSizeMatch[1], 10);

// pharmy.parse(lines) 本体
const { full: parseFull } = extractBraceBlock(src, 'parse(lines) {');
const parseBody = parseFull.slice(1, -1);
if (!parseBody.includes('cols[22]') || !parseBody.includes('computeHomecareTotalsFromRows')) {
  throw new Error('抽出したparse本体がpharmy用と一致しません（index.html構造変更の疑い）');
}

// 全ブロックを同一スコープへ結合して評価（HOMECARE_ROWS_HEADER_PHARMY→computeHomecareTotalsFromRows→
// mergeHomecareRows→parse()、いずれも関数/定数宣言なのでホイストされ相互参照できる）
const combinedSrc = rowsBlockSrc + '\n' + rowsMergeBlockSrc + '\n' +
  'function parsePharmy(lines) {' + parseBody + '}\n' +
  'this.computeHomecareTotalsFromRows = computeHomecareTotalsFromRows;\n' +
  'this.mergeHomecareRows = mergeHomecareRows;\n' +
  'this.parsePharmy = parsePharmy;\n' +
  'this.HOMECARE_ROWS_HEADER_PHARMY = HOMECARE_ROWS_HEADER_PHARMY;\n';

import vm from 'node:vm';
const sandbox = { TECH_INCLUDE_TIME_ADD };
vm.createContext(sandbox);
vm.runInContext(combinedSrc, sandbox);
const { computeHomecareTotalsFromRows, mergeHomecareRows, parsePharmy, HOMECARE_ROWS_HEADER_PHARMY } = sandbox;

// ===== サンプルCSV構築（列構造はCSV_IMPORT_SPEC.md L50-75・test_pharmy_parse.mjsと同一） =====
// 列: 0名前(識別子),1空,2給,3保険種,4回数,5定負担,6介護負担,7選定療養,8自費薬,9請求額,10入金額,11現未収,
//     12保険計,13基本点,14時加算,15調剤点,16調加算,17指導点,18内服薬,19内服外,20材料点,21患者ID(識別子),22施設名,23カナ(識別子)
function csvRow({ name, patientId, kana, visits, insTotal, base, timeAdd, disp, dispAdd, guidance, oral, external, material, facility, insuranceType = '国老+介', copayRatio = '9' }) {
  return [
    name, '', copayRatio, insuranceType, visits, '0', '0', '0', '0', '0', '0', '0',
    insTotal, base, timeAdd, disp, dispAdd, guidance, oral, external, material, patientId, facility, kana
  ].join(',');
}

const IDENTIFIER_NAME = '個人情報太郎';
const IDENTIFIER_ID = 'PID-99887766';
const IDENTIFIER_KANA = 'コジンジョウホウタロウ';

const A_ROW = { name: IDENTIFIER_NAME, patientId: IDENTIFIER_ID, kana: IDENTIFIER_KANA, visits: 3, insTotal: 16850, base: 100, timeAdd: 10, disp: 200, dispAdd: 20, guidance: 300, oral: 1000, external: 50, material: 5, facility: '施設A' };
const A_ROW2 = { ...A_ROW, name: 'テスト次郎', patientId: 'PID-2', kana: 'テストジロウ', visits: 2 };
const B_ROW = { name: 'テスト花子', patientId: 'PID-3', kana: 'テストハナコ', visits: 1, insTotal: 1690, base: 10, timeAdd: 1, disp: 20, dispAdd: 2, guidance: 30, oral: 100, external: 5, material: 1, facility: '施設B' };

const lines = ['ヘッダー行（ダミー）', '単位行（ダミー）', csvRow(A_ROW), csvRow(A_ROW2), csvRow(B_ROW)];

const result = parsePharmy(lines);
if (!result) { console.log('❌ FAIL: parsePharmy() が null を返しました'); process.exit(1); }
const { sorted, totals, header, rows } = result;

// ---- (a) 識別子（患者名/患者ID/カナ）がrowsに含まれないこと ----
const rowsJson = JSON.stringify(rows);
assertOk(!rowsJson.includes(IDENTIFIER_NAME), '(a) 患者名(IDENTIFIER_NAME)がrowsに含まれない');
assertOk(!rowsJson.includes(IDENTIFIER_ID), '(a) 患者ID(IDENTIFIER_ID)がrowsに含まれない');
assertOk(!rowsJson.includes(IDENTIFIER_KANA), '(a) カナ(IDENTIFIER_KANA)がrowsに含まれない');
assertOk(!header.includes('name') && !header.includes('patientId') && !header.includes('kana') && !header.includes('csvPatientId'),
  '(a) headerに識別子キー(name/patientId/kana/csvPatientId)が含まれない');
assertEq(header, HOMECARE_ROWS_HEADER_PHARMY, '(a) headerはHOMECARE_ROWS_HEADER_PHARMYと一致（識別子を含まない固定列）');

// ---- (b) 全数値列が保存されること ----
const NUMERIC_FIELDS = ['copayRatio', 'visits', 'copay', 'careCopay', 'selectTherapy', 'selfPayDrug', 'billedAmount',
  'paidAmount', 'unpaidAmount', 'insuranceTotal', 'basePoints', 'timePoints', 'dispensingPoints',
  'dispensingAddPoints', 'guidancePoints', 'oralMedPoints', 'externalMedPoints', 'materialPoints'];
assertOk(NUMERIC_FIELDS.every(f => header.includes(f)), '(b) 全数値列がheaderに存在する（' + NUMERIC_FIELDS.length + '列）');
assertEq(rows.length, 3, '(b) rows件数=CSV行数(3)');
const idx = {}; header.forEach((h, i) => { idx[h] = i; });
assertEq(rows[0][idx.facility], '施設A', '(b) 1行目のfacility=施設A');
assertEq(rows[0][idx.basePoints], 100, '(b) 1行目のbasePoints(col13)=100');
assertEq(rows[0][idx.timePoints], 10, '(b) 1行目のtimePoints(col14)=10');
assertEq(rows[0][idx.dispensingPoints], 200, '(b) 1行目のdispensingPoints(col15)=200');
assertEq(rows[0][idx.oralMedPoints], 1000, '(b) 1行目のoralMedPoints(col18)=1000');
assertEq(rows[0][idx.materialPoints], 5, '(b) 1行目のmaterialPoints(col20)=5');
assertEq(rows[0][idx.insuranceType], '国老+介', '(b) 1行目のinsuranceType(col3・非識別属性)=国老+介');

// ---- (c) computeHomecareTotalsFromRows が既存parse()の集計結果と一致する ----
const gA = sorted.find(([name]) => name === '施設A')[1];
const gB = sorted.find(([name]) => name === '施設B')[1];
assertEq(gA.tech, 1260, '(c) 施設A tech = col13+14+15+16+17の合計（col18-20を含まない・INC-399の式）');
assertEq(gA.drugFee, 2110, '(c) 施設A drugFee = col18+19+20の合計');
assertEq(gB.tech, 63, '(c) 施設B tech');
assertEq(gB.drugFee, 106, '(c) 施設B drugFee');
assertEq(totals.tech, 1323, '(c) totals.tech（INC-399の核心: col18-20が混入していないこと）');
assertEq(totals.drugFee, 2216, '(c) totals.drugFee');
// header/rowsを独立に渡しても同じ結果になること（parse()内部呼び出しとの整合性確認）
const aggFromRows = computeHomecareTotalsFromRows(header, rows, 'pharmy');
assertEq(aggFromRows.totals, totals, '(c) computeHomecareTotalsFromRows(header,rows)の結果がparse()のtotalsと一致');
assertEq(aggFromRows.sorted, sorted, '(c) computeHomecareTotalsFromRows(header,rows)の結果がparse()のsortedと一致');

// ---- (d) 500行超のチャンク分割ロジック（HOMECARE_ROWS_CHUNK_SIZE基準の行数計算） ----
assertEq(HOMECARE_ROWS_CHUNK_SIZE, 500, '(d) HOMECARE_ROWS_CHUNK_SIZE=500');
const dummyRows = [];
for (let i = 0; i < 1234; i++) dummyRows.push([`施設${i % 5}`, '国', 9, 1, 0, 0, 0, 0, 0, 0, 0, 100, 10, 1, 2, 0, 3, 4, 0, 0]);
const chunkCount = Math.ceil(dummyRows.length / HOMECARE_ROWS_CHUNK_SIZE);
assertEq(chunkCount, 3, '(d) 1234行 → 3チャンク（ceil(1234/500)）');
const chunks = [];
for (let n = 0; n < chunkCount; n++) chunks.push(dummyRows.slice(n * HOMECARE_ROWS_CHUNK_SIZE, (n + 1) * HOMECARE_ROWS_CHUNK_SIZE));
assertEq(chunks.map(c => c.length), [500, 500, 234], '(d) 各チャンクの行数=[500,500,234]（上限500・端数保持）');
assertOk(chunks.every(c => c.length <= HOMECARE_ROWS_CHUNK_SIZE), '(d) 全チャンクが上限500行以下');
const reassembled = [].concat(...chunks);
assertEq(reassembled, dummyRows, '(d) チャンクを連結すると元のrowsと完全一致（欠落・重複なし）');

// ---- (e) 保存済み行(header/rows)からの再集計が元のfacilities/totalsを完全再現する ----
// 再集計ボタン/CLI(homecare_recompute.mjs)は「Firestoreから読み戻したheader/rows」に対してcomputeHomecareTotalsFromRowsを
// 呼ぶだけなので、ここではparse()が返したrowsをそのまま「保存→読み戻し」相当として使い再計算の忠実性を検証する。
const recomputed = computeHomecareTotalsFromRows(header, rows, 'pharmy');
const origFacilities = sorted.map(([name, g]) => ({ name, ...g }));
const recomputedFacilities = recomputed.sorted.map(([name, g]) => ({ name, ...g }));
assertEq(recomputedFacilities, origFacilities, '(e) 再集計facilitiesが元のparse()結果と完全一致（施設数・全フィールド）');
assertEq(recomputed.totals, totals, '(e) 再集計totalsが元のparse()結果と完全一致');
assertEq(recomputedFacilities.length, 2, '(e) 再集計後も2施設のまま（施設が消えていない）');

// ---- mergeHomecareRows: 施設ごと順次アップロード時の行マージ（facilitiesのupsertと対称・INC-403） ----
const prevHeader = header;
const prevRowsForMerge = rows.filter(r => r[idx.facility] === '施設A'); // 前回=施設Aのみ保存済み
const newRowsForMerge = rows.filter(r => r[idx.facility] === '施設B'); // 今回=施設Bを追加
const merged = mergeHomecareRows(prevHeader, prevRowsForMerge, header, newRowsForMerge);
assertEq(merged.rows.length, prevRowsForMerge.length + newRowsForMerge.length, 'mergeHomecareRows: 施設Aの既存行+施設Bの新規行=件数一致');
assertOk(merged.rows.some(r => r[idx.facility] === '施設A') && merged.rows.some(r => r[idx.facility] === '施設B'),
  'mergeHomecareRows: マージ後に施設A・施設Bの両方の行が残る');
const reuploadA = rows.filter(r => r[idx.facility] === '施設A').map(r => r.slice()); // 施設Aを再アップロード（内容は同一）
const merged2 = mergeHomecareRows(prevHeader, merged.rows, header, reuploadA);
assertEq(merged2.rows.filter(r => r[idx.facility] === '施設A').length, reuploadA.length,
  'mergeHomecareRows: 同一施設の再アップロードは新データで置換される（重複しない）');

console.log('---');
if (fail === 0) { console.log('ALL PASS (test_homecare_rows.mjs) — ' + pass + ' assertions'); process.exit(0); }
else { console.log('FAILED: ' + fail + ' assertion(s) / PASS ' + pass); process.exit(1); }
