// 1ファイルのHTMLにまとめる（公開用＝artifact に publish する本文、テスト用とGitHub用＝そのまま開ける完全なHTML）
const fs = require('fs');
const path = require('path');
const src = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
let html = src('template.html');
// シミュレーターの見本（CPUだけの大会の記録）。無ければ null
const samplePath = path.join(__dirname, 'src', 'sim-sample.json');
const sample = fs.existsSync(samplePath) ? fs.readFileSync(samplePath, 'utf8').replace(/<\//g, '<\\/') : 'null';
html = html.replace('/*ENGINE*/', () => src('engine.js'))
           .replace('/*AI*/', () => src('ai.js'))
           .replace('/*SIM*/', () => src('sim.js'))
           .replace('/*SAMPLE*/', () => sample)
           .replace('/*AUDIO*/', () => src('audio.js'))
           .replace('/*UI*/', () => src('ui.js'));
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'searchbattle.html'), html);
const full = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
  + '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style>'
  + '</head><body>' + html + '</body></html>';
fs.writeFileSync(path.join(__dirname, 'dist', 'test.html'), full);
// GitHub のランチャー（index.html と同じ階層）に置く版：そのまま開ける完全なHTML（ランチャーが参照するファイル名）
fs.writeFileSync(path.join(__dirname, 'dist', 'search_battle.html'), full);
console.log('built', (html.length / 1024).toFixed(1) + 'KB');
