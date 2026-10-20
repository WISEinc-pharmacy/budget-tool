#!/usr/bin/env node
// test_homecare_overwrite_guard.mjs
// INC-602（2026-10-20）: 在宅内訳 上書きガード(_homecareOverwriteGuard)の単体テスト。
//
// 背景: saveHomecareData の homecareData/{docId} 保存は set で行われるが、Firestoreルール
// （firestore.rules match /homecareData/{docId}）では update を「admin/editorロール」または
// 「その文書のuploadedByと自分のuidが一致（本人）」のみに許可している
// （isEditor()=role() in ['admin','editor']、isHomecareOwner()=resource.data.uploadedBy==request.auth.uid）。
// 本部がAdmin SDKで取り込んだ月（uploadedByがhq_import_...等のuid以外の文字列）や、別の担当者が
// 登録した月を、権限のないアカウントが上書きしようとすると、先に行データ（homecareRows・認証済みなら
// 誰でも書ける）だけが保存され、その後の集計保存でだけ「Missing or insufficient permissions」の
// 生エラーが出て店舗が原因不明のまま止まった（10/20 11:33）。
// 本テストは、ルールと同じ判定をクライアント側で行う純関数 _homecareOverwriteGuard が
// ルール（firestore.rules L162-167・isEditor()・isHomecareOwner()）と同じ結論を返すことを確認する。
//
// 抽出方式: test_homecare_zero_tech_guard.mjs / test_sales_period_guard.mjs と同じマーカーブロック
// (===HOMECARE_OVERWRITE_GUARD_START/END===)のソース直接抽出（index.htmlを書き換えずに実行）。
//
// フィクスチャの値はすべて架空（公開リポジトリ対策。実在の経営数値・患者情報・実在のuidは書かない）。
// 実行: node test_homecare_overwrite_guard.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');
const src = readFileSync(INDEX_HTML_PATH, 'utf8');

function extractOverwriteGuardFn() {
  const START = '// ===HOMECARE_OVERWRITE_GUARD_START===';
  const END = '// ===HOMECARE_OVERWRITE_GUARD_END===';
  const si = src.indexOf(START);
  const ei = src.indexOf(END);
  if (si === -1 || ei === -1) throw new Error('HOMECARE_OVERWRITE_GUARDマーカーが見つかりません（index.html構造変更の疑い）');
  const block = src.slice(si + START.length, ei);

  if (!block.includes('function _homecareOverwriteGuard')) {
    throw new Error('抽出したブロックに_homecareOverwriteGuardが見つかりません（index.html構造変更の疑い）');
  }

  // 呼出側（saveHomecareData）が実際にこのガードを呼んでいること、かつsaveHomecareRowsより前に
  // 置かれていることも併せて検査する（抽出単体テストだけでは呼出し漏れ・位置ズレを検知できないため）。
  const callIdx = src.indexOf('_homecareOverwriteGuard({');
  const rowsCallIdx = src.indexOf('await saveHomecareRows(rowsTargetDocId');
  if (callIdx === -1) throw new Error('saveHomecareData側で_homecareOverwriteGuardが呼ばれていません');
  if (rowsCallIdx === -1) throw new Error('saveHomecareRowsの呼出箇所が見つかりません（index.html構造変更の疑い）');
  if (!(callIdx < rowsCallIdx)) throw new Error('_homecareOverwriteGuardの呼出がsaveHomecareRowsより後ろにあります（書込み前に止める設計が崩れている）');

  // eslint-disable-next-line no-new-func
  const factory = new Function(block + '\nreturn { _homecareOverwriteGuard };');
  return factory();
}

const { _homecareOverwriteGuard } = extractOverwriteGuardFn();

// ===== 検証ユーティリティ（test_homecare_zero_tech_guard.mjs と同方式） =====
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

const MY_UID = 'uidAAA111（架空）';
const OTHER_UID = 'uidBBB222（架空）';
const HQ_IMPORT_UPLOADER = 'hq_import_20261001（架空・本部取込の識別文字列）';
const BLOCK_REASON = 'この月の在宅内訳は別の担当（または本部）が登録済みのため、この権限では上書きできません。入れ直す場合は管理部へ削除を依頼してください。';

console.log('=== 新規の月（既存文書なし） ===');

// (1) existingUploadedBy=null（新規） + role=viewer + 別uid → ok（新規は誰でも作成できる）
{
  const r = _homecareOverwriteGuard({ existingUploadedBy: null, currentUid: OTHER_UID, role: 'viewer' });
  assertEq(r.ok, true, '(1) 新規(null) + viewer → ok:true');
  assertEq(r.reason, null, '(1) reason:null');
}

// (1b) existingUploadedBy=undefined（新規・フィールド欠落） + role未取得 → ok
{
  const r = _homecareOverwriteGuard({ existingUploadedBy: undefined, currentUid: OTHER_UID, role: undefined });
  assertEq(r.ok, true, '(1b) 新規(undefined) + role未取得 → ok:true（nullと同義に扱う）');
}

