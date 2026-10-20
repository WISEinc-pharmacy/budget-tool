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

// ===== INC-595: saveHomecareRows/loadHomecareRowsAll の Firestore nested-array制約テスト =====
// モックFirestore: 配列の直下に配列があるset()をFirestore実機と同じく例外にする（この検証が無いと
// 「配列の配列を書けること」を前提にした偽成功テストになる＝INC-595の穴そのもの）。
function assertNoNestedArray(value, p) {
  if (Array.isArray(value)) {
    for (const v of value) {
      if (Array.isArray(v)) throw new Error('INVALID_ARGUMENT: Nested arrays are not supported (at ' + p + ')');
      assertNoNestedArray(v, p);
    }
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) assertNoNestedArray(value[k], p + '.' + k);
  }
}
function createMockDb() {
  const data = new Map();
  function docRef(path) {
    return {
      get: async () => ({ exists: data.has(path), data: () => data.get(path) }),
      set: async (v) => { assertNoNestedArray(v, path); data.set(path, JSON.parse(JSON.stringify(v))); },
      collection: (sub) => collRef(path + '/' + sub),
    };
  }
  function collRef(path) {
    return {
      doc: (id) => docRef(path + '/' + id),
      get: async () => {
        const prefix = path + '/';
        const docs = [];
        for (const p of data.keys()) {
          if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) {
            docs.push({ id: p.slice(prefix.length), data: () => data.get(p), ref: docRef(p) });
          }
        }
        return { docs };
      },
    };
  }
  return { collection: (name) => collRef(name), _raw: data };
}

// _homecareRowToArray + saveHomecareRows + loadHomecareRowsAll を抽出（index.htmlを書き換えずに実関数を直接実行）
const rowsFormatSrc = extractBetweenMarkers(src, '// ===HOMECARE_ROWS_FORMAT_START===', '// ===HOMECARE_ROWS_FORMAT_END===');
const { full: saveFull } = extractBraceBlock(src, 'async function saveHomecareRows(docId, { store, yearMonth, profile, header, rows, sourceFileName }) {');
const saveBody = saveFull.slice(1, -1);
const { full: loadFull } = extractBraceBlock(src, 'async function loadHomecareRowsAll(docId) {');
const loadBody = loadFull.slice(1, -1);
if (!saveBody.includes('wrappedRows') || !saveBody.includes("rowFormat: 'v'")) {
  throw new Error('抽出したsaveHomecareRows本体がINC-595修正後の形(各行を{v:[...]}でラップ)と一致しません（index.html構造変更の疑い）');
}

const combinedSrc2 = rowsFormatSrc + '\n' +
  'const HOMECARE_ROWS_CHUNK_SIZE = ' + HOMECARE_ROWS_CHUNK_SIZE + ';\n' +
  'async function saveHomecareRows(docId, { store, yearMonth, profile, header, rows, sourceFileName }) {' + saveBody + '}\n' +
  'async function loadHomecareRowsAll(docId) {' + loadBody + '}\n' +
  'this.saveHomecareRows = saveHomecareRows;\n' +
  'this.loadHomecareRowsAll = loadHomecareRowsAll;\n';

function makeSandbox2(mockDb) {
  const sandbox2 = {
    db: mockDb,
    firebase: { firestore: { FieldValue: { serverTimestamp: () => '__SERVER_TIMESTAMP__' } } },
    auth: { currentUser: null },
  };
  vm.createContext(sandbox2);
  vm.runInContext(combinedSrc2, sandbox2);
  return sandbox2;
}

// ---- ① 保存→読み戻しで行数・列数・内容が完全一致（非chunk・chunk両方） ----
{
  const mockDb = createMockDb();
  const sandbox2 = makeSandbox2(mockDb);
  const smallRows = rows.slice(); // pharmy.parse()が返した3行（識別子なし）
  await sandbox2.saveHomecareRows('test_roundtrip_small', { store: 'kashiwa', yearMonth: '2026-08', profile: 'pharmy', header, rows: smallRows, sourceFileName: 'x.csv' });
  const loadedSmall = await sandbox2.loadHomecareRowsAll('test_roundtrip_small');
  assertEq(loadedSmall.rows.length, smallRows.length, '①非chunk: 読み戻し行数が一致');
  assertEq(loadedSmall.header.length, header.length, '①非chunk: 読み戻し列数(header)が一致');
  assertEq(loadedSmall.rows, smallRows, '①非chunk: 読み戻し内容が元の行配列と完全一致');

  const bigRows = [];
  for (let i = 0; i < 1234; i++) bigRows.push(rows[i % rows.length].slice());
  await sandbox2.saveHomecareRows('test_roundtrip_big', { store: 'kashiwa', yearMonth: '2026-09', profile: 'pharmy', header, rows: bigRows, sourceFileName: 'y.csv' });
  const loadedBig = await sandbox2.loadHomecareRowsAll('test_roundtrip_big');
  assertEq(loadedBig.rows.length, bigRows.length, '①chunk(1234行): 読み戻し行数が一致');
  assertEq(loadedBig.rows, bigRows, '①chunk(1234行): 読み戻し内容が元の行配列と完全一致（chunk連結後も順序保持）');
}

