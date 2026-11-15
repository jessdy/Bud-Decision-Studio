// Models, after LM Studio's My Models: a table of every model on the left, an inspector on the right with
// Overview, a comparison with Jev, and Load settings. #/models/<id> selects a model.

import { openChooser } from '../chooser.js';
import { EXAMPLES } from '../examples.js';
import { guideFor } from '../model-guides.js';
import { setSub } from '../shell.js';
import { api, cancelDownload, download, downloadPct, ejectModel, loadModel, phaseOf, phaseTrack, refresh, registry, setPref, store } from '../store.js';
import { $, $$, askText, confirmDialog, esc, fmtBytes, fmtDuration, fmtGB, icon, term, toast } from '../util.js';

let root, reg;
let selected = null;
let tab = 'overview';
let filter = { q: '', show: 'all', input: 'any' };
let sort = { key: 'recommended', dir: 1 };
let finder = { input: 'text', language: 'en', priority: 'balanced' };

// Registry text comes from publishers; normalise its dashes to the studio's plain punctuation.
const clean = (s) => String(s ?? '').replace(/(\d)\s*[–—]\s*(\d)/g, '$1 to $2').replace(/\s+[—–]\s+/g, ': ').replace(/[—–]/g, '-');
const isLocal = (u) => !/^https?:\/\//.test(String(u || ''));   // sources that are not web pages
const JEV = '__jev';

export async function mount(el, p = {}) {
  root = el;
  root.innerHTML = '<div class="view"><div class="empty"><p>正在加载注册表。</p></div></div>';
  reg = await registry();
  if (root !== el || !el.isConnected) return;
  const ms = store.state?.models || [];
  selected = p.id || selected || ms.find((m) => m.worker?.status === 'ready')?.id || 'intern-decision-4b';
  render();
}
export function onState() {
  if (!root?.isConnected || !reg || !$('#mtable', root)) return;
  renderTable();
  if (!$('#insp .hero', root)) renderInspector(); else { renderActs(); if (tab === 'load') renderTab(); }
}

function render() {
  root.innerHTML = `<div class="view panes models-view">
    <section class="pane" aria-label="全部模型">
      <div class="pane-head">
        <label class="search">${icon('magnifying-glass')}<input id="q" placeholder="筛选模型" value="${esc(filter.q)}" aria-label="筛选模型"></label>
        <span class="seg" role="group" aria-label="显示">${[['all', '全部'], ['downloaded', '本机'], ['loaded', '已加载']].map(([v, l]) => `<button data-show="${v}" aria-pressed="${filter.show === v}">${l}</button>`).join('')}</span>
        <select class="select" id="input" aria-label="输入" style="width:auto;height:28px;min-height:28px;padding-top:2px;padding-bottom:2px">
          ${[['any', '任意输入'], ['image', '可读图像'], ['av', '音视频'], ['multi', '多语言']].map(([v, l]) => `<option value="${v}" ${filter.input === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <div class="right">
          <button class="btn btn-plain sm" id="help">${icon('lightbulb')}帮我选择</button>
          <button class="btn btn-plain sm" id="addlocal">${icon('hard-drive')}添加本地模型</button>
          <button class="btn sm" id="dlall">${icon('cloud-arrow-down')}下载模型</button>
        </div>
      </div>
      <div id="mtable"></div>
    </section>
    <aside class="pane white m-insp" id="insp" aria-label="模型详情"></aside>
  </div>`;
  $('#q', root).addEventListener('input', (e) => { filter.q = e.target.value; renderTable(); });
  $$('[data-show]', root).forEach((b) => b.addEventListener('click', () => { filter.show = b.dataset.show; $$('[data-show]', root).forEach((x) => x.setAttribute('aria-pressed', x === b)); renderTable(); }));
  $('#input', root).addEventListener('change', (e) => { filter.input = e.target.value; renderTable(); });
  $('#help', root).addEventListener('click', helpMeChoose);
  $('#addlocal', root).addEventListener('click', addCustomModel);
  $('#dlall', root).addEventListener('click', () => openChooser());
  $('#mtable', root).addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) { const k = th.dataset.sort; sort = { key: k, dir: sort.key === k ? -sort.dir : 1 }; renderTable(); return; }
    if (e.target.closest('button, a')) return;
    const tr = e.target.closest('tr[data-id]');
    if (tr) select(tr.dataset.id);
  });
  $('#mtable', root).addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr[data-id]');
    const m = tr && store.state.models.find((x) => x.id === tr.dataset.id);
    if (m?.worker?.status === 'ready') location.hash = `#/playground?model=${m.id}`;
  });
  $('#mtable', root).addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const rows = $$('tr[data-id]', root); const i = rows.findIndex((r) => r.dataset.id === selected);
    const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (n) { e.preventDefault(); select(n.dataset.id); n.focus(); }
  });
  renderTable(); renderInspector();
}

function select(id) {
  selected = id;
  history.replaceState(null, '', id === JEV ? '#/models' : `#/models/${id}`);
  $$('tr[data-id]', root).forEach((r) => r.classList.toggle('sel', r.dataset.id === id));
  renderInspector();
}