console.log('=== 自分が登録した月（本人） ===');

// (2) existingUploadedBy=自分のuid + role=viewer（店舗アカウント相当）→ ok
{
  const r = _homecareOverwriteGuard({ existingUploadedBy: MY_UID, currentUid: MY_UID, role: 'viewer' });
  assertEq(r.ok, true, '(2) 自分の月 + viewer → ok:true（firestore.rules isHomecareOwner()と同条件）');
  assertEq(r.reason, null, '(2) reason:null');
}

console.log('=== editorロール（admin/editorは誰の月でも上書き可） ===');

// (3) existingUploadedBy=他人 + role=editor → ok
{
  const r = _homecareOverwriteGuard({ existingUploadedBy: OTHER_UID, currentUid: MY_UID, role: 'editor' });
  assertEq(r.ok, true, '(3) 別uidの月 + role:editor → ok:true（firestore.rules isEditor()と同条件）');
}

// (3b) existingUploadedBy=hq_import文字列 + role=admin → ok
{
  const r = _homecareOverwriteGuard({ existingUploadedBy: HQ_IMPORT_UPLOADER, currentUid: MY_UID, role: 'admin' });
  assertEq(r.ok, true, '(3b) 本部取込の月 + role:admin → ok:true');
}

console.log('=== 別uid（権限なし・本人でも admin/editor でもない） ===');

// (4) existingUploadedBy=他人 + role=viewer + 別uid → block
{
  const r = _homecareOverwriteGuard({ existingUploadedBy: OTHER_UID, currentUid: MY_UID, role: 'viewer' });
  assertEq(r.ok, false, '(4) 別uidの月 + viewer → ok:false');
  assertEq(r.reason, BLOCK_REASON, '(4) reasonは案内文と一致');
}

console.log('=== hq_import文字列（本部Admin SDK取込。uid形式ではない） ===');

// (5) existingUploadedBy=hq_import文字列 + role=viewer + 一般uid → block
{
  const r = _homecareOverwriteGuard({ existingUploadedBy: HQ_IMPORT_UPLOADER, currentUid: MY_UID, role: 'viewer' });
  assertEq(r.ok, false, '(5) 本部取込の月 + viewer → ok:false（店舗アカウントは上書きできない）');
  assertEq(r.reason, BLOCK_REASON, '(5) reasonは案内文と一致');
}

console.log('=== roleが未取得（読込中・取得失敗等）のフェイルセーフ ===');

// (6) role未取得(undefined) + 別uid → block（editor相当と誤認しない）
{
  const r = _homecareOverwriteGuard({ existingUploadedBy: OTHER_UID, currentUid: MY_UID, role: undefined });
  assertEq(r.ok, false, '(6) role未取得 + 別uid → ok:false（フェイルセーフでブロック側に倒す）');
}

// (6b) role=null + 別uid → block（undefinedと同様に扱う）
{
  const r = _homecareOverwriteGuard({ existingUploadedBy: OTHER_UID, currentUid: MY_UID, role: null });
  assertEq(r.ok, false, '(6b) role:null + 別uid → ok:false');
}

// (7) role未取得(undefined) + 本人のuidと一致 → ok（本人判定はroleに依存しない）
{
  const r = _homecareOverwriteGuard({ existingUploadedBy: MY_UID, currentUid: MY_UID, role: undefined });
  assertEq(r.ok, true, '(7) role未取得 + 本人の月 → ok:true（isHomecareOwner()相当は役割に依存しない）');
}

console.log('=== 空文字uid（未認証・異常値のフェイルセーフ） ===');

// (8) currentUid='' + existingUploadedBy=他人 + role=viewer → block（通常の別uidケースと同じ）
{
  const r = _homecareOverwriteGuard({ existingUploadedBy: OTHER_UID, currentUid: '', role: 'viewer' });
  assertEq(r.ok, false, "(8) currentUid:'' + 別uid → ok:false");
}

// (8b) currentUid='' + existingUploadedBy=''（データ異常で両方空文字）→ block
// 空文字どうしの一致で「本人」と誤判定しない（currentUidが空文字のときは本人判定を無効化する設計）。
{
  const r = _homecareOverwriteGuard({ existingUploadedBy: '', currentUid: '', role: 'viewer' });
  assertEq(r.ok, false, "(8b) currentUid:'' + existingUploadedBy:'' → ok:false（空文字同士を本人一致とみなさない）");
}

// (8c) currentUid='' でも role=editor なら ok（editor判定はuidより先に通る）
{
  const r = _homecareOverwriteGuard({ existingUploadedBy: OTHER_UID, currentUid: '', role: 'editor' });
  assertEq(r.ok, true, "(8c) currentUid:'' + role:editor → ok:true（editor判定が優先）");
}

console.log('---');
if (fail === 0) { console.log('ALL PASS (test_homecare_overwrite_guard.mjs) — ' + pass + ' assertions'); process.exit(0); }
else { console.log('FAILED: ' + fail + ' assertion(s) / PASS ' + pass); process.exit(1); }
