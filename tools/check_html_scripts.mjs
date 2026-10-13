#!/usr/bin/env node
// check_html_scripts.mjs — extract inline <script> blocks and run node --check on each
// Usage: node tools/check_html_scripts.mjs <htmlfile>
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

const htmlFile = process.argv[2];
if (!htmlFile) { console.error('Usage: node check_html_scripts.mjs <htmlfile>'); process.exit(1); }

const html = readFileSync(htmlFile, 'utf8');

// 2026-10-13: U+0000(NUL)バイトがファイル中にあると、gitがバイナリと誤判定し
// autocrlf正規化・diffが機能しなくなる（全行差分化。budget_tool index.html実例）。push前必須チェックで機械検出する。
let errors = 0;
{
  const nulPositions = [];
  let idx = html.indexOf('\u0000');
  while (idx !== -1) {
    nulPositions.push(idx);
    idx = html.indexOf('\u0000', idx + 1);
  }
  if (nulPositions.length > 0) {
    errors++;
    const lines = nulPositions.map((pos) => {
      let line = 1;
      for (let i = 0; i < pos; i++) if (html[i] === '\n') line++;
      return line;
    });
    console.log(`NUL check: FAIL — ${nulPositions.length}個の生NULバイト（行: ${lines.join(', ')}）。` +
      `生のNUL文字は使わず '\\u0000' のようなエスケープ表記に置き換えること（JS挙動は同一・gitのバイナリ誤判定を防ぐ）。`);
  } else {
    console.log('NUL check: OK');
  }
}

const re = /<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/g;
let m, count = 0;
while ((m = re.exec(html)) !== null) {
  count++;
  const code = m[1];
  const tmp = join(tmpdir(), `chk_${count}.js`);
  writeFileSync(tmp, code, 'utf8');
  try {
    execSync(`node --check "${tmp}"`, { stdio: 'pipe' });
    console.log(`script${count}: OK`);
  } catch (e) {
    errors++;
    console.log(`script${count}: SYNTAX ERROR — ${e.stderr.toString().split('\n')[0]}`);
  }
  try { unlinkSync(tmp); } catch (_) {}
}
console.log(`\n${count} scripts checked. ${errors === 0 ? 'ALL OK' : 'BROKEN: ' + errors + ' error(s)'}`);
process.exit(errors > 0 ? 1 : 0);
