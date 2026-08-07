import { readFileSync } from 'fs';
import { createRequire } from 'module';

const SPREADSHEET_ID = '18DyRlXbK6OO_cOLomTUKFJ0AYGKSR-YeHUU_ck0muO0';
const SHEET_NAME = '2026年';

// Load token
function loadToken(path) {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  return raw.access_token;
}

async function sheetsGet(token, range, renderOption = 'FORMULA') {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}?valueRenderOption=${renderOption}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GET ${range} -> ${res.status}: ${txt.substring(0, 200)}`);
  }
  return res.json();
}

async function sheetsBatchUpdate(token, data) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`;
  const body = {
    valueInputOption: 'USER_ENTERED',
    data
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`batchUpdate -> ${res.status}: ${txt.substring(0, 200)}`);
  }
  return res.json();
}

async function main() {
  // Try reika token first
  let token;
  let tokenSource;
  try {
    token = loadToken('C:/Users/WISE-Yamauchi/wise/AI_secretary_reika/token.json');
    tokenSource = 'reika';
    console.log('Using reika token');
  } catch (e) {
    console.log('reika token load failed:', e.message);
    token = loadToken('C:/Users/WISE-Yamauchi/wise/AI_assistant_merubo/token.json');
    tokenSource = 'merubo';
    console.log('Using merubo token');
  }

  // Step 1: Get formulas for AK40:AK50, AH46, AE46
  console.log('\n=== Step 1: Fetch current formulas ===');

  let akFormulas, ah46Formula, ae46Formula;

  try {
    const akRange = `'${SHEET_NAME}'!AK40:AK50`;
    const akData = await sheetsGet(token, akRange);
    console.log(`AK40:AK50 formulas:`);
    const rows = akData.values || [];
    rows.forEach((row, i) => {
      console.log(`  AK${40 + i}: ${row[0] || '(empty)'}`);
    });
    // AK46 is index 6 (40+6=46)
    akFormulas = rows;
    const ak46Row = rows[6];
    const ak46Formula = ak46Row ? ak46Row[0] : null;
    console.log(`\nAK46 formula: ${ak46Formula}`);

    // Test if AK38 is in the formula
    if (ak46Formula && ak46Formula.includes('AK38')) {
      console.log('AK38 is ALREADY included in AK46 formula -> no fix needed for AK46');
    } else {
      console.log('AK38 is NOT in AK46 formula -> fix needed');
    }
  } catch (e) {
    // Try with 403 fallback to merubo
    if (e.message.includes('403') && tokenSource === 'reika') {
      console.log('403 from reika token, switching to merubo...');
      token = loadToken('C:/Users/WISE-Yamauchi/wise/AI_assistant_merubo/token.json');
      tokenSource = 'merubo';
      const akRange = `'${SHEET_NAME}'!AK40:AK50`;
      const akData = await sheetsGet(token, akRange);
      console.log(`AK40:AK50 formulas (merubo token):`);
      const rows = akData.values || [];
      rows.forEach((row, i) => {
        console.log(`  AK${40 + i}: ${row[0] || '(empty)'}`);
      });
      akFormulas = rows;
    } else {
      throw e;
    }
  }

  // Get AH46 and AE46
  try {
    const ahData = await sheetsGet(token, `'${SHEET_NAME}'!AH46`);
    ah46Formula = (ahData.values || [[]])[0][0];
    console.log(`AH46 formula: ${ah46Formula}`);
  } catch (e) {
    console.log(`AH46 fetch error: ${e.message}`);
    ah46Formula = null;
  }

  try {
    const aeData = await sheetsGet(token, `'${SHEET_NAME}'!AE46`);
    ae46Formula = (aeData.values || [[]])[0][0];
    console.log(`AE46 formula: ${ae46Formula}`);
  } catch (e) {
    console.log(`AE46 fetch error: ${e.message}`);
    ae46Formula = null;
  }

  // Step 2: Determine what needs fixing
  console.log('\n=== Step 2: Analysis ===');

  const ak46Row = akFormulas ? akFormulas[6] : null;
  const ak46Formula = ak46Row ? ak46Row[0] : null;

  const fixes = [];

  function needsFix(formula, colLetter, row38Ref) {
    if (!formula) return false;
    return !formula.includes(row38Ref);
  }

  if (needsFix(ak46Formula, 'AK', 'AK38')) {
    console.log('AK46 needs fix');
    fixes.push({ range: `'${SHEET_NAME}'!AK46`, formula: ak46Formula, col: 'AK', ref38: 'AK38' });
  } else {
    console.log('AK46: no fix needed');
  }

  if (needsFix(ah46Formula, 'AH', 'AH38')) {
    console.log('AH46 needs fix');
    fixes.push({ range: `'${SHEET_NAME}'!AH46`, formula: ah46Formula, col: 'AH', ref38: 'AH38' });
  } else {
    console.log('AH46: no fix needed');
  }

  if (needsFix(ae46Formula, 'AE', 'AE38')) {
    console.log('AE46 needs fix');
    fixes.push({ range: `'${SHEET_NAME}'!AE46`, formula: ae46Formula, col: 'AE', ref38: 'AE38' });
  } else {
    console.log('AE46: no fix needed');
  }

  if (fixes.length === 0) {
    console.log('\nAll cells already include row 38. No updates needed.');
    // Still fetch display values
    await fetchDisplayValues(token);
    return;
  }

  // Step 3: Build corrected formulas
  console.log('\n=== Step 3: Building corrected formulas ===');

  function buildFixedFormula(formula, col) {
    if (!formula) return null;
    // Pattern: if formula is =SUM(COLxx, COLyy:COLzz) style
    // We want to insert row 38 into the range
    // Most likely pattern: =SUM(AK37,AK39:AK45) -> =SUM(AK37:AK45)
    // Or =SUM(AK39:AK45) -> =SUM(AK38:AK45)
    // Strategy: replace COL37,COL39 with COL37:COL39 (include 38 in range)
    //           or replace COL39: with COL38: if 37 not present

    let fixed = formula;

    // Try: COL37,COL39 -> COL37:COL45 (merge skipped 38)
    const pattern1 = new RegExp(`${col}(\\d+),${col}(\\d+):(${col}\\d+)`, 'g');
    if (pattern1.test(formula)) {
      fixed = formula.replace(new RegExp(`${col}(\\d+),${col}(\\d+):(${col}\\d+)`, 'g'), (m, start, rangeStart, rangeEnd) => {
        // Check if this covers rows 37-45 range with 38 skipped
        if (parseInt(start) <= 38 && parseInt(rangeStart) > 38) {
          return `${col}${start}:${rangeEnd}`;
        }
        return m;
      });
      if (fixed !== formula) {
        console.log(`  ${col}46: ${formula} -> ${fixed}`);
        return fixed;
      }
    }

    // Try: if formula has COLxx:COLyy where xx > 38, extend to include 38
    // e.g. =SUM(AK39:AK45) -> =SUM(AK38:AK45)
    const pattern2 = new RegExp(`${col}39:`, 'g');
    if (pattern2.test(formula)) {
      fixed = formula.replace(new RegExp(`${col}39:`, 'g'), `${col}38:`);
      console.log(`  ${col}46: ${formula} -> ${fixed}`);
      return fixed;
    }

    // Fallback: append +COL38 to SUM
    // =SUM(...) -> =SUM(...)+AK38
    fixed = `${formula}+${col}38`;
    console.log(`  ${col}46 (fallback): ${formula} -> ${fixed}`);
    return fixed;
  }

  const updateData = fixes.map(fix => {
    const newFormula = buildFixedFormula(fix.formula, fix.col);
    return {
      range: fix.range,
      values: [[newFormula]]
    };
  });

  console.log('\nUpdate data:');
  updateData.forEach(u => console.log(`  ${u.range}: ${u.values[0][0]}`));

  // Step 3: Write
  console.log('\n=== Step 3: Writing to sheet ===');
  const updateResult = await sheetsBatchUpdate(token, updateData);
  console.log(`Updated ${updateResult.totalUpdatedCells} cells`);

  // Step 4: Verify
  console.log('\n=== Step 4: Verification ===');
  await fetchDisplayValues(token);

  async function fetchDisplayValues(tkn) {
    // Fetch formula and display value for AK46, AH46, AE46
    const cells = ['AK46', 'AH46', 'AE46'];
    for (const cell of cells) {
      try {
        const formulaData = await sheetsGet(tkn, `'${SHEET_NAME}'!${cell}`, 'FORMULA');
        const formulaVal = (formulaData.values || [[]])[0][0];
        const displayData = await sheetsGet(tkn, `'${SHEET_NAME}'!${cell}`, 'FORMATTED_VALUE');
        const displayVal = (displayData.values || [[]])[0][0];
        console.log(`  ${cell}: formula=${formulaVal} | display=${displayVal}`);
      } catch (e) {
        console.log(`  ${cell}: error - ${e.message}`);
      }
    }
  }
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
