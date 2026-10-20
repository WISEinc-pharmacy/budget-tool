#!/usr/bin/env node
// test_homecare_elysia.mjs
// HOMECARE_CSV_PROFILES.elysia.parse() の単体テスト（依存ゼロ・index.htmlから関数本体を抽出して実行）。
// 対象: つなぐ薬局 足立（レセコン=シグマ エリシア）の在宅内訳CSV「施設集計」取込（2026-10-13実装）。
//
// 実データ構造（2026-10-13・足立SPスタッフ提供サンプルで確認済み。Slack C02CW7SL78U ts=1791597344.424869）:
//   ヘッダー1行（各フィールドは""で囲まれる。pharmyと異なり単位行は無くi=1からデータ）:
//   0患者番号,1カナ氏名,2漢字氏名,3生年月日,4性別,5管理フラグ(施設コード),6管理名(施設名/"在宅"),
//   7サービス内容,8単位,9請求額,10入金額,11要介護度区分,12サービス提供日
//   ⚠️pharmyは「1行=1患者の月間集計済み」だが、このCSVは「1行=1回の訪問」(同一患者が月内に複数行)。
//   ⚠️基本点/時加算/調剤点/調加算・薬剤料(内服薬/内服外/材料点)・保険計に相当する列が無いため、
//     tech=guidancePointsのみ・drugFee=0・insuranceTotal=0固定（INC-399のtech式自体は変更しない）。
//
// フィクスチャは実CSVの構造だけを写した合成データ（施設名・金額は架空・実データはリポに入れない）。
// 抽出方式はtest_pharmy_parse.mjs / test_homecare_rows.mjsと同じ「括弧カウントによる本体抽出」。

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

function extractElysiaProfile() {
  const src = readFileSync(INDEX_HTML_PATH, 'utf8');

  const headerConstMatch = src.match(/const\s+HOMECARE_ROWS_HEADER_PHARMY\s*=\s*(\[[\s\S]*?\]);/);
  if (!headerConstMatch) throw new Error('HOMECARE_ROWS_HEADER_PHARMY 定数が見つかりません');
  const headerConstSrc = 'const HOMECARE_ROWS_HEADER_PHARMY = ' + headerConstMatch[1] + ';';

  const computeBlock = extractBraceBlock(src, 'function computeHomecareTotalsFromRows(header, rows, _profile) {');
  const computeFull = 'function computeHomecareTotalsFromRows(header, rows, _profile) ' + computeBlock.full;
  if (!computeFull.includes('REQUIRED') || !computeFull.includes('g.tech')) {
    throw new Error('抽出したcomputeHomecareTotalsFromRows本体が想定と一致しません（index.html構造変更の疑い）');
  }

  const techConstMatch = src.match(/const\s+TECH_INCLUDE_TIME_ADD\s*=\s*(true|false)\s*;/);
  if (!techConstMatch) throw new Error('TECH_INCLUDE_TIME_ADD 定数が見つかりません');
  const techConstSrc = 'const TECH_INCLUDE_TIME_ADD = ' + techConstMatch[1] + ';';

  // ⚠️ salesData側のRECEIPT_PROFILES（L4201付近）にも無関係な「elysia: {」ブロックが存在し、かつ
  // HOMECARE_CSV_PROFILES内でもpharmyの「parse(lines) {」がelysiaより前にあるため、
  // 検索開始位置を「HOMECARE_CSV_PROFILES定義の開始」→「その中のelysia: {」の2段で絞り込み、
  // pharmyのparse(lines)を誤検出しないようにする
  const homecareProfilesStart = src.indexOf('const HOMECARE_CSV_PROFILES = {');
  if (homecareProfilesStart === -1) throw new Error('HOMECARE_CSV_PROFILES 定数が見つかりません');
  const elysiaStart = src.indexOf('elysia: {', homecareProfilesStart);
  if (elysiaStart === -1) throw new Error('HOMECARE_CSV_PROFILES.elysia ブロックが見つかりません');
  const confirmedMatch = src.slice(elysiaStart).match(/elysia:\s*\{[\s\S]*?confirmed:\s*(true|false)/);
  if (!confirmedMatch) throw new Error('HOMECARE_CSV_PROFILES.elysia.confirmed が見つかりません');
  const confirmed = confirmedMatch[1] === 'true';

  // 2026-10-13: techBreakdown/techKind/techLabel（医療保険の技術料内訳が無いことの明示フラグ）を抽出
  // INC-603（2026-10-20）: 固定2000文字の切り出しだと、elysiaブロック冒頭の説明コメントが伸びるたびに
  // techKind/techLabel（場合によってはtechBreakdownも）が範囲外になり無言でnull化・例外化する
  // （実測: INC-603でコメント4行追加しただけでtechBreakdownすら拾えなくなった）。固定長をやめ、
  // parse()本体の直前（次の'parse(lines) {'出現位置）までを動的に切り出す。
  const parseMarkerIdx = src.indexOf('parse(lines) {', elysiaStart);
  const elysiaBlockForAttrs = parseMarkerIdx === -1 ? src.slice(elysiaStart, elysiaStart + 2000) : src.slice(elysiaStart, parseMarkerIdx); // parse()本体より前の属性群のみでよい
  const techBreakdownMatch = elysiaBlockForAttrs.match(/techBreakdown:\s*(true|false)/);
  if (!techBreakdownMatch) throw new Error('HOMECARE_CSV_PROFILES.elysia.techBreakdown が見つかりません');
  const techBreakdown = techBreakdownMatch[1] === 'true';
  const techKindMatch = elysiaBlockForAttrs.match(/techKind:\s*'([^']*)'/);
  const techKind = techKindMatch ? techKindMatch[1] : null;
  const techLabelMatch = elysiaBlockForAttrs.match(/techLabel:\s*'([^']*)'/);
  const techLabel = techLabelMatch ? techLabelMatch[1] : null;

  const { full: parseFull } = extractBraceBlock(src, 'parse(lines) {', elysiaStart);
  const parseBody = parseFull.slice(1, -1);
  if (!parseBody.includes('perPatient') || !parseBody.includes('computeHomecareTotalsFromRows')) {
    throw new Error('抽出したparse本体がelysia用と一致しません（index.html構造変更の疑い。pharmyのparse(lines)を誤検出していないか確認）');
  }

  const combinedSrc = techConstSrc + '\n' + headerConstSrc + '\n' + computeFull + '\n' +
    'function parseElysia(lines) ' + parseFull + '\n' +
    'this.parseElysia = parseElysia;\n' +
    'this.HOMECARE_ROWS_HEADER_PHARMY = HOMECARE_ROWS_HEADER_PHARMY;\n';

  const sandbox = {};
  const vmFn = new Function(combinedSrc);
  vmFn.call(sandbox);
  return {
    parseElysia: sandbox.parseElysia, HOMECARE_ROWS_HEADER_PHARMY: sandbox.HOMECARE_ROWS_HEADER_PHARMY,
    confirmed, techBreakdown, techKind, techLabel,
  };
}

