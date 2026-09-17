// scripts/rules_deploy.mjs — Firebase Rules API で firestore.rules をテスト→デプロイ（firebase CLI不要）
// 使い方: GTOKEN=$(gcloud auth print-access-token) node scripts/rules_deploy.mjs backup|test|deploy|rollback <rulesetName>
//
// 由来: scratchpad(bt_sec/rules_deploy.mjs)の9/9デプロイで使用した実装をリポジトリへ取り込み（2026-09-17 T-20260917-003）。
// テスト対象は常にリポジトリ直下の firestore.rules（正本）。旧版は firestore.rules.draft という別ファイルを見ていたが、
// 二重管理を避けるため単一ファイルを正本とする。
//
// 注意: このスクリプトの `deploy` サブコマンドは本番Firestoreルールを書き換える（本番反映）。
// 実行してよいのは親（COO運用の判断者）が本番反映ゲートを通した後のみ。bg-workerからは絶対に呼ばない。
// `test` サブコマンドはFirebase Rules API の :test エンドポイントを叩くだけで、
// どのFirestoreドキュメントも変更しない（読み取り専用のシミュレーション）。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const PROJECT = 'wise-budget-26d4c';
const TOKEN = process.env.GTOKEN; if (!TOKEN) { console.error('GTOKEN missing (gcloud auth print-access-token)'); process.exit(1); }
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'x-goog-user-project': PROJECT };
const BASE = 'https://firebaserules.googleapis.com/v1';
const RULES_PATH = fileURLToPath(new URL('../firestore.rules', import.meta.url));
const [cmd, arg] = process.argv.slice(2);
const DB = '/databases/(default)/documents';
const U = email => `${DB}/users/${email}`;

