#!/usr/bin/env node
// サーチバトル — 画面に出る文言の書き出しと書き戻し（2026-11-04。ユーザーの依頼：文言を自分で編集したい）
//  extract：src の JS（文字列・テンプレート文字列）と template.html（本文・title などの属性）から、
//   日本語を含む文言と、大文字の英語の表示（ACID・STEALTH HIT など）を抜き出して JSON にする。コメントは抜き出さない。
//   HTML の入った文字列は、タグの外の文だけを1つずつ抜き出す（タグは書き換えの対象にしない）。
//   テンプレート文字列の ${…}（名前や数などの差し込み）は {{1}}・{{2}} の札にして、vars に元の式を添える。
//   札は文の中で動かしてよい（順番を変えてよい）。消してもよい（その情報が出なくなる）が、増やしたり同じ札を2回使ったりはできない。
//  apply：編集した JSON を読み、text が書き出したときと変わったものだけをソースに書き戻す。
//   書き出したあとにソースが変わって、その文言の場所が合わなくなったものは書き戻さずに知らせる。
//  使い方:
//   node tools/texts.js extract [--out texts]            （texts フォルダに、カテゴリごとの JSON を書く）
//   node tools/texts.js apply texts [--dry]               （フォルダごと。ファイルを並べてもよい）
//  JS の読み取りに acorn を使う（なければ `npm i acorn acorn-walk`。置き場所は環境変数 SB_DEPS でも指定できる）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const JS_FILES = ['src/engine.js', 'src/ui.js', 'src/net.js', 'src/sim.js', 'src/ai.js', 'src/audio.js'];
const HTML_FILES = ['src/template.html'];
const JA = /[぀-ヿ㐀-鿿！-｠　-〿]/;
// 大文字の英語の表示（演出の文字など）。コードの識別子（小文字）は拾わない
const EN = /^(?=.*[A-Z]{2})[A-Z][A-Za-z0-9 !?'’.:\-…/&+%#()]*$/;
// 句読点だけの切れ端（「）」「：」）と、コードの記号（列の文字・正規化の名前など）は外す
const LETTER = /[\u3040-\u30ff\u3400-\u9fffA-Za-z\uff21-\uff3a\uff41-\uff5a]/;
const NOT_TEXT = /^(ABCDE.*|NFK?[CD]|BUTTON|INPUT|SELECT|TEXTAREA)$/;
const isText = (s) => { const t = s.trim(); if (!LETTER.test(t) || NOT_TEXT.test(t)) return false; return JA.test(t) || (t.length >= 3 && EN.test(t)); };

function req(name) {
  const tries = [process.env.SB_DEPS && path.join(process.env.SB_DEPS, 'node_modules', name), name].filter(Boolean);
  for (const t of tries) { try { return require(t); } catch (e) { /* 次を試す */ } }
  console.error(`${name} が見つかりません。npm i acorn acorn-walk を実行するか、SB_DEPS にその場所を入れてください`);
  process.exit(1);
}
// カテゴリ（2026-11-04。ユーザーの依頼：目に触れる順に分けて編集する）。where のいちばん外の名前で決める。どれにも入らないものは「5_その他」
const CATEGORIES = [
  { name: '1_ルールとアイテム', note: 'ルール画面・アイテムとキューブの名前と説明', test: (f, w) =>
    (f === 'src/ui.js' && /^(rulesModal|itemHead|chipHTML|stepsHTML)$/.test(w)) || f === 'src/template.html' ||
    (f === 'src/engine.js' && /^(acid|bazooka|cross|cube|homing|line|node|number|pair|shape|stealth|warp|makeRules|pieceName|[A-Z]\d|\(top\))$/.test(w)) },
  { name: '2_タイトル・配置・対戦', note: 'タイトル・キューブの配置・ドラフト・対戦中の案内と演出の文字・エラーの知らせ', test: (f, w) =>
    (f === 'src/ui.js' && /^(renderTitle|renderSetup|setupCell|setupDrag\w*|setup-done|renderDraft|draft-pick|renderBattle|dockHTML|phaseText|playItem|startItem|play|hudHTML|ownBoard|ownCell|predBoard|predCell|intelFor|intelTagsHTML|cellTagHTML|cubeMenuHTML|memoBarHTML|toggleMemo|fieldChips|field|side|scoreHTML|answer-submit|handleAnswer\w*|skip-call|warp\w*|useItem|cubePips|held|heldCubes|setSound|sfx|quitModal|startGame|itemCountHTML|itemsHTML|itemsSummary|foeName|acid|bazooka|node|number|shape|x|o|t|btn|tre|row|all|off|icnt|random|restore|warp-done)$/.test(w)) ||
    (f === 'src/engine.js' && /^(validateItem|checkPlacement|placePiece|finishSetup|draftPick|setTreasure|_warpDest)$/.test(w)) },
  { name: '3_ログ・結果・大会', note: '対戦ログ・試合の結果・リプレイ・大会の画面と順位表・CPUの性格', test: (f, w) =>
    (f === 'src/engine.js' && /^(call|answer|useItem|treasureCall|_warpFire|_revealAll|_checkEnd|_startPlay|_acidTick|sacrifice|skipCall|lineLabel|coordList|matchOpts|create|std|mass|save|steady|items|Game)$/.test(w)) ||
    (f === 'src/ui.js' && /^(resultHTML|historyHTML|renderReplay|replaySkeleton|openReplay|replay-open|pctOverlay|probeLabel|renderTour|standingsHTML|matchCardHTML|rarePickHTML|tour\w*|gemsHTML|gemCellHTML|tieTag|vicText|speedText|refreshTourChoices|cpuRun|lost|left|picks|crit|avatar|tour-next)$/.test(w)) },
  { name: '4_シミュレーター・オンライン', note: 'シミュレーター画面・オンライン対戦のロビーと知らせ', test: (f, w) =>
    f === 'src/sim.js' || f === 'src/net.js' || (f === 'src/ui.js' && /^(sim\w*|renderSim|renderLobby|lobbyJoin|net\w*|guestPrecheck|ng|version|full|timeout)$/.test(w)) },
];
const categoryOf = (e) => { const w = (e.where || '(top)').split(' › ')[0]; const c = CATEGORIES.find((k) => k.test(e.file, w)); return c ? c.name : '5_その他'; };
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
const lineOf = (src, off) => src.slice(0, off).split('\n').length;

// HTML の入った文字列を「タグ」と「文」に分ける。pieces は [{ s, a, b, tag }]（a・b はソースの位置）
//  chars：1文字ずつの { ch, a, b }（${…} の差し込みは1つの「式」としてまとめて入る：{ expr, a, b }）
function splitRuns(chars) {
  const runs = [];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (!c.expr && c.ch === '<') {
      // タグ：> まで（中の差し込みもタグの一部）
      let j = i + 1;
      while (j < chars.length && !(!chars[j].expr && chars[j].ch === '>')) j++;
      i = j + 1;
      continue;
    }
    const start = i;
    while (i < chars.length && !(!chars[i].expr && chars[i].ch === '<')) i++;
    runs.push(chars.slice(start, i));
  }
  return runs;
}

