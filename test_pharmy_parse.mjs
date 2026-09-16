#!/usr/bin/env node
// test_pharmy_parse.mjs
// HOMECARE_CSV_PROFILES.pharmy.parse() の単体テスト（依存ゼロ・index.htmlから関数本体を抽出して実行）。
// 目的（INC-399再発防止・2026-09-16）: 技術料(tech)がcol13-17(基本/時加算/調剤/調加算/指導)のみの合計になっており、
// col18-20(内服薬/内服外/材料点=薬剤料・材料料)を含めていないことを機械的に検証する。
// 実行: node test_pharmy_parse.mjs
//
// 抽出方式: index.html内の「parse(lines) {」から対応する閉じ括弧までをクォート認識の括弧カウントで
// 切り出し、computeHomecareTotalsFromRows()本体と結合したうえで
// new Function('TECH_INCLUDE_TIME_ADD','lines', combinedBody) として評価する。
// index.html自体を書き換えずに実関数（コピー・再実装ではない）を直接テストするため、
// 将来index.htmlのparse()実装が変わってもこのテストが実装とズレない。
//
// INC-403（2026-09-16）でparse()は「行の正規化」のみを担当するよう分離され、
// 集計はcomputeHomecareTotalsFromRows()に一本化された。parse()はこの関数を呼び出すため、
// テスト側も両方を同一スコープへ抽出して結合評価する（parse()単体では実行できない）。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');

