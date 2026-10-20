#!/usr/bin/env node
// test_homecare_zero_tech_guard.mjs
// INC-603（2026-10-20）: 在宅内訳 技術料ゼロガード(_homecareZeroTechGuard)の単体テスト。
//
// 背景: 改修B（2026-10-19）で医療(elysia_r)と介護(elysia_kaigo)を同じ月に取り込むと合算する経路
// （saveHomecareData側）を実装済みだったが、それより前に入っていた本ガードのisKaigoCsv分岐が
// (profileId==='elysia' || profileId==='elysia_kaigo') のままだったため、改修Bで新設された
// elysia_kaigo（施設集計CSV・confirmed:true）まで常時ブロックしてしまい、足立が介護CSVを画面から
// 一切取り込めなかった（10/20 11:41 店舗提出が赤警告「技術料（報酬点数）が入っていません」で停止）。
// 対処: isKaigoCsv（常時ブロック）はelysia（旧ID・居宅療養管理指導の訪問明細CSV・列構造未確認）のみに
// 絞り、elysia_kaigoは「取込行が0件」のときだけブロックするよう変更した（それ以外はblocked:falseで
// notice:'kaigo_csv_ok'を返し、改修Bの合算経路に乗せる）。
//
// 抽出方式: 同日のtest_sales_period_guard.mjs（INC-598）と同じマーカーブロック
// (===HOMECARE_ZERO_TECH_GUARD_START/END===)のソース直接抽出（index.htmlを書き換えずに実行）。
// マーカー外で定義されるHOMECARE_KAIGO_UNIT_YEN定数は test_homecare_elysia.mjs と同方式で別途regex抽出し、
// combinedSrcの先頭に差し込む（ブラウザではscript内のグローバルスコープで解決されるが、マーカー抽出単体では
// 未定義になるため）。
//
// フィクスチャの数値はすべて架空（公開リポジトリ対策。実在の経営数値・患者情報は書かない）。
// 実行: node test_homecare_zero_tech_guard.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');
const src = readFileSync(INDEX_HTML_PATH, 'utf8');

function extractZeroTechGuardFns() {
  const START = '// ===HOMECARE_ZERO_TECH_GUARD_START===';
  const END = '// ===HOMECARE_ZERO_TECH_GUARD_END===';
  const si = src.indexOf(START);
  const ei = src.indexOf(END);
  if (si === -1 || ei === -1) throw new Error('HOMECARE_ZERO_TECH_GUARDマーカーが見つかりません（index.html構造変更の疑い）');
  const block = src.slice(si + START.length, ei);

  const unitYenMatch = src.match(/const\s+HOMECARE_KAIGO_UNIT_YEN\s*=\s*(\d+)\s*;/);
  if (!unitYenMatch) throw new Error('HOMECARE_KAIGO_UNIT_YEN 定数が見つかりません');
  const unitYenSrc = 'const HOMECARE_KAIGO_UNIT_YEN = ' + unitYenMatch[1] + ';';

  if (!block.includes('function _homecareZeroTechGuard') || !block.includes('isKaigoCsv')) {
    throw new Error('抽出したブロックに_homecareZeroTechGuard/isKaigoCsvが見つかりません（index.html構造変更の疑い）');
  }

  // eslint-disable-next-line no-new-func
  const factory = new Function(unitYenSrc + '\n' + block +
    '\nreturn { _homecareZeroTechGuard, _homecareZeroTechMessage, _homecareZeroTechWarningHtml, ' +
    'HOMECARE_ZERO_TECH_MSG_KAIGO_CSV, HOMECARE_ZERO_TECH_MSG_GENERIC, HOMECARE_KAIGO_CSV_OK_NOTICE, HOMECARE_KAIGO_UNIT_YEN };');
  return factory();
}

const fns = extractZeroTechGuardFns();
const {
  _homecareZeroTechGuard, _homecareZeroTechMessage, _homecareZeroTechWarningHtml,
  HOMECARE_ZERO_TECH_MSG_KAIGO_CSV, HOMECARE_ZERO_TECH_MSG_GENERIC, HOMECARE_KAIGO_CSV_OK_NOTICE, HOMECARE_KAIGO_UNIT_YEN,
} = fns;

// ===== 検証ユーティリティ（test_homecare_elysia.mjs と同方式） =====
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

// ===== フィクスチャ（架空値のみ。_homecareZeroTechGuardが参照するキーだけ最小構成） =====
function makeResult({ profileId, rowCount = 3, facilityCount = 1, insTotal = 0, tech = 0 }) {
  return {
    totals: { insTotal, tech },
    sorted: Array.from({ length: facilityCount }, (_, i) => ['施設' + (i + 1) + '（架空）', {}]),
    rows: Array.from({ length: rowCount }, () => ([])),
    profileId,
  };
}