// 1つの文（chars の並び）を書き出す形にする。前後の空白と、前後にある差し込みは外す（文の外に置いたまま）
// ソースの書き方（\n・\'・\` など）を、読める形に直す（書き戻すときに付け直す）
function unescapeRaw(t) { return t.replace(/\\([\\nt'"`$])/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c)); }
function runEntry(run) {
  let a = 0, b = run.length;
  const blank = (c) => !c.expr && /\s/.test(c.ch);
  while (a < b && (blank(run[a]) || run[a].expr)) a++;
  while (b > a && (blank(run[b - 1]) || run[b - 1].expr)) b--;
  if (a >= b) return null;
  const part = run.slice(a, b);
  let text = '';
  const vars = [];
  for (const c of part) {
    if (c.expr) { if (c.complex) return { split: true }; vars.push(c.src); text += `{{${vars.length}}}`; }
    else text += c.ch;
  }
  const plain = part.filter((c) => !c.expr).map((c) => c.ch).join('');
  if (!isText(plain)) return null;
  text = unescapeRaw(text);
  return { text, vars, a: part[0].a, b: part[part.length - 1].b };
}

// プログラムの中で見分けるのに使っている文字（形の分類 R型・L型・T型・Z型 など）。書き換えるとゲームが壊れるので、そのものだけの文字列は書き出さない
//  （文の中に出てくるのはかまわない）。engine.js の CATS から読む
const KEY_WORDS = new Set((/const CATS = \[([^\]]*)\]/.exec(fs.readFileSync(path.join(ROOT, 'src/engine.js'), 'utf8')) || [, ''])[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
function extractJS(file) {
  const acorn = req('acorn'), walk = req('acorn-walk');
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowHashBang: true });
  const out = [];
  // その文言がどこにあるか（いちばん近い関数の名前・オブジェクトのキー）
  const whereOf = (anc) => {
    const names = [];
    for (let k = anc.length - 1; k >= 0; k--) {
      const n = anc[k];
      if (n.type === 'Property' && n.key && names.length < 2) names.unshift(n.key.name || n.key.value);
      if (n.type === 'SwitchCase' && n.test && n.test.type === 'Literal' && names.length < 2) names.unshift(`case ${n.test.value}`);
      if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') && n.id) { names.unshift(n.id.name); break; }
      if (n.type === 'VariableDeclarator' && n.id && n.id.name && (n.init && /Function/.test(n.init.type))) { names.unshift(n.id.name); break; }
      if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression') {
        const s = src.slice(n.left.start, n.left.end);
        if (/prototype|^api\.|^[A-Z]/.test(s) && /Function/.test(n.right.type)) { names.unshift(s.replace(/^.*prototype\./, '')); break; }
      }
    }
    return names.filter(Boolean).join(' › ');
  };
  // 差し込み（${…}）の中に、日本語の文字列やテンプレート文字列があるか（あれば、そこで文を区切る。中の文は別に書き出す）
  const complexExpr = (e) => {
    let found = false;
    walk.full(e, (n) => { if (n.type === 'TemplateLiteral' || (n.type === 'Literal' && typeof n.value === 'string' && isText(n.value))) found = true; });
    return found;
  };
  const push = (entry, anc, kind) => out.push(Object.assign({ file, line: lineOf(src, entry.a), where: whereOf(anc), kind }, entry));
  walk.fullAncestor(ast, (node, _st, anc) => {
    if (node.type === 'Literal' && typeof node.value === 'string') {
      const raw = src.slice(node.start + 1, node.end - 1);
      if (!isText(raw) || KEY_WORDS.has(raw)) return;
      // オブジェクトのキー（{ 'R型': … }）は書き換えるとゲームが壊れるので書き出さない
      const par = anc[anc.length - 2];
      if (par && par.type === 'Property' && par.key === node && !par.computed) return;
      if (par && par.type === 'MemberExpression' && par.property === node) return;
      const q = src[node.start];
      const chars = [];
      for (let i = 0; i < raw.length; i++) chars.push({ ch: raw[i], a: node.start + 1 + i, b: node.start + 2 + i });
      const runs = raw.indexOf('<') >= 0 ? splitRuns(chars) : [chars];
      // 文字列を + でつないでいるとき（size + 'ブロックの…'）、つながる式は差し込みの札にならないので、around でまわりを見せる（… が式）
      let top = null;
      for (let k = anc.length - 2; k >= 0 && anc[k].type === 'BinaryExpression' && anc[k].operator === '+'; k--) top = anc[k];
      let joined = null;
      if (top) {
        const leaves = [];
        const flat = (n) => { if (n.type === 'BinaryExpression' && n.operator === '+') { flat(n.left); flat(n.right); } else leaves.push(n); };
        flat(top);
        joined = leaves.map((n) => (n.type === 'Literal' && typeof n.value === 'string' ? n.value : '…')).join('').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      for (const r of runs) {
        const e = runEntry(r);
        if (!e || e.split) continue;
        if (joined && joined !== e.text) e.around = joined.length > 160 ? joined.slice(0, 160) + '…' : joined;
        push(Object.assign(e, { quote: q, inHtml: raw.indexOf('<') >= 0 }), anc, 'string');
      }
    } else if (node.type === 'TemplateLiteral') {
      const chars = [];
      node.quasis.forEach((q, k) => {
        const raw = src.slice(q.start, q.end);
        for (let i = 0; i < raw.length; i++) chars.push({ ch: raw[i], a: q.start + i, b: q.start + i + 1 });
        const e = node.expressions[k];
        if (e) chars.push({ expr: true, src: src.slice(e.start, e.end), complex: complexExpr(e), a: q.end, b: node.quasis[k + 1].start });
      });
      const hasTag = chars.some((c) => !c.expr && c.ch === '<');
      const runs = hasTag ? splitRuns(chars) : [chars];
      // around：文が差し込みやタグで分かれたとき、どの文の一部かが分かるように、まわりの文（タグを外し、差し込みは …）を添える
      const plainAll = chars.map((c) => (c.expr ? '…' : c.ch)).join('').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      const before = out.length;
      for (const r0 of runs) {
        // 込み入った差し込み（中に別の文がある）で区切る
        const pieces = [];
        let cur = [];
        for (const c of r0) { if (c.expr && c.complex) { pieces.push(cur); cur = []; } else cur.push(c); }
        pieces.push(cur);
        for (const r of pieces) { const e = runEntry(r); if (e && !e.split) push(Object.assign(e, { quote: '`', inHtml: hasTag }), anc, 'template'); }
      }
      if (out.length - before > 1 || node.expressions.some((x) => complexExpr(x))) for (let k = before; k < out.length; k++) if (plainAll.length > out[k].text.length + 2) out[k].around = plainAll.length > 160 ? plainAll.slice(0, 160) + '…' : plainAll;
    }
  });
  return out;
}

function extractHTML(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const out = [];
  // style・script・コメントは飛ばす（同じ長さの空白に置き換えて、位置はそのまま）
  const masked = src.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<!--[\s\S]*?-->/gi, (m) => m.replace(/[^\n]/g, ' '));
  // 本文
  const re = />([^<>]+)</g;
  let m;
  while ((m = re.exec(masked))) {
    const raw = m[1];
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (!text || !isText(text)) continue;
    const a = m.index + 1 + lead;
    out.push({ file, line: lineOf(src, a), where: 'HTML', kind: 'html', text, vars: [], a, b: a + text.length });
  }
  // 属性（title・placeholder・aria-label・alt・content）
  const ra = /\s(title|placeholder|aria-label|alt|content)="([^"]*)"/g;
  while ((m = ra.exec(masked))) {
    if (!isText(m[2])) continue;
    const a = m.index + m[0].indexOf('"') + 1;
    out.push({ file, line: lineOf(src, a), where: `HTML ${m[1]}=`, kind: 'attr', text: m[2], vars: [], a, b: a + m[2].length });
  }
  return out.sort((x, y) => x.a - y.a);
}

