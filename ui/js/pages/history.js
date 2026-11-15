// History: every decision the studio made, from the Playground, your code, an SDK or curl, kept on this computer.
// A summary strip, a chart, the list (filtered on the server, live), and an inspector for one decision: its answers,
// its input, the settings it was made with and why, feedback, and actions (label, pin, rerun, save as template).

import { animate, figures, mini } from '../figures.js';
import { jsonTree } from '../format.js';
import { setSub } from '../shell.js';
import { api, model, readyModels, studio } from '../store.js';
import { $, $$, askText, confirmDialog, copy, esc, fmtMs, fmtNum, fmtPct, icon, popMenu, toast } from '../util.js';
import { loadDecision } from './playground.js';

let root, timer, onResize;
let items = [];          // decision summaries, newest first
let more = false;        // older pages exist
let paused = false;
let sel = null;          // selected decision id
let full = null;         // the selected decision, in full
let itab = 'answers';
let view = 'time';
let f = { range: '1440', model: '', template: '', result: '', q: '' };
let settings = null;
let templates = [];
let statsCache = null;

const RANGES = [['60', '1 小时'], ['1440', '24 小时'], ['10080', '7 天'], ['', '全部']];
const SURFACE = { api: 'API', playground: '试验台', compare: '对比', order_test: '顺序测试', eval: '评测', rerun: '重跑', imported: '导入', batch: '批量', replay: '回放' };
const nameOf = (id) => model(id)?.name || id || '无模型';
function ago(t) {
  const s = Math.max(0, Date.now() / 1000 - t);
  if (s < 60) return `${Math.round(s)} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return new Date(t * 1000).toLocaleDateString();
}
const tplLabel = (t) => (t ? `${t.id.replace(/^builtin\//, '')} v${t.version}` : '');

function query(extra = {}) {
  const p = new URLSearchParams();
  if (f.range) p.set('created_after', `-${f.range}m`);
  if (f.model) p.set('model', f.model);
  if (f.template) p.set('template', f.template);
  if (f.result === 'review') p.set('act', 'false');
  if (f.result === 'acted') p.set('act', 'true');
  if (f.result === 'failed') p.set('status', 'failed');
  if (f.result === 'labelled') p.set('labelled', 'true');
  if (f.result === 'pinned') p.set('pinned', 'true');
  if (f.q) p.set('q', f.q);
  if (f.template) p.set('attribution', 'all');
  for (const [k, v] of Object.entries(extra)) if (v != null) p.set(k, v);
  return p.toString();
}

export async function mount(el, params = {}) {
  root = el;
  if (params.template) f.template = params.template;
  if (params.id) sel = params.id;
  root.innerHTML = `<div class="view panes act-view">
    <section class="pane" aria-label="决策列表">
      <div class="pane-head">
        <span class="live" id="live"><i></i>实时</span>
        <button class="btn btn-quiet sm" id="pause">${icon('pause')}暂停</button>
        <span class="seg" role="group" aria-label="时间范围">${RANGES.map(([v, l]) => `<button data-range="${v}" aria-pressed="${f.range === v}">${l}</button>`).join('')}</span>
        <select class="select" id="fresult" style="width:auto" aria-label="结果">
          ${[['', '全部结果'], ['review', '需人工审核'], ['acted', '已自动执行'], ['failed', '失败'], ['labelled', '已标注'], ['pinned', '已置顶']].map(([v, l]) => `<option value="${v}" ${f.result === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select class="select" id="fmodel" style="width:auto" aria-label="模型"><option value="">全部模型</option></select>
        <select class="select" id="ftemplate" style="width:auto;max-width:200px" aria-label="模板"><option value="">全部模板</option></select>
        <div class="right">
          <label class="search"><span class="sr">搜索</span>${icon('magnifying-glass')}<input class="input" id="fq" placeholder="搜索情境" value="${esc(f.q)}"></label>
          <button class="icon-btn" id="hsettings" aria-label="历史记录设置" data-tip="历史记录保留内容">${icon('gear-six')}</button>
        </div>
      </div>
      <div class="pane-body" id="abody"></div>
    </section>
    <aside class="pane white" id="ainsp" aria-label="决策详情"></aside>
  </div>`;
  $('#pause', root).addEventListener('click', () => {
    paused = !paused;
    $('#pause', root).innerHTML = paused ? `${icon('play')}继续` : `${icon('pause')}暂停`;
    $('#live', root).classList.toggle('paused', paused);
    $('#live', root).lastChild.textContent = paused ? '已暂停' : '实时';
    if (!paused) load();
  });
  $$('[data-range]', root).forEach((b) => b.addEventListener('click', () => { f.range = b.dataset.range; $$('[data-range]', root).forEach((x) => x.setAttribute('aria-pressed', x === b)); reload(); }));
  $('#fresult', root).addEventListener('change', (e) => { f.result = e.target.value; reload(); });
  $('#fmodel', root).addEventListener('change', (e) => { f.model = e.target.value; reload(); });
  $('#ftemplate', root).addEventListener('change', (e) => { f.template = e.target.value; reload(); });
  let qt; $('#fq', root).addEventListener('input', (e) => { clearTimeout(qt); qt = setTimeout(() => { f.q = e.target.value.trim(); reload(); }, 300); });
  $('#hsettings', root).addEventListener('click', (e) => settingsMenu(e.currentTarget));
  $('#abody', root).addEventListener('click', onBodyClick);
  $('#abody', root).addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest('[data-req]')) onBodyClick(e); });
  let rt; onResize = () => { clearTimeout(rt); rt = setTimeout(() => { if (root.isConnected) draw(); }, 150); };
  window.addEventListener('resize', onResize);
  drawInspector();
  await Promise.all([loadSettings(), loadTemplates()]);
  await reload();
  clearInterval(timer);
  timer = setInterval(() => { if (!root.isConnected) { clearInterval(timer); return; } if (!paused && !document.hidden) load(); }, 3000);
}
export function unmount() { clearInterval(timer); window.removeEventListener('resize', onResize); }
// Model names arrive with the studio's state; redraw so the list shows names rather than ids.
export function onState() { if (root?.isConnected && items.length) draw(); }

async function loadSettings() {
  try { settings = await studio('/settings'); } catch (e) { settings = { error: e.message }; }
}
async function loadTemplates() {
  try {
    const r = await studio('/templates?limit=100&include_archived=true');
    const b = await studio('/templates?limit=100&origin=builtin');
    templates = [...r.data.filter((t) => t.origin === 'user'), ...b.data];
  } catch { templates = []; }
  const opts = `<option value="">全部模板</option><option value="none" ${f.template === 'none' ? 'selected' : ''}>无模板</option>${templates.filter((t) => t.origin === 'user').map((t) => `<option value="${esc(t.id)}" ${f.template === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
    ${templates.some((t) => t.origin === 'builtin') ? `<optgroup label="入门模板">${templates.filter((t) => t.origin === 'builtin').map((t) => `<option value="${esc(t.id)}" ${f.template === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</optgroup>` : ''}`;
  const el = $('#ftemplate', root); if (el) el.innerHTML = opts;
}

async function reload() { items = []; more = false; statsCache = null; await load(); }

async function load() {
  let page;
  try { page = await studio(`/decisions?${query({ limit: 100 })}`); }
  catch (e) { drawError(e); return; }
  const fresh = page.data;
  const old = items.filter((x) => !fresh.some((y) => y.id === x.id) && x.created_at <= (fresh.at(-1)?.created_at ?? Infinity));
  items = fresh.concat(items.length > fresh.length ? old : []);
  if (!items.length || !more) more = page.has_more;
  try { statsCache = await studio(`/decisions/stats?${query({ group_by: view === 'model' ? 'model' : view === 'template' ? 'template' : view === 'surface' ? 'surface' : null })}`); } catch { statsCache = null; }
  const models = [...new Set(items.map((x) => x.model).filter(Boolean))];
  const fm = $('#fmodel', root);
  const opts = `<option value="">全部模型</option>${[...new Set([...models, ...(f.model ? [f.model] : [])])].map((id) => `<option value="${esc(id)}" ${f.model === id ? 'selected' : ''}>${esc(nameOf(id))}</option>`).join('')}`;
  if (fm && fm.dataset.html !== opts) { fm.dataset.html = opts; fm.innerHTML = opts; }
  if (!sel && items.length) sel = items[0].id;
  draw();
  if (sel && full?.id !== sel) drawInspector();
}

async function loadOlder() {
  const lastId = items.at(-1)?.id;
  if (!lastId) return;
  try {
    const page = await studio(`/decisions?${query({ limit: 100, after: lastId })}`);
    items = items.concat(page.data); more = page.has_more; draw();
  } catch (e) { toast(e.message, 'error'); }
}

function drawError(e) {
  const box = $('#abody', root);
  if (box) box.innerHTML = `<div class="empty"><div class="glyph">${icon('warning-circle')}</div><h2>历史记录不可用</h2><p>${esc(e.message)}</p></div>`;
}

// ------------------------------------------------------------------ the page body
function onBodyClick(e) {
  const v = e.target.closest('[data-view]');
  if (v) { view = v.dataset.view; load(); return; }
  if (e.target.closest('#older')) { loadOlder(); return; }
  if (e.target.closest('#ack')) { ackNotice(); return; }
  if (e.target.closest('#notice-settings')) { settingsMenu(e.target.closest('#notice-settings')); return; }
  const r = e.target.closest('[data-req]');
  if (r) { sel = r.dataset.req; full = null; drawInspector(); $$('[data-req]', root).forEach((x) => x.classList.toggle('sel', x.dataset.req === sel)); draw(); }
}

function notice() {
  const h = settings?.history;
  if (!h || h.notice_acknowledged_at) return '';
  const kept = h.store === 'none' ? '不保存任何内容' : `决策保留 ${h.retention_days ? `${h.retention_days} 天` : '永久'}`;
  return `<div class="note violet" style="align-items:center">${icon('clock-counter-clockwise')}
    <span style="flex:1"><b>本机上的每次决策都会记入历史</b>，包括代码中的调用：情境、问题、答案与模型。当前 ${kept}。调用方可使用 <code>"store": false</code> 选择不保存。</span>
    <button class="btn sm" id="notice-settings">更改</button><button class="btn btn-primary sm" id="ack">知道了</button></div>`;
}

async function ackNotice() {
  try { settings = await studio('/settings', { method: 'PATCH', body: { history: { notice_acknowledged_at: true } } }); draw(); } catch (e) { toast(e.message, 'error'); }
}

function draw() {
  const box = $('#abody', root);
  if (!box) return;
  const g = statsCache?.groups || [];
  const total = g.reduce((a, x) => a + x.count, 0);
  const failed = g.reduce((a, x) => a + x.failed, 0);
  const acted = g.reduce((a, x) => a + (x.act_rate || 0) * (x.count - x.failed), 0);
  const p50 = g.length === 1 ? g[0].latency_ms?.p50 : null;
  setSub(`${total.toLocaleString()} 条决策${f.range ? `（最近 ${RANGES.find(([v]) => v === f.range)[1]}）` : ''}`);
  const filtered = f.model || f.template || f.result || f.q;
  if (!items.length) {
    box.innerHTML = `${notice()}<div class="empty"><div class="glyph">${icon('clock-counter-clockwise')}</div><h2>${filtered ? '没有符合筛选条件的记录' : '尚无决策'}</h2>
      <p>${filtered ? '尝试拉长时间范围或减少筛选条件。' : '试验台、代码、SDK 或 curl 的每次决策都会出现在这里。可在试验台运行一次，或调用 API。'}</p>
      ${filtered ? '' : `<a class="btn btn-primary" href="#/playground">${icon('flask')}打开试验台</a>`}</div>`;
    return;
  }
  const W = Math.max(300, (box.clientWidth || 700) - 64);
  const chart = view === 'time' ? timeline(items, W) : bars(g, view);
  const sub = { time: '每个点是一次决策：发生时间与耗时。橙色表示需人工；红色表示失败。点击可打开。', model: '按模型统计，含自动执行比例。', template: '按模板统计。', surface: '按来源统计。' }[view];
  const done = total - failed;
  const html = `${notice()}
    <div class="stats-strip slim">
      <div><span>决策数</span><b>${total.toLocaleString()}</b><small>${items.length < total ? `显示 ${items.length}` : '全部显示'}</small></div>
      <div><span>自动执行</span><b>${done ? fmtPct(acted / done) : 'n/a'}</b><small>已完成 ${done.toLocaleString()} 中的 ${Math.round(acted).toLocaleString()}</small></div>
      <div><span>需人工</span><b>${Math.max(0, Math.round(done - acted)).toLocaleString()}</b><small>${failed ? `${failed} 次失败` : '无失败'}</small></div>
      <div><span>典型耗时</span><b>${p50 != null ? fmtMs(p50) : 'n/a'}</b><small>${g.length === 1 && g[0].latency_ms?.p95 != null ? `95% 低于 ${fmtMs(g[0].latency_ms.p95)}` : '在工作室中'}</small></div>
    </div>
    <div class="chart-card">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2>${{ time: '按时间', model: '按模型', template: '按模板', surface: '按来源' }[view]}</h2>
        <span class="seg" role="group" aria-label="图表" style="margin-left:auto">${[['time', '时间线'], ['model', '模型'], ['template', '模板'], ['surface', '来源']].map(([k, l]) => `<button data-view="${k}" aria-pressed="${view === k}">${l}</button>`).join('')}</span></div>
      <span class="sub">${sub}</span>
      <div class="chart-body">${chart}</div>
    </div>
    <div class="card" style="overflow:hidden"><div class="tscroll"><table class="table hover">
      <thead><tr><th>时间</th><th>结果</th><th>决策</th><th>首个答案</th><th class="num">耗时</th></tr></thead>
      <tbody>${items.map(row).join('')}</tbody></table></div>
      ${more ? `<div style="padding:10px;display:flex;justify-content:center;border-top:1px solid var(--line-2)"><button class="btn sm" id="older">${icon('arrow-down')}显示更早的决策</button></div>` : ''}</div>`;
  if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
}

function resultChip(x) {
  if (x.status === 'failed') return '<span class="chip danger">失败</span>';
  if (x.status === 'queued' || x.status === 'in_progress') return '<span class="chip">运行中</span>';
  if (x.status === 'cancelled') return '<span class="chip">已取消</span>';
  return x.act ? '<span class="chip violet">已执行</span>' : '<span class="chip amber">需人工</span>';
}

function row(x) {
  const k = Object.keys(x.answers || {})[0];
  const a = k ? x.answers[k] : null;
  const first = a ? `${esc(String(Array.isArray(a.decision) ? a.decision.join(', ') || 'none' : a.decision ?? '')).replace(/_/g, ' ')} <span class="faint num">${fmtPct(a.certainty)}</span>` : x.error ? `<span style="color:var(--red-text)">${esc(x.error.code || 'failed')}</span>` : '';
  return `<tr data-req="${esc(x.id)}" class="${x.id === sel ? 'sel' : ''}" tabindex="0">
    <td class="small nowrap" title="${esc(new Date(x.created_at * 1000).toLocaleString())}">${ago(x.created_at)}${x.pinned ? ` ${icon('push-pin')}` : ''}${x.labelled ? ` ${icon('tag')}` : ''}</td>
    <td class="nowrap">${resultChip(x)}</td>
    <td class="cell2"><span>${x.template ? `${icon('stack')}${esc(tplLabel(x.template))}${x.extended ? ' <span class="faint">已扩展</span>' : ''}` : esc(nameOf(x.model))}</span>
      <span class="small muted">${x.template ? `${esc(nameOf(x.model))}, ` : ''}${esc(SURFACE[x.source.surface] || x.source.surface)}${x.source.client && x.source.surface === 'api' ? `, ${esc(x.source.client)}` : ''}</span></td>
    <td class="small" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${first}</td>
    <td class="num small nowrap">${fmtMs(x.timing?.total_ms)}</td></tr>`;
}

function bars(groups, by) {
  if (!groups.length) return '<p class="small muted">该范围内无数据。</p>';
  const rows = [...groups].sort((a, b) => b.count - a.count).slice(0, 8);
  const max = Math.max(...rows.map((g) => g.count), 1);
  const label = (g) => { const v = Object.values(g.key)[0]; if (by === 'model') return nameOf(v); if (by === 'surface') return SURFACE[v] || v; return v ? v.replace(/^builtin\//, '入门: ') : '无模板'; };
  return `<div class="hbars">${rows.map((g) => `<div class="hb"><span>${esc(label(g))}</span><span class="n">${g.count.toLocaleString()}${g.act_rate != null ? `, 自动执行 ${fmtPct(g.act_rate)}` : ''}</span><span class="b"><i style="width:${(g.count / max) * 100}%"></i></span></div>`).join('')}</div>`;
}

function timeline(list, W = 760) {
  const pts = list.filter((x) => x.timing?.total_ms != null);
  if (!pts.length) return '<p class="small muted">该范围内无数据。</p>';
  const H = 220, L = 54, R = 12, T = 12, B = 26;
  const now = Date.now() / 1000;
  const t0 = f.range ? now - +f.range * 60 : Math.min(...pts.map((x) => x.created_at));
  const t1 = Math.max(now, t0 + 60);
  const lats = pts.map((x) => Math.max(1, x.timing.total_ms));
  const lo = Math.min(...lats), hi = Math.max(...lats, lo * 2);
  const log = hi / lo > 20;
  const ymin = log ? 10 ** Math.floor(Math.log10(lo)) : 0, ymax = log ? 10 ** Math.ceil(Math.log10(hi)) : hi * 1.15;
  const y = (v) => T + (1 - (log ? (Math.log10(v) - Math.log10(ymin)) / (Math.log10(ymax) - Math.log10(ymin)) : (v - ymin) / (ymax - ymin || 1))) * (H - T - B);
  const x = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
  const yt = log ? Array.from({ length: Math.log10(ymax) - Math.log10(ymin) + 1 }, (_, i) => ymin * 10 ** i) : [0, ymax / 2, ymax].map((v) => Math.round(v));
  const xt = (W < 520 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).map((p) => t0 + p * (t1 - t0));
  const span = t1 - t0;
  const fmtT = (t) => (span > 2 * 86400 ? new Date(t * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' }) : new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  return `<svg class="tl" viewBox="0 0 ${W} ${H}" role="img" aria-label="${pts.length} 条决策的时间与耗时分布">
    ${yt.map((v) => `<line class="gl" x1="${L}" x2="${W - R}" y1="${y(v || ymin || 0)}" y2="${y(v || ymin || 0)}"/><text class="gt" x="${L - 6}" y="${y(v || ymin || 0) + 4}" text-anchor="end">${fmtMs(v)}</text>`).join('')}
    ${xt.map((t, i) => `<text class="gt" x="${x(t)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === xt.length - 1 ? 'end' : 'middle'}">${fmtT(t)}</text>`).join('')}
    ${pts.map((it, i) => { const cx = x(Math.max(t0, it.created_at)).toFixed(1), cy = y(lats[i]).toFixed(1); return `<circle class="pt ${it.status === 'failed' ? 'err' : it.act === false ? 'ask' : ''} ${it.id === sel ? 'sel' : ''}" cx="${cx}" cy="${cy}" r="${it.id === sel ? 5 : 3.5}"/><circle class="hit" data-req="${esc(it.id)}" cx="${cx}" cy="${cy}" r="9"><title>${esc(nameOf(it.model))}${it.template ? `, ${esc(tplLabel(it.template))}` : ''}, ${fmtMs(it.timing.total_ms)}, ${ago(it.created_at)}</title></circle>`; }).join('')}
  </svg>`;
}

// ------------------------------------------------------------------ settings
function settingsMenu(anchor) {
  const h = settings?.history;
  if (!h) { toast(settings?.error || '历史记录设置不可用。', 'error'); return; }
  const st = settings.storage || {};
  const levels = [['full', '全部', '情境、问题、答案与模型。'], ['answers_only', '仅答案', '不含情境或文件：问题、答案、模型与耗时。'], ['none', '无', '历史记录关闭。决策功能仍可用。']];
  const ret = [[7, '7 天'], [30, '30 天'], [90, '90 天'], [365, '1 年'], [0, '永久']];
  popMenu(anchor, `<div class="menu-group">历史记录保留</div>
    ${levels.map(([v, l, d]) => `<button class="menu-item" data-pick="store:${v}">${icon(h.store === v ? 'check-circle' : 'circle')}<span><b>${l}</b><span>${d}</span></span></button>`).join('')}
    <div class="menu-group">决策保留时长</div>
    <div style="padding:4px 9px 8px"><span class="seg">${ret.map(([v, l]) => `<button data-pick="ret:${v}" aria-pressed="${h.retention_days === v}">${l}</button>`).join('')}</span></div>
    <div class="menu-group">Storage</div>
    <div class="small muted" style="padding:2px 12px 8px;max-width:340px">${(st.decisions || 0).toLocaleString()} 条决策，磁盘占用 ${fmtNum(((st.db_bytes || 0) + (st.blob_bytes || 0)) / 1e6, 1)} MB。置顶与已标注的决策会突破此上限保留。代码可在单次调用中使用 <code>"store": false</code> 选择不保存。</div>
    <div class="menu-sep"></div>
    <button class="menu-item" data-pick="clear">${icon('trash')}<span><b>删除历史记录</b><span>除置顶外的全部决策。</span></span></button>`, {
    align: 'right',
    onPick: async (v) => {
      const [k, val] = v.split(':');
      try {
        if (k === 'store') settings = await studio('/settings', { method: 'PATCH', body: { history: { store: val, notice_acknowledged_at: true } } });
        if (k === 'ret') settings = await studio('/settings', { method: 'PATCH', body: { history: { retention_days: +val, notice_acknowledged_at: true } } });
        if (k === 'clear') {
          if (!(await confirmDialog({ title: '删除历史记录？', body: '<p>历史中的全部决策将被删除，置顶除外。模板、示例与模型不受影响。此操作无法撤销。</p>', confirm: '删除历史', danger: true }))) return;
          const r = await studio('/decisions/delete', { method: 'POST', body: { all: true, include_pinned: false } });
          toast(`已删除 ${r.deleted.toLocaleString()} 条决策`);
          sel = null; full = null; drawInspector();
        }
        toast(k === 'store' ? '历史设置已保存' : k === 'ret' ? '保留时长已保存' : '');
        reload();
      } catch (e) { toast(e.message, 'error'); }
    },
  });
}

// ------------------------------------------------------------------ inspector
async function drawInspector() {
  const box = $('#ainsp', root);
  if (!box) return;
  if (!sel) { box.innerHTML = `<div class="empty" style="height:100%"><div class="glyph">${icon('cursor-click')}</div><h2>选择一条决策</h2><p>此处会展示答案、输入、当时使用的设置，以及可执行的后续操作。</p></div>`; return; }
  if (!full || full.id !== sel) {
    try { full = await studio(`/decisions/${sel}?include=input.rendered_state,answers.raw_probabilities`); }
    catch (e) { box.innerHTML = `<div class="empty" style="height:100%"><h2>不可用</h2><p>${esc(e.message)}</p></div>`; return; }
  }
  const d = full;
  const t = d.template;
  const title = t ? (templates.find((x) => x.id === t.id)?.name || t.id) : '无模板的决策';
  const statusChip = d.status === 'completed' ? (d.act ? '<span class="chip violet">已自动执行</span>' : '<span class="chip amber">需人工</span>') : d.status === 'failed' ? '<span class="chip danger">失败</span>' : `<span class="chip">${esc(d.status)}</span>`;
  box.innerHTML = `<div class="req-insp" data-shown="${esc(d.id)}">
    <div class="hero"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${statusChip}<span class="muted small">${esc(new Date(d.created_at * 1000).toLocaleString())}</span>${d.pinned ? `<span class="chip">${icon('push-pin')}已置顶</span>` : ''}</div>
      <h2>${esc(title)}${t ? ` <span class="muted" style="font-weight:500">v${t.version}</span>` : ''}</h2>
      <span class="small muted">${esc(nameOf(d.model))}, ${esc(SURFACE[d.source.surface] || d.source.surface)}${d.source.client ? `, ${esc(d.source.client)}` : ''}</span></div>
    <div class="tabbody" style="padding:6px 18px 24px;display:grid;gap:14px">
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-primary sm" id="replay" ${d.input ? '' : 'disabled'}>${icon('flask')}在试验台中打开</button>
        <button class="btn sm" id="rerun" ${d.input ? '' : 'disabled'}>${icon('arrow-clockwise')}重跑于</button>
        <button class="btn sm" id="pin">${icon('push-pin')}${d.pinned ? '取消置顶' : '置顶'}</button>
        <button class="icon-btn" id="dmore" aria-label="更多操作">${icon('dots-three')}</button>
      </div>
      ${d.error ? `<div class="note danger">${icon('warning-circle')}<span>${esc(d.error.message)}</span></div>` : ''}
      ${d.warnings?.length ? `<div class="note">${icon('info')}<span>${d.warnings.map((w) => esc(w.message)).join('<br>')}</span></div>` : ''}
      <span class="seg full" role="tablist">${[['answers', '答案'], ['input', '输入'], ['settings', '设置'], ['json', 'JSON']].map(([k, l]) => `<button role="tab" data-itab="${k}" aria-pressed="${itab === k}" aria-selected="${itab === k}">${l}</button>`).join('')}</span>
      <div id="itabbody"></div>
    </div></div>`;
  const body = $('#itabbody', box);
  const drawTab = () => {
    if (itab === 'answers') {
      if (!d.answers) { body.innerHTML = '<p class="muted">此决策没有答案。</p>'; return; }
      body.innerHTML = `${figures(d, { questions: d.input?.questions || {} }, { run: 1 })}${feedbackForm(d)}`;
      const g = $('.figs', body); if (g) g.style.gridTemplateColumns = 'minmax(0, 1fr)';
      animate(body, { instant: true });
      bindFeedback(body, d);
    }
    if (itab === 'input') body.innerHTML = inputView(d);
    if (itab === 'settings') { body.innerHTML = settingsView(d); $$('[data-copy]', body).forEach((r) => r.addEventListener('click', () => copy(r.dataset.copy, '已复制'))); }
    if (itab === 'json') body.innerHTML = jsonTree(d, { file: 'Decision', openDepth: 2, collapse: ['legend', 'raw_probabilities', 'questions'] });
  };
  $$('[data-itab]', box).forEach((b) => b.addEventListener('click', () => { itab = b.dataset.itab; $$('[data-itab]', box).forEach((y) => { y.setAttribute('aria-pressed', y === b); y.setAttribute('aria-selected', y === b); }); drawTab(); }));
  $('#replay', box).addEventListener('click', async () => { await loadDecision(d); location.hash = '#/playground'; });
  $('#rerun', box).addEventListener('click', (e) => rerunMenu(e.currentTarget, d));
  $('#pin', box).addEventListener('click', async () => {
    try { full = await studio(`/decisions/${d.id}`, { method: 'PATCH', body: { pinned: !d.pinned } }); toast(full.pinned ? '已置顶：超出保留期仍保留' : '已取消置顶'); drawInspector(); load(); } catch (e) { toast(e.message, 'error'); }
  });
  $('#dmore', box).addEventListener('click', (e) => moreMenu(e.currentTarget, d));
  drawTab();
}

function inputView(d) {
  if (!d.input) return `<div class="note">${icon('info')}<span>${d.store === 'answers_only' ? '仅保留了此决策的答案，未保留情境。' : '未保留此决策的输入。'}</span></div>`;
  const i = d.input;
  const media = (i.media || []).map((m) => `<div class="grow"><span class="k">${esc(m.variable || m.type)}</span><span class="v">${m.available && m.file_id ? `<a href="/v1/studio/files/${esc(m.file_id)}/content" target="_blank">${esc(m.name || m.file_id)}</a>` : `<span class="faint">${esc(m.type)}，文件未保留</span>`}</span></div>`).join('');
  return `<div style="display:grid;gap:12px">
    ${i.variables ? `<div><h3 class="small muted" style="margin-bottom:6px">变量</h3>${jsonTree(i.variables, { file: 'variables', openDepth: 2 })}</div>` : ''}
    <div><h3 class="small muted" style="margin-bottom:6px">模型阅读的内容</h3><pre class="code" style="white-space:pre-wrap;max-height:320px;overflow:auto">${esc(i.rendered_state ?? JSON.stringify(i.state, null, 2))}</pre></div>
    ${media ? `<div class="group">${media}</div>` : ''}
    ${i.redacted ? `<p class="small muted">已脱敏：${i.redacted.map(esc).join(', ')}</p>` : ''}
  </div>`;
}

const SRC = { request: '本次请求', 'request.questions': '本次请求（此问题）', template: '模板', 'template.questions': '模板（此问题）', studio: '工作室默认', question: '问题' };
const srcText = (s) => SRC[s] || (s?.startsWith('template.models.') ? `the template, for ${nameOf(s.split('.')[2])}${s.endsWith('.questions') ? ', this question' : ''}` : s);

function settingsView(d) {
  const s = d.settings || {};
  const src = s.sources || {};
  const rows = [['执行阈值', fmtPct(s.act_threshold), src.act_threshold], ['校准温度', fmtNum(s.temperature), src.temperature]];
  for (const [q, v] of Object.entries(s.questions || {})) for (const [k, val] of Object.entries(v)) rows.push([`${q}: ${k.replace('_', ' ')}`, k === 'temperature' ? fmtNum(val) : fmtPct(val), src[`questions.${q}.${k}`]]);
  const ext = d.extensions || {};
  const extLines = [ext.questions?.length ? `新增问题：${ext.questions.join(', ')}` : '', Object.keys(ext.options || {}).length ? `新增选项：${Object.entries(ext.options).map(([k, v]) => `${k}（${v.join(', ')}）`).join('；')}` : '', ext.skipped?.length ? `已跳过：${ext.skipped.join(', ')}` : ''].filter(Boolean);
  return `<div style="display:grid;gap:12px">
    <div class="group">${rows.map(([k, v, from]) => `<div class="grow"><span class="k">${esc(k)}</span><span class="v"><b class="num" style="font-weight:600;color:var(--text)">${esc(v)}</b> <span class="small">来自 ${esc(srcText(from))}</span></span></div>`).join('')}</div>
    ${extLines.length ? `<div class="note">${icon('plus-circle')}<span>${extLines.map(esc).join('<br>')}</span></div>` : ''}
    <div class="group">
      <div class="grow"><span class="k">耗时</span><span class="v num">模型 ${fmtMs(d.timing?.model_ms)}，合计 ${fmtMs(d.timing?.total_ms)}${d.timing?.load_ms ? `，加载 ${fmtMs(d.timing.load_ms)}` : ''}</span></div>
      <div class="grow"><span class="k">端点</span><span class="v"><code>${esc(d.source.endpoint)}</code></span></div>
      ${d.source.request_id ? `<div class="grow link" data-copy="${esc(d.source.request_id)}"><span class="k">请求 ID</span><span class="v"><code>${esc(d.source.request_id)}</code></span></div>` : ''}
      <div class="grow link" data-copy="${esc(d.id)}"><span class="k">决策 ID</span><span class="v"><code>${esc(d.id)}</code></span></div>
      <div class="grow"><span class="k">保留至</span><span class="v">${d.expires_at ? esc(new Date(d.expires_at * 1000).toLocaleDateString()) : '长期保留（置顶、已标注或无限制）'}</span></div>
      ${Object.keys(d.metadata || {}).length ? `<div class="grow stack"><span class="k">元数据</span><span class="v"><code>${esc(JSON.stringify(d.metadata))}</code></span></div>` : ''}
    </div></div>`;
}

// Labels: the right answer per question, in the decision's own vocabulary. They feed accuracy per version.
function labelOptions(q) {
  if (!q) return [];
  if (q.type === 'noul') return [['yes', '是'], ['no', '否']];
  if (q.type === 'score') return (q.criteria || []).map((l, i) => [String(i), typeof l === 'string' ? l : JSON.stringify(l)]);
  if (['choice', 'rank'].includes(q.type)) return (Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria || {})).map((n) => [String(n), String(n)]);
  return [];
}

function feedbackForm(d) {
  const qs = d.input?.questions || {};
  const keys = Object.keys(d.answers || {}).filter((k) => labelOptions(qs[k] || { type: d.answers[k].type }).length);
  if (!keys.length) return '';
  return `<details class="more" style="margin-top:12px" ${Object.keys(d.feedback || {}).length ? 'open' : ''}><summary>${icon('tag')}标注正确答案</summary>
    <div class="group" style="margin-top:8px">${keys.map((k) => {
      const opts = labelOptions(qs[k] || { type: d.answers[k].type });
      const cur = d.feedback?.[k];
      const verdict = cur ? (cur.correct ? `<span class="chip ok">${icon('check')}正确</span>` : '<span class="chip amber">错误</span>') : '';
      return `<div class="grow"><span class="k small" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(qs[k]?.instructions || k)}</span>${verdict}
        <select class="select" data-label="${esc(k)}" style="width:auto;max-width:160px"><option value="">未标注</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${cur?.expected === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
    }).join('')}</div>
    <p class="help">标注用于按模板版本统计准确率，并可成为测试示例。</p></details>`;
}

function bindFeedback(body, d) {
  $$('[data-label]', body).forEach((s) => s.addEventListener('change', async () => {
    if (!s.value) return;
    try {
      await studio(`/decisions/${d.id}/feedback`, { method: 'POST', body: { expected: { [s.dataset.label]: s.value } } });
      full = null; toast('标注已保存'); drawInspector(); load();
    } catch (e) { toast(e.message, 'error'); }
  }));
}

function rerunMenu(anchor, d) {
  const ms = readyModels();
  popMenu(anchor, `<div class="menu-group">用相同输入重跑于</div>${ms.map((m) => `<button class="menu-item" data-pick="${esc(m.id)}">${icon('cube')}<span><b>${esc(m.name)}</b>${m.id === d.model ? '<span>同一模型</span>' : ''}</span></button>`).join('') || '<div class="small muted" style="padding:8px 12px">请先加载模型。</div>'}`, {
    onPick: async (mid) => {
      try {
        const r = await studio(`/decisions/${d.id}/rerun`, { method: 'POST', body: { model: mid } });
        toast(`在 ${nameOf(mid)} 上重跑：${r.act ? '已自动执行' : '需人工'}`);
        sel = r.id; full = null; await load(); drawInspector();
      } catch (e) { toast(e.message, 'error'); }
    },
  });
}

function moreMenu(anchor, d) {
  const inTemplate = d.template && !d.template.id.startsWith('builtin/');
  popMenu(anchor, `
    <button class="menu-item" data-pick="template" ${d.input ? '' : 'disabled'}>${icon('stack')}<span><b>保存为模板</b><span>问题、模型与设置，可在任意模型上复用。</span></span></button>
    ${d.template ? `<button class="menu-item" data-pick="example" ${d.input && inTemplate ? '' : 'disabled'}>${icon('list-checks')}<span><b>加入 ${esc(d.template.id)} 的测试示例</b><span>使用你给出的标注。</span></span></button>
    <button class="menu-item" data-pick="open-template">${icon('arrow-square-out')}<span><b>打开模板</b></span></button>` : ''}
    <button class="menu-item" data-pick="copy">${icon('copy')}<span><b>复制决策 ID</b></span></button>
    <div class="menu-sep"></div>
    <button class="menu-item" data-pick="delete">${icon('trash')}<span><b>删除此决策</b></span></button>`, {
    align: 'right',
    onPick: async (p) => {
      try {
        if (p === 'copy') copy(d.id, '决策 ID 已复制');
        if (p === 'open-template') location.hash = `#/templates/${d.template.id}`;
        if (p === 'template') {
          const id = await askText({ title: '保存为模板', label: '模板在代码中使用的短 ID：小写字母、数字与短横线。', value: 'my-template', pattern: '[a-z0-9][a-z0-9_\\-]{0,63}', confirm: '保存模板' });
          if (!id) return;
          const t = await studio('/templates', { method: 'POST', body: { id, name: id.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase()), from: { decision: d.id }, note: '来自历史记录' } });
          toast(`模板 ${t.id} 已保存`); location.hash = `#/templates/${t.id}`;
        }
        if (p === 'example') {
          await studio(`/templates/${d.template.id}/examples`, { method: 'POST', body: { from_decision: d.id } });
          toast(`已加入 ${d.template.id} 的测试示例`);
        }
        if (p === 'delete') {
          if (!(await confirmDialog({ title: '删除此决策？', body: '<p>其输入、答案与标注将从历史中移除。此操作无法撤销。</p>', confirm: '删除', danger: true }))) return;
          await studio(`/decisions/${d.id}`, { method: 'DELETE' });
          items = items.filter((x) => x.id !== d.id); sel = items[0]?.id || null; full = null; draw(); drawInspector(); toast('已删除');
        }
      } catch (e) { toast(e.message, 'error'); }
    },
  });
}