console.log('=== elysia_kaigo（施設集計CSV・confirmed・INC-603でブロック解除） ===');

// (1) elysia_kaigo + 行あり + 技術料あり → ブロックしない・notice:kaigo_csv_ok
{
  const r = _homecareZeroTechGuard(makeResult({ profileId: 'elysia_kaigo', rowCount: 5, insTotal: 12340, tech: 1234 }));
  assertEq(r.blocked, false, '(1) elysia_kaigo + 行あり + 技術料あり → blocked:false');
  assertEq(r.reason, null, '(1) reason:null');
  assertEq(r.notice, 'kaigo_csv_ok', '(1) notice:kaigo_csv_ok');
}

// (2) elysia_kaigo + 行あり + 技術料ゼロ → それでもブロックしない（タスク仕様: rowCount===0以外はblocked:false）
{
  const r = _homecareZeroTechGuard(makeResult({ profileId: 'elysia_kaigo', rowCount: 4, insTotal: 0, tech: 0 }));
  assertEq(r.blocked, false, '(2) elysia_kaigo + 行あり + 技術料ゼロ → blocked:false（zero_bothを適用しない）');
  assertEq(r.notice, 'kaigo_csv_ok', '(2) notice:kaigo_csv_ok（技術料ゼロでも告知は出す）');
}

// (3) elysia_kaigo + 行0件 → no_rowsでブロック
{
  const r = _homecareZeroTechGuard(makeResult({ profileId: 'elysia_kaigo', rowCount: 0, facilityCount: 0 }));
  assertEq(r.blocked, true, '(3) elysia_kaigo + 行0件 → blocked:true');
  assertEq(r.reason, 'no_rows', '(3) reason:no_rows');
  assertEq(r.notice, null, '(3) notice:null（ブロック時はnoticeを立てない）');
}

console.log('=== elysia（旧ID・居宅療養管理指導の訪問明細CSV・未確認＝引き続きblock） ===');

// (4) elysia + 行あり → 常にブロック（技術料の値を問わない）
{
  const r = _homecareZeroTechGuard(makeResult({ profileId: 'elysia', rowCount: 7, insTotal: 99999, tech: 9999 }));
  assertEq(r.blocked, true, '(4) elysia + 行あり + 技術料正値でもブロック継続');
  assertEq(r.reason, 'kaigo_csv', '(4) reason:kaigo_csv');
}

// (5) elysia + 行0件 → no_rows（rowCountが優先）
{
  const r = _homecareZeroTechGuard(makeResult({ profileId: 'elysia', rowCount: 0, facilityCount: 0 }));
  assertEq(r.blocked, true, '(5) elysia + 行0件 → blocked:true');
  assertEq(r.reason, 'no_rows', '(5) reason:no_rows（kaigo_csvより優先）');
}

console.log('=== pharmy / elysia_r（既存挙動・回帰ガード） ===');

// (6) pharmy 保険計・技術料ともゼロ → zero_both（既存挙動不変）
{
  const r = _homecareZeroTechGuard(makeResult({ profileId: 'pharmy', rowCount: 10, insTotal: 0, tech: 0 }));
  assertEq(r.blocked, true, '(6) pharmy + 保険計・技術料ともゼロ → blocked:true');
  assertEq(r.reason, 'zero_both', '(6) reason:zero_both');
}

// (7) pharmy 技術料のみ正値（保険計は欠落0でもOK）→ ブロックしない（INC-555の誤ブロック回避・回帰ガード）
{
  const r = _homecareZeroTechGuard(makeResult({ profileId: 'pharmy', rowCount: 10, insTotal: 0, tech: 5000 }));
  assertEq(r.blocked, false, '(7) pharmy + techのみ正値 → blocked:false（片方だけ正値でも通す・既存挙動不変）');
}

// (8) elysia_r（PDF・医療保険技術料内訳）保険計のみ正値 → ブロックしない
{
  const r = _homecareZeroTechGuard(makeResult({ profileId: 'elysia_r', rowCount: 10, insTotal: 54320, tech: 0 }));
  assertEq(r.blocked, false, '(8) elysia_r + insTotalのみ正値 → blocked:false（既存挙動不変）');
}

// (9) elysia_r 両方ゼロ → zero_both（既存挙動不変）
{
  const r = _homecareZeroTechGuard(makeResult({ profileId: 'elysia_r', rowCount: 10, insTotal: 0, tech: 0 }));
  assertEq(r.blocked, true, '(9) elysia_r + 両方ゼロ → blocked:true');
  assertEq(r.reason, 'zero_both', '(9) reason:zero_both');
}