// ---- ② 回帰テスト: 「配列の配列」を拒否するモックに対して、修正前の実装は失敗し修正後は成功する ----
{
  const mockDb = createMockDb();
  // 修正前の実装を再現（objRows変換なしでrowsをそのままset()）
  const oldSaveSrc = 'async function saveHomecareRowsOld(docId, { store, yearMonth, profile, header, rows, sourceFileName }) {' +
    'const rowCount = rows.length; const uploadedAt = firebase.firestore.FieldValue.serverTimestamp(); ' +
    "const uploadedBy = auth.currentUser ? auth.currentUser.uid : 'unknown'; " +
    'const base = { store, yearMonth, profile: profile || null, header, rowCount, uploadedAt, uploadedBy }; ' +
    'if (sourceFileName) base.sourceFileName = sourceFileName; ' +
    "const rowsRef = db.collection('homecareRows').doc(docId); " +
    'if (rowCount <= HOMECARE_ROWS_CHUNK_SIZE) { await rowsRef.set({ ...base, rows, chunked: false, chunkCount: 0 }); } ' +
    'else { const chunkCount = Math.ceil(rowCount / HOMECARE_ROWS_CHUNK_SIZE); ' +
    'await rowsRef.set({ ...base, chunked: true, chunkCount, rows: [] }); const writes = []; ' +
    'for (let n = 0; n < chunkCount; n++) { const chunkRows = rows.slice(n * HOMECARE_ROWS_CHUNK_SIZE, (n + 1) * HOMECARE_ROWS_CHUNK_SIZE); ' +
    "writes.push(rowsRef.collection('chunks').doc(String(n)).set({ chunkIndex: n, rows: chunkRows })); } " +
    'await Promise.all(writes); } }\n' +
    'this.saveHomecareRowsOld = saveHomecareRowsOld;\n';
  const sandboxOld = { db: mockDb, firebase: { firestore: { FieldValue: { serverTimestamp: () => 't' } } }, auth: { currentUser: null } };
  vm.createContext(sandboxOld);
  vm.runInContext('const HOMECARE_ROWS_CHUNK_SIZE = ' + HOMECARE_ROWS_CHUNK_SIZE + ';\n' + oldSaveSrc, sandboxOld);
  let oldThrew = false;
  try { await sandboxOld.saveHomecareRowsOld('test_old_bug', { store: 'kashiwa', yearMonth: '2026-08', profile: 'pharmy', header, rows: rows.slice(), sourceFileName: null }); }
  catch (e) { oldThrew = /[Nn]ested array/.test(e.message); }
  assertOk(oldThrew, '②回帰: 修正前の実装(配列の配列を直接set)はモックのnested array制約で例外になる（INC-595の再現）');

  const sandbox2 = makeSandbox2(mockDb);
  let newThrew = null;
  try { await sandbox2.saveHomecareRows('test_new_fixed', { store: 'kashiwa', yearMonth: '2026-08', profile: 'pharmy', header, rows: rows.slice(), sourceFileName: null }); }
  catch (e) { newThrew = e; }
  assertOk(newThrew === null, '②回帰: 修正後のsaveHomecareRows(オブジェクト化)は同じモックで例外にならない');
  const reloaded = await sandbox2.loadHomecareRowsAll('test_new_fixed');
  assertEq(reloaded.rows, rows, '②回帰: 修正後に保存した内容が元のrowsと完全一致（{v:[...]}形式→配列正規化）');
}

