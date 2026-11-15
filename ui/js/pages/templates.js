// Templates: reusable decisions. A template holds the questions, the typed variables that fill in the situation, a
// default model and settings; every save is a new, numbered version, and every decision made with it is in its history.
// The library lists your templates and the starter ones; a template's page shows it, its history, a comparison of two
// versions over real traffic, its test examples and its versions.

import { TYPE_META } from '../figures.js';
import { codeBlock, jsonTree } from '../format.js';
import { setSub, shell } from '../shell.js';
import { model, studio } from '../store.js';
import { $, $$, askText, confirmDialog, copy, esc, fmtMs, fmtNum, fmtPct, icon, popMenu, toast } from '../util.js';
import { openTemplate } from './playground.js';

let root;
let tab = 'overview';
let state = { list: null, builtins: null, showArchived: false, q: '' };
let cur = null;           // the open template (latest version)
let shown = null;         // the version shown on Overview
let cmp = { a: null, b: null, model: '', range: '' };

const nameOf = (id) => model(id)?.name || id;
const ago = (t) => { if (!t) return '从未'; const s = Date.now() / 1000 - t; if (s < 3600) return `${Math.max(1, Math.round(s / 60))} 分钟前`; if (s < 86400) return `${Math.round(s / 3600)} 小时前`; return new Date(t * 1000).toLocaleDateString(); };
const CLASS = { created: ['首个版本', ''], extended: ['扩展', 'violet'], wording: ['措辞', ''], settings_only: ['仅设置', ''], breaking: ['破坏性变更', 'amber'], unchanged: ['未变更', ''] };
const COMP = { identical: ['相同问题', 'ok'], text_changed: ['改写', ''], options_changed: ['选项已改', 'violet'], incomparable: ['无法比较', 'amber'], added: ['新增', 'violet'], removed: ['已移除', 'amber'], reference: ['参考', ''] };

export async function mount(el, params = {}) {
  root = el;
  if (params.id) {
    if (params.tab) tab = params.tab;
    await openDetail(params.id);
  } else {
    shell.setTitle('模板', '');
    await drawLibrary();
  }
}

// ------------------------------------------------------------------ library
async function drawLibrary() {
  root.innerHTML = `<div class="view scroll"><div class="lib-page">
    <div class="lib-top">
      <p class="muted" style="max-width:70ch">模板是可复用的决策：问题、用于填充情境的变量，以及默认模型与设置。每次保存生成新版本，使用该模板做出的每次决策都会记入历史。</p>
      <div class="lib-actions">
        <label class="search">${icon('magnifying-glass')}<input class="input" id="tq" placeholder="搜索模板" value="${esc(state.q)}"></label>
        <label class="switch small"><span>显示已归档</span><input type="checkbox" id="arch" ${state.showArchived ? 'checked' : ''}></label>
        <button class="btn btn-primary" id="newtpl">${icon('plus')}新建模板</button>
      </div>
    </div>
    <div id="lib"></div></div></div>`;
  $('#newtpl', root).addEventListener('click', newTemplate);
  $('#arch', root).addEventListener('change', (e) => { state.showArchived = e.target.checked; loadLibrary(); });
  let t; $('#tq', root).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim(); renderLibrary(); }, 200); });
  await loadLibrary();
}

async function loadLibrary() {
  try {
    const [mine, builtins] = await Promise.all([
      studio(`/templates?origin=user&limit=100${state.showArchived ? '&include_archived=true' : ''}`),
      studio('/templates?origin=builtin&limit=100'),
    ]);
    state.list = mine.data; state.builtins = builtins.data;
  } catch (e) { $('#lib', root).innerHTML = `<div class="empty"><h2>模板不可用</h2><p>${esc(e.message)}</p></div>`; return; }
  renderLibrary();
}

function match(t) {
  const q = state.q.toLowerCase();
  return !q || `${t.id} ${t.name} ${t.description}`.toLowerCase().includes(q);
}

function card(t, starter = false) {
  const s = t.summary || {};
  const recommended = (t.metadata?.['basal.recommended_models'] || '').split(',').filter(Boolean);
  return `<a class="tpl-card ${t.archived ? 'archived' : ''}" href="#/templates/${esc(t.id)}">
    <span class="tpl-card-top"><b>${esc(t.name)}</b>${starter ? '' : `<span class="chip">v${t.version}</span>`}${t.archived ? '<span class="chip">已归档</span>' : ''}</span>
    <span class="small muted tpl-desc">${esc(t.description || (starter ? '' : t.id))}</span>
    <span class="tpl-meta small muted">
      <span>${icon('question')}${(s.questions || []).length} 个问题</span>
      ${(s.variables || []).length ? `<span>${icon('brackets-curly')}${s.variables.length} 个变量</span>` : `<span>${icon('text-t')}接收情境</span>`}
      ${s.model ? `<span>${icon('cube')}${esc(nameOf(s.model))}</span>` : recommended.length ? `<span>${icon('cube')}${esc(recommended.map(nameOf).join(', '))}</span>` : ''}
      ${starter ? '' : `<span>${icon('clock')}${t.last_used_at ? `${ago(t.last_used_at)} 使用` : '尚未使用'}</span>`}
    </span></a>`;
}