// ------------------------------------------------------------------ numbers and comparisons
const paramsNum = (p) => { const m = String(p).match(/([\d.]+)\s*([MB])/i); return m ? +m[1] * (m[2].toUpperCase() === 'B' ? 1 : 0.001) : 0; };
function scaled(b, v) { if (v == null) return null; return b.unit === 'ratio' && b.higher_is_better ? v * 100 : v; }
function fmtVal(b, v, display) {
  if (display) return clean(display);
  if (v == null) return '不适用';
  if (b.unit === '%') return `${+v.toFixed(1)}%`;
  if (b.unit === 'ratio') return b.higher_is_better ? `${+(v * 100).toFixed(1)}%` : v.toFixed(3);
  if (b.unit === 'score') return `${+v.toFixed(1)}`;
  return `${+(+v).toPrecision(4)} ${clean(b.unit)}`;
}
const wins = (b) => (b.higher_is_better ? b.model > b.jev : b.model < b.jev);
const level = (b) => b.model === b.jev;
function h2h(r) {
  const rows = [...(r?.benchmarks || []), ...(r?.independent || [])].filter((b) => b.model != null && b.jev != null);
  const w = rows.filter(wins).length, t = rows.filter(level).length;
  return { rows, w, t, l: rows.length - w - t, n: rows.length, rate: rows.length ? w / rows.length : -1 };
}
const onPctAxis = (b) => ['%', 'score'].includes(b.unit) || (b.unit === 'ratio' && b.higher_is_better);
function winbar(s, cls = '') {
  if (!s.n) return `<span class="winbar ${cls}" aria-hidden="true"></span>`;
  return `<span class="winbar ${cls}" role="img" aria-label="在 ${s.n} 项公开结果中领先 Jev ${s.w} 项、持平 ${s.t} 项、落后 ${s.l} 项"><i class="a" style="flex:${s.w}"></i>${s.t ? `<i class="t" style="flex:${s.t}"></i>` : ''}${s.l ? `<i class="b" style="flex:${s.l}"></i>` : ''}</span>`;
}
function dumbbell(b) {
  const m = scaled(b, b.model), j = scaled(b, b.jev);
  const x = (v) => `${Math.max(0, Math.min(100, v)).toFixed(2)}%`;
  const lo = Math.min(m, j), hi = Math.max(m, j);
  return `<div class="dumbbell" role="img" aria-label="本模型 ${esc(fmtVal(b, b.model, b.model_display))}，Jev ${esc(fmtVal(b, b.jev, b.jev_display))}">
    <span class="span" style="left:${x(lo)};width:calc(${x(hi)} - ${x(lo)})"></span><span class="dot j" style="left:${x(j)}"></span><span class="dot m" style="left:${x(m)}"></span></div>`;
}
function headlineRows(rows, max = 6) {
  const seen = new Set();
  return rows.filter(onPctAxis).filter((b) => { const k = clean(b.suite).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, max);
}

// ------------------------------------------------------------------ small pieces
function logoFor(m, r, cls = '') {
  if (m?.base_id && !r?.maker_id) r = reg.models[m.base_id] || r;     // a trained model wears its original's logo
  const maker = reg.makers[r?.maker_id] || {};
  const src = maker.avatar || r?.logo || maker.logo;
  return `<span class="logo ${cls}">${src ? `<img src="/ui/${esc(src)}" alt="" loading="lazy">` : icon('cube')}</span>`;
}
const INPUT_ICON = { text: 'text-t', image: 'image', audio: 'speaker-high', video: 'film-strip' };
const INPUT = { text: '文本', image: '图像', audio: '音频', video: '视频' };
const inputs = (m) => m.modalities.map((k) => INPUT[k]).join('、').replace(/、([^、]*)$/, ' 与 $1');
const inputIcons = (m) => m.modalities.map((k) => `<span data-tip="${INPUT[k]}">${icon(INPUT_ICON[k])}</span>`).join('');
const lang = (m) => clean(m.languages).replace(/\s*\(.*\)/, '');

function statusWord(m) {
  const st = store.state;
  const d = m.download;
  if (st.downloads?.active?.model_id === m.id) {
    const got = d.have + d.partial, speed = st.downloads.active.speed_bps;
    const eta = speed > 0 ? (d.total - got) / speed : null;
    return `正在下载 ${downloadPct(m)}%${eta ? `，剩余 ${fmtDuration(eta)}` : ''}`;
  }
  if (m.worker?.status === 'ready') return '已加载';
  if (m.worker?.status === 'error') return '加载失败';
  if (m.worker) return esc(m.worker.stage || '加载中');
  if (m.fit && !m.fit.ok) return `<span data-tip="${esc(m.fit.reason)}">${esc(m.fit.short || (m.needs_gpu && st.runtime?.device === 'cpu' ? '需要 GPU' : '本机容量不足'))}</span>`;
  if (m.local) return '本地目录';
  if (m.downloaded) return '本机已有';
  if (st.downloads?.queue?.includes(m.id)) return '排队中';
  return fmtBytes(d.remaining || m.download_bytes);
}
function actions(m, { size = 'sm', full = false, quiet = false, single = false } = {}) {
  const st = store.state;
  const free = st.system.mem_available_gb;
  const fits = free == null || m.memory_gb <= free + 1;
  const primary = quiet ? 'btn-quiet' : 'btn-primary';
  if (m.worker?.status === 'ready') return `<a class="btn ${primary} ${size}" href="#/playground?model=${m.id}">${icon('play')}${full ? '在试验台中试用' : '试用'}</a>${single ? '' : `<button class="btn btn-quiet ${size}" data-eject="${m.id}">${icon('eject')}卸载</button>`}`;
  if (m.worker?.status === 'error') return `<button class="btn ${primary} ${size}" data-load="${m.id}">${icon('arrows-clockwise')}重试</button>${full ? `<button class="btn btn-quiet ${size}" data-logs="${m.id}">${icon('scroll')}查看日志</button>` : ''}`;
  if (m.worker) return `<button class="btn btn-quiet ${size}" data-eject="${m.id}">${icon('x')}取消</button>`;
  if (st.downloads?.active?.model_id === m.id || st.downloads?.queue?.includes(m.id)) return `<button class="btn btn-quiet ${size}" data-cancel="${m.id}">${icon('stop')}取消</button>`;
  if (m.fit && !m.fit.ok) return full ? `<span class="small muted">${esc(m.fit.reason)}</span>` : '';
  if (m.downloaded) return `<button class="btn ${primary} ${size}" data-load="${m.id}" ${fits ? '' : `data-tip="约需 ${fmtGB(m.memory_gb)} 内存；当前仅余 ${fmtGB(free)}。请先卸载其他模型。"`}>${icon('play')}加载</button>`;
  if (m.fit && !m.fit.ok) return full ? `<span class="small muted">${esc(m.fit.reason)}</span>` : '';
  if (m.custom) return full ? `<span class="small muted">请先确认本地目录可用</span>` : '';
  const dl = `<button class="btn ${quiet ? 'btn-quiet' : ''} ${size}" data-download="${m.id}">${icon('download-simple')}下载${full ? ` ${fmtBytes(m.download.remaining || m.download_bytes)}` : ''}</button>`;
  const local = full || !quiet
    ? `<button class="btn btn-quiet ${size}" data-local="${m.id}">${icon('hard-drive')}从本地目录…</button>`
    : `<button class="icon-btn" data-local="${m.id}" aria-label="从本地目录加载" data-tip="从本地目录加载">${icon('hard-drive')}</button>`;
  return `${dl}${local}`;
}
function bindActions(box) {
  $$('[data-download]', box).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); download(b.dataset.download); }));
  $$('[data-cancel]', box).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); cancelDownload(b.dataset.cancel); }));
  $$('[data-load]', box).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); loadModel(b.dataset.load); }));
  $$('[data-eject]', box).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); ejectModel(b.dataset.eject); }));
  $$('[data-logs]', box).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); showLogs(b.dataset.logs); }));
  $$('[data-delete]', box).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); del(b.dataset.delete); }));
  $$('[data-local]', box).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); bindLocal(b.dataset.local); }));
  $$('[data-unbind]', box).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); unbindLocal(b.dataset.unbind); }));
  $$('[data-rmcustom]', box).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); removeCustom(b.dataset.rmcustom); }));
}

