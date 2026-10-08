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

// ── v2テスト拡張（2026-10-08・第2版rules反証修正の検証）: 任意パス対応の汎用ヘルパー ──
// 由来: C:/Users/WISE-Yamauchi/.claude/projects/.../tool-results/bc9u6n7sf.txt の
// 「=== TEST CASES (61)」を第2版firestore.rulesの最終形に合わせて取り込み、反証修正（submittedBy/uploadedBy
// なりすまし防止・salesDeleteQueue所有者チェック・pdfChunks所有者継承）の検証ケースを追加するために導入。
// tcGeneric()は `${DB}/${collection}/${docId}` の2階層固定（HARNESS GAPS記載）のため、
// salesData/{docId}/pdfChunks/{chunkId} 等の3階層パスを直接表現できる本ヘルパーを別途追加する
// （既存のtc()/tcGeneric()・legacyTestCases/newTestCasesは一切変更しない）。
//
// actor: 'anon' | { email, role }（role===null は users/{email} 未登録＝hasUserDoc()=false を表す。
//   role省略時も null 扱いにする＝HARNESS GAPS記載の「roleを明示しないと誤動作する」注意点への対応）
// path: 完全パス文字列（P()で組み立てる）
// resourceData: 既存ドキュメントの状態（`resource.data`。get/update/delete判定・isSalesOwner等の既存データ所有者チェック用）
// requestResourceData: create/updateで書き込まれる新データ（`request.resource.data`。submittedBy/uploadedByの
//   なりすまし検証はこちらを使う。resourceDataとは別のRules変数のため取り違えないこと）
// extraMocks: get()/exists()の追加functionMocks（roleMocksと合成。親ドキュメント参照の所有者チェック=
//   get(/databases/$(database)/documents/salesData/$(docId)) 等に使う。docMock()で組み立てる）
function tcPath({ expectation, path, method, actor, resourceData, requestResourceData, extraMocks }) {
  const isAnonActor = actor === 'anon';
  const auth = isAnonActor ? anon : google(actor.email);
  const t = { expectation, request: { auth, path, method } };
  const mocks = [];
  if (!isAnonActor) mocks.push(...roleMocks(actor.email, actor.role === undefined ? null : actor.role));
  if (extraMocks) mocks.push(...extraMocks);
  if (mocks.length) t.functionMocks = mocks;
  if (resourceData) t.resource = { data: resourceData };
  if (requestResourceData) t.request.resource = { data: requestResourceData };
  return t;
}
// 未登録Googleアカウント用ヘルパ（usersドキュメント未作成＝role:nullを明示。existing tc()のgoogle(email)+role:nullパターンと同義）
const unregisteredGoogle = email => ({ email, role: null });
// get()/exists()の任意パスモック（親ドキュメント参照の所有者チェック用。data=nullなら「ドキュメント無し」を表す）
function docMock(path, data) {
  return [
    { function: 'exists', args: [{ exactValue: path }], result: { value: data !== null } },
    { function: 'get', args: [{ exactValue: path }], result: { value: data === null ? null : { data } } },
  ];
}
// フルパス組立（DB起点・任意階層）
const P = (...segs) => `${DB}/${segs.join('/')}`;

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
  { expectation: 'ALLOW', request: { auth: google(V), path: `${DB}/salesData/2026-08_adachi`, method: 'get' }, functionMocks: roleMocks(V, 'viewer') }, // 第2版でsalesData readがhasUserDoc()を評価するため追加
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
  tcGeneric({ expectation: 'DENY', collection: 'salesData', docId: '2026-08_kashiwa', method: 'create', email: V, role: 'viewer' }), // 第2版: request.resource.data.submittedBy 未指定は DENY（旧仕様=誰でも可→なりすまし防止のため変更。ALLOW版はv2TestCases L199参照）

  // --- homecareData: uploadedBy(uid一致) or admin/editor のみ更新可。第2版で isAnon 撤去＝匿名は DENY（homecare_recompute.mjsは第3版でAdmin SDKへ） ---
  tcGeneric({ expectation: 'DENY', collection: 'homecareData', docId: 'kashiwa_2026-08', method: 'update',
    resourceData: { uploadedBy: 'u_someone' } }), // 第2版で isAnon 撤去＝匿名は DENY（homecare_recompute.mjsは第3版でAdmin SDKへ）
  tcGeneric({ expectation: 'ALLOW', collection: 'homecareData', docId: 'kashiwa_2026-08', method: 'update', email: V, role: 'viewer',
    resourceData: { uploadedBy: 'u_' + V.split('@')[0] } }), // 提出者本人（uid一致）による更新→許可
  tcGeneric({ expectation: 'DENY', collection: 'homecareData', docId: 'kashiwa_2026-08', method: 'update', email: UP, role: 'viewer',
    resourceData: { uploadedBy: 'u_' + V.split('@')[0] } }), // 別store viewerによる更新→拒否
];