async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${t.slice(0, 400)}`);
  return j;
}
async function currentRelease() { return api('GET', `/projects/${PROJECT}/releases/cloud.firestore`); }

// ── functionMocks: role()関数内部のget()/exists()呼び出しをモックする（users/{email}ドキュメントの存在＆roleフィールド） ──
function roleMocks(email, role) {
  return [
    { function: 'exists', args: [{ exactValue: U(email) }], result: { value: role !== null } },
    { function: 'get', args: [{ exactValue: U(email) }], result: { value: role === null ? null : { data: { role } } } },
  ];
}
const google = email => ({ uid: 'u_' + email.split('@')[0], token: { email, firebase: { sign_in_provider: 'google.com' } } });
const anon = { uid: 'anon1', token: { firebase: { sign_in_provider: 'anonymous' } } };

// budgetData用（既存26件・INC-376封じ込め時に9/9実行してPASS済み）
function tc(expectation, method, docId, auth, email, role) {
  const t = { expectation, request: { auth, path: `${DB}/budgetData/${docId}`, method } };
  if (email) t.functionMocks = roleMocks(email, role);
  return t;
}
// 汎用（コレクション・ドキュメント任意・既存resource状態を指定可）2026-09-17追加
// resourceData: 更新/削除対象ドキュメントの「書込み前の既存状態」（TestCase.resource → Rulesの`resource`変数に対応）
function tcGeneric({ expectation, collection, docId, method, email, role, resourceData }) {
  const t = { expectation, request: { auth: email ? google(email) : anon, path: `${DB}/${collection}/${docId}`, method } };
  if (email) t.functionMocks = roleMocks(email, role);
  if (resourceData) t.resource = { data: resourceData };
  return t;
}

const V = 'tsunagup.adachi@wise-jmco.com', K = 'info@wise-jmco.com', G = 'academic@wise-jmco.com', A = 'director@wise-jmco.com', T = 'nimura@account.jpn.com', UP = 'tsunagu.pharmacy@wise-jmco.com';

// ── 既存26件（2026-09-09 INC-376封じ込め・本番デプロイ済みruleset相当） ──
const legacyTestCases = [
  tc('ALLOW', 'get', 'FY2026_kashiwa', google(V), V, 'viewer'),
  tc('DENY',  'get', 'FY2026_yakuin', google(V), V, 'viewer'),
  tc('DENY',  'get', 'FY2026_kanribu', google(V), V, 'viewer'),
  tc('DENY',  'get', 'FY2026_gakujutsu', google(V), V, 'viewer'),
  tc('DENY',  'get', 'FY2026_all', google(V), V, 'viewer'),
  tc('DENY',  'get', 'FY2026_company_total', google(V), V, 'viewer'),
  tc('DENY',  'list', 'FY2026_kashiwa', google(V), V, 'viewer'),
  tc('ALLOW', 'list', 'FY2026_kashiwa', google(A), A, 'admin'),
  tc('ALLOW', 'list', 'FY2026_kashiwa', anon),
  tc('DENY',  'update', 'FY2026_kashiwa', google(V), V, 'viewer'),
  tc('ALLOW', 'get', 'FY2026_kanribu', google(K), K, 'viewer_kanribu'),
  tc('DENY',  'get', 'FY2026_yakuin', google(K), K, 'viewer_kanribu'),
  tc('DENY',  'get', 'FY2026_kashiwa', google(K), K, 'viewer_kanribu'),
  tc('ALLOW', 'get', 'FY2026_gakujutsu', google(G), G, 'viewer_gakujutsu'),
  tc('DENY',  'get', 'FY2026_yakuin', google(G), G, 'viewer_gakujutsu'),
  // 旧: uploaderロール（2026-09-15判例168で廃止）のテストは削除。同アカウントは今後viewerとして再登録される想定
  tc('DENY',  'get', 'FY2026_yakuin', google(UP), UP, 'viewer'),
  tc('ALLOW', 'get', 'FY2026_kashiwa', google(UP), UP, 'viewer'),
  tc('ALLOW', 'get', 'FY2026_yakuin', google(A), A, 'admin'),
  tc('ALLOW', 'update', 'FY2026_yakuin', google(A), A, 'admin'),
  tc('ALLOW', 'get', 'FY2026_yakuin', google(T), T, 'tax_advisor'),
  tc('DENY',  'update', 'FY2026_yakuin', google(T), T, 'tax_advisor'),
  tc('ALLOW', 'get', 'FY2026_yakuin', anon),
  tc('ALLOW', 'update', 'FY2026_adachi', anon),
  tc('DENY',  'get', 'FY2026_kashiwa', google('stranger@example.com'), 'stranger@example.com', null),
  { expectation: 'DENY', request: { auth: null, path: `${DB}/budgetData/FY2026_kashiwa`, method: 'get' } },
  { expectation: 'ALLOW', request: { auth: google(V), path: `${DB}/salesData/2026-08_adachi`, method: 'get' } },
];

// ── 新規（2026-09-17 T-20260917-003）: users自己昇格穴の閉塞・uploader廃止・salesData/homecareData提出者本人操作 ──
const newTestCases = [
  // --- users: 自己昇格・自己降格・自己削除の禁止 ---
  tcGeneric({ expectation: 'DENY', collection: 'users', docId: V, method: 'update', email: V, role: 'viewer',
    resourceData: { email: V, role: 'viewer' } }), // 判例: viewerが自分のroleをadminへ書換え→拒否（元の自己昇格穴）
  tcGeneric({ expectation: 'DENY', collection: 'users', docId: 'newperson@example.com', method: 'create', email: V, role: 'viewer' }), // viewerが他人のusersドキュメントを新規作成→拒否
  tcGeneric({ expectation: 'ALLOW', collection: 'users', docId: 'newperson@example.com', method: 'create', email: A, role: 'admin' }), // adminによる新規ユーザー追加→許可
  tcGeneric({ expectation: 'ALLOW', collection: 'users', docId: V, method: 'update', email: A, role: 'admin',
    resourceData: { email: V, role: 'viewer' } }), // adminによる他人のchangeRole→許可
  tcGeneric({ expectation: 'DENY', collection: 'users', docId: A, method: 'update', email: A, role: 'admin',
    resourceData: { email: A, role: 'admin' } }), // adminであっても自分自身のusersドキュメント更新は拒否（自己降格・自己昇格の防止・多層防御）
  tcGeneric({ expectation: 'DENY', collection: 'users', docId: A, method: 'delete', email: A, role: 'admin',
    resourceData: { email: A, role: 'admin' } }), // adminの自己削除（総ロックアウト防止）
  tcGeneric({ expectation: 'ALLOW', collection: 'users', docId: V, method: 'delete', email: A, role: 'admin',
    resourceData: { email: V, role: 'viewer' } }), // adminによる他人の削除→許可
  tcGeneric({ expectation: 'ALLOW', collection: 'users', docId: V, method: 'get', email: V, role: 'viewer' }), // 読取は従来どおり全ログインユーザー

  // --- salesData: 提出者本人 or admin/editor のみ更新・削除可。匿名バッチ(kpi_counts.mjs)は維持 ---
  tcGeneric({ expectation: 'ALLOW', collection: 'salesData', docId: '2026-08_kashiwa', method: 'update',
    resourceData: { submittedBy: 'x@example.com' } }), // 匿名バッチ（kpi_counts.mjs等のkpiCounts merge書込）→許可
  tcGeneric({ expectation: 'ALLOW', collection: 'salesData', docId: '2026-08_kashiwa', method: 'update', email: V, role: 'viewer',
    resourceData: { submittedBy: V } }), // 提出者本人による更新→許可
  tcGeneric({ expectation: 'DENY', collection: 'salesData', docId: '2026-08_kashiwa', method: 'update', email: UP, role: 'viewer',
    resourceData: { submittedBy: V } }), // 提出者と異なる店舗viewerによる更新→拒否
  tcGeneric({ expectation: 'ALLOW', collection: 'salesData', docId: '2026-08_kashiwa', method: 'update', email: A, role: 'admin',
    resourceData: { submittedBy: V } }), // adminによる他人の提出データ更新→許可
  tcGeneric({ expectation: 'ALLOW', collection: 'salesData', docId: '2026-08_kashiwa', method: 'delete', email: V, role: 'viewer',
    resourceData: { submittedBy: V } }), // 提出者本人による削除→許可
  tcGeneric({ expectation: 'DENY', collection: 'salesData', docId: '2026-08_kashiwa', method: 'delete', email: UP, role: 'viewer',
    resourceData: { submittedBy: V } }), // 他人の提出データ削除→拒否
  tcGeneric({ expectation: 'DENY', collection: 'salesData', docId: '2026-08_kashiwa', method: 'delete', email: V, role: 'viewer',
    resourceData: { submittedBy: null } }), // submittedBy未記録の旧データ（フェイルセーフ）はviewer本人でも削除不可
  tcGeneric({ expectation: 'ALLOW', collection: 'salesData', docId: '2026-08_kashiwa', method: 'create', email: V, role: 'viewer' }), // 新規提出（create）は誰でも可（旧仕様維持）

  // --- homecareData: uploadedBy(uid一致) or admin/editor のみ更新可。匿名バッチ(homecare_recompute.mjs)は維持 ---
  tcGeneric({ expectation: 'ALLOW', collection: 'homecareData', docId: 'kashiwa_2026-08', method: 'update',
    resourceData: { uploadedBy: 'u_someone' } }), // 匿名バッチ（homecare_recompute.mjs）→許可
  tcGeneric({ expectation: 'ALLOW', collection: 'homecareData', docId: 'kashiwa_2026-08', method: 'update', email: V, role: 'viewer',
    resourceData: { uploadedBy: 'u_' + V.split('@')[0] } }), // 提出者本人（uid一致）による更新→許可
  tcGeneric({ expectation: 'DENY', collection: 'homecareData', docId: 'kashiwa_2026-08', method: 'update', email: UP, role: 'viewer',
    resourceData: { uploadedBy: 'u_' + V.split('@')[0] } }), // 別store viewerによる更新→拒否
];

const testCases = [...legacyTestCases, ...newTestCases];

if (cmd === 'backup') {
  const rel = await currentRelease();
  const rs = await api('GET', '/' + rel.rulesetName);
  const content = rs.source.files.map(f => f.content).join('\n');
  fs.writeFileSync(new URL('../firestore.rules.backup_' + rel.rulesetName.split('/').pop() + '.rules', import.meta.url), content);
  console.log('current release:', rel.rulesetName, 'updateTime:', rel.updateTime, 'bytes:', content.length);
} else if (cmd === 'test') {
  const content = fs.readFileSync(RULES_PATH, 'utf8');
  const res = await api('POST', `/projects/${PROJECT}:test`, { source: { files: [{ name: 'firestore.rules', content }] }, testSuite: { testCases } });
  if (res.issues?.length) console.log('ISSUES:', JSON.stringify(res.issues, null, 1));
  let ng = 0;
  (res.testResults || []).forEach((r, i) => { const c = testCases[i]; const ok = r.state === 'SUCCESS'; if (!ok) ng++; console.log(`${ok ? 'PASS' : 'FAIL'} #${i + 1} ${c.expectation} ${c.request.method} ${c.request.path.split('/').slice(-2).join('/')} as ${c.request.auth ? (c.request.auth.token.email || 'anonymous') : 'unauth'}${ok ? '' : ' :: ' + JSON.stringify(r.debugMessages || r.errorPosition || r).slice(0, 300)}`); });
  console.log(ng ? `${ng} FAIL / ${testCases.length} total` : `ALL ${testCases.length} PASS`);
  process.exit(ng ? 1 : 0);
} else if (cmd === 'deploy') {
  const content = fs.readFileSync(RULES_PATH, 'utf8');
  const before = await currentRelease();
  const rs = await api('POST', `/projects/${PROJECT}/rulesets`, { source: { files: [{ name: 'firestore.rules', content }] } });
  const rel = await api('PATCH', `/projects/${PROJECT}/releases/cloud.firestore`, { release: { name: `projects/${PROJECT}/releases/cloud.firestore`, rulesetName: rs.name }, updateMask: 'rulesetName' });
  console.log('before:', before.rulesetName); console.log('after :', rel.rulesetName, rel.updateTime);
  fs.writeFileSync(new URL('../rules_deploy.sent.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), before: before.rulesetName, after: rel.rulesetName }, null, 1));
} else if (cmd === 'rollback') {
  if (!arg) throw new Error('rollback には rulesetName が必要');
  const rel = await api('PATCH', `/projects/${PROJECT}/releases/cloud.firestore`, { release: { name: `projects/${PROJECT}/releases/cloud.firestore`, rulesetName: arg }, updateMask: 'rulesetName' });
  console.log('rolled back to', rel.rulesetName);
} else { console.log('usage: GTOKEN=<token> node scripts/rules_deploy.mjs backup|test|deploy|rollback <rulesetName>'); }
process.exit(0);