// ------------------------------------------------------------------ table
const rankScore = (m) => (m.worker ? 100 : 0) + (m.downloaded ? 50 : 0) + (m.badge === 'Start here' ? 30 : 0) + Math.log10((m.likes || 1) + 1);
function renderTable() {
  const st = store.state;
  const box = $('#mtable', root);
  if (!st || !box) return;
  let list = st.models.slice();
  const q = filter.q.trim().toLowerCase();
  if (q) list = list.filter((m) => `${m.name} ${m.maker} ${m.tagline} ${m.languages}`.toLowerCase().includes(q));
  if (filter.show === 'downloaded') list = list.filter((m) => m.downloaded || m.worker);
  if (filter.show === 'loaded') list = list.filter((m) => m.worker);
  if (filter.input === 'image') list = list.filter((m) => m.modalities.includes('image'));
  if (filter.input === 'av') list = list.filter((m) => m.modalities.includes('audio'));
  if (filter.input === 'multi') list = list.filter((m) => !/^English$/.test(m.languages));
  const key = { recommended: (m) => -rankScore(m), name: (m) => m.name.toLowerCase(), size: (m) => paramsNum(m.params), memory: (m) => m.memory_gb, jev: (m) => -h2h(reg.models[m.id]).rate };
  const f = key[sort.key] || key.recommended;
  list.sort((a, b) => { const x = f(a), y = f(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; });
  const th = (k, label, cls = '') => `<th class="${cls}" data-sort="${k}" style="cursor:pointer" aria-sort="${sort.key === k ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${label}${sort.key === k ? icon(sort.dir > 0 ? 'caret-up' : 'caret-down') : ''}</th>`;
  const rows = list.map((m) => {
    const r = reg.models[m.id] || {};
    const s = h2h(r);
    return `<tr data-id="${m.id}" class="${m.id === selected ? 'sel' : ''}" tabindex="0">
      <td><div class="mname">${logoFor(m, r, 'sm')}<div style="min-width:0"><b>${esc(m.name)}${m.badge === 'Start here' ? ' <span class="chip violet tag">从这里开始</span>' : m.custom || m.badge === '本地' ? ' <span class="chip tag">本地</span>' : m.base_id ? ' <span class="chip tag">微调</span>' : ''}</b><span>${esc(clean(m.tagline))}</span></div></div></td>
      <td class="num">${esc(m.params)}</td>
      <td class="num">${fmtGB(m.memory_gb)}</td>
      <td><span class="ins">${inputIcons(m)}</span></td>
      <td>${m.base_id ? `<span class="vsj"><span class="num" data-tip="训练前后在留出样本上的表现">${esc(String(m.headline_metric || '').replace(/ on held-out examples$/, ''))}</span></span>` : `<span class="vsj">${winbar(s)}${s.n ? `<span class="num">${s.w} / ${s.n}</span>` : '<span>暂无</span>'}</span>`}</td>
      <td><div class="st"><span class="word" title="${esc(statusWord(m).replace(/<[^>]+>/g, ''))}">${phaseTrack(m)}${store.state.downloads?.active?.model_id === m.id ? ` <span class="num">${downloadPct(m)}%</span>` : m.worker && m.worker.status !== 'ready' ? ' 加载中' : ''}</span><span class="row-acts">${actions(m, { quiet: true, single: true })}</span></div></td></tr>`;
  }).join('');
  const jevRow = reg.jev?.name ? `<tr data-id="${JEV}" class="ref ${selected === JEV ? 'sel' : ''}" tabindex="0"><td><div class="mname"><span class="logo sm">${reg.makers[reg.jev.maker_id]?.logo ? `<img src="/ui/${esc(reg.makers[reg.jev.maker_id].logo)}" alt="">` : ''}</span><div><b>${esc(reg.jev.name)} <span class="chip tag">参考</span></b><span>TypeSafe 托管模型，用于对比</span></div></div></td>
    <td class="num muted">不适用</td><td class="num"></td><td><span class="ins">${icon('text-t')}</span></td><td></td><td><div class="st"><span class="word">仅托管</span></div></td></tr>` : '';
  const html = `<table class="table hover mtable"><colgroup><col><col class="c-size"><col class="c-mem"><col class="c-reads"><col class="c-jev"><col class="c-st"></colgroup><thead><tr>${th('name', '模型')}${th('size', '大小', 'num')}${th('memory', '<span data-tip="加载时所需内存">需求</span>', 'num')}<th>输入</th>${th('jev', '领先 Jev')}<th style="text-align:right">状态</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6"><div class="empty" style="padding:24px"><p>没有匹配的模型：「${esc(filter.q)}」</p></div></td></tr>`}${jevRow}</tbody></table>`;
  const onDisk = st.models.filter((m) => m.downloaded).length;
  const disk = diskUse(st.models);
  const foot = `<div class="table-foot">本机 ${onDisk} / ${st.models.length} 个模型，占用磁盘 ${fmtBytes(disk)}。${st.hf_cache ? ` <code>${esc(st.hf_cache)}</code> <a href="#/system">更改文件夹</a>` : ''}</div>`;
  const all = html + foot;
  if (box.dataset.html !== all) { box.dataset.html = all; box.innerHTML = all; bindActions(box); }
  setSub(`本机 ${onDisk} / ${st.models.length}`);
}

// ------------------------------------------------------------------ inspector
function renderInspector() {
  const box = $('#insp', root);
  if (!box) return;
  if (selected === JEV) { box.innerHTML = jevInspector(); return; }
  const m = store.state?.models.find((x) => x.id === selected);
  if (!m) { box.innerHTML = '<div class="empty"><p>请选择一个模型以查看详情。</p></div>'; return; }
  const r = reg.models[m.id] || {};
  const maker = reg.makers[r.maker_id] || {};
  box.innerHTML = `
    <div class="hero">${logoFor(m, r, 'lg')}<div style="min-width:0"><h2>${esc(m.name)}</h2>
      <p>${esc(clean(r.maker || m.maker))}${maker.url ? ` <a href="${esc(maker.url)}" target="_blank" rel="noopener" aria-label="发布方网站">${icon('arrow-square-out')}</a>` : ''}${m.badge ? ` <span class="chip ${m.badge === 'Start here' ? 'violet' : ''}" style="margin-left:4px">${m.badge === 'Start here' ? '从这里开始' : esc(m.badge)}</span>` : ''}</p></div></div>
    <div class="acts" id="acts"></div>
    <div class="tabsbar"><span class="seg full" role="tablist">${[['overview', '概览'], ['jev', '对比 Jev'], ['load', '加载']].map(([k, l]) => `<button role="tab" data-tab="${k}" aria-pressed="${tab === k}" aria-selected="${tab === k}">${l}</button>`).join('')}</span></div>
    <div class="tabbody" id="tabbody"></div>`;
  $$('[data-tab]', box).forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; $$('[data-tab]', box).forEach((x) => { x.setAttribute('aria-pressed', x === b); x.setAttribute('aria-selected', x === b); }); renderTab(); }));
  renderActs(); renderTab();
}

function renderActs() {
  const box = $('#acts', root);
  const m = store.state?.models.find((x) => x.id === selected);
  if (!box || !m) return;
  const html = `${actions(m, { size: '', full: true })}<span class="status">${phaseTrack(m)}${statusWord(m)}</span>`;
  if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; bindActions(box); }
}

function renderTab() {
  const box = $('#tabbody', root);
  const m = store.state?.models.find((x) => x.id === selected);
  if (!box || !m) return;
  const r = reg.models[m.id] || {};
  if (tab === 'overview') box.innerHTML = overview(m, r);
  if (tab === 'jev') box.innerHTML = vsJev(m, r);
  if (tab === 'load') { const html = loadTab(m); if (box.dataset.html === html) return; box.dataset.html = html; box.innerHTML = html; bindLoad(box, m); }
  else box.dataset.html = '';
  bindActions(box);
}

function overview(m, r) {
  const base = m.base_id ? store.state?.models.find((x) => x.id === m.base_id) : null;
  const facts = [
    ...(m.base_id ? [['训练自', esc(base?.name || m.base_id)], ['结果', esc(m.headline_metric || '')]] : []),
    [term('parameters', '参数量'), esc(m.params)],
    ['加载时内存', `约 ${fmtGB(m.memory_gb)}`],
    ['输入', esc(inputs(m))],
    ['语言', esc(lang(m))],
    [term('context', '上下文'), `${m.context_tokens.toLocaleString()} 个 token`],
    ['下载', fmtBytes(m.download_bytes)],
    ['许可', esc(m.license)],
  ];
  const g = guideFor(m.id);
  const tries = (g?.examples || []).map((id) => EXAMPLES.find((e) => e.id === id)).filter(Boolean);
  const tryIt = g ? `<div class="try-it"><h3>适用场景</h3><p>${esc(g.madeFor)}</p>
      <div class="try-list">${tries.map((e) => `<a class="try" href="#/playground?model=${esc(m.id)}&example=${esc(e.id)}">${icon(e.needsMedia ? 'image' : 'play')}<span><b>${esc(e.title)}</b><span>${esc(e.blurb.replace(/\s*Made for [^.]*\.$/, ''))}</span></span></a>`).join('')}</div></div>` : '';
  return `<p class="lede">${esc(clean(m.summary))}</p>
    ${tryIt}
    <div class="group">${facts.map(([k, v]) => `<div class="grow"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('')}</div>
    <div class="gw">
      <div class="good"><h3>优势</h3><ul>${m.good_for.map((x) => `<li>${icon('check-circle')}<span>${esc(clean(x))}</span></li>`).join('')}</ul></div>
      <div class="watch"><h3>注意</h3><ul>${m.watch_out.map((x) => `<li>${icon('warning')}<span>${esc(clean(x))}</span></li>`).join('')}</ul></div>
    </div>
    <details class="disclose"><summary>技术细节${icon('caret-right', 'chev')}</summary><div class="body">
      <dl class="specs">
        ${r.architecture ? `<dt>架构</dt><dd>${esc(clean(r.architecture))}</dd>` : ''}
        ${r.base_model ? `<dt>${term('base_model', '基座模型')}</dt><dd><code>${esc(r.base_model)}</code></dd>` : ''}
        ${r.training ? `<dt>训练</dt><dd>${esc(clean(r.training))}</dd>` : ''}
        <dt>问题类型</dt><dd>原生支持六种：${m.types.map((t) => ({ choice: '单选', score: '量表', noul: '是/否' }[t])).join('、')}，另支持多选、排序与数值等${term('extensions', '扩展')}</dd>
        <dt>每题选项数</dt><dd>最多 ${m.max_options.toLocaleString()}</dd>
        <dt>每轮问题数</dt><dd>${m.one_pass ? '一次全部' : '逐题进行'}</dd>
        <dt>来源</dt><dd>${m.custom || String(m.repo?.id || '').startsWith('local/') ? `<code>${esc(m.repo.id)}</code>（本机添加）` : `<a href="${esc(m.hf_url)}" target="_blank" rel="noopener">${esc(m.repo.id)}</a>`}${r.paper_or_code_url && !isLocal(r.paper_or_code_url) ? `<br><a href="${esc(r.paper_or_code_url)}" target="_blank" rel="noopener">代码或论文</a>` : ''}</dd>
      </dl></div></details>`;
}

function resultRow(m, b, withJev = true) {
  const mv = esc(fmtVal(b, b.model, b.model_display));
  const jv = esc(fmtVal(b, b.jev, b.jev_display));
  const name = b.note ? `<span class="term" tabindex="0" data-tip="${esc(clean(b.note))}">${esc(clean(b.suite))}</span>` : esc(clean(b.suite));
  return `<div class="grow stack"><span>${name}</span><span class="v small" style="display:flex;gap:8px;justify-content:space-between"><span>${esc(clean(b.metric))}${b.higher_is_better ? '' : '，越低越好'}</span>
    <span class="num">${withJev ? `<b style="${wins(b) ? 'color:var(--accent-text);' : ''}font-weight:600">${mv}</b> vs ${jv}` : `<b style="font-weight:600">${mv}</b>`}</span></span></div>`;
}

function vsJev(m, r) {
  const s = h2h(r);
  const top = headlineRows(s.rows);
  const other = [...(r.benchmarks || []), ...(r.independent || [])].filter((b) => b.jev == null && b.model != null);
  if (!s.n && !other.length) return '<div class="empty" style="padding:24px"><p>该模型尚无公开评测结果。</p></div>';
  const pct = s.rows.filter(onPctAxis), rest = s.rows.filter((b) => !onPctAxis(b));
  const srcs = [...new Set([...s.rows, ...other].map((b) => b.source))];
  const links = srcs.filter((u) => !isLocal(u)).map((u) => { let h = u; try { const x = new URL(u); h = (x.hostname + x.pathname).replace(/\/$/, ''); } catch { /* keep */ } return `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(h.length > 60 ? `${h.slice(0, 58)}...` : h)}</a></li>`; });
  for (const u of new Set(srcs.filter(isLocal).map((x) => String(x).replace(/\s*\(.*$/, '')))) if (u) links.push(`<li>${esc(u)}</li>`);
  return `${s.n ? `<div style="display:grid;gap:8px">
      <div style="display:flex;align-items:baseline;gap:8px"><b style="font-size:22px;font-weight:650;letter-spacing:-0.02em" class="num">${s.w} / ${s.n}</b><span class="muted">项公开结果偏向 ${esc(m.name)}</span></div>
      ${winbar(s, 'lg')}
      <div class="legend"><span><i style="background:var(--data-3)"></i>领先</span>${s.t ? '<span><i style="background:var(--data-1)"></i>持平</span>' : ''}<span><i style="background:var(--text-3)"></i>落后</span></div></div>` : ''}
    ${top.length ? `<div style="display:grid;gap:10px">
      <div style="display:flex;align-items:center"><h3 style="font-size:12.5px;color:var(--text-2)">主要结果</h3><span class="legend" style="margin-left:auto"><span><i style="background:var(--data-3)"></i>${esc(m.name)}</span><span><i style="background:var(--text-3)"></i>Jev</span></span></div>
      <figure class="hl">${top.map((b) => `<div class="hl-row"><div class="top"><span class="nm" title="${esc(clean(b.suite))}">${esc(clean(b.suite))}</span><span class="vals"><b>${esc(fmtVal(b, b.model, b.model_display))}</b> <span class="muted">vs ${esc(fmtVal(b, b.jev, b.jev_display))}</span></span></div>${dumbbell(b)}</div>`).join('')}
        <div class="ticks"><span>0</span><span>25</span><span>50</span><span>75</span><span>100%</span></div></figure></div>` : ''}
    <div>
      ${pct.length ? `<details class="disclose"><summary>准确率与得分 <span class="muted num" style="font-weight:400">${pct.length}</span>${icon('caret-right', 'chev')}</summary><div class="body"><div class="group">${pct.map((b) => resultRow(m, b)).join('')}</div></div></details>` : ''}
      ${rest.length ? `<details class="disclose"><summary>校准、速度与成本 <span class="muted num" style="font-weight:400">${rest.length}</span>${icon('caret-right', 'chev')}</summary><div class="body"><div class="group">${rest.map((b) => resultRow(m, b)).join('')}</div></div></details>` : ''}
      ${other.length ? `<details class="disclose"><summary>无 Jev 对比 <span class="muted num" style="font-weight:400">${other.length}</span>${icon('caret-right', 'chev')}</summary><div class="body"><div class="group">${other.map((b) => resultRow(m, b, false)).join('')}</div></div></details>` : ''}
      <details class="disclose"><summary>来源${icon('caret-right', 'chev')}</summary><div class="body">
        ${r.headline ? `<p class="small muted">${esc(clean(r.headline))}</p>` : ''}<ul class="sources">${links.join('')}</ul>
        <p class="help">发布方数据为厂商自述；独立结果为第三方评测。请先在「评测」中用自有数据验证后再做判断。</p></div></details>
    </div>`;
}

function optionField(o) {
  if (o.type === 'select' && o.choices.length <= 3) return `<div class="setting"><div class="top"><label>${esc(o.label)}</label></div>
    <span class="seg full" data-opt="${o.key}">${o.choices.map(([v, l]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${v === o.default}">${esc(l.replace(/\s*\(.*\)/, ''))}</button>`).join('')}</span><span class="help">${esc(clean(o.help))}</span></div>`;
  if (o.type === 'select') return `<div class="setting"><div class="top"><label for="opt-${o.key}">${esc(o.label)}</label></div><select class="select" id="opt-${o.key}" name="${o.key}">${o.choices.map(([v, l]) => `<option value="${esc(v)}" ${v === o.default ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select><span class="help">${esc(clean(o.help))}</span></div>`;
  if (o.type === 'number') return `<div class="setting"><div class="top"><label for="opt-${o.key}">${esc(o.label)}</label><input class="input num-field" type="number" id="opt-${o.key}" name="${o.key}" value="${o.default}" min="${o.min}" max="${o.max}" step="${o.step}"></div>
    <input type="range" data-for="opt-${o.key}" min="${o.min}" max="${o.max}" step="${o.step}" value="${o.default}" aria-label="${esc(o.label)}"><span class="help">${esc(clean(o.help))}</span></div>`;
  if (o.type === 'toggle') return `<div class="setting"><label class="switch" style="justify-content:space-between"><span style="font-weight:500">${esc(o.label)}</span><input type="checkbox" name="${o.key}" ${o.default ? 'checked' : ''}></label><span class="help">${esc(clean(o.help))}</span></div>`;
  return '';
}

function loadTab(m) {
  const opts = m.load_options || [];
  const paths = Object.entries(m.local_paths || {});
  let head;
  if (m.worker) head = `<div class="note">${icon('info')}<span>已加载，选项为 ${Object.entries(m.worker.options || {}).map(([k, v]) => `${esc(k.replace(/_/g, ' '))} <b>${esc(String(v))}</b>`).join('、') || '默认值'}。需先卸载才能更改。</span></div>`;
  else if (m.custom) head = `<div class="note violet">${icon('hard-drive')}<span>本机添加的模型，权重来自你选择的本地目录，不会从 Hugging Face 下载。</span></div>`;
  else if (!m.downloaded) head = `<div class="note">${icon('info')}<span>请先下载 ${esc(m.name)}（${fmtBytes(m.download.remaining || m.download_bytes)}），或<button class="btn-plain" data-local="${m.id}" type="button">从本地目录加载</button>。</span></div>`;
  else if (m.local) head = `<div class="note violet">${icon('hard-drive')}<span>正在使用本地目录权重，不会从 Hugging Face 下载。</span></div>`;
  else head = '';
  return `${head}
    ${m.downloaded && !m.worker ? `<form class="insp-sec" id="loadform">${opts.map(optionField).join('')}
      <button class="btn btn-primary" type="submit">${icon('play')}按此设置加载</button></form>` : ''}
    <div class="insp-sec"><h3>文件</h3><div class="group">
      <div class="grow"><span class="k">${m.local || m.custom ? '本地绑定' : '磁盘占用'}</span><span class="v">${m.local || m.custom ? '不会删除你的文件夹' : `${fmtBytes(m.download.have)}${m.base ? '，含共享基座模型' : ''}`}</span></div>
      ${paths.map(([repo, path]) => `<div class="grow stack"><span class="k"><code>${esc(repo)}</code></span><span class="v wrap small muted" style="overflow-wrap:anywhere">${esc(path)}</span></div>`).join('')}
      ${m.worker ? `<div class="grow link" data-logs="${m.id}"><span class="k">查看模型日志</span><span class="v">${icon('caret-right')}</span></div>` : ''}
      ${!m.downloaded && !m.local && !m.custom ? `<div class="grow link" data-local="${m.id}"><span class="k">从本地目录加载</span><span class="v">${icon('hard-drive')}</span></div>` : ''}
      ${m.custom ? `<div class="grow link" data-rmcustom="${m.id}"><span class="k" style="color:var(--red-text)">从列表中移除</span><span class="v">${icon('trash')}</span></div>` : ''}
      ${m.local && !m.custom ? `<div class="grow link" data-unbind="${m.id}"><span class="k" style="color:var(--red-text)">解除本地绑定</span><span class="v">${icon('x-circle')}</span></div>` : ''}
      ${!m.local && !m.custom && (m.downloaded || m.download.have > 0) ? `<div class="grow link" data-delete="${m.id}"><span class="k" style="color:var(--red-text)">删除文件</span><span class="v">${icon('trash')}</span></div>` : ''}
    </div></div>`;
}

function bindLoad(box, m) {
  // Number fields and sliders move together, like LM Studio's load settings.
  const fill = (r) => r.style.setProperty('--fill-pct', `${((r.value - r.min) / (r.max - r.min || 1)) * 100}%`);
  $$('input[type=range][data-for]', box).forEach((r) => {
    const n = $(`#${r.dataset.for}`, box);
    fill(r);
    r.addEventListener('input', () => { n.value = r.value; fill(r); });
    n.addEventListener('input', () => { r.value = n.value; fill(r); });
  });
  $$('[data-opt] button', box).forEach((b) => b.addEventListener('click', () => $$('button', b.parentElement).forEach((x) => x.setAttribute('aria-pressed', x === b))));
  $('#loadform', box)?.addEventListener('submit', (e) => {
    e.preventDefault();
    const o = {};
    for (const el of e.target.elements) if (el.name) o[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value : el.value;
    $$('[data-opt]', box).forEach((s) => { o[s.dataset.opt] = $('[aria-pressed="true"]', s)?.dataset.v; });
    loadModel(m.id, o);
  });
}

function jevInspector() {
  const j = reg.jev;
  const maker = reg.makers[j.maker_id] || {};
  return `<div class="hero"><span class="logo lg">${maker.logo ? `<img src="/ui/${esc(maker.logo)}" alt="">` : ''}</span><div><h2>${esc(j.name)}</h2><p>${esc(j.maker)}，发布于 ${esc(j.released)}</p></div></div>
    <div class="tabbody">
      <p class="lede">${term('jev', 'Jev')} 是 TypeSafe 托管的决策模型，也是此处各模型的对比基准。无法在本机运行，但本地模型均兼容其 API——将代码中的 base URL 改成本地地址即可运行面向 Jev 编写的代码。</p>
      <div class="group">
        <div class="grow stack"><span class="k">价格</span><span class="v">${esc(clean(j.pricing))}</span></div>
        <div class="grow stack"><span class="k">延迟</span><span class="v">${esc(clean(j.latency_band))}</span></div>
        <div class="grow stack"><span class="k">上下文</span><span class="v">${esc(clean(j.context))}</span></div>
        <div class="grow stack"><span class="k">问题类型</span><span class="v">${esc(clean(j.question_types))}</span></div>
      </div>
      <div class="insp-sec"><h3>独立评测</h3><div class="group">${(j.independent || []).map((b) => `<div class="grow"><span class="k">${esc(clean(b.suite))}<br><span class="small muted">${esc(clean(b.metric))}${b.higher_is_better ? '' : '，越低越好'}</span></span><span class="v num">${esc(fmtVal(b, b.value))}</span></div>`).join('')}</div></div>
      ${j.docs_url ? `<a href="${esc(j.docs_url)}" target="_blank" rel="noopener">${icon('arrow-square-out')} Jev API 文档</a>` : ''}
    </div>`;
}

// ------------------------------------------------------------------ help me choose, download all
function recommend() {
  const { input, language, priority } = finder;
  if (input === 'av') return ['jev-omni', '唯一支持听音频、看视频的本机模型。'];
  if (input === 'image') return ['intern-decision-4b', '每次请求最多可读 8 张图。'];
  if (language === 'multi') return priority === 'speed' ? ['julia-1', '体积小、多语言且快。'] : ['laya-multilingual', '覆盖 100+ 种语言。'];
  if (priority === 'speed') return ['gliner2.5-decide', '小巧快速，CPU 也能跑。'];
  if (priority === 'options') return ['lev', '单题可处理数百个选项。'];
  if (priority === 'agents') return ['clm-v0.1-8b', '针对智能体轨迹训练：选工具与下一步动作。'];
  return ['intern-decision-4b', '发布方测试中综合表现最佳。'];
}
function helpMeChoose() {
  const d = document.createElement('dialog');
  const seg = (key, opts) => `<span class="seg full" role="group">${opts.map(([v, l]) => `<button type="button" data-k="${key}" data-v="${v}" aria-pressed="${finder[key] === v}">${l}</button>`).join('')}</span>`;
  const draw = () => {
    const [id, why] = recommend();
    const m = store.state.models.find((x) => x.id === id);
    d.innerHTML = `<form method="dialog"><div class="dialog-body" style="gap:14px"><h2 style="font-size:17px">该用哪个模型？</h2>
      <div class="field"><span class="label">输入类型？</span>${seg('input', [['text', '文本'], ['image', '图像'], ['av', '音频或视频']])}</div>
      <div class="field"><span class="label">使用语言？</span>${seg('language', [['en', '英语'], ['multi', '其他或多语言']])}</div>
      <div class="field"><span class="label">更看重？</span>${seg('priority', [['speed', '速度'], ['balanced', '准确率'], ['options', '选项数量'], ['agents', '智能体']])}</div>
      <div class="note violet">${icon('lightbulb')}<span><b>${esc(m.name)}</b>：${esc(why)}</span></div></div>
      <div class="dialog-foot"><button class="btn" value="cancel">关闭</button><button class="btn btn-primary" value="${id}">查看 ${esc(m.name)}</button></div></form>`;
    $$('[data-k]', d).forEach((b) => b.addEventListener('click', () => { finder[b.dataset.k] = b.dataset.v; draw(); }));
  };
  document.body.append(d); draw();
  d.addEventListener('close', () => { const v = d.returnValue; d.remove(); if (v && v !== 'cancel') { filter = { q: '', show: 'all', input: 'any' }; render(); select(v); } });
  d.showModal();
}
async function pickDir(title, start) {
  if (window.__TAURI__) {
    try { return await window.__TAURI__.core.invoke('pick_folder', { start: start || null }); }
    catch (e) { toast(String(e), 'error'); return null; }
  }
  return askText({ title, label: '模型文件夹的完整路径（含 config.json 或 adapter_config.json 与权重文件）。', value: start || '', confirm: '使用此文件夹' });
}

async function bindLocal(id) {
  const m = store.state.models.find((x) => x.id === id);
  if (!m || m.finetune_dir) { toast('微调模型请绑定其基座型号的本地权重。', 'error'); return; }
  if (m.custom) { toast('本机添加的模型请删除后重新添加以更换目录。', 'error'); return; }
  const path = await pickDir(`选择 ${m.name} 的本地目录`);
  if (!path) return;
  let base_path;
  if (m.base) {
    base_path = await pickDir(`选择基座 ${m.base.id} 的本地目录`);
    if (!base_path) return;
  }
  try {
    await api(`/api/models/${id}/local`, { method: 'POST', body: { path, base_path } });
    toast(`已绑定本地目录：${m.name}`);
    await refresh();
  } catch (e) { toast(e.message, 'error'); }
}

async function addCustomModel() {
  let templates;
  try {
    ({ templates } = await api('/api/custom-models/templates'));
  } catch (e) { toast(e.message, 'error'); return; }
  if (!templates?.length) { toast('没有可用的模型模板。', 'error'); return; }

  const d = document.createElement('dialog');
  d.style.maxWidth = '520px';
  const opts = templates.map((t) =>
    `<option value="${esc(t.template_id)}" data-base="${t.needs_base ? '1' : '0'}" data-hint="${esc(t.base_hint || '')}">${esc(t.name)}（${esc(t.params)}，约 ${fmtGB(t.memory_gb)}）${t.needs_base ? ' · 需基座' : ''}</option>`
  ).join('');
  d.innerHTML = `<form method="dialog"><div class="dialog-body" style="gap:12px">
    <h2 style="font-size:17px">添加本地模型</h2>
    <p class="help">选择与本机权重匹配的运行方式（适配器），再指定文件夹。不会上传或下载，只登记到本机列表。</p>
    <label class="field"><span class="label">显示名称</span><input class="input" name="name" required placeholder="例如：我的 Julia 权重"></label>
    <label class="field"><span class="label">运行方式（同内置型号）</span><select class="select" name="template_id" id="tpl">${opts}</select></label>
    <p class="help" id="tplhint"></p>
    <label class="field"><span class="label">模型目录</span>
      <span style="display:flex;gap:8px"><input class="input code" name="path" id="cpath" required placeholder="/path/to/weights"><button type="button" class="btn sm" id="pickp">浏览…</button></span>
    </label>
    <label class="field" id="basewrap" hidden><span class="label">基座模型目录</span>
      <span style="display:flex;gap:8px"><input class="input code" name="base_path" id="cbase" placeholder="/path/to/base"><button type="button" class="btn sm" id="pickb">浏览…</button></span>
    </label>
  </div>
  <div class="dialog-foot"><button class="btn" value="cancel" formnovalidate>取消</button><button class="btn btn-primary" value="ok">添加并绑定</button></div></form>`;
  document.body.append(d);

  const tpl = d.querySelector('#tpl');
  const baseWrap = d.querySelector('#basewrap');
  const hint = d.querySelector('#tplhint');
  const syncTpl = () => {
    const o = tpl.selectedOptions[0];
    const need = o?.dataset.base === '1';
    baseWrap.hidden = !need;
    d.querySelector('#cbase').required = need;
    hint.textContent = need
      ? `此类型需要单独的基座权重目录（参考 ${o.dataset.hint}）。`
      : '此类型只需一个包含 config 与权重的文件夹。';
  };
  tpl.addEventListener('change', syncTpl);
  syncTpl();
  d.querySelector('#pickp').addEventListener('click', async () => {
    const p = await pickDir('选择模型权重目录');
    if (p) d.querySelector('#cpath').value = p;
  });
  d.querySelector('#pickb').addEventListener('click', async () => {
    const p = await pickDir('选择基座模型目录');
    if (p) d.querySelector('#cbase').value = p;
  });

  const done = await new Promise((resolve) => {
    d.addEventListener('close', () => {
      if (d.returnValue !== 'ok') { resolve(null); d.remove(); return; }
      const fd = new FormData(d.querySelector('form'));
      resolve({
        name: String(fd.get('name') || '').trim(),
        template_id: String(fd.get('template_id') || ''),
        path: String(fd.get('path') || '').trim(),
        base_path: String(fd.get('base_path') || '').trim() || undefined,
      });
      d.remove();
    });
    d.showModal();
    d.querySelector('input[name=name]')?.focus();
  });
  if (!done?.name || !done.path) return;
  try {
    const r = await api('/api/custom-models', { method: 'POST', body: done });
    toast(`已添加：${r.name || done.name}`);
    await refresh();
    if (r.id) { selected = r.id; render(); select(r.id); }
  } catch (e) { toast(e.message, 'error'); }
}

async function removeCustom(id) {
  const m = store.state.models.find((x) => x.id === id);
  const ok = await confirmDialog({
    title: `移除 ${m?.name || id}？`,
    body: '<p>只会从列表中去掉登记，<b>不会删除</b>硬盘上的权重文件夹。</p>',
    confirm: '移除', danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/custom-models/${id}`, { method: 'DELETE' });
    toast(`已移除 ${m?.name || id}`);
    if (selected === id) selected = 'intern-decision-4b';
    await refresh();
    render();
  } catch (e) { toast(e.message, 'error'); }
}

async function unbindLocal(id) {
  const m = store.state.models.find((x) => x.id === id);
  const ok = await confirmDialog({
    title: `解除 ${m.name} 的本地绑定？`,
    body: '<p>只会取消登记，<b>不会删除</b>你硬盘上的文件夹。之后可重新下载或再次绑定。</p>',
    confirm: '解除绑定', danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/models/${id}/local`, { method: 'DELETE' });
    toast(`已解除 ${m.name} 的本地绑定`);
    await refresh();
  } catch (e) { toast(e.message, 'error'); }
}

async function del(id) {
  const m = store.state.models.find((x) => x.id === id);
  if (m.local) return unbindLocal(id);
  const shared = m.base && store.state.models.some((o) => o.id !== id && o.downloaded && o.base?.id === m.base.id);
  const ok = await confirmDialog({
    title: `删除 ${m.name} 的文件？`,
    body: `<p>将释放约 <b>${fmtBytes(m.download.have)}</b> 磁盘空间${shared ? `，因其他模型仍在使用 ${esc(m.base.id)} 基座而将保留该基座` : ''}。可随时重新下载。</p>`,
    confirm: '删除文件', danger: true,
  });
  if (!ok) return;
  try { const r = await api(`/api/models/${id}/files`, { method: 'DELETE' }); toast(r.removed.length ? `已删除 ${m.name} 的文件` : '没有可删除的文件'); }
  catch (e) { toast(e.message, 'error'); }
  refresh();
}

// Bytes the models take on disk, partial downloads included. A shared base model (for example the Qwen base under
// Kev 4B and Lev) counts once.
export function diskUse(models) {
  const bases = new Map();
  return models.reduce((a, m) => {
    if (!m.downloaded) return a + (m.download?.have || 0);
    if (m.base) bases.set(m.base.id, m.base_bytes || 0);
    return a + (m.download_bytes - (m.base ? m.base_bytes || 0 : 0));
  }, 0) + [...bases.values()].reduce((a, v) => a + v, 0);
}

export async function showLogs(id) {
  const text = await (await api(`/api/models/${id}/logs?lines=300`, { raw: true })).text();
  const d = document.createElement('dialog');
  d.style.maxWidth = '920px';
  d.innerHTML = `<div class="dialog-body"><h2 style="font-size:17px">模型日志</h2><p class="help">模型进程在加载与运行期间的输出。</p>
    <div class="code"><pre style="max-height:60vh;padding:12px 14px;white-space:pre-wrap">${esc(text || '（空）')}</pre></div></div><div class="dialog-foot"><button class="btn" id="cl">关闭</button></div>`;
  document.body.append(d);
  d.querySelector('#cl').onclick = () => d.close();
  d.addEventListener('close', () => d.remove());
  d.showModal();
}

export { setPref };