function renderLibrary() {
  const box = $('#lib', root);
  if (!box || !state.list) return;
  const mine = state.list.filter(match);
  const starters = (state.builtins || []).filter(match);
  const groups = [...new Set(starters.map((t) => t.metadata?.['basal.group'] || '其他'))];
  setSub(`你的 ${state.list.length} 个，入门 ${state.builtins?.length || 0} 个`);
  box.innerHTML = `
    <section class="lib-sec"><h2>你的模板</h2>
      ${mine.length ? `<div class="tpl-grid">${mine.map((t) => card(t)).join('')}</div>` : `<div class="lib-empty">${icon('stack')}<div><b>${state.q ? '没有匹配的模板' : '还没有模板'}</b>
        <p class="small muted">${state.q ? '请换个关键词试试。' : '在试验台中构建决策并点击 <b>另存为模板</b>，或从下方入门模板开始。'}</p></div>
        ${state.q ? '' : `<a class="btn" href="#/playground">${icon('flask')}打开试验台</a>`}</div>`}
    </section>
    <section class="lib-sec"><h2>入门模板</h2><p class="small muted" style="margin-top:-4px">即用型决策。可直接使用，或克隆后按需修改。</p>
      ${groups.map((g) => `<h3 class="lib-group">${esc(g)}</h3><div class="tpl-grid">${starters.filter((t) => (t.metadata?.['basal.group'] || '其他') === g).map((t) => card(t, true)).join('')}</div>`).join('')}
    </section>`;
}

function newTemplate() {
  popMenu($('#newtpl', root), `
    <button class="menu-item" data-pick="play">${icon('flask')}<span><b>在试验台中构建</b><span>编写情境与问题、在模型上试用，再另存为模板。</span></span></button>
    <button class="menu-item" data-pick="json">${icon('brackets-curly')}<span><b>粘贴定义</b><span>符合 API 格式的 JSON（变量、state、问题等）。</span></span></button>`, {
    align: 'right',
    onPick: (p) => { if (p === 'play') { location.hash = '#/playground?new=1'; } else pasteDefinition(); },
  });
}

function pasteDefinition() {
  const d = document.createElement('dialog');
  const sample = { id: 'support-triage', name: 'Support triage', variables: { customer_message: { type: 'string' }, account_tier: { type: 'string', enum: ['free', 'pro', 'enterprise'], default: 'free' } },
    state: { tier: '{{account_tier}}', message: '{{customer_message}}' },
    questions: { department: { type: 'choice', instructions: 'Which department should handle this?', criteria: ['billing', 'technical', 'sales'] }, urgent: { type: 'noul', instructions: 'Is it urgent?' } } };
  d.innerHTML = `<form method="dialog" style="width:min(720px,92vw)"><div class="dialog-body"><h2 style="font-size:17px">从定义新建模板</h2>
    <p class="small muted">与 <code>POST /v1/studio/templates</code> 接受的 JSON 相同。所有错误会一并列出。</p>
    <textarea class="textarea code" id="def" rows="16" spellcheck="false">${esc(JSON.stringify(sample, null, 2))}</textarea><div id="deferr"></div></div>
    <div class="dialog-foot"><button class="btn" value="cancel" formnovalidate>取消</button><button class="btn btn-primary" id="defsave" value="ok">创建模板</button></div></form>`;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  $('#defsave', d).addEventListener('click', async (e) => {
    e.preventDefault();
    let body;
    try { body = JSON.parse($('#def', d).value); } catch (err) { $('#deferr', d).innerHTML = `<div class="note danger">${esc(err.message)}</div>`; return; }
    try {
      const t = await studio('/templates', { method: 'POST', body: { note: '第一版', ...body } });
      d.close(); toast(`已创建 ${t.id}`); location.hash = `#/templates/${t.id}`;
    } catch (err) { $('#deferr', d).innerHTML = problems(err); }
  });
  d.showModal();
}

function problems(err) {
  const det = err.data?.error?.details || [];
  return `<div class="note danger" style="margin-top:8px">${icon('warning-circle')}<span>${det.length ? det.map((x) => `${x.param ? `<code>${esc(x.param)}</code> ` : ''}${esc(x.message)}`).join('<br>') : esc(err.message)}</span></div>`;
}

// ------------------------------------------------------------------ one template
async function openDetail(id) {
  try { cur = await studio(`/templates/${id}`); }
  catch (e) { shell.setTitle('模板', ''); root.innerHTML = `<div class="empty"><div class="glyph">${icon('warning-circle')}</div><h2>未找到模板</h2><p>${esc(e.message)}</p><a class="btn" href="#/templates">全部模板</a></div>`; return; }
  shown = cur;
  cmp = { a: Math.max(1, cur.version - 1), b: cur.version, model: '', range: '' };
  shell.setTitle(cur.name, '');
  drawDetail();
}

function drawDetail() {
  const t = cur;
  const builtin = t.origin === 'builtin';
  const aliases = Object.entries(t.aliases).filter(([a]) => a !== 'latest');
  setSub(`<code>${esc(t.id)}</code>，版本 ${t.version}`);
  root.innerHTML = `<div class="view scroll"><div class="tpl-page">
    <div class="tpl-head">
      <div style="min-width:0">
        <a class="small muted back" href="#/templates">${icon('caret-left')}模板</a>
        <h1>${esc(t.name)}</h1>
        <p class="muted">${esc(t.description || (builtin ? '入门模板。' : ''))}</p>
        <div class="tpl-badges"><span class="chip mono">${esc(t.id)}</span><span class="chip violet">v${t.version} 最新</span>
          ${aliases.map(([a, v]) => `<span class="chip">${icon('tag')}${esc(a)}: v${v}</span>`).join('')}
          ${builtin ? '<span class="chip">入门，只读</span>' : ''}${t.archived ? '<span class="chip amber">已归档</span>' : ''}
          ${t.storage !== 'full' ? `<span class="chip">历史：${t.storage === 'none' ? '关闭' : '仅答案'}</span>` : ''}</div>
      </div>
      <div class="tpl-head-actions">
        <button class="btn btn-primary" id="use">${icon('flask')}在试验台中打开</button>
        ${builtin ? `<button class="btn" id="clone">${icon('copy')}克隆以编辑</button>` : `<button class="btn" id="edit">${icon('pencil-simple')}编辑</button>`}
        <button class="icon-btn" id="tmore" aria-label="更多">${icon('dots-three')}</button>
      </div>
    </div>
    <div class="utabs tpl-tabs" role="tablist">${[['overview', '概览', 'info'], ['history', '历史', 'clock-counter-clockwise'], ['compare', '比较版本', 'git-diff'], ['examples', '测试示例', 'list-checks'], ['versions', `版本 (${t.version})`, 'git-commit']].map(([k, l, i]) => `<button role="tab" data-tab="${k}" aria-pressed="${tab === k}" aria-selected="${tab === k}">${icon(i)}${l}</button>`).join('')}</div>
    <div id="tbody" class="tpl-body"></div></div></div>`;
  $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; $$('[data-tab]', root).forEach((x) => { x.setAttribute('aria-pressed', x === b); x.setAttribute('aria-selected', x === b); }); drawTab(); }));
  $('#use', root).addEventListener('click', () => { openTemplate(shown); location.hash = '#/playground'; });
  $('#edit', root)?.addEventListener('click', () => { openTemplate(cur, { edit: true }); location.hash = '#/playground'; });
  $('#clone', root)?.addEventListener('click', cloneIt);
  $('#tmore', root).addEventListener('click', (e) => moreMenu(e.currentTarget));
  drawTab();
}

