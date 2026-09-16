/**
 * 施設別技術料（homecareData.totals・施設別CSV col13-17の合計・点）と
 * レセコン月計表の技術料合計（salesData.values.techFee・円・帳票の直接行）を突合するスクリプト（INC-401・2026-09-16）
 *
 * 期待関係: totals.tech ≒ techFee / 10（点換算）。あわせて訪問回数(times vs visitCount)・保険計(insTotal vs totalInsurance)も
 * カバレッジ確認として比較する（施設別CSVが店舗の全患者をカバーしているかの検証・2026-08実測で柏1,289=1,289等ほぼ一致）。
 *
 * 読取専用（匿名認証・公開webキーはindex.htmlから実行時抽出。値は出力しない）。Firestoreへの書込みは一切行わない。
 *
 * 使い方:
 *   node homecare_reconcile.mjs --month 2026-08   # 指定月のみ
 *   node homecare_reconcile.mjs                    # 省略時は直近3か月（当月は未提出の可能性が高いため対象外）
 *
 * 出力: reports/homecare_reconcile_{month}.md（月ごとに1ファイル）＋標準出力に要約
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// firebase パッケージは budget_tool 配下に存在しないため、既存導入済みのAI_secretary_reikaから借用（読取専用処理のみ）
const require = createRequire(pathToFileURL(path.join('C:/Users/WISE-Yamauchi/wise/AI_secretary_reika', 'package.json')));
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc } = require('firebase/firestore');
const { getAuth, signInAnonymously } = require('firebase/auth');

// ===== 突合判定ロジック（純関数・test_homecare_reconcile.mjsから直接importして検証する） =====
// 判定基準: |差分%|<=1% 一致 / <=3% 要確認 / それ超 乖離。noHomecareは在宅患者なし、salesData未提出は月計表未提出扱い。
// index.html の _hcJudge と同一ロジック（埋め込みscriptのためコードは複製。閾値・分岐を変更する場合は両方に反映すること）
export function judgeReconcile({ tech, techFee, times, visitCount, insTotal, totalInsurance, noHomecare, hasSalesData }) {
  if (noHomecare) return { status: 'no_homecare', label: '在宅患者なし' };
  if (!hasSalesData) return { status: 'no_salesdata', label: '月計表未提出' };
  const techFeePoints = (typeof techFee === 'number') ? techFee / 10 : null;
  if (techFeePoints === null) return { status: 'no_salesdata', label: '月計表未提出（技術料欄なし）' };
  const diff = (typeof tech === 'number') ? tech - techFeePoints : null;
  const diffPercent = (diff !== null)
    ? (techFeePoints !== 0 ? (diff / techFeePoints) * 100 : (diff === 0 ? 0 : null))
    : null;
  let status, label;
  if (diffPercent === null) { status = 'unknown'; label = '判定不可'; }
  else if (Math.abs(diffPercent) <= 1) { status = 'match'; label = '✅ 月計表と一致'; }
  else if (Math.abs(diffPercent) <= 3) { status = 'check'; label = '⚠ 要確認'; }
  else { status = 'mismatch'; label = '❌ 乖離（再取込 or 式の確認）'; }
  const timesMatch = (typeof times === 'number' && typeof visitCount === 'number') ? (times === visitCount) : null;
  const insDiffPercent = (typeof insTotal === 'number' && typeof totalInsurance === 'number' && totalInsurance !== 0)
    ? ((insTotal - totalInsurance) / totalInsurance) * 100
    : null;
  return { status, label, techFeePoints, diff, diffPercent, timesMatch, insDiffPercent };
}

// 対象店舗（HOMECARE_STORE_LABELS＝DEPTS.filter(!adminOnly) と同一。index.html L700-712準拠）
const STORES = [
  ['kashiwa', '柏'], ['adachi', '足立'], ['nagareyama', 'ながれやま'], ['ai_chozai', 'アイ調剤'],
  ['abiko', '我孫子'], ['sakuradai', 'さくら台'], ['koshigaya', '越谷'], ['kiyose', '清瀬'],
];

function getRecentMonths(n) {
  const now = new Date();
  const months = [];
  // 当月は月計表がまだ未提出の可能性が高いため対象外。直近n=過去nか月（当月を含まない）
  for (let i = n; i >= 1; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--month' && argv[i + 1]) { out.month = argv[i + 1]; i++; }
  }
  return out;
}

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString() : '-';
}
function fmtPct(n) {
  return typeof n === 'number' ? (n >= 0 ? '+' : '') + n.toFixed(1) + '%' : '-';
}
function fmtSigned(n) {
  return typeof n === 'number' ? (n >= 0 ? '+' : '') + Math.round(n).toLocaleString() : '-';
}

async function fetchMonthData(db, month) {
  const ym = month.replace('-', '');
  const rows = [];
  for (const [storeId, storeName] of STORES) {
    const hcSnap = await getDoc(doc(db, 'homecareData', `${storeId}_${ym}`));
    const svSnap = await getDoc(doc(db, 'salesData', `${month}_${storeId}`));
    const hc = hcSnap.exists() ? hcSnap.data() : null;
    const sv = svSnap.exists() ? (svSnap.data().values || {}) : null;
    if (!hc) {
      rows.push({ storeId, storeName, month, noData: true });
      continue;
    }
    const t = hc.totals || {};
    const noHomecare = !!hc.noHomecare;
    const hasSalesData = !!sv;
    const j = judgeReconcile({
      tech: t.tech, techFee: sv ? sv.techFee : null,
      times: t.times, visitCount: sv ? sv.visitCount : null,
      insTotal: t.insTotal, totalInsurance: sv ? sv.totalInsurance : null,
      noHomecare, hasSalesData,
    });
    const isOld = typeof t.drugFee !== 'number';
    rows.push({
      storeId, storeName, month, noHomecare,
      tech: t.tech, techFee: sv ? sv.techFee : null,
      times: t.times, visitCount: sv ? sv.visitCount : null,
      insTotal: t.insTotal, totalInsurance: sv ? sv.totalInsurance : null,
      judge: j, isOld,
    });
  }
  return rows;
}

function buildMarkdown(month, rows) {
  let md = `# 在宅内訳 月計表突合レポート ${month}（INC-401）\n\n`;
  md += `施設別集計(homecareData.totals.tech・点)とレセコン月計表(salesData.values.techFee・円→点換算)を突合。` +
    `判定: |差分%|<=1% 一致 / <=3% 要確認 / それ超 乖離。あわせて訪問回数・保険計のカバレッジも確認。\n\n`;
  md += `| 店舗 | tech(点) | techFee/10(点) | 差分(点) | 差分% | 判定 | times | visitCount | 回数一致 | insTotal | totalInsurance | 保険計差% | 旧式/新式 |\n`;
  md += `|---|---:|---:|---:|---:|---|---:|---:|:---:|---:|---:|---:|:---:|\n`;
  rows.forEach(r => {
    if (r.noData) {
      md += `| ${r.storeName} | - | - | - | - | 未提出（施設データなし） | - | - | - | - | - | - | - |\n`;
      return;
    }
    if (r.noHomecare) {
      md += `| ${r.storeName} | - | - | - | - | 在宅患者なし | - | - | - | - | - | - | - |\n`;
      return;
    }
    const j = r.judge;
    const timesMark = j.timesMatch === true ? '✓' : (j.timesMatch === false ? '✗' : '-');
    md += `| ${r.storeName} | ${fmt(r.tech)} | ${j.techFeePoints != null ? fmt(Math.round(j.techFeePoints)) : '-'} | ` +
      `${fmtSigned(j.diff)} | ${fmtPct(j.diffPercent)} | ${j.label} | ${fmt(r.times)} | ${fmt(r.visitCount)} | ${timesMark} | ` +
      `${fmt(r.insTotal)} | ${fmt(r.totalInsurance)} | ${fmtPct(j.insDiffPercent)} | ${r.isOld ? '旧式' : '新式'} |\n`;
  });
  return md;
}

function summarize(month, rows) {
  const lines = [`\n=== ${month} ===`];
  rows.forEach(r => {
    if (r.noData) { lines.push(`  ${r.storeName}: 未提出（施設データなし）`); return; }
    if (r.noHomecare) { lines.push(`  ${r.storeName}: 在宅患者なし`); return; }
    const j = r.judge;
    lines.push(
      `  ${r.storeName}: tech=${fmt(r.tech)}点 techFee/10=${j.techFeePoints != null ? fmt(Math.round(j.techFeePoints)) : '-'}点 ` +
      `差分=${fmtSigned(j.diff)}点(${fmtPct(j.diffPercent)}) → ${j.label} ｜ times ${fmt(r.times)} vs visitCount ${fmt(r.visitCount)}(${j.timesMatch === true ? '✓' : j.timesMatch === false ? '✗' : '-'}) ` +
      `｜ insTotal ${fmt(r.insTotal)} vs totalInsurance ${fmt(r.totalInsurance)}(差${fmtPct(j.insDiffPercent)}) ｜ ${r.isOld ? '旧式' : '新式'}`
    );
  });
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const months = args.month ? [args.month] : getRecentMonths(3);

  const html = readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
  const apiKeyMatch = html.match(/apiKey:\s*"([^"]+)"/);
  if (!apiKeyMatch) {
    console.error('❌ index.htmlからapiKeyを抽出できませんでした');
    process.exit(1);
  }
  const app = initializeApp({
    apiKey: apiKeyMatch[1],
    authDomain: 'wise-budget-26d4c.firebaseapp.com',
    projectId: 'wise-budget-26d4c',
  });
  const db = getFirestore(app);
  await signInAnonymously(getAuth(app));

  const reportsDir = path.join(__dirname, 'reports');
  if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });

  for (const month of months) {
    const rows = await fetchMonthData(db, month);
    const md = buildMarkdown(month, rows);
    const outPath = path.join(reportsDir, `homecare_reconcile_${month}.md`);
    writeFileSync(outPath, md, 'utf-8');
    console.log(summarize(month, rows));
    console.log(`  → ${path.relative(__dirname, outPath)} に出力`);
  }

  process.exit(0);
}

// テストからimportされた場合はmain()を実行しない（ESMではimport.meta.urlで判定）
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(e => { console.error('❌ 実行エラー:', e.message); process.exit(1); });
}