function extractBraceBlock(src, startMarker) {
  const markerIdx = src.indexOf(startMarker);
  if (markerIdx === -1) throw new Error('marker not found: ' + startMarker);
  const openIdx = markerIdx + startMarker.length - 1; // startMarkerは末尾が"{"である前提
  if (src[openIdx] !== '{') throw new Error('startMarker must end with "{"');
  let depth = 0;
  let inStr = null; // 現在文字列リテラル内か（'/"/`のいずれか、またはnull）
  let i = openIdx;
  for (; i < src.length; i++) {
    const ch = src[i];
    const prev = src[i - 1];
    if (inStr) {
      if (ch === inStr && prev !== '\\') inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  if (depth !== 0) throw new Error('matching closing brace not found for: ' + startMarker);
  return { full: src.slice(openIdx, i), openIdx, endIdx: i };
}

function extractParsePharmy() {
  const src = readFileSync(INDEX_HTML_PATH, 'utf8');

  const techConstMatch = src.match(/const\s+TECH_INCLUDE_TIME_ADD\s*=\s*(true|false)\s*;/);
  if (!techConstMatch) throw new Error('TECH_INCLUDE_TIME_ADD 定数が見つかりません（index.html側の宣言が変更された可能性）');
  const techIncludeTimeAdd = techConstMatch[1] === 'true';

  // computeHomecareTotalsFromRows() 本体（関数宣言そのものを丸ごと取り込み、parse()から呼べるようにする）
  const computeBlock = extractBraceBlock(src, 'function computeHomecareTotalsFromRows(header, rows, _profile) {');
  const computeFull = 'function computeHomecareTotalsFromRows(header, rows, _profile) ' + computeBlock.full;
  if (!computeFull.includes('REQUIRED') || !computeFull.includes('g.tech')) {
    throw new Error('抽出したcomputeHomecareTotalsFromRows本体が想定と一致しません（index.html構造変更の疑い）');
  }

  // HOMECARE_ROWS_HEADER_PHARMY（pharmy用の行ヘッダー定数）もparse()が参照するため同一スコープへ取り込む
  const headerConstMatch = src.match(/const\s+HOMECARE_ROWS_HEADER_PHARMY\s*=\s*(\[[\s\S]*?\]);/);
  if (!headerConstMatch) throw new Error('HOMECARE_ROWS_HEADER_PHARMY 定数が見つかりません（index.html側の宣言が変更された可能性）');
  const headerConstSrc = 'const HOMECARE_ROWS_HEADER_PHARMY = ' + headerConstMatch[1] + ';';

  const { full } = extractBraceBlock(src, 'parse(lines) {');
  // full は "{ ...本体... }" （外側の中括弧を含む）。new Function の第3引数には中身のみ渡す。
  const parseBody = full.slice(1, -1);

  // eslint的な安全確認: 抽出テキストにHOMECARE_CSV_PROFILES/pharmy固有の識別子が含まれるか（抽出位置の妥当性チェック）
  if (!parseBody.includes('cols[22]') || !parseBody.includes('computeHomecareTotalsFromRows')) {
    throw new Error('抽出したparse本体がpharmy用と一致しません（index.html構造変更の疑い）');
  }

  // HOMECARE_ROWS_HEADER_PHARMY定数 → computeHomecareTotalsFromRows（関数宣言・ホイスト） → parse()本体、の順に
  // 同一スコープへ結合し評価する
  const combinedBody = headerConstSrc + '\n' + computeFull + '\n' + parseBody;
  // eslint-disable-next-line no-new-func
  const parsePharmy = new Function('TECH_INCLUDE_TIME_ADD', 'lines', combinedBody);
  return { parsePharmy, techIncludeTimeAdd };
}

// ===== サンプルCSV構築 =====
// 列: 0名前,1空,2給,3保険種,4回数,5定負担,6介護負担,7選定療養,8自費薬,9請求額,10入金額,11現未収,
//     12保険計,13基本点,14時加算,15調剤点,16調加算,17指導点,18内服薬,19内服外,20材料点,21患者ID,22施設名
function csvRow({ name, visits, insTotal, base, timeAdd, disp, dispAdd, guidance, oral, external, material, facility }) {
  return [
    name, '', '9', '国老+介', visits, '0', '0', '0', '0', '0', '0', '0',
    insTotal, base, timeAdd, disp, dispAdd, guidance, oral, external, material, '', facility
  ].join(',');
}

// 施設A: 2患者（同一値を2行）。基本100/時加算10/調剤200/調加算20/指導300/内服1000/内服外50/材料5
//   → tech(1行)=100+10+200+20+300=630, drugFee(1行)=1000+50+5=1055, insTotal(1行)=(630+1055)*10=16850
const A_ROW = { name: 'テスト太郎', visits: 3, insTotal: 16850, base: 100, timeAdd: 10, disp: 200, dispAdd: 20, guidance: 300, oral: 1000, external: 50, material: 5, facility: '施設A' };
const A_ROW2 = { ...A_ROW, name: 'テスト次郎', visits: 2 };
// 施設B: 1患者。基本10/時加算1/調剤20/調加算2/指導30/内服100/内服外5/材料1
//   → tech=10+1+20+2+30=63, drugFee=100+5+1=106, insTotal=(63+106)*10=1690
const B_ROW = { name: 'テスト花子', visits: 1, insTotal: 1690, base: 10, timeAdd: 1, disp: 20, dispAdd: 2, guidance: 30, oral: 100, external: 5, material: 1, facility: '施設B' };

const lines = [
  'ヘッダー行（ダミー）',
  '単位行（ダミー）',
  csvRow(A_ROW),
  csvRow(A_ROW2),
  csvRow(B_ROW),
];

// ===== 検証 =====
let failCount = 0;
function assertEqual(label, actual, expected) {
  const ok = actual === expected;
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + label + ' (actual=' + actual + ', expected=' + expected + ')');
  if (!ok) failCount++;
}

const { parsePharmy, techIncludeTimeAdd } = extractParsePharmy();
console.log('TECH_INCLUDE_TIME_ADD (index.htmlから抽出) = ' + techIncludeTimeAdd);
assertEqual('TECH_INCLUDE_TIME_ADD は既定でtrue（時加算を技術料に含める）', techIncludeTimeAdd, true);

const result = parsePharmy(techIncludeTimeAdd, lines);
if (!result) {
  console.log('FAIL - parsePharmy() が null を返しました（データ行が正しく認識されていません）');
  process.exit(1);
}
const { sorted, totals } = result;

assertEqual('施設数（グループ化）', sorted.length, 2);
assertEqual('sorted[0]は保険計の多い施設A（降順ソート）', sorted[0][0], '施設A');
assertEqual('sorted[1]は施設B', sorted[1][0], '施設B');

const gA = sorted[0][1];
const gB = sorted[1][1];

// --- 施設A（2患者合算） ---
assertEqual('施設A patients', gA.patients, 2);
assertEqual('施設A times（回数合算）', gA.times, 5);
assertEqual('施設A tech = col13+14+15+16+17の合計（col18-20を含まない）', gA.tech, 1260);
assertEqual('施設A drugFee = col18+19+20の合計', gA.drugFee, 2110);
assertEqual('施設A base(col13)', gA.base, 200);
assertEqual('施設A timeAdd(col14)', gA.timeAdd, 20);
assertEqual('施設A dispensing(col15)', gA.dispensing, 400);
assertEqual('施設A dispAdd(col16)', gA.dispAdd, 40);
assertEqual('施設A guidance(col17)', gA.guidance, 600);
assertEqual('施設A oralMed(col18)', gA.oralMed, 2000);
assertEqual('施設A externalMed(col19)', gA.externalMed, 100);
assertEqual('施設A material(col20)', gA.material, 10);
assertEqual('施設A internal（旧フィールド、oralMedと同値で後方互換維持）', gA.internal, gA.oralMed);
assertEqual('施設A 検算: tech+drugFee = insTotal/10（薬剤料/材料料を技術料から除外した回帰確認）', gA.tech + gA.drugFee, Math.round(gA.insTotal / 10));

// --- 施設B（1患者） ---
assertEqual('施設B tech', gB.tech, 63);
assertEqual('施設B drugFee', gB.drugFee, 106);
assertEqual('施設B 検算: tech+drugFee = insTotal/10', gB.tech + gB.drugFee, Math.round(gB.insTotal / 10));

// --- 全体合計 ---
assertEqual('totals.patients', totals.patients, 3);
assertEqual('totals.times', totals.times, 6);
assertEqual('totals.tech（INC-399の核心: 旧実装はここにcol18-20が混入していた）', totals.tech, 1323);
assertEqual('totals.drugFee', totals.drugFee, 2216);
assertEqual('totals.base', totals.base, 210);
assertEqual('totals.timeAdd', totals.timeAdd, 21);
assertEqual('totals.dispensing', totals.dispensing, 420);
assertEqual('totals.dispAdd', totals.dispAdd, 42);
assertEqual('totals.guidance', totals.guidance, 630);
assertEqual('totals.oralMed', totals.oralMed, 2100);
assertEqual('totals.externalMed', totals.externalMed, 105);
assertEqual('totals.material', totals.material, 11);
assertEqual('totals 検算: tech+drugFee = insTotal/10', totals.tech + totals.drugFee, Math.round(totals.insTotal / 10));

// --- 回帰ガード: 旧バグの再現値（tech=1875, drugFee相当なし）にならないことの明示確認 ---
const OLD_BUGGY_TOTAL_TECH = totals.tech + totals.drugFee; // 旧実装ではtechがこの値になっていた
assertEqual('旧バグ再発防止: tech は insTotal/10 と一致しない（薬剤料が混入していない証跡）', totals.tech === Math.round(totals.insTotal / 10), false);
assertEqual('旧バグ値の内訳確認: tech(新) + drugFee = 旧tech相当値', totals.tech + totals.drugFee, OLD_BUGGY_TOTAL_TECH);

console.log('---');
if (failCount === 0) {
  console.log('ALL PASS (' + 'test_pharmy_parse.mjs' + ')');
  process.exit(0);
} else {
  console.log('FAILED: ' + failCount + ' assertion(s)');
  process.exit(1);
}
