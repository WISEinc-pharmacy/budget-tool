// INC-598（2026-10-20）: index.html の ===SALES_PERIOD_GUARD_START/END=== マーカーブロック
// （_salesPeriodFromText / _salesPeriodGuard / _salesConsistencyCheck）を、ロジックを複製せずに
// そのまま抽出して hq_backfill_sales_2026 配下のNode CLIから使えるようにする。
// homecare_recompute.mjs の extractHomecareRowToArray と同方式（new Function で抽出）。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 本ツールは wise/budget_tool/tools/hq_backfill_sales_2026/ に置かれ、index.htmlは2階層上(budget_tool/)。
const INDEX_HTML_PATH = path.join(__dirname, '..', '..', 'index.html');

export function extractSalesPeriodGuard(indexHtmlPath = INDEX_HTML_PATH) {
  const src = readFileSync(indexHtmlPath, 'utf8');
  const START = '// ===SALES_PERIOD_GUARD_START===';
  const END = '// ===SALES_PERIOD_GUARD_END===';
  const si = src.indexOf(START);
  const ei = src.indexOf(END);
  if (si === -1 || ei === -1) throw new Error('SALES_PERIOD_GUARDマーカーが見つかりません（index.html構造変更の疑い）');
  const block = src.slice(si + START.length, ei);
  if (!block.includes('function _salesPeriodGuard') || !block.includes('function _salesConsistencyCheck')) {
    throw new Error('抽出したブロックに_salesPeriodGuard/_salesConsistencyCheckが含まれません（index.html構造変更の疑い）');
  }
  // eslint-disable-next-line no-new-func
  const factory = new Function(block + '\nreturn { _salesPeriodFromText, _salesPeriodGuard, _salesConsistencyCheck };');
  return factory();
}