// 2026-10-13: saveHomecareData()内のtechBreakdown/techLabel/techKind算出式を再現したもの（Firestore接続なしで検証するため）。
// 式自体はindex.htmlのsaveHomecareData内の _techBreakdownForSave/_techKindForSave/_techLabelForSave と同一にすること。
function computeSavedDocFields(profileObj) {
  return {
    techBreakdown: !(profileObj && profileObj.techBreakdown === false),
    techKind: (profileObj && profileObj.techKind) || null,
    techLabel: (profileObj && profileObj.techLabel) || null,
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

// ===== 合成CSV構築（施設名・患者情報・金額は架空。実CSVと同じ13列構造のみ再現） =====
// 列: 0患者番号,1カナ氏名,2漢字氏名,3生年月日,4性別,5管理フラグ,6管理名,7サービス内容,8単位,9請求額,10入金額,11要介護度区分,12サービス提供日
function row({ id, kana, kanji, birth = '1950/01/01', gender = '女', flag, facility, service = '薬剤師居宅療養Ⅱ１', units, billed, paid, careLevel = '要介護２', date }) {
  const b = billed == null ? units : billed;
  const p = paid == null ? units : paid;
  return [id, kana, kanji, birth, gender, flag, facility, service, units, b, p, careLevel, date]
    .map(v => '"' + String(v) + '"').join(',');
}

const IDENTIFIER_KANJI = '個人情報太郎';
const IDENTIFIER_KANA = 'コジンジョウホウタロウ';
const IDENTIFIER_BIRTH = '1940/03/03';
const IDENTIFIER_ID = '999001';

// 施設A（架空）: 患者1が月2回訪問（同一患者・複数行→1行へ事前集約されるはず）、患者2が月1回
const A1_V1 = row({ id: IDENTIFIER_ID, kana: IDENTIFIER_KANA, kanji: IDENTIFIER_KANJI, birth: IDENTIFIER_BIRTH, flag: '2', facility: '施設A', units: 400, date: '2026/09/02' });
const A1_V2 = row({ id: IDENTIFIER_ID, kana: IDENTIFIER_KANA, kanji: IDENTIFIER_KANJI, birth: IDENTIFIER_BIRTH, flag: '2', facility: '施設A', service: '薬剤師居宅療養Ⅱ２', units: 400, billed: 0, paid: 0, date: '2026/09/16' }); // 請求額/入金額が単位と不一致な行（実データの53%相当パターン）
const A2_V1 = row({ id: '999002', kana: 'テストジロウ', kanji: 'テスト次郎', flag: '2', facility: '施設A', units: 300, date: '2026/09/10' });

// 施設B（架空）: 患者3が月1回
const B1_V1 = row({ id: '999003', kana: 'テストハナコ', kanji: 'テスト花子', flag: '9', facility: '施設B', units: 342, date: '2026/09/05' });

// 管理フラグ・管理名が空欄の行（実データで5行確認済みの「在宅」未設定ケース）→（未分類）バケットへ
const BLANK_V1 = row({ id: '999004', kana: 'テストサブロウ', kanji: 'テスト三郎', flag: '', facility: '', units: 342, date: '2026/09/20' });

const lines = ['ヘッダー行（ダミー）', A1_V1, A1_V2, A2_V1, B1_V1, BLANK_V1];

// ===== 実行 =====
const { parseElysia, HOMECARE_ROWS_HEADER_PHARMY, confirmed, techBreakdown, techKind, techLabel } = extractElysiaProfile();

assertOk(confirmed === true, 'HOMECARE_CSV_PROFILES.elysia.confirmed === true（未対応エラーが出ない設定になっている）');

// ---- techBreakdown/techKind/techLabel（2026-10-13・医療保険の技術料内訳が無いことの明示フラグ） ----
assertEq(techBreakdown, false, 'HOMECARE_CSV_PROFILES.elysia.techBreakdown === false（介護保険の単位のみで医療保険の技術料内訳が無い）');
assertEq(techKind, 'kaigo_kyotaku', 'HOMECARE_CSV_PROFILES.elysia.techKind === "kaigo_kyotaku"');
assertEq(techLabel, '介護保険 居宅療養管理指導（単位）', 'HOMECARE_CSV_PROFILES.elysia.techLabel が想定文言');

// ---- 保存doc（homecareData）に techBreakdown=false 等が含まれること（saveHomecareDataの算出式を再現して検証） ----
{
  const elysiaProfileStub = { techBreakdown, techKind, techLabel };
  const saved = computeSavedDocFields(elysiaProfileStub);
  assertEq(saved.techBreakdown, false, '保存doc: elysiaはtechBreakdown=falseが保存される');
  assertEq(saved.techKind, 'kaigo_kyotaku', '保存doc: elysiaはtechKind="kaigo_kyotaku"が保存される');
  assertEq(saved.techLabel, '介護保険 居宅療養管理指導（単位）', '保存doc: elysiaはtechLabelが保存される');
}
{
  // pharmy等（techBreakdown未指定）は保存docでもtrue扱い（既存の挙動を変えない・回帰ガード）
  const pharmyProfileStub = {}; // techBreakdown/techKind/techLabelを一切持たない
  const saved = computeSavedDocFields(pharmyProfileStub);
  assertEq(saved.techBreakdown, true, '保存doc: pharmy等(未指定)はtechBreakdown=true扱いで保存される（既存挙動不変）');
  assertEq(saved.techKind, null, '保存doc: pharmy等(未指定)はtechKind=null');
  assertEq(saved.techLabel, null, '保存doc: pharmy等(未指定)はtechLabel=null');
}

// ---- 整合チェック（_hcJudge/INC-401）が対象外になること（index.html側の呼び出し分岐と同型のロジックを検証） ----
{
  // index.html renderHomecareView の「const j = techBreakdown ? _hcJudge(...) : {status:'excluded',...}」と同じ分岐。
  // _hcJudgeはブラウザ埋め込みscript内のためここではimportできず、分岐ロジック自体（homecare_reconcile.mjsの
  // judgeReconcileWithBreakdownと同型）を再現して検証する（node側は test_homecare_reconcile.mjs で直接テスト済み）。
  const simulateHcJudgeCallSite = (breakdownFlag) => breakdownFlag
    ? { status: 'would_call_hcJudge' }
    : { status: 'excluded', label: '対象外（技術料内訳なし・' + (techLabel || '介護保険') + '）' };
  const j = simulateHcJudgeCallSite(techBreakdown);
  assertEq(j.status, 'excluded', '整合チェック: elysia(techBreakdown=false)は_hcJudgeを呼ばず対象外になる');
  assertOk(j.label.includes('対象外') && j.label.includes('居宅療養管理指導'), '整合チェック: 対象外ラベルにtechLabelが含まれる');
}

const result = parseElysia(lines);
if (!result) { console.log('FAIL - parseElysia() が null を返しました'); process.exit(1); }
const { sorted, totals, header, rows } = result;

// ---- header/識別子除去（pharmyと同じ方針を踏襲） ----
assertEq(header, HOMECARE_ROWS_HEADER_PHARMY, 'headerはHOMECARE_ROWS_HEADER_PHARMYを再利用（profile間で集計関数を共有できる）');
const rowsJson = JSON.stringify(rows);
assertOk(!rowsJson.includes(IDENTIFIER_KANJI), '患者氏名(漢字)がrowsに含まれない');
assertOk(!rowsJson.includes(IDENTIFIER_KANA), '患者カナがrowsに含まれない');
assertOk(!rowsJson.includes(IDENTIFIER_BIRTH), '生年月日がrowsに含まれない');
assertOk(!rowsJson.includes(IDENTIFIER_ID), '患者番号がrowsに含まれない');

// ---- 施設数・事前集約（同一患者の複数行→1行） ----
assertEq(sorted.length, 3, '施設数=3（施設A・施設B・（未分類）)');
const byName = {}; sorted.forEach(([name, g]) => { byName[name] = g; });

// 施設A: 患者1(2回訪問・単位400+400)+患者2(1回・単位300) → patients=2(来院回数ではない), times=3, guidance=1100
assertOk(!!byName['施設A'], '施設Aが集計結果に存在する');
assertEq(byName['施設A'].patients, 2, '施設A patients=2（同一患者の複数行が1人に事前集約されている・来院回数ではない）');
assertEq(byName['施設A'].times, 3, '施設A times=3（回数=行数の合計=2回+1回）');
assertEq(byName['施設A'].guidance, 1100, '施設A guidance=1100（単位列の合計：400+400+300）');
assertEq(byName['施設A'].tech, 1100, '施設A tech=guidanceと同値（base/timeAdd/dispensing/dispAddが0のため・INC-399式は不変）');
assertEq(byName['施設A'].drugFee, 0, '施設A drugFee=0固定（内服薬/内服外/材料点に相当する列がCSVに無いため）');
assertEq(byName['施設A'].insTotal, 0, '施設A insTotal=0固定（保険計に相当する列がCSVに無く推測代入していないため）');

// 施設B: 患者3(1回・単位342)
assertEq(byName['施設B'].patients, 1, '施設B patients=1');
assertEq(byName['施設B'].times, 1, '施設B times=1');
assertEq(byName['施設B'].guidance, 342, '施設B guidance=342');

// （未分類）: 管理フラグ・管理名が空欄の行
assertOk(!!byName['（未分類）'], '管理名が空欄の行は（未分類）バケットに入る（pharmyの空欄施設名処理と同方針）');
assertEq(byName['（未分類）'].patients, 1, '（未分類）patients=1');
assertEq(byName['（未分類）'].guidance, 342, '（未分類）guidance=342');

// ---- billedAmount/paidAmountは素通し保存のみ（集計REQUIREDには使わない・値が単位と不一致でも集計に影響しない） ----
const idx = {}; header.forEach((h, i) => { idx[h] = i; });
const aRows = rows.filter(r => r[idx.facility] === '施設A');
assertEq(aRows.length, 2, '施設Aの事前集約後の行数=2（患者1・患者2それぞれ1行）');
const patient1Row = aRows.find(r => r[idx.visits] === 2);
assertOk(!!patient1Row, '患者1（2回訪問）の行がvisits=2として存在する');
assertEq(patient1Row[idx.billedAmount], 400, '患者1のbilledAmount=400（1回目400+2回目0の合計・単位合計800とは一致しない=素通し保存の実データ傾向を再現）');
assertEq(patient1Row[idx.paidAmount], 400, '患者1のpaidAmount=400（同上）');

// ---- totals（全施設合算） ----
assertEq(totals.patients, 4, 'totals.patients=4（施設A2人+施設B1人+未分類1人）');
assertEq(totals.times, 5, 'totals.times=5（行数合計=CSVデータ行数と一致）');
assertEq(totals.guidance, 1100 + 342 + 342, 'totals.guidance=1784（各施設guidanceの合計）');
assertEq(totals.tech, totals.guidance, 'totals.tech=totals.guidance（base/timeAdd/dispensing/dispAddが常に0のため）');
assertEq(totals.drugFee, 0, 'totals.drugFee=0固定');
assertEq(totals.insTotal, 0, 'totals.insTotal=0固定（保険計相当列が無いことの明示的な回帰ガード）');

// ---- computeHomecareTotalsFromRowsへ独立に渡しても同じ結果になること（再計算CLI/ボタンとの整合性） ----
// ※ここではextractElysiaProfile内で既にcomputeHomecareTotalsFromRowsを同一スコープへ取り込んでいるため、
//   parseElysia側の内部呼び出しと同一ロジックであることはparse()のソース自体が保証する（pharmy用テストと同方針）。

console.log('---');
if (fail === 0) { console.log('ALL PASS (test_homecare_elysia.mjs) — ' + pass + ' assertions'); process.exit(0); }
else { console.log('FAILED: ' + fail + ' assertion(s) / PASS ' + pass); process.exit(1); }