function extractAll() {
  const all = [];
  for (const f of JS_FILES) all.push(...extractJS(f));
  for (const f of HTML_FILES) all.push(...extractHTML(f));
  // 同じ場所を2回拾わない（入れ子のテンプレートなど）
  const seen = new Set();
  return all.filter((e) => { const k = e.file + ':' + e.a; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((x, y) => (x.file === y.file ? x.a - y.a : JS_FILES.concat(HTML_FILES).indexOf(x.file) - JS_FILES.concat(HTML_FILES).indexOf(y.file)));
}

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };

if (args[0] === 'extract') {
  const all = extractAll();
  let engineV = null;
  try { engineV = +(/const VERSION = (\d+)/.exec(fs.readFileSync(path.join(ROOT, 'src/engine.js'), 'utf8')) || [])[1]; } catch (e) { /* なし */ }
  const outDir = opt('out', path.join(ROOT, 'texts'));
  fs.mkdirSync(outDir, { recursive: true });
  // 前に書き出したカテゴリのファイルを消してから書く（カテゴリの名前を変えたときに古いファイルが残らないように）
  for (const f of fs.readdirSync(outDir)) if (/\.json$/.test(f)) fs.unlinkSync(path.join(outDir, f));
  const byCat = {};
  for (const e of all) {
    const cat = categoryOf(e);
    const doc = byCat[cat] || (byCat[cat] = { files: {}, count: 0 });
    (doc.files[e.file] || (doc.files[e.file] = [])).push(Object.assign(
      { id: `${path.basename(e.file)}:${e.a}`, line: e.line, where: e.where, text: e.text },
      e.vars.length ? { vars: e.vars } : {},
      e.around ? { around: e.around } : {},
      { h: hash(e.file + '\0' + e.a + '\0' + e.text) }));
    doc.count++;
  }
  const names = CATEGORIES.map((c) => c.name).concat(['5_その他']);
  const notes = Object.fromEntries(CATEGORIES.map((c) => [c.name, c.note]).concat([['5_その他', 'どの画面にも分けられなかった細かい文言']]));
  const lines = [];
  for (const cat of names) {
    const doc = byCat[cat];
    if (!doc) continue;
    const out = { category: cat, about: notes[cat] + '。text だけを書き換えてください（くわしくは README.md）', engineVersion: engineV, extractedAt: new Date().toISOString().slice(0, 10), count: doc.count, files: doc.files };
    fs.writeFileSync(path.join(outDir, cat + '.json'), JSON.stringify(out, null, 1) + '\n');
    lines.push(`${cat} ${doc.count}`);
  }
  console.log(`${all.length} 件を書き出しました（${lines.join('・')}）→ ${outDir}`);
} else if (args[0] === 'apply') {
  // フォルダ（中の .json を全部）か、JSON ファイルを何個でも
  const inputs = [];
  for (const a of args.slice(1)) {
    if (a.startsWith('--')) continue;
    if (fs.statSync(a).isDirectory()) for (const f of fs.readdirSync(a).sort()) { if (/\.json$/.test(f)) inputs.push(path.join(a, f)); }
    else inputs.push(a);
  }
  const doc = { files: {} };
  for (const f of inputs) for (const [k, list] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')).files)) (doc.files[k] || (doc.files[k] = [])).push(...list);
  const dry = args.includes('--dry');
  const cur = new Map(extractAll().map((e) => [`${path.basename(e.file)}:${e.a}`, e]));
  const edits = {};
  let changed = 0, stale = 0, bad = 0;
  for (const [file, list] of Object.entries(doc.files)) {
    for (const x of list) {
      const e = cur.get(x.id);
      // 書き出したときと同じ場所・同じ文か（h で確かめる）
      if (!e || hash(e.file + '\0' + e.a + '\0' + e.text) !== x.h) { if (!e || e.text !== x.text) { stale++; console.error(`場所が合いません（書き出したあとにソースが変わった）：${x.id} 「${x.text.slice(0, 30)}」`); } continue; }
      if (x.text === e.text) continue;
      // 差し込みの札が同じだけあるか
      // 差し込みの札：消すのはよい（その情報を出さなくなるだけ）。元にない札や、同じ札を2回使うのは断る
      const want = new Set(e.text.match(/\{\{\d+\}\}/g) || []);
      const gotList = x.text.match(/\{\{\d+\}\}/g) || [];
      if (gotList.some((t) => !want.has(t)) || new Set(gotList).size !== gotList.length) { bad++; console.error(`差し込みの札が合いません：${x.id}（元 ${[...want].join() || 'なし'}・編集後 ${gotList.join() || 'なし'}）`); continue; }
      let out = x.text;
      if (e.kind === 'string') out = out.replace(/\\/g, '\\\\').split(e.quote).join('\\' + e.quote).replace(/\n/g, '\\n').replace(/\t/g, '\\t');
      if (e.kind === 'template') out = out.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
      if (e.kind === 'attr') out = out.replace(/"/g, '&quot;');
      // HTML の中の文：< はタグにならないように置き換える
      if (e.kind === 'html' || e.kind === 'attr' || e.inHtml) out = out.replace(/</g, '&lt;');
      out = out.replace(/\{\{(\d+)\}\}/g, (_, n) => '${' + e.vars[+n - 1] + '}');
      (edits[e.file] || (edits[e.file] = [])).push({ a: e.a, b: e.b, out });
      changed++;
    }
  }
  if (!dry) for (const [file, list] of Object.entries(edits)) {
    const p = path.join(ROOT, file);
    let src = fs.readFileSync(p, 'utf8');
    for (const ed of list.sort((x, y) => y.a - x.a)) src = src.slice(0, ed.a) + ed.out + src.slice(ed.b);
    fs.writeFileSync(p, src);
  }
  console.log(`${dry ? '（試し）' : ''}書き戻し ${changed} 件・場所が合わない ${stale} 件・札が合わない ${bad} 件`);
  if (stale || bad) process.exitCode = 1;
} else {
  console.log('使い方: node tools/texts.js extract [--out texts] ／ node tools/texts.js apply <フォルダか JSON …> [--dry]');
}