// ---- ④ 重複ヘッダー・空ヘッダー・スラッシュ入りヘッダーでも列が潰れず往復一致する（親ゲート指摘2026-10-20） ----
// {v:[...]}形式はheader名をキーにしないため、Object.fromEntries方式で起きるフィールド名制約・重複キー崩壊
// （INC-403「全列保持」違反）が構造的に発生しない。ここではheaderに重複・空文字・スラッシュを混在させて確認する。
{
  const mockDb = createMockDb();
  const sandbox2 = makeSandbox2(mockDb);
  const weirdHeader = ['facility', 'a', 'a', '', 'b/c', 'd~e*f'];
  const weirdRows = [
    ['施設A', 1, 2, 3, 4, 5],
    ['施設B', 10, 20, 30, 40, 50],
  ];
  await sandbox2.saveHomecareRows('test_weird_header', { store: 'kashiwa', yearMonth: '2026-08', profile: 'pharmy', header: weirdHeader, rows: weirdRows, sourceFileName: null });
  const loadedWeird = await sandbox2.loadHomecareRowsAll('test_weird_header');
  assertEq(loadedWeird.header, weirdHeader, '④headerに重複/空文字/スラッシュがあっても親docのheaderはそのまま保持');
  assertEq(loadedWeird.rows, weirdRows, '④重複ヘッダー("a","a")・空ヘッダー・スラッシュ入りヘッダーでも列の値が1つも潰れず往復一致');
  assertEq(loadedWeird.rows[0].length, weirdHeader.length, '④1行目の列数がheader列数(6列)と一致（列欠落なし）');
  assertEq(loadedWeird.rows[1].length, weirdHeader.length, '④2行目の列数がheader列数(6列)と一致（列欠落なし）');
}

// ---- ⑤ homecare_recompute.mjs: 共有正規化関数(extractHomecareRowToArray)の最小テスト（親ゲート指摘2026-10-20） ----
// index.htmlの===HOMECARE_ROWS_FORMAT_START/END===ブロックをhomecare_recompute.mjsが実際に抽出して使っている
// ことを検証する（ロジックの複製ではなく共有であることの確認）。Firestoreアクセスを伴うloadRowsDoc本体は
// firebase SDKの実体が必要なため、本テストでは正規化関数(_homecareRowToArray)の3形式対応のみを検証する。
{
  const { extractHomecareRowToArray } = await import('./homecare_recompute.mjs');
  const rowToArray = extractHomecareRowToArray();
  const hdr = ['facility', 'visits', 'insuranceTotal'];
  assertEq(rowToArray(['施設A', 3, 100], hdr), ['施設A', 3, 100], '⑤homecare_recompute.mjs: ①旧・配列形式はそのまま返す');
  assertEq(rowToArray({ v: ['施設A', 3, 100] }, hdr), ['施設A', 3, 100], '⑤homecare_recompute.mjs: ③新・{v:[...]}形式を配列へ変換');
  assertEq(rowToArray({ facility: '施設A', visits: 3, insuranceTotal: 100 }, hdr), ['施設A', 3, 100], '⑤homecare_recompute.mjs: ②本部手動修復時のヘッダーキー付きオブジェクトをheader順の配列へ変換');
}