// ── v2（2026-10-08・第2版firestore.rules反証修正の検証）: tool-results/bc9u6n7sf.txt「TEST CASES(61)」を
// 第2版の最終ルールに合わせて取り込み、反証[high]/[medium]修正（salesData/homecareData createのなりすまし防止、
// pdfChunks/salesDeleteQueueの所有者チェック継承）の検証ケースを追加したもの。61件からの変更点は各行のコメントに明記する。
// 2026-10-08 第2版で salesData create(viewer) と homecareData update(匿名) の2件を新仕様に合わせて DENY 化
const EDITOR = { email: 'editor1@wise-jmco.com', role: 'editor' }; // 61件のうちeditorアクターが未定義だったため追加（任意のemailで role を明示的にモック）
const OUTSIDER = 'outsider@example.com'; // 未登録Google用の任意メール（users未登録を表す）
const v2TestCases = [
  // --- users（61-#1〜#6。users rulesは本タスク範囲外だが既存の2026-10-08版と整合することを確認） ---
  tcPath({ expectation: 'ALLOW', path: P('users', V), method: 'get', actor: { email: V, role: 'viewer' } }), // 61-#1 本人get
  tcPath({ expectation: 'DENY', path: P('users', UP), method: 'get', actor: { email: V, role: 'viewer' } }), // 61-#2 viewerが他人(UP)をget
  tcPath({ expectation: 'DENY', path: P('users', 'dummy'), method: 'list', actor: { email: V, role: 'viewer' } }), // 61-#3 viewerのlist
  tcPath({ expectation: 'ALLOW', path: P('users', 'dummy'), method: 'list', actor: { email: A, role: 'admin' } }), // 61-#4 adminのlist
  tcPath({ expectation: 'ALLOW', path: P('users', OUTSIDER), method: 'get', actor: unregisteredGoogle(OUTSIDER) }), // 61-#5 未登録Googleの自分自身get（鶏と卵対策）
  tcPath({ expectation: 'DENY', path: P('users', 'dummy'), method: 'list', actor: unregisteredGoogle(OUTSIDER) }), // 61-#6 未登録Googleのlist

  // --- config/gemini（61-#7〜#8 + N: 匿名get→DENYを追加。config ruleにisAnon()は無いため） ---
  tcPath({ expectation: 'DENY', path: P('config', 'gemini'), method: 'get', actor: unregisteredGoogle(OUTSIDER) }), // 61-#7
  tcPath({ expectation: 'ALLOW', path: P('config', 'gemini'), method: 'get', actor: { email: V, role: 'viewer' } }), // 61-#8
  tcPath({ expectation: 'DENY', path: P('config', 'gemini'), method: 'get', actor: 'anon' }), // 追加: config/{doc}はhasUserDoc()のみでisAnon()を含まないためDENY

  // --- salesData（61-#9〜#13 + create所有者チェック追加分） ---
  tcPath({ expectation: 'ALLOW', path: P('salesData', '2026-08_kashiwa'), method: 'get', actor: { email: V, role: 'viewer' } }), // 61-#9
  tcPath({ expectation: 'DENY', path: P('salesData', '2026-08_kashiwa'), method: 'get', actor: unregisteredGoogle(OUTSIDER) }), // 61-#10
  tcPath({ expectation: 'DENY', path: P('salesData', '2026-08_kashiwa'), method: 'create', actor: unregisteredGoogle(OUTSIDER), requestResourceData: { submittedBy: OUTSIDER } }), // 61-#11
  tcPath({ expectation: 'ALLOW', path: P('salesData', '2026-08_kashiwa'), method: 'get', actor: 'anon' }), // 61-#12
  tcPath({ expectation: 'DENY', path: P('salesData', '2026-08_kashiwa'), method: 'create', actor: 'anon' }), // 61-#13
  tcPath({ expectation: 'ALLOW', path: P('salesData', '2026-08_kashiwa'), method: 'update', actor: 'anon' }), // 追加: updateはisAnon()単独で許可（kpi_counts.mjs等）。resourceData不要（isAnon()が||の左辺で短絡）
  tcPath({ expectation: 'ALLOW', path: P('salesData', '2026-08_kashiwa'), method: 'create', actor: { email: V, role: 'viewer' }, requestResourceData: { submittedBy: V } }), // 追加（反証[high]是正の検証）: submittedBy本人→ALLOW
  tcPath({ expectation: 'DENY', path: P('salesData', '2026-08_kashiwa'), method: 'create', actor: { email: V, role: 'viewer' }, requestResourceData: { submittedBy: UP } }), // 追加（反証[high]是正の検証）: submittedByが他人のアドレス→DENY（なりすまし拒否）

  // --- salesData/{docId}/pdfChunks/{chunkId}（61-#14〜#17 + 所有者継承チェック追加分） ---
  tcPath({ expectation: 'ALLOW', path: P('salesData', '2026-08_kashiwa', 'pdfChunks', 'chunk0'), method: 'get', actor: { email: V, role: 'viewer' } }), // 61-#14
  tcPath({ expectation: 'DENY', path: P('salesData', '2026-08_kashiwa', 'pdfChunks', 'chunk0'), method: 'get', actor: unregisteredGoogle(OUTSIDER) }), // 61-#15
  tcPath({ expectation: 'DENY', path: P('salesData', '2026-08_kashiwa', 'pdfChunks', 'chunk0'), method: 'delete', actor: 'anon' }), // 61-#16 を第2版に合わせてALLOW→DENYへ訂正。firestore.rules:84のdelete条件にisAnon()は無い（反証[low]是正=sync_sales_to_drive.mjsはpdfChunksをdelete呼出しない実測に基づく）
  tcPath({ expectation: 'DENY', path: P('salesData', '2026-08_kashiwa', 'pdfChunks', 'chunk0'), method: 'create', actor: 'anon' }), // 61-#17
  tcPath({ expectation: 'ALLOW', path: P('salesData', '2026-08_kashiwa', 'pdfChunks', 'chunk0'), method: 'get', actor: 'anon' }), // 追加: readはisAnon()併記のためALLOW（sync_sales_to_drive.mjsのチャンク結合GET）
  tcPath({ expectation: 'ALLOW', path: P('salesData', '2026-08_kashiwa', 'pdfChunks', 'chunk0'), method: 'create', actor: { email: V, role: 'viewer' }, extraMocks: docMock(P('salesData', '2026-08_kashiwa'), { submittedBy: V }) }), // 追加（反証[medium]是正の検証）: 親salesDataの提出者本人→ALLOW
  tcPath({ expectation: 'DENY', path: P('salesData', '2026-08_kashiwa', 'pdfChunks', 'chunk0'), method: 'create', actor: { email: UP, role: 'viewer' }, extraMocks: docMock(P('salesData', '2026-08_kashiwa'), { submittedBy: V }) }), // 追加（反証[medium]是正の検証）: 別の店舗viewer(UP)が他人(V)提出のpdfChunksへcreate→DENY
  tcPath({ expectation: 'ALLOW', path: P('salesData', '2026-08_kashiwa', 'pdfChunks', 'chunk0'), method: 'create', actor: EDITOR }), // 追加: editorはisEditor()で短絡許可（親get()のextraMocksは不要）

  // --- salesDeleteQueue（61-#18〜#21 + 所有者チェック追加分） ---
  tcPath({ expectation: 'ALLOW', path: P('salesDeleteQueue', '2026-08_kashiwa'), method: 'create', actor: { email: V, role: 'viewer' }, extraMocks: docMock(P('salesData', '2026-08_kashiwa'), { submittedBy: V }) }), // 61-#18 を第2版に合わせてextraMocks追加（提出者本人でなければDENYになるため）
  tcPath({ expectation: 'DENY', path: P('salesDeleteQueue', '2026-08_kashiwa'), method: 'create', actor: unregisteredGoogle(OUTSIDER) }), // 61-#19
  tcPath({ expectation: 'ALLOW', path: P('salesDeleteQueue', '2026-08_kashiwa'), method: 'delete', actor: 'anon' }), // 61-#20
  tcPath({ expectation: 'ALLOW', path: P('salesDeleteQueue', '2026-08_kashiwa'), method: 'get', actor: 'anon' }), // 61-#21 訂正版（元の61-list表記ミスをALLOWへ修正。read側にisAnon()併記=firestore.rules:109）
  tcPath({ expectation: 'DENY', path: P('salesDeleteQueue', '2026-08_kashiwa'), method: 'create', actor: { email: UP, role: 'viewer' }, extraMocks: docMock(P('salesData', '2026-08_kashiwa'), { submittedBy: V }) }), // 追加（反証[high]是正の検証）: 他人(V)の提出データに対し別viewer(UP)がdelete queueをcreate→DENY
  tcPath({ expectation: 'ALLOW', path: P('salesDeleteQueue', '2026-08_kashiwa'), method: 'create', actor: EDITOR }), // 追加: editorはisEditor()で短絡許可→ALLOW

  // --- exportLogs（61-#22〜#28） ---
  tcPath({ expectation: 'ALLOW', path: P('exportLogs', 'log1'), method: 'create', actor: EDITOR }), // 61-#22
  tcPath({ expectation: 'ALLOW', path: P('exportLogs', 'log1'), method: 'create', actor: { email: T, role: 'tax_advisor' } }), // 61-#23
  tcPath({ expectation: 'DENY', path: P('exportLogs', 'log1'), method: 'create', actor: { email: V, role: 'viewer' } }), // 61-#24
  tcPath({ expectation: 'DENY', path: P('exportLogs', 'log1'), method: 'create', actor: unregisteredGoogle(OUTSIDER) }), // 61-#25
  tcPath({ expectation: 'ALLOW', path: P('exportLogs', 'log1'), method: 'list', actor: { email: A, role: 'admin' } }), // 61-#26
  tcPath({ expectation: 'DENY', path: P('exportLogs', 'log1'), method: 'list', actor: EDITOR }), // 61-#27
  tcPath({ expectation: 'DENY', path: P('exportLogs', 'log1'), method: 'list', actor: 'anon' }), // 61-#28

  // --- kot_monthly（61-#29〜#33 + editor write ALLOW追加） ---
  tcPath({ expectation: 'ALLOW', path: P('kot_monthly', '2026-08'), method: 'get', actor: { email: V, role: 'viewer' } }), // 61-#29
  tcPath({ expectation: 'DENY', path: P('kot_monthly', '2026-08'), method: 'get', actor: unregisteredGoogle(OUTSIDER) }), // 61-#30
  tcPath({ expectation: 'ALLOW', path: P('kot_monthly', '2026-08'), method: 'get', actor: 'anon' }), // 61-#31
  tcPath({ expectation: 'DENY', path: P('kot_monthly', '2026-08'), method: 'update', actor: 'anon' }), // 61-#32
  tcPath({ expectation: 'DENY', path: P('kot_monthly', '2026-08'), method: 'update', actor: { email: V, role: 'viewer' } }), // 61-#33
  tcPath({ expectation: 'ALLOW', path: P('kot_monthly', '2026-08'), method: 'update', actor: EDITOR }), // 追加: writeはisStaff()限定でeditorは含まれる→ALLOW

  // --- kot_summary（61-#34〜#36） ---
  tcPath({ expectation: 'ALLOW', path: P('kot_summary', 'employees'), method: 'get', actor: { email: V, role: 'viewer' } }), // 61-#34
  tcPath({ expectation: 'DENY', path: P('kot_summary', 'employees'), method: 'get', actor: unregisteredGoogle(OUTSIDER) }), // 61-#35
  tcPath({ expectation: 'DENY', path: P('kot_summary', 'employees'), method: 'get', actor: 'anon' }), // 61-#36

  // --- kot_monthly/{ym}/employeeRows/{chunkId}（61-#37〜#39） ---
  tcPath({ expectation: 'ALLOW', path: P('kot_monthly', '2026-08', 'employeeRows', 'chunk0'), method: 'get', actor: { email: V, role: 'viewer' } }), // 61-#37
  tcPath({ expectation: 'DENY', path: P('kot_monthly', '2026-08', 'employeeRows', 'chunk0'), method: 'get', actor: unregisteredGoogle(OUTSIDER) }), // 61-#38
  tcPath({ expectation: 'DENY', path: P('kot_monthly', '2026-08', 'employeeRows', 'chunk0'), method: 'update', actor: 'anon' }), // 61-#39

  // --- freee_import_requests（61-#40〜#45） ---
  tcPath({ expectation: 'ALLOW', path: P('freee_import_requests', 'req1'), method: 'get', actor: { email: A, role: 'admin' } }), // 61-#40
  tcPath({ expectation: 'ALLOW', path: P('freee_import_requests', 'req1'), method: 'create', actor: { email: T, role: 'tax_advisor' } }), // 61-#41
  tcPath({ expectation: 'DENY', path: P('freee_import_requests', 'req1'), method: 'create', actor: EDITOR }), // 61-#42
  tcPath({ expectation: 'DENY', path: P('freee_import_requests', 'req1'), method: 'create', actor: { email: V, role: 'viewer' } }), // 61-#43
  tcPath({ expectation: 'DENY', path: P('freee_import_requests', 'req1'), method: 'get', actor: unregisteredGoogle(OUTSIDER) }), // 61-#44
  tcPath({ expectation: 'DENY', path: P('freee_import_requests', 'req1'), method: 'create', actor: 'anon' }), // 61-#45

  // --- keiei_monthly（61-#46〜#50 + editor get ALLOW追加） ---
  tcPath({ expectation: 'ALLOW', path: P('keiei_monthly', '2026-08'), method: 'get', actor: { email: A, role: 'admin' } }), // 61-#46
  tcPath({ expectation: 'ALLOW', path: P('keiei_monthly', '2026-08'), method: 'update', actor: EDITOR }), // 61-#47
  tcPath({ expectation: 'DENY', path: P('keiei_monthly', '2026-08'), method: 'get', actor: { email: V, role: 'viewer' } }), // 61-#48
  tcPath({ expectation: 'DENY', path: P('keiei_monthly', '2026-08'), method: 'get', actor: unregisteredGoogle(OUTSIDER) }), // 61-#49
  tcPath({ expectation: 'DENY', path: P('keiei_monthly', '2026-08'), method: 'update', actor: 'anon' }), // 61-#50
  tcPath({ expectation: 'ALLOW', path: P('keiei_monthly', '2026-08'), method: 'get', actor: EDITOR }), // 追加: readもisStaff()限定でeditorは含まれる→ALLOW

  // --- homecareData（61-#51〜#56 + create所有者チェック追加分） ---
  tcPath({ expectation: 'ALLOW', path: P('homecareData', 'kashiwa_2026-08'), method: 'get', actor: { email: V, role: 'viewer' } }), // 61-#51
  tcPath({ expectation: 'ALLOW', path: P('homecareData', 'kashiwa_2026-08'), method: 'create', actor: { email: G, role: 'viewer_gakujutsu' }, requestResourceData: { uploadedBy: google(G).uid } }), // 61-#52 を第2版に合わせてrequestResourceData追加（uploadedBy==auth.uid一致が必須のため）
  tcPath({ expectation: 'DENY', path: P('homecareData', 'kashiwa_2026-08'), method: 'get', actor: unregisteredGoogle(OUTSIDER) }), // 61-#53
  tcPath({ expectation: 'DENY', path: P('homecareData', 'kashiwa_2026-08'), method: 'create', actor: unregisteredGoogle(OUTSIDER), requestResourceData: { uploadedBy: 'u_outsider' } }), // 61-#54
  tcPath({ expectation: 'DENY', path: P('homecareData', 'kashiwa_2026-08'), method: 'get', actor: 'anon' }), // 61-#55
  tcPath({ expectation: 'DENY', path: P('homecareData', 'kashiwa_2026-08'), method: 'update', actor: 'anon', resourceData: { uploadedBy: 'u_someone' } }), // 61-#56 を第2版で ALLOW→DENY に訂正: homecareData update の isAnon 撤去（homecare_recompute.mjsは第3版でAdmin SDK移行まで実行不可）
  tcPath({ expectation: 'DENY', path: P('homecareData', 'kashiwa_2026-08'), method: 'create', actor: { email: G, role: 'viewer_gakujutsu' }, requestResourceData: { uploadedBy: 'u_someone_else' } }), // 追加（反証[high]是正の検証）: uploadedByが自分のuidと不一致→DENY（なりすまし拒否）

  // --- homecareRows/{docId}(+chunks)（61-#57〜#61） ---
  tcPath({ expectation: 'ALLOW', path: P('homecareRows', 'kashiwa_2026-08'), method: 'get', actor: { email: V, role: 'viewer' } }), // 61-#57
  tcPath({ expectation: 'ALLOW', path: P('homecareRows', 'kashiwa_2026-08'), method: 'update', actor: { email: V, role: 'viewer' } }), // 61-#58
  tcPath({ expectation: 'DENY', path: P('homecareRows', 'kashiwa_2026-08'), method: 'get', actor: unregisteredGoogle(OUTSIDER) }), // 61-#59
  tcPath({ expectation: 'DENY', path: P('homecareRows', 'kashiwa_2026-08'), method: 'update', actor: unregisteredGoogle(OUTSIDER) }), // 61-#60
  tcPath({ expectation: 'DENY', path: P('homecareRows', 'kashiwa_2026-08'), method: 'get', actor: 'anon' }), // 61-#61

  // --- 2026-10-08 追加（未網羅テストの補完） ---
  // kot_summary write（firestore.rules:134 write: hasUserDoc() && isStaff()）
  tcPath({ expectation: 'ALLOW', path: P('kot_summary', 'employees'), method: 'update', actor: EDITOR }),
  tcPath({ expectation: 'DENY', path: P('kot_summary', 'employees'), method: 'update', actor: { email: V, role: 'viewer' } }),
  tcPath({ expectation: 'DENY', path: P('kot_summary', 'employees'), method: 'update', actor: 'anon' }),

  // homecareData delete（firestore.rules:165 delete: hasUserDoc() && (isEditor() || isHomecareOwner())）
  tcPath({ expectation: 'ALLOW', path: P('homecareData', 'kashiwa_2026-08'), method: 'delete', actor: EDITOR }),
  tcPath({ expectation: 'ALLOW', path: P('homecareData', 'kashiwa_2026-08'), method: 'delete', actor: { email: V, role: 'viewer' }, resourceData: { uploadedBy: google(V).uid } }), // 本人（uploadedBy=uid一致）
  tcPath({ expectation: 'DENY', path: P('homecareData', 'kashiwa_2026-08'), method: 'delete', actor: { email: V, role: 'viewer' }, resourceData: { uploadedBy: 'u_someone' } }), // 別人の viewer
  tcPath({ expectation: 'DENY', path: P('homecareData', 'kashiwa_2026-08'), method: 'delete', actor: unregisteredGoogle(OUTSIDER), resourceData: { uploadedBy: 'u_someone' } }),

  // pdfChunks delete（firestore.rules:84）
  tcPath({ expectation: 'ALLOW', path: P('salesData', '2026-08_kashiwa', 'pdfChunks', 'chunk0'), method: 'delete', actor: EDITOR }),
  tcPath({ expectation: 'ALLOW', path: P('salesData', '2026-08_kashiwa', 'pdfChunks', 'chunk0'), method: 'delete', actor: { email: V, role: 'viewer' }, extraMocks: docMock(P('salesData', '2026-08_kashiwa'), { submittedBy: V }) }), // 提出者本人

  // salesDeleteQueue get/delete（firestore.rules:109,111 read/delete: hasUserDoc() || isAnon()）
  tcPath({ expectation: 'ALLOW', path: P('salesDeleteQueue', '2026-08_kashiwa'), method: 'get', actor: { email: V, role: 'viewer' } }),
  tcPath({ expectation: 'ALLOW', path: P('salesDeleteQueue', '2026-08_kashiwa'), method: 'delete', actor: { email: V, role: 'viewer' } }),
  tcPath({ expectation: 'DENY', path: P('salesDeleteQueue', '2026-08_kashiwa'), method: 'get', actor: unregisteredGoogle(OUTSIDER) }),
  tcPath({ expectation: 'DENY', path: P('salesDeleteQueue', '2026-08_kashiwa'), method: 'delete', actor: unregisteredGoogle(OUTSIDER) }),

  // kot_monthly/{ym}/employeeRows write（firestore.rules:200 write: hasUserDoc() && isStaff()）
  tcPath({ expectation: 'ALLOW', path: P('kot_monthly', '2026-08', 'employeeRows', 'chunk0'), method: 'update', actor: EDITOR }),
  tcPath({ expectation: 'DENY', path: P('kot_monthly', '2026-08', 'employeeRows', 'chunk0'), method: 'update', actor: { email: V, role: 'viewer' } }),

  // method:'update' 版の補完
  tcPath({ expectation: 'ALLOW', path: P('salesData', '2026-08_kashiwa', 'pdfChunks', 'chunk0'), method: 'update', actor: { email: V, role: 'viewer' }, extraMocks: docMock(P('salesData', '2026-08_kashiwa'), { submittedBy: V }) }), // 提出者本人
  tcPath({ expectation: 'ALLOW', path: P('salesDeleteQueue', '2026-08_kashiwa'), method: 'update', actor: EDITOR }),
];

const testCases = [...legacyTestCases, ...newTestCases, ...v2TestCases];

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
