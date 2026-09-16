/**
 * homecareRows（保存済みCSV行データ・識別子除去済み）から施設別集計(homecareData.facilities/totals)を
 * 再計算するCLI（INC-403・2026-09-16）。
 *
 * 背景: 旧実装は集計値のみを保存し行データを破棄していたため、INC-399の式修正時に過去月を再計算できず
 * スタッフへCSV再提出を強いた（山内さん9/16指摘）。行データを保存する改修（index.html側）とセットで、
 * 保存済み行から最新ロジック(computeHomecareTotalsFromRows・index.html内)でいつでも作り直せるようにする。
 * index.html内のブラウザUI「保存データから再集計」ボタンと同じロジックをCLIからも実行できるようにしたもの。
 *
 * 既定は --dry-run（差分表示のみ・書込みなし）。実書込みは --write を明示指定したときのみ。
 * 認証: 匿名認証（公開webキーはindex.htmlから実行時抽出・値は出力しない）。読取＋書込み（--write時のみ）。
 *
 * 使い方:
 *   node homecare_recompute.mjs --dry-run                          # 全homecareRowsドキュメントを対象に差分確認
 *   node homecare_recompute.mjs --store kashiwa --month 2026-08 --dry-run
 *   node homecare_recompute.mjs --store kashiwa --month 2026-08 --write   # 実際にhomecareDataへ書込み
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');

// firebase パッケージは budget_tool 配下に存在しないため、既存導入済みのAI_secretary_reikaから借用（homecare_reconcile.mjsと同じ方式）
const require = createRequire(pathToFileURL(path.join('C:/Users/WISE-Yamauchi/wise/AI_secretary_reika', 'package.json')));
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, collection, getDocs, setDoc, serverTimestamp } = require('firebase/firestore');
const { getAuth, signInAnonymously } = require('firebase/auth');

// ===== index.html から computeHomecareTotalsFromRows() と TECH_INCLUDE_TIME_ADD を抽出して実行可能にする =====
// (test_pharmy_parse.mjs と同じ「括弧カウントによる本体抽出」方式。index.htmlを書き換えずに実関数を直接使う)
function extractBraceBlock(src, startMarker) {
  const markerIdx = src.indexOf(startMarker);
  if (markerIdx === -1) throw new Error('marker not found: ' + startMarker);
  const openIdx = markerIdx + startMarker.length - 1;
  if (src[openIdx] !== '{') throw new Error('startMarker must end with "{"');
  let depth = 0;
  let inStr = null;
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

export function extractComputeHomecareTotalsFromRows() {
  const src = readFileSync(INDEX_HTML_PATH, 'utf8');
  const techConstMatch = src.match(/const\s+TECH_INCLUDE_TIME_ADD\s*=\s*(true|false)\s*;/);
  if (!techConstMatch) throw new Error('TECH_INCLUDE_TIME_ADD 定数が見つかりません（index.html側の宣言が変更された可能性）');
  const techIncludeTimeAdd = techConstMatch[1] === 'true';

  const { full } = extractBraceBlock(src, 'function computeHomecareTotalsFromRows(header, rows, _profile) {');
  const body = full.slice(1, -1);
  if (!body.includes('REQUIRED') || !body.includes('g.tech')) {
    throw new Error('抽出したcomputeHomecareTotalsFromRows本体が想定と一致しません（index.html構造変更の疑い）');
  }
  // eslint-disable-next-line no-new-func
  const computeHomecareTotalsFromRows = new Function('TECH_INCLUDE_TIME_ADD', 'header', 'rows', '_profile', body);
  return { computeHomecareTotalsFromRows: (header, rows, _profile) => computeHomecareTotalsFromRows(techIncludeTimeAdd, header, rows, _profile), techIncludeTimeAdd };
}

const STORES = [
  ['kashiwa', '柏'], ['adachi', '足立'], ['nagareyama', 'ながれやま'], ['ai_chozai', 'アイ調剤'],
  ['abiko', '我孫子'], ['sakuradai', 'さくら台'], ['koshigaya', '越谷'], ['kiyose', '清瀬'],
];
const STORE_LABEL = Object.fromEntries(STORES);

function parseArgs(argv) {
  const out = { write: false, dryRun: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--month' && argv[i + 1]) { out.month = argv[i + 1]; i++; }
    else if (argv[i] === '--store' && argv[i + 1]) { out.store = argv[i + 1]; i++; }
    else if (argv[i] === '--write') { out.write = true; out.dryRun = false; }
    else if (argv[i] === '--dry-run') { out.dryRun = true; out.write = false; }
  }
  return out;
}

async function loadRowsDoc(db, docId) {
  const ref = doc(db, 'homecareRows', docId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  const data = snap.data();
  if (!data.chunked) return { header: data.header || [], rows: data.rows || [], profile: data.profile || null };
  const chunksSnap = await getDocs(collection(db, 'homecareRows', docId, 'chunks'));
  const chunkDocs = chunksSnap.docs.slice().sort((a, b) => (a.data().chunkIndex || 0) - (b.data().chunkIndex || 0));
  const rows = [];
  chunkDocs.forEach(d => rows.push(...(d.data().rows || [])));
  return { header: data.header || [], rows, profile: data.profile || null };
}

function fmt(n) { return typeof n === 'number' ? n.toLocaleString() : '-'; }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { computeHomecareTotalsFromRows } = extractComputeHomecareTotalsFromRows();

  const html = readFileSync(INDEX_HTML_PATH, 'utf-8');
  const apiKeyMatch = html.match(/apiKey:\s*"([^"]+)"/);
  if (!apiKeyMatch) { console.error('❌ index.htmlからapiKeyを抽出できませんでした'); process.exit(1); }
  const app = initializeApp({
    apiKey: apiKeyMatch[1],
    authDomain: 'wise-budget-26d4c.firebaseapp.com',
    projectId: 'wise-budget-26d4c',
  });
  const db = getFirestore(app);
  await signInAnonymously(getAuth(app));

  // 対象docId一覧を決定
  let targets = [];
  if (args.store && args.month) {
    targets = [args.store + '_' + args.month.replace('-', '')];
  } else {
    const snap = await getDocs(collection(db, 'homecareRows'));
    targets = snap.docs
      .filter(d => !args.store || d.data().store === args.store)
      .filter(d => !args.month || d.data().yearMonth === args.month)
      .map(d => d.id);
  }

  if (targets.length === 0) {
    console.log('対象のhomecareRowsドキュメントが見つかりませんでした（store/month条件を確認してください）');
    process.exit(0);
  }

  console.log(`モード: ${args.write ? '書込み(--write)' : '差分確認のみ(--dry-run・既定)'}`);
  console.log(`対象: ${targets.length}件`);

  let changed = 0, unchanged = 0, errors = 0;
  for (const docId of targets) {
    try {
      const rowsData = await loadRowsDoc(db, docId);
      if (!rowsData || !rowsData.rows.length) { console.log(`  ${docId}: 行データなし（スキップ）`); continue; }
      const agg = computeHomecareTotalsFromRows(rowsData.header, rowsData.rows, rowsData.profile);
      if (!agg) { console.log(`  ${docId}: 集計に必要な列が揃っていません（スキップ）`); errors++; continue; }

      const hcSnap = await getDoc(doc(db, 'homecareData', docId));
      const prevTotals = hcSnap.exists() ? (hcSnap.data().totals || {}) : {};
      const newTech = agg.totals.tech || 0;
      const prevTech = prevTotals.tech || 0;
      const diff = newTech - prevTech;
      const label = STORE_LABEL[docId.split('_')[0]] || docId.split('_')[0];
      const ym = docId.split('_')[1];
      if (diff === 0 && prevTotals.drugFee === agg.totals.drugFee) {
        console.log(`  ${label} ${ym}: 変化なし（tech=${fmt(newTech)}点・${agg.sorted.length}施設・${rowsData.rows.length}行）`);
        unchanged++;
      } else {
        console.log(`  ${label} ${ym}: tech ${fmt(prevTech)}→${fmt(newTech)}点（差${diff >= 0 ? '+' : ''}${fmt(diff)}）・${agg.sorted.length}施設・${rowsData.rows.length}行`);
        changed++;
      }
      if (args.write) {
        const facilities = agg.sorted.map(([name, g]) => ({ name, ...g }));
        await setDoc(doc(db, 'homecareData', docId), {
          facilities,
          totals: agg.totals,
          recomputedAt: serverTimestamp(),
          recomputedBy: 'cli:homecare_recompute',
        }, { merge: true });
        console.log(`    → homecareData/${docId} を更新しました`);
      }
    } catch (e) {
      console.error(`  ${docId}: ❌ エラー ${e.message}`);
      errors++;
    }
  }

  console.log('---');
  console.log(`変化あり: ${changed} / 変化なし: ${unchanged} / エラー: ${errors}`);
  if (args.dryRun) console.log('（--dry-runのため書込みは行っていません。反映するには --write を付けて再実行してください）');
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(e => { console.error('❌ 実行エラー:', e.message); process.exit(1); });
}