// ---- ⑥ _homecareRecomputeGuard: 片側データしか無いときの再集計ガード（INC-595b・2026-10-20） ----
// homecareData(既存集計)のtechKindと、保存済み行(homecareRows)の医療/介護の有無を突き合わせ、片側だけの
// データで合算済み・反対側だけの集計を上書きしないことを検証する。index.html側の実関数をvmで直接実行し、
// homecare_recompute.mjs(CLI)側のextractHomecareRecomputeGuardが同じ関数を共有していることも確認する。
{
  const guardBlockSrc = extractBetweenMarkers(src, '// ===HOMECARE_RECOMPUTE_GUARD_START===', '// ===HOMECARE_RECOMPUTE_GUARD_END===');
  const sandboxGuard = {};
  vm.createContext(sandboxGuard);
  vm.runInContext(guardBlockSrc + '\nthis._homecareRecomputeGuard = _homecareRecomputeGuard;\n', sandboxGuard);
  const guard = sandboxGuard._homecareRecomputeGuard;

  assertEq(guard({ existingDoc: { techKind: 'iryo_kaigo' }, hasIryoRows: false, hasKaigoRows: true }).ok, false,
    '⑥ガード: iryo_kaigo既存＋介護のみ→中止(false)');
  assertEq(guard({ existingDoc: { techKind: 'iryo_kaigo' }, hasIryoRows: true, hasKaigoRows: true }).ok, true,
    '⑥ガード: iryo_kaigo既存＋両方あり→許可(true)');
  assertEq(guard({ existingDoc: { techKind: 'iryo_kaigo' }, hasIryoRows: false, hasKaigoRows: false }).ok, false,
    '⑥ガード: 両方無し→中止(false)（existingDocの有無に関わらず）');
  assertEq(guard({ existingDoc: { techKind: 'kaigo' }, hasIryoRows: false, hasKaigoRows: true }).ok, true,
    '⑥ガード: kaigo既存＋介護のみ→許可(true)（同じ側のデータなので上書き可）');
  assertEq(guard({ existingDoc: { techKind: 'iryo' }, hasIryoRows: false, hasKaigoRows: true }).ok, false,
    '⑥ガード: iryo既存＋介護のみ→中止(false)（医療分を介護だけで上書きしない）');
  assertEq(guard({ existingDoc: null, hasIryoRows: false, hasKaigoRows: true }).ok, true,
    '⑥ガード: existingDoc無し(初回保存)→許可(true)');
  assertEq(guard({ existingDoc: undefined, hasIryoRows: true, hasKaigoRows: false }).ok, true,
    '⑥ガード: existingDoc無し(初回保存・医療のみ)→許可(true)');
  assertOk(guard({ existingDoc: { techKind: 'iryo_kaigo' }, hasIryoRows: false, hasKaigoRows: true }).reason.length > 0,
    '⑥ガード: ok:falseのときreasonが空文字でない');

  // homecare_recompute.mjs(CLI)側が同じ関数を共有していることを確認（ロジックの複製ではない）
  const { extractHomecareRecomputeGuard } = await import('./homecare_recompute.mjs');
  const guardFromCli = extractHomecareRecomputeGuard();
  assertEq(guardFromCli({ existingDoc: { techKind: 'iryo_kaigo' }, hasIryoRows: false, hasKaigoRows: true }),
    guard({ existingDoc: { techKind: 'iryo_kaigo' }, hasIryoRows: false, hasKaigoRows: true }),
    '⑥homecare_recompute.mjs: extractHomecareRecomputeGuardがindex.html側と同じ判定結果を返す（iryo_kaigo＋介護のみ）');
  assertEq(guardFromCli({ existingDoc: { techKind: 'kaigo' }, hasIryoRows: false, hasKaigoRows: true }),
    guard({ existingDoc: { techKind: 'kaigo' }, hasIryoRows: false, hasKaigoRows: true }),
    '⑥homecare_recompute.mjs: extractHomecareRecomputeGuardがindex.html側と同じ判定結果を返す（kaigo＋介護のみ）');
}

// ---- ③ 保存失敗時に例外が呼び出し元へ伝播すること（saveHomecareData側のabort-before-write前提の検証） ----
{
  const mockDb = createMockDb();
  const sandbox2 = makeSandbox2(mockDb);
  // chunk書込みの一部を強制失敗させるdbラッパー（chunks.doc('1').setだけ失敗＝Promise.all内の部分失敗を模擬）
  const origCollection = mockDb.collection.bind(mockDb);
  const failingDb = {
    collection: (name) => {
      const c = origCollection(name);
      return {
        ...c,
        doc: (id) => {
          const d = c.doc(id);
          return {
            ...d,
            collection: (sub) => {
              const cc = d.collection(sub);
              return {
                ...cc,
                doc: (cid) => {
                  const cd = cc.doc(cid);
                  if (cid === '1') return { ...cd, set: async () => { throw new Error('INC-595-TEST: simulated chunk write failure'); } };
                  return cd;
                },
              };
            },
          };
        },
      };
    },
  };
  const sandboxFail = makeSandbox2(failingDb);
  let propagated = false;
  const bigRows = [];
  for (let i = 0; i < 1234; i++) bigRows.push(rows[i % rows.length].slice());
  try { await sandboxFail.saveHomecareRows('test_fail_propagate', { store: 'kashiwa', yearMonth: '2026-08', profile: 'pharmy', header, rows: bigRows, sourceFileName: null }); }
  catch (e) { propagated = /simulated chunk write failure/.test(e.message); }
  assertOk(propagated, '③saveHomecareRowsは内部書込み失敗時に例外を呼び出し元へ伝播する（catchして握り潰さない）');
  // index.html側のsaveHomecareData（この伝播をcatchしてstatus表示+returnし、homecareData.set()より前に中止する）は
  // ソース読解で確認済み（行番号は本テスト実行時のレポートに記載）。DOM依存のため本ハーネスでは直接駆動しない。
}

console.log('---');
if (fail === 0) { console.log('ALL PASS (test_homecare_rows.mjs) — ' + pass + ' assertions'); process.exit(0); }
else { console.log('FAILED: ' + fail + ' assertion(s) / PASS ' + pass); process.exit(1); }