async function cloneIt() {
  const id = await askText({ title: '克隆到你的模板', label: '副本 id：小写字母、数字与连字符。', value: cur.id.replace(/^builtin\//, 'my-'), pattern: '[a-z0-9][a-z0-9_\\-]{0,63}', confirm: '克隆' });
  if (!id) return;
  try {
    const t = await studio('/templates', { method: 'POST', body: { id, name: `${cur.name}（副本）`, description: cur.description, from: { template: `${cur.id}@${cur.version}` }, note: `从 ${cur.id} v${cur.version} 克隆` } });
    toast(`已克隆为 ${t.id}`); location.hash = `#/templates/${t.id}`;
  } catch (e) { toast(e.message, 'error'); }
}

function moreMenu(anchor) {
  const builtin = cur.origin === 'builtin';
  popMenu(anchor, `
    ${builtin ? '' : `<button class="menu-item" data-pick="rename">${icon('pencil-simple-line')}<span><b>重命名或描述</b><span>不会创建新版本。</span></span></button>
    <button class="menu-item" data-pick="storage">${icon('clock-counter-clockwise')}<span><b>此模板的历史记录</b><span>保留内容与保留时长。</span></span></button>`}
    ${builtin ? '' : `<button class="menu-item" data-pick="clone">${icon('copy')}<span><b>复制</b></span></button>`}
    <button class="menu-item" data-pick="json">${icon('brackets-curly')}<span><b>复制定义为 JSON</b></span></button>
    ${builtin ? '' : `<div class="menu-sep"></div>
    <button class="menu-item" data-pick="archive">${icon('archive')}<span><b>${cur.archived ? '取消归档' : '归档'}</b><span>${cur.archived ? '在库中重新显示。' : '在库中隐藏；调用它的代码仍可工作。'}</span></span></button>
    <button class="menu-item" data-pick="delete">${icon('trash')}<span><b>删除</b><span>调用它的代码将无法工作。</span></span></button>`}`, {
    align: 'right',
    onPick: async (p) => {
      try {
        if (p === 'json') { const def = Object.fromEntries(['modalities', 'variables', 'state', 'questions', 'model', 'settings', 'extensions'].map((k) => [k, shown[k]])); copy(JSON.stringify({ id: cur.id, name: cur.name, ...def }, null, 2), '已复制定义'); }
        if (p === 'clone') cloneIt();
        if (p === 'rename') {
          const name = await askText({ title: '重命名', label: '在库中显示的名称。', value: cur.name, confirm: '保存' });
          if (!name) return;
          cur = await studio(`/templates/${cur.id}`, { method: 'PATCH', body: { name } }); shown = cur; shell.setTitle(cur.name, ''); drawDetail();
        }
        if (p === 'storage') storageDialog();
        if (p === 'archive') { cur = await studio(`/templates/${cur.id}/${cur.archived ? 'unarchive' : 'archive'}`, { method: 'POST' }); shown = cur; drawDetail(); toast(cur.archived ? '已归档，仍可响应调用。' : '已取消归档'); }
        if (p === 'delete') {
          const keep = await confirmDialog({ title: `删除 ${cur.name}？`, body: `<p>调用 <code>${esc(cur.id)}</code> 的代码将收到「template not found」。其决策仍保留在历史中（含所用版本）；若需清除请到历史中删除。</p>`, confirm: '删除模板', danger: true });
          if (!keep) return;
          await studio(`/templates/${cur.id}?confirm=${encodeURIComponent(cur.id)}&history=keep`, { method: 'DELETE' });
          toast('模板已删除，历史记录已保留。'); location.hash = '#/templates';
        }
      } catch (e) { toast(e.message, 'error'); }
    },
  });
}

function storageDialog() {
  const d = document.createElement('dialog');
  const levels = [['full', '全部'], ['answers_only', '仅答案'], ['none', '不保留']];
  d.innerHTML = `<form method="dialog"><div class="dialog-body"><h2 style="font-size:17px">${esc(cur.name)} 的历史记录</h2>
    <label class="field"><span class="label">每次决策保留的内容</span><select class="select" name="storage">${levels.map(([v, l]) => `<option value="${v}" ${cur.storage === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span class="help">调用方只能保留更少，不能更多。「仅答案」保留答案、模型与耗时，不保留情境。</span></label>
    <label class="field"><span class="label">保留决策（天）</span><input class="input" name="days" type="number" min="0" placeholder="工作室默认" value="${cur.retention_days ?? ''}">
      <span class="help">留空使用工作室默认；0 表示永久保留。</span></label></div>
    <div class="dialog-foot"><button class="btn" value="cancel">取消</button><button class="btn btn-primary" value="ok">保存</button></div></form>`;
  document.body.append(d);
  d.addEventListener('close', async () => {
    if (d.returnValue === 'ok') {
      const f = new FormData(d.querySelector('form'));
      const days = f.get('days');
      try { cur = await studio(`/templates/${cur.id}`, { method: 'PATCH', body: { storage: f.get('storage'), retention_days: days === '' ? null : +days } }); shown = cur; drawDetail(); toast('已保存'); } catch (e) { toast(e.message, 'error'); }
    }
    d.remove();
  });
  d.showModal();
}

function drawTab() {
  const box = $('#tbody', root);
  if (!box) return;
  ({ overview, history: historyTab, compare: compareTab, examples: examplesTab, versions: versionsTab })[tab](box);
}

// ------------------------------------------------------------------ overview
function varType(v) {
  if (v.type === 'string' && v.enum) return `其一：${v.enum.join('、')}`;
  if (v.type === 'string') return `文本${v.max_length ? `，最多 ${v.max_length.toLocaleString()} 个字符` : ''}`;
  return { integer: '整数', number: '数字', boolean: '是/否', json: 'JSON', options: '选项列表', image: '图像', audio: '音频', video: '视频' }[v.type] || v.type;
}

function questionCard(k, q, t) {
  const meta = TYPE_META[q.type];
  const c = q.criteria;
  let opts = '';
  if (typeof c === 'string') opts = `<span class="chip violet">${esc(c)}</span><span class="small muted">选项来自此变量</span>`;
  else if (['choice', 'multi', 'rank'].includes(q.type)) opts = (Array.isArray(c) ? c.map((n) => [n, null]) : Object.entries(c || {})).map(([n, d]) => `<span class="opt ro"><span class="name">${esc(String(n).replace(/_/g, ' '))}</span>${d ? `<span class="desc">${esc(typeof d === 'string' ? d : JSON.stringify(d))}</span>` : ''}</span>`).join('');
  else if (q.type === 'score') opts = (c || []).map((l, i) => `${i ? `<span class="arrow">${icon('caret-right')}</span>` : ''}<span class="opt ro"><span class="name">${esc(typeof l === 'string' ? l : JSON.stringify(l))}</span></span>`).join('');
  else if (q.type === 'number') opts = (Array.isArray(c) ? c : Object.keys(c || {})).map((v) => `<span class="opt ro"><span class="name">${esc(String(v))}${q.unit ? ` ${esc(q.unit)}` : ''}</span></span>`).join('');
  const ext = t.extensions || {};
  const canAdd = ext.options === true || (ext.options || []).includes(k);
  const canSkip = ext.skip === true || (ext.skip || []).includes(k);
  const qs = t.settings?.questions?.[k];
  return `<div class="qcard"><div class="qcard-top"><span class="q-type ro">${icon(meta.icon)}${meta.name}</span><code class="small muted">${esc(k)}</code>
      ${canAdd ? '<span class="chip">调用方可添加选项</span>' : ''}${canSkip ? '<span class="chip">调用方可跳过</span>' : ''}
      ${qs?.act_threshold ? `<span class="chip">在 ${fmtPct(qs.act_threshold)} 时自动执行</span>` : ''}</div>
    <p class="qcard-text">${withVars(typeof q.instructions === 'string' ? q.instructions : JSON.stringify(q.instructions ?? ''))}</p>
    ${opts ? `<div class="opts ro">${opts}</div>` : ''}</div>`;
}

// Question text with its {{variable}} placeholders shown as variables.
const withVars = (text) => esc(text).replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g, '<code class="var">$1</code>');

function exampleVariables(t) {
  const out = {};
  for (const [n, v] of Object.entries(t.variables || {})) {
    if (v.example != null) out[n] = v.example;
    else if (v.default != null) continue;
    else if (!v.required) continue;
    else out[n] = v.type === 'string' ? (v.enum ? v.enum[0] : '...') : v.type === 'integer' || v.type === 'number' ? 0 : v.type === 'boolean' ? false : v.type === 'options' ? ['option_a', 'option_b'] : ['image', 'audio', 'video'].includes(v.type) ? 'file_...' : {};
  }
  return out;
}

function overview(box) {
  const t = shown;
  const vars = Object.entries(t.variables || {});
  const s = t.settings || {};
  const perModel = Object.entries(s.models || {});
  const ext = t.extensions || {};
  const body = vars.length ? { template: t.id, variables: exampleVariables(t) } : { template: t.id, state: '待决策的情境' };
  const curl = `curl ${location.origin}/v1/studio/decisions \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify(body)}'`;
  const py = `import httpx\n\nstudio = httpx.Client(base_url="${location.origin}/v1/studio")\nd = studio.post("/decisions", json=${JSON.stringify(body, null, 4).replace(/\n/g, '\n').replace(/true/g, 'True').replace(/false/g, 'False').replace(/null/g, 'None')}).json()\n\nif d["act"]:\n    ...  # every answer is sure enough to act on\nelse:\n    print("Ask a human about", d["needs_review"])`;
  box.innerHTML = `<div class="tpl-cols">
    <div class="tpl-main">
      ${t.version !== cur.version ? `<div class="note amber">${icon('clock-counter-clockwise')}<span>正在查看版本 ${t.version}，最新为 ${cur.version}。</span><button class="btn sm" id="latest" style="margin-left:auto">查看最新</button></div>` : ''}
      <section class="tpl-sec"><h2>情境</h2>
        ${vars.length ? `<p class="small muted">调用方填写这些变量，模板将其组合为模型可读的情境。</p>
          <div class="group">${vars.map(([n, v]) => `<div class="grow"><span class="k"><code>${esc(n)}</code>${v.required ? '' : ' <span class="faint small">可选</span>'}${v.sensitive ? ` <span class="chip" data-tip="用于决策，不会写入历史">${icon('lock-simple')}敏感</span>` : ''}${v.description ? `<span class="small muted" style="display:block">${esc(v.description)}</span>` : ''}</span><span class="v small">${esc(varType(v))}${v.default != null ? `，默认 ${esc(JSON.stringify(v.default))}` : ''}</span></div>`).join('')}</div>
          ${t.state != null ? `<details class="more"><summary>${icon('caret-right')}如何组成情境</summary><div style="margin-top:8px">${typeof t.state === 'string' ? `<pre class="code" style="white-space:pre-wrap">${esc(t.state)}</pre>` : jsonTree(t.state, { file: 'state', openDepth: 3 })}</div></details>` : '<p class="small muted">变量本身即情境（JSON 对象）。</p>'}`
        : '<p class="small muted">调用方以 <code>state</code> 传入完整情境：文本或 JSON 对象/数组。声明变量可固定结构。</p>'}
        ${t.modalities.length > 1 ? `<p class="small muted">还支持 ${t.modalities.filter((m) => m !== 'text').join('、')}。</p>` : ''}
      </section>
      <section class="tpl-sec"><h2>问题</h2>${Object.entries(t.questions).map(([k, q]) => questionCard(k, q, t)).join('')}
        ${ext.questions ? `<p class="small muted">调用方每次决策最多可另加 ${ext.max_questions} 个问题。</p>` : '<p class="small muted">调用方不能添加问题。</p>'}</section>
    </div>
    <aside class="tpl-side">
      <section class="tpl-sec"><h2>模型与设置</h2>
        <div class="group">
          <div class="grow"><span class="k">默认模型</span><span class="v">${t.model ? esc(nameOf(t.model)) : '最近加载的模型'}</span></div>
          <div class="grow"><span class="k">自动执行阈值</span><span class="v num">${s.act_threshold ? fmtPct(s.act_threshold) : '工作室默认'}</span></div>
          <div class="grow"><span class="k">温度</span><span class="v num">${s.temperature ? fmtNum(s.temperature) : '1（无）'}</span></div>
          ${perModel.map(([m, v]) => `<div class="grow"><span class="k small">${esc(nameOf(m))}</span><span class="v small">${[v.temperature ? `温度 ${fmtNum(v.temperature)}` : '', v.act_threshold ? `在 ${fmtPct(v.act_threshold)} 执行` : '', v.questions ? `${Object.keys(v.questions).length} 项问题设置` : ''].filter(Boolean).join('、')}</span></div>`).join('')}
        </div>
        <p class="small muted">单次请求可覆盖模型与设置；历史会记录各值来自哪一层。</p>
      </section>
      <section class="tpl-sec"><h2>可运行的模型</h2><div id="compat" class="small muted">检查中</div></section>
      <section class="tpl-sec"><h2>在代码中使用</h2>
        ${codeBlock(curl, { lang: 'bash', file: 'curl' })}
        <details class="more"><summary>${icon('caret-right')}Python</summary><div style="margin-top:8px">${codeBlock(py, { lang: 'python', file: 'python' })}</div></details>
        <p class="small muted">用 <code>${esc(t.id)}@${t.version}</code> 固定版本，或用别名如 <code>${esc(t.id)}@production</code>。<a href="#/api">API 参考</a></p>
      </section>
    </aside></div>`;
  $('#latest', box)?.addEventListener('click', () => { shown = cur; overview(box); });
  studio(`/templates/${t.id}/compatibility?version=${t.version}`).then((c) => {
    const el = $('#compat', box);
    if (!el) return;
    const ok = c.models.filter((m) => m.ok && m.model !== 'fake-decider');
    const bad = c.models.filter((m) => !m.ok && m.model !== 'fake-decider');
    el.innerHTML = `<div class="compat">${ok.map((m) => `<span class="chip ${m.status === 'loaded' ? 'ok' : ''}" title="${esc(m.notes.join(' '))}">${icon('check')}${esc(m.name)}</span>`).join('')}
      ${bad.map((m) => `<span class="chip faint" title="${esc(m.problems.map((p) => p.message).join(' '))}">${esc(m.name)}</span>`).join('')}</div>
      ${bad.length ? '<p class="small muted" style="margin-top:6px">灰色模型无法运行；悬停查看原因。</p>' : ''}`;
  }).catch(() => {});
}

// ------------------------------------------------------------------ history
async function historyTab(box) {
  box.innerHTML = '<p class="muted">加载中</p>';
  let page, stats;
  try {
    [page, stats] = await Promise.all([studio(`/templates/${cur.id}/decisions?limit=50&attribution=all`), studio(`/templates/${cur.id}/stats`)]);
  } catch (e) { box.innerHTML = `<div class="note danger">${esc(e.message)}</div>`; return; }
  if (!page.data.length) {
    box.innerHTML = `<div class="empty"><div class="glyph">${icon('clock-counter-clockwise')}</div><h2>尚无使用此模板的决策</h2><p>在试验台中打开，或通过代码调用。每次决策都会在此保留所用确切版本。</p></div>`;
    return;
  }
  const total = stats.groups.reduce((a, g) => a + g.count, 0);
  box.innerHTML = `<div class="stats-strip slim" style="margin-bottom:14px">
      ${stats.groups.slice(-4).map((g) => `<div><span>版本 ${g.key.version}</span><b>${g.count.toLocaleString()}</b><small>${g.act_rate != null ? `${fmtPct(g.act_rate)} 自动执行` : ''}${g.latency_ms?.p50 != null ? `，典型 ${fmtMs(g.latency_ms.p50)}` : ''}</small></div>`).join('')}
    </div>
    <div class="card" style="overflow:hidden"><div class="tscroll"><table class="table hover">
      <thead><tr><th>时间</th><th>结果</th><th>版本</th><th>模型</th><th>答案</th></tr></thead>
      <tbody>${page.data.map((x) => `<tr data-open="${esc(x.id)}" tabindex="0"><td class="small">${ago(x.created_at)}</td>
        <td>${x.status === 'failed' ? '<span class="chip danger">失败</span>' : x.act ? '<span class="chip violet">已执行</span>' : '<span class="chip amber">需人工</span>'}</td>
        <td class="small">v${x.template.version}${x.extended ? ' <span class="faint">已扩展</span>' : ''}</td><td>${esc(nameOf(x.model))}</td>
        <td class="small" style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Object.entries(x.answers).slice(0, 3).map(([k, a]) => `${esc(k)}: <b>${esc(String(Array.isArray(a.decision) ? a.decision.join(', ') : a.decision ?? '').replace(/_/g, ' '))}</b>`).join(', ')}</td></tr>`).join('')}</tbody>
    </table></div></div>
    <p class="small muted" style="margin-top:8px">共 ${total.toLocaleString()} 次决策。<a href="#/history?template=${encodeURIComponent(cur.id)}">在历史中筛选与标注</a></p>`;
  $$('[data-open]', box).forEach((r) => r.addEventListener('click', () => { location.hash = `#/history/${r.dataset.open}?template=${encodeURIComponent(cur.id)}`; }));
}

// ------------------------------------------------------------------ compare versions
async function compareTab(box) {
  if (cur.version < 2) {
    box.innerHTML = `<div class="empty"><div class="glyph">${icon('git-diff')}</div><h2>目前只有一个版本</h2><p>保存第二个版本后，可在此对比真实流量：答案分布、自动执行频率、标注决策上的准确率，以及相同输入下答案变化。</p></div>`;
    return;
  }
  const opts = (sel) => Array.from({ length: cur.version }, (_, i) => cur.version - i).map((v) => `<option value="${v}" ${v === sel ? 'selected' : ''}>版本 ${v}${v === cur.version ? '（最新）' : ''}</option>`).join('');
  box.innerHTML = `<div class="cmp-bar">
      <select class="select" id="va" style="width:auto">${opts(cmp.a)}</select><span class="muted">${icon('arrow-right')}</span><select class="select" id="vb" style="width:auto">${opts(cmp.b)}</select>
      <select class="select" id="vm" style="width:auto"><option value="">全部模型</option>${[...new Set((await modelsUsed()))].map((m) => `<option value="${esc(m)}" ${cmp.model === m ? 'selected' : ''}>${esc(nameOf(m))}</option>`).join('')}</select>
      <span class="seg" role="group">${[['', '全部时间'], ['10080', '7 天'], ['43200', '30 天']].map(([v, l]) => `<button data-crange="${v}" aria-pressed="${cmp.range === v}">${l}</button>`).join('')}</span>
    </div><div id="cmpbody"><p class="muted">对比中</p></div>`;
  $('#va', box).addEventListener('change', (e) => { cmp.a = +e.target.value; compareTab(box); });
  $('#vb', box).addEventListener('change', (e) => { cmp.b = +e.target.value; compareTab(box); });
  $('#vm', box).addEventListener('change', (e) => { cmp.model = e.target.value; compareTab(box); });
  $$('[data-crange]', box).forEach((b) => b.addEventListener('click', () => { cmp.range = b.dataset.crange; compareTab(box); }));
  if (cmp.a === cmp.b) { $('#cmpbody', box).innerHTML = '<p class="muted">请选择两个不同版本。</p>'; return; }
  const p = new URLSearchParams({ versions: `${cmp.a},${cmp.b}` });
  if (cmp.model) p.set('model', cmp.model);
  if (cmp.range) p.set('created_after', `-${cmp.range}m`);
  let r, diff;
  try { [r, diff] = await Promise.all([studio(`/templates/${cur.id}/compare?${p}`), studio(`/templates/${cur.id}/versions/${cmp.b}/diff?against=${cmp.a}`)]); }
  catch (e) { $('#cmpbody', box).innerHTML = `<div class="note danger">${esc(e.message)}</div>`; return; }
  const [A, B] = [String(cmp.a), String(cmp.b)];
  const op = r.operational;
  $('#cmpbody', box).innerHTML = `
    <div class="stats-strip slim" style="margin-bottom:14px">
      <div><span>决策数</span><b>${op[A].n} ${icon('arrow-right')} ${op[B].n}</b><small>版本 ${A} → ${B}</small></div>
      <div><span>典型耗时</span><b>${fmtMs(op[A].latency_ms.p50)} ${icon('arrow-right')} ${fmtMs(op[B].latency_ms.p50)}</b><small>P95：${fmtMs(op[A].latency_ms.p95)} 与 ${fmtMs(op[B].latency_ms.p95)}</small></div>
      <div><span>失败</span><b>${op[A].failed} ${icon('arrow-right')} ${op[B].failed}</b><small>&nbsp;</small></div>
      <div><span>变更类型</span><b style="font-size:16px">${esc((CLASS[diff.class] || [diff.class])[0])}</b><small>${diff.breaking_for_callers ? '部分调用可能被拒绝' : '调用方仍可工作'}</small></div>
    </div>
    ${diff.summary?.length ? `<div class="note" style="margin-bottom:14px">${icon('git-diff')}<span>${diff.summary.map(esc).join('<br>')}</span></div>` : ''}
    <div class="cmp-grid">${Object.entries(r.questions).map(([k, q]) => cmpQuestion(k, q, A, B)).join('')}</div>
    <p class="small muted" style="margin-top:10px">分布仅统计未改动的模板问题。 <b>相同输入</b> 将各版本最近一次、${r.paired_by === 'variables_hash' ? '变量' : '情境'}相同的决策配对对比。</p>`;
}

async function modelsUsed() {
  try { const s = await studio(`/templates/${cur.id}/stats?group_by=model`); return s.groups.map((g) => g.key.model).filter(Boolean); } catch { return []; }
}

// A score answer is a level number; show the level's words from the template.
function labelFor(k, n) {
  const q = cur.questions[k];
  if (q?.type === 'score' && Array.isArray(q.criteria) && /^\d+$/.test(n)) { const l = q.criteria[+n]; if (l != null) return typeof l === 'string' ? l : JSON.stringify(l); }
  return n.replace(/_/g, ' ');
}

function cmpQuestion(k, q, A, B) {
  const [label, tone] = COMP[q.comparability] || [q.comparability, ''];
  const a = q.by_version[A], b = q.by_version[B];
  const both = a && b;
  const names = [...new Set([...Object.keys(a?.distribution || {}), ...Object.keys(b?.distribution || {})])];
  const bars = names.slice(0, 10).map((n) => {
    const pa = a?.distribution?.[n] ?? 0, pb = b?.distribution?.[n] ?? 0;
    return `<div class="cb"><span class="cb-name">${esc(labelFor(k, n))}</span>
      <span class="cb-bars">${a ? `<i class="a" style="width:${pa * 100}%"></i>` : ''}${b ? `<i class="b" style="width:${pb * 100}%"></i>` : ''}</span>
      <span class="cb-v num">${both ? `${fmtPct(pa)} ${icon('arrow-right')} ${fmtPct(pb)}` : fmtPct(a ? pa : pb)}</span></div>`;
  }).join('');
  const stat = (lbl, fa, fb) => `<div><span class="small muted">${lbl}</span><b class="num">${fa === null ? fb : `${fa} ${icon('arrow-right')} ${fb}`}</b></div>`;
  const pr = q.paired;
  return `<div class="card cmp-q"><div class="cmp-q-top"><b>${esc(k)}</b><span class="chip ${tone}">${esc(label)}</span>
      ${q.added_options?.length ? `<span class="small muted">新增 ${q.added_options.map(esc).join('、')}</span>` : ''}${q.removed_options?.length ? `<span class="small muted">移除 ${q.removed_options.map(esc).join('、')}</span>` : ''}</div>
    ${a && b ? `<div class="cmp-stats">${stat('自动执行率', fmtPct(a.act_rate), fmtPct(b.act_rate))}${stat('平均置信度', fmtPct(a.mean_certainty), fmtPct(b.mean_certainty))}
      ${stat('标注准确率', a.feedback.labelled ? `${fmtPct(a.feedback.accuracy)} <span class="small muted">(${a.feedback.labelled})</span>` : '无', b.feedback.labelled ? `${fmtPct(b.feedback.accuracy)} <span class="small muted">(${b.feedback.labelled})</span>` : '无')}
      ${pr ? stat('相同输入、相同答案', null, pr.n ? `${fmtPct(pr.agreement)} <span class="small muted">（${pr.n} 对）</span>` : '尚无配对') : ''}</div>` : `<p class="small muted">${a ? `仅在版本 ${A}` : `仅在版本 ${B}`}：${fmtNum((a || b).n)} 次决策。</p>`}
    ${bars && q.comparability !== 'incomparable' ? `<div class="cb-list"><div class="cb-legend small muted">${a ? `<span><i class="a"></i>v${A}</span>` : ''}${b ? `<span><i class="b"></i>v${B}</span>` : ''}</div>${bars}</div>` : ''}
    ${pr?.flips?.length ? `<p class="small muted">相同输入下答案变化：${pr.flips.slice(0, 4).map((x) => `${esc(x.from)} ${icon('arrow-right')} ${esc(x.to)}（${x.n}）`).join('、')}</p>` : ''}</div>`;
}

// ------------------------------------------------------------------ examples
async function examplesTab(box) {
  box.innerHTML = '<p class="muted">加载中</p>';
  let r;
  try { r = await studio(`/templates/${cur.id}/examples?limit=200`); } catch (e) { box.innerHTML = `<div class="note danger">${esc(e.message)}</div>`; return; }
  const builtin = cur.origin === 'builtin';
  const preview = (ex) => { const v = ex.variables ? Object.values(ex.variables).find((x) => typeof x === 'string') : typeof ex.state === 'string' ? ex.state : JSON.stringify(ex.state); return esc(String(v ?? '').slice(0, 140)); };
  box.innerHTML = `<div class="ex-top"><p class="muted" style="max-width:72ch">测试示例是带标准答案的输入，用于切换版本或模型前验证。在历史中标注决策后可一键加入此处。</p>
      <div style="display:flex;gap:6px;margin-left:auto">${builtin ? '' : `<button class="btn" id="exadd">${icon('plus')}添加示例</button>`}<a class="btn" href="/v1/studio/templates/${esc(cur.id)}/examples/export" download>${icon('download-simple')}导出</a></div></div>
    ${r.data.length ? `<div class="card" style="overflow:hidden"><div class="tscroll"><table class="table">
      <thead><tr><th>输入</th><th>标准答案</th><th>标签</th><th></th></tr></thead>
      <tbody>${r.data.map((ex) => `<tr><td class="small" style="max-width:420px">${preview(ex)}</td>
        <td class="small">${Object.entries(ex.expected).map(([k, v]) => `${esc(k)}: <b>${esc(Array.isArray(v) ? v.join(', ') : String(v))}</b>`).join('<br>') || '<span class="faint">未标注</span>'}</td>
        <td>${ex.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join(' ')}</td>
        <td class="num">${builtin ? '' : `<button class="icon-btn" data-exdel="${esc(ex.id)}" aria-label="删除示例">${icon('trash')}</button>`}</td></tr>`).join('')}</tbody></table></div></div>
      <p class="small muted" style="margin-top:8px">${r.data.length} 个示例，修订 ${r.revision}。每次修改产生新修订，过往评测可复现。</p>`
    : `<div class="empty"><div class="glyph">${icon('list-checks')}</div><h2>尚无测试示例</h2><p>在历史中为决策标注标准答案，再选择 <b>加入测试示例</b>，或在此添加。</p></div>`}`;
  $('#exadd', box)?.addEventListener('click', () => addExample(box));
  $$('[data-exdel]', box).forEach((b) => b.addEventListener('click', async () => {
    try { await studio(`/templates/${cur.id}/examples/${b.dataset.exdel}`, { method: 'DELETE' }); toast('已删除示例'); examplesTab(box); } catch (e) { toast(e.message, 'error'); }
  }));
}

function addExample(box) {
  const d = document.createElement('dialog');
  const vars = cur.variables || {};
  const input = Object.keys(vars).length ? { variables: exampleVariables(cur) } : { state: '' };
  const expected = Object.fromEntries(Object.entries(cur.questions).slice(0, 2).map(([k, q]) => [k, q.type === 'noul' ? 'yes' : q.type === 'score' ? '0' : Array.isArray(q.criteria) ? String(q.criteria[0]) : Object.keys(q.criteria || { '': 0 })[0]]));
  d.innerHTML = `<form method="dialog" style="width:min(640px,92vw)"><div class="dialog-body"><h2 style="font-size:17px">添加测试示例</h2>
    <p class="small muted">输入与标准答案。量表用等级数字（「0」为最低）；是/否用 yes 或 no。</p>
    <textarea class="textarea code" id="exj" rows="12" spellcheck="false">${esc(JSON.stringify({ ...input, expected, tags: [] }, null, 2))}</textarea><div id="exerr"></div></div>
    <div class="dialog-foot"><button class="btn" value="cancel" formnovalidate>取消</button><button class="btn btn-primary" id="exsave" value="ok">添加示例</button></div></form>`;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  $('#exsave', d).addEventListener('click', async (e) => {
    e.preventDefault();
    let body;
    try { body = JSON.parse($('#exj', d).value); } catch (err) { $('#exerr', d).innerHTML = `<div class="note danger">${esc(err.message)}</div>`; return; }
    try { await studio(`/templates/${cur.id}/examples`, { method: 'POST', body }); d.close(); toast('已添加示例'); examplesTab(box); }
    catch (err) { $('#exerr', d).innerHTML = problems(err); }
  });
  d.showModal();
}

// ------------------------------------------------------------------ versions
async function versionsTab(box) {
  box.innerHTML = '<p class="muted">加载中</p>';
  let r;
  try { r = await studio(`/templates/${cur.id}/versions?limit=100`); } catch (e) { box.innerHTML = `<div class="note danger">${esc(e.message)}</div>`; return; }
  const builtin = cur.origin === 'builtin';
  box.innerHTML = `<div class="ver-list">${r.data.map((v) => {
    const [cl, tone] = CLASS[v.changes.class] || [v.changes.class, ''];
    return `<div class="ver"><div class="ver-dot"></div><div class="ver-body">
      <div class="ver-top"><b>版本 ${v.version}</b><span class="chip ${tone}">${esc(cl)}</span>${v.aliases.map((a) => `<span class="chip ${a === 'latest' ? 'violet' : ''}">${icon('tag')}${esc(a)}</span>`).join('')}
        <span class="small muted">${esc(new Date(v.created_at * 1000).toLocaleString())}</span></div>
      ${v.note ? `<p>${esc(v.note)}</p>` : ''}
      ${v.changes.summary?.length && v.changes.class !== 'created' ? `<ul class="small muted">${v.changes.summary.slice(0, 6).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${v.changes.breaking_for_callers ? `<p class="small" style="color:var(--orange-text)">${icon('warning')}在版本 ${v.changes.from} 上成功的请求可能被拒绝。</p>` : ''}
      <div class="ver-actions">
        <button class="btn sm" data-show="${v.version}">${icon('eye')}查看</button>
        ${v.version > 1 ? `<button class="btn sm" data-cmp="${v.version}">${icon('git-diff')}与版本 ${v.version - 1} 比较</button>` : ''}
        ${builtin ? '' : `<button class="btn sm" data-alias="${v.version}">${icon('tag')}设置别名</button>${v.version !== cur.version ? `<button class="btn sm" data-restore="${v.version}">${icon('arrow-u-up-left')}恢复</button>` : ''}`}
      </div></div></div>`;
  }).join('')}</div>
  <p class="small muted">版本保存后不可修改。别名（如 <code>production</code>）指向某一版本：移动别名即可上线新版本而无需改代码。</p>`;
  $$('[data-show]', box).forEach((b) => b.addEventListener('click', async () => {
    try { shown = await studio(`/templates/${cur.id}?version=${b.dataset.show}`); tab = 'overview'; drawDetail(); } catch (e) { toast(e.message, 'error'); }
  }));
  $$('[data-cmp]', box).forEach((b) => b.addEventListener('click', () => { cmp.b = +b.dataset.cmp; cmp.a = cmp.b - 1; tab = 'compare'; drawDetail(); }));
  $$('[data-restore]', box).forEach((b) => b.addEventListener('click', async () => {
    try { cur = await studio(`/templates/${cur.id}/versions/${b.dataset.restore}/restore`, { method: 'POST', body: { note: `恢复版本 ${b.dataset.restore}` } }); shown = cur; toast(`已保存为版本 ${cur.version}`); drawDetail(); } catch (e) { toast(e.message, 'error'); }
  }));
  $$('[data-alias]', box).forEach((b) => b.addEventListener('click', async () => {
    const alias = await askText({ title: `将别名指向版本 ${b.dataset.alias}`, label: '例如 production 或 staging。以 @别名 调用的代码将获得此版本。', value: 'production', pattern: '[a-z][a-z0-9_\\-]{0,31}', confirm: '设置别名' });
    if (!alias) return;
    try { await studio(`/templates/${cur.id}/aliases/${alias}`, { method: 'PUT', body: { version: +b.dataset.alias } }); cur = await studio(`/templates/${cur.id}`); shown = cur; toast(`${alias} 已指向版本 ${b.dataset.alias}`); drawDetail(); } catch (e) { toast(e.message, 'error'); }
  }));
}
