/**
 * 月計表突合ロジック(judgeReconcile)のスタンドアロンNodeテスト（依存ゼロ・純関数のみ検証・INC-401）
 * 実行: node test_homecare_reconcile.mjs
 */
import { judgeReconcile } from './homecare_reconcile.mjs';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log('✅ PASS: ' + label);
    pass++;
  } else {
    console.log('❌ FAIL: ' + label);
    console.log('   expected: ' + e);
    console.log('   actual  : ' + a);
    fail++;
  }
}
function assertOk(cond, label) {
  if (cond) { console.log('✅ PASS: ' + label); pass++; }
  else { console.log('❌ FAIL: ' + label); fail++; }
}

// ---- 分岐1: 一致（|差分%|<=1%） ----
{
  // tech=1000点, techFee=10,000円→1000点, 差分0%
  const j = judgeReconcile({ tech: 1000, techFee: 10000, times: 50, visitCount: 50, insTotal: 500000, totalInsurance: 500000, hasSalesData: true });
  assertEq(j.status, 'match', '(1) 差分0% → match');
  assertEq(j.label, '✅ 月計表と一致', '(1) label');
  assertEq(j.timesMatch, true, '(1) times一致');
  assertEq(j.insDiffPercent, 0, '(1) insTotal差分0%');
}
{
  // 差分ちょうど1%（境界値・一致とする）
  const j = judgeReconcile({ tech: 1010, techFee: 10000, times: 50, visitCount: 50, insTotal: 100, totalInsurance: 100, hasSalesData: true });
  assertEq(j.status, 'match', '(1b) 差分+1%（境界） → match');
}

// ---- 分岐2: 要確認（1%<|差分%|<=3%） ----
{
  // tech=1020点 vs techFee/10=1000点 → 差分+2%
  const j = judgeReconcile({ tech: 1020, techFee: 10000, times: 48, visitCount: 50, insTotal: 100, totalInsurance: 100, hasSalesData: true });
  assertEq(j.status, 'check', '(2) 差分+2% → check');
  assertEq(j.label, '⚠ 要確認', '(2) label');
  assertEq(j.timesMatch, false, '(2) times不一致');
}
{
  // 境界値3%ちょうど
  const j = judgeReconcile({ tech: 1030, techFee: 10000, hasSalesData: true });
  assertEq(j.status, 'check', '(2b) 差分+3%（境界） → check');
}

// ---- 分岐3: 乖離（|差分%|>3%） ----
{
  // 旧式バグ再現: tech(旧式・drugFee込み)がtechFeeの2倍近い
  const j = judgeReconcile({ tech: 1900, techFee: 10000, times: 50, visitCount: 50, insTotal: 500000, totalInsurance: 500000, hasSalesData: true });
  assertEq(j.status, 'mismatch', '(3) 差分+90% → mismatch');
  assertEq(j.label, '❌ 乖離（再取込 or 式の確認）', '(3) label');
}
{
  const j = judgeReconcile({ tech: 1031, techFee: 10000, hasSalesData: true });
  assertEq(j.status, 'mismatch', '(3b) 差分+3.1%（境界超） → mismatch');
}

// ---- 分岐4: 月計表なし ----
{
  const j = judgeReconcile({ tech: 1000, hasSalesData: false });
  assertEq(j.status, 'no_salesdata', '(4) hasSalesData=false → no_salesdata');
  assertEq(j.label, '月計表未提出', '(4) label');
}
{
  // salesDataは存在するがtechFeeフィールドが無い（技術料欄なしのレセコン等）
  const j = judgeReconcile({ tech: 1000, techFee: null, hasSalesData: true });
  assertEq(j.status, 'no_salesdata', '(4b) techFeeなし → no_salesdata');
  assertEq(j.label, '月計表未提出（技術料欄なし）', '(4b) label');
}

// ---- 分岐5: 在宅患者なし ----
{
  const j = judgeReconcile({ noHomecare: true, hasSalesData: true, tech: 100, techFee: 1000 });
  assertEq(j.status, 'no_homecare', '(5) noHomecare=true → no_homecare（salesDataがあっても優先）');
  assertEq(j.label, '在宅患者なし', '(5) label');
}

// ---- 参考ケース: 2026-08実測に近い値（背景記載の柏の例に近似・insTotalはほぼ一致想定） ----
{
  const j = judgeReconcile({
    tech: 50000, techFee: 500000, times: 1289, visitCount: 1289,
    insTotal: 23908180, totalInsurance: 23934320, hasSalesData: true
  });
  assertOk(j.status === 'match' || j.status === 'check', '(6) 実測近似ケースは match/check のいずれか');
  assertEq(j.timesMatch, true, '(6) times一致(柏1,289=1,289)');
  assertOk(Math.abs(j.insDiffPercent) < 1, '(6) insTotal差分は1%未満(0.1%相当)');
}

console.log(`\n合計: ${pass + fail}件 / PASS ${pass} / FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
