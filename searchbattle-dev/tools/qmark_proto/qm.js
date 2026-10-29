// 「？」マーク（◎と○が混ざった記号）の試作 その3
//  外の輪は◎・○とも半径14。境界はくねくねした斜めのS字（paths.js）。中心の点は○側に残す
//  H＝くねくね＋ぼかし、I＝境界を煙のように乱し、白い煙（薄いもや＋細い筋）を重ねる、J＝煙を◎と○の色で
const QM = (() => {
  const OO = '<circle cx="20" cy="20" r="14"/><circle cx="20" cy="20" r="7.6"/><path d="M20 2.6v5M20 32.4v5M2.6 20h5M32.4 20h5"/>';
  const O14 = '<circle cx="20" cy="20" r="14"/><circle cx="20" cy="20" r="2.3" style="fill:currentColor;stroke:none"/>';
  const O = '<circle cx="20" cy="20" r="12.6"/><circle cx="20" cy="20" r="2.3" style="fill:currentColor;stroke:none"/>';
  const box = 'maskUnits="userSpaceOnUse" x="-12" y="-12" width="64" height="64"';
  const fbox = 'filterUnits="userSpaceOnUse" x="-14" y="-14" width="68" height="68"';
  const turb = (id, f, sc, bl, seed) => `<filter id="${id}" ${fbox}><feTurbulence type="fractalNoise" baseFrequency="${f}" numOctaves="3" seed="${seed}" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="${sc}" xChannelSelector="R" yChannelSelector="G" result="d"/><feGaussianBlur in="d" stdDeviation="${bl}"/></filter>`;
  let defs = `
    <filter id="qm-glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="qm-soft" ${fbox}><feGaussianBlur stdDeviation="1.4"/></filter>
    ${turb('qm-smoke', 0.16, 6, 1, 7)}
    ${turb('qm-haze', 0.12, 9, 2.2, 4)}
    ${turb('qm-wisp', 0.26, 6, 0.6, 9)}
    <filter id="qm-haze-a" ${fbox}><feTurbulence type="fractalNoise" baseFrequency="0.12" numOctaves="3" seed="4" result="n"/><feOffset in="n" result="m"><animate attributeName="dx" values="0;3;0;-3;0" dur="6s" repeatCount="indefinite"/><animate attributeName="dy" values="0;-4;0;4;0" dur="4.5s" repeatCount="indefinite"/></feOffset><feDisplacementMap in="SourceGraphic" in2="m" scale="9" xChannelSelector="R" yChannelSelector="G" result="d"/><feGaussianBlur in="d" stdDeviation="2.2"/></filter>
    <filter id="qm-wisp-a" ${fbox}><feTurbulence type="fractalNoise" baseFrequency="0.26" numOctaves="3" seed="9" result="n"/><feOffset in="n" result="m"><animate attributeName="dx" values="0;-2.5;0;2.5;0" dur="5s" repeatCount="indefinite"/><animate attributeName="dy" values="0;3;0;-3;0" dur="3.5s" repeatCount="indefinite"/></feOffset><feDisplacementMap in="SourceGraphic" in2="m" scale="6" xChannelSelector="R" yChannelSelector="G" result="d"/><feGaussianBlur in="d" stdDeviation="0.6"/></filter>
    <radialGradient id="qm-rad"><stop offset=".6" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>
    <mask id="qm-fade" ${box}><circle cx="20" cy="20" r="19" fill="url(#qm-rad)"/></mask>`;
  for (const [v, f] of [['H', 'qm-soft'], ['I', 'qm-smoke'], ['J', 'qm-smoke'], ['K', 'qm-smoke']]) {
    defs += `<mask id="qm${v}-oo" ${box}><path d="${QM_REGION}" fill="#fff" filter="url(#${f})"/></mask>`;
    defs += `<mask id="qm${v}-o" ${box}><rect x="-12" y="-12" width="64" height="64" fill="#fff"/><path d="${QM_REGION}" fill="#000" filter="url(#${f})"/></mask>`;
  }
  // 煙：境界線に沿って、広くて薄いもやと、細い筋を重ねる（記号の外側では消える）
  const L = (stroke, w, op, f, tr) => `<path d="${QM_LINE}"${tr ? ` transform="translate(${tr})"` : ''} fill="none" stroke="${stroke}" stroke-width="${w}" stroke-opacity="${op}" filter="url(#${f})"/>`;
  const wisp = (v) => {
    if (v === 'I') return `<g mask="url(#qm-fade)">${L('#E9DEFF', 7, 0.2, 'qm-haze')}${L('#FFF2F8', 1.6, 0.55, 'qm-wisp')}</g>`;
    if (v === 'K') return `<g mask="url(#qm-fade)">${L('#E9DEFF', 7, 0.2, 'qm-haze-a')}${L('#FFF2F8', 1.6, 0.55, 'qm-wisp-a')}</g>`;
    if (v === 'J') return `<g mask="url(#qm-fade)">${L('var(--magenta)', 6, 0.3, 'qm-haze', '-1.6 -1.2')}${L('var(--hit)', 6, 0.3, 'qm-haze', '1.6 1.2')}${L('#FFF2F8', 1.4, 0.4, 'qm-wisp')}</g>`;
    return '';
  };
  const svg = (v) => `<svg class="mk" viewBox="0 0 40 40" aria-hidden="true"><g filter="url(#qm-glow)"><g mask="url(#qm${v}-oo)" style="color:var(--magenta)">${OO}</g><g mask="url(#qm${v}-o)" style="color:var(--hit)">${O14}</g>${wisp(v)}</g></svg>`;
  return { defs, svg, OO, O };
})();