// (10) 行0件はプロファイル無関係に最優先でブロック（profileId=nullでも）
{
  const r = _homecareZeroTechGuard(makeResult({ profileId: null, rowCount: 0, facilityCount: 0 }));
  assertEq(r.blocked, true, '(10) profileId=null + 行0件 → blocked:true');
  assertEq(r.reason, 'no_rows', '(10) reason:no_rows');
}

console.log('=== _homecareZeroTechMessage / _homecareZeroTechWarningHtml（文面・枠の出し分け） ===');

// (11) elysia(kaigo_csv)ブロック時のメッセージ文面（INC-603で改訂）
{
  const guard = _homecareZeroTechGuard(makeResult({ profileId: 'elysia', rowCount: 3 }));
  const msg = _homecareZeroTechMessage(guard);
  assertEq(msg, HOMECARE_ZERO_TECH_MSG_KAIGO_CSV, '(11) elysiaブロック時のメッセージ=HOMECARE_ZERO_TECH_MSG_KAIGO_CSV');
  assertOk(msg.includes('訪問明細') && msg.includes('施設集計'), '(11) 文面に「訪問明細」「施設集計」を含む（改訂後の文言）');
  assertOk(!msg.includes('施設集計 R'), '(11) 旧文言「施設集計 R（患者別調剤報酬明細）」は含まない（改訂で変更済み）');
}

// (12) elysiaブロック時のHTML=赤枠
{
  const guard = _homecareZeroTechGuard(makeResult({ profileId: 'elysia', rowCount: 3 }));
  const html = _homecareZeroTechWarningHtml(guard);
  assertOk(html.includes('#e74c3c') && html.includes('⚠️'), '(12) elysiaブロック時のHTMLは赤枠(#e74c3c)+⚠️');
  assertOk(html.includes(HOMECARE_ZERO_TECH_MSG_KAIGO_CSV), '(12) 赤枠HTMLにメッセージ本文を含む');
}

// (13) elysia_kaigo（notice）時のメッセージはblocked:falseなので空文字
{
  const guard = _homecareZeroTechGuard(makeResult({ profileId: 'elysia_kaigo', rowCount: 3, insTotal: 100, tech: 10 }));
  const msg = _homecareZeroTechMessage(guard);
  assertEq(msg, '', '(13) elysia_kaigo(notice)はblocked:falseなのでメッセージは空文字');
}

// (14) elysia_kaigo（notice）時のHTML=情報枠（青）。赤枠の文言・配色は出ない
{
  const guard = _homecareZeroTechGuard(makeResult({ profileId: 'elysia_kaigo', rowCount: 3, insTotal: 100, tech: 10 }));
  const html = _homecareZeroTechWarningHtml(guard);
  assertOk(html.includes('#3498db') && html.includes('ℹ️'), '(14) elysia_kaigo(notice)のHTMLは情報枠(#3498db)+ℹ️');
  assertOk(!html.includes('#e74c3c'), '(14) 赤枠(#e74c3c)は出ない');
  assertOk(html.includes(HOMECARE_KAIGO_CSV_OK_NOTICE), '(14) 情報枠に告知文(HOMECARE_KAIGO_CSV_OK_NOTICE)を含む');
  assertOk(html.includes(String(HOMECARE_KAIGO_UNIT_YEN)), '(14) 告知文に1単位換算額(' + HOMECARE_KAIGO_UNIT_YEN + ')を含む');
}

// (15) blocked:false かつ notice:null（pharmy正常ケース）→ 警告HTMLは空文字
{
  const guard = _homecareZeroTechGuard(makeResult({ profileId: 'pharmy', rowCount: 10, insTotal: 0, tech: 5000 }));
  const html = _homecareZeroTechWarningHtml(guard);
  assertEq(html, '', '(15) pharmy正常ケース（blocked:false・notice:null）→ 警告HTMLは空文字');
}

// (16) zero_both時の汎用メッセージ文面は不変（回帰ガード）
{
  const guard = _homecareZeroTechGuard(makeResult({ profileId: 'pharmy', rowCount: 10, insTotal: 0, tech: 0 }));
  assertEq(_homecareZeroTechMessage(guard), HOMECARE_ZERO_TECH_MSG_GENERIC, '(16) zero_both時のメッセージ=HOMECARE_ZERO_TECH_MSG_GENERIC（不変）');
}

console.log('---');
if (fail === 0) { console.log('ALL PASS (test_homecare_zero_tech_guard.mjs) — ' + pass + ' assertions'); process.exit(0); }
else { console.log('FAILED: ' + fail + ' assertion(s) / PASS ' + pass); process.exit(1); }
