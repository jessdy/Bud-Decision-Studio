// Playground: the situation and questions on the left, the answers in the middle, decision settings in an
// inspector on the right. The model button opens the loader palette (Ctrl+L), as in LM Studio.
// With a template open, the left side becomes the template's variables and its questions (locked, with the changes the
// template allows); "Edit questions" unlocks them and "保存版本" keeps the edits as the template's next version.
// Every decision goes through the studio API and is saved to History unless "Keep in history" is off.

import { addGridHTML, buildQuestions, createBuilder, fromQuestion } from '../builder.js';
import { EXAMPLES } from '../examples.js';
import { guideFor } from '../model-guides.js';
import { animate, decisionOf, figures, mini, odo } from '../figures.js';
import { codeBlock, jsonTree } from '../format.js';
import { openLoader } from '../loader.js';
import { setSub } from '../shell.js';
import { FORMATS, LANGS, snippet, studioSnippet } from '../snippets.js';
import { api, decide, download, ensureReady, markLearned, model, phaseOf, phaseTrack, readyModels, refresh, registry, setPref, store, studio } from '../store.js';
import { addOptionsBody, bindLocked, bindVarForm, initialVars, lockedQuestionsHTML, varFormHTML, varsFromDecision, varValues } from '../template-form.js';
import { $, $$, askText, copy, debounce, esc, fmtBytes, fmtGB, fmtMs, fmtNum, fmtPct, icon, popMenu, term, toast } from '../util.js';

const KEY = 'bud.draft.v2';
const NO_TEMPLATE = { tpl: null, vars: {}, varMedia: {}, skip: [], addOptions: {}, editing: false, tplAt: null, tplT: null };
let draft = loadDraft();
let last = null;
let tab = 'answers';
let busy = false;
let root, builder, keyHandler, reg, autorunTimer;
let pendingModel = null;   // a model named in the URL before the first state poll has arrived
let exampleForPending = false;   // ...and whether to show that model's own example once it is applied
let lang = 'python', format = 'typesafe';
let inspOpen = null;
let hint = null;   // the last "what's missing" message, cleared as soon as the person fixes it
const clearHint = () => { hint?.remove(); hint = null; };

// ------------------------------------------------------------------ draft
// Template mode: tpl is the open template version; vars the form's text; varMedia files for media variables; skip and
// addOptions the per-decision changes; editing = template questions unlocked; tplAt/tplT this decision's overrides.
function fromExample(ex, keep = draft) {
  const isObj = typeof ex.state !== 'string';
  return {
    ...keep, ...NO_TEMPLATE, example: ex.id, stateMode: isObj ? 'json' : 'text',
    stateText: isObj ? JSON.stringify(ex.state, null, 2) : ex.state,
    questions: Object.entries(ex.questions).map(([k, q]) => fromQuestion(k, q)), media: [],
  };
}
function loadDraft() {
  try { const d = JSON.parse(localStorage.getItem(KEY)); if (d?.questions) return { media: [], temperature: null, compare: false, ...NO_TEMPLATE, ...d }; } catch { /* fresh start */ }
  return fromExample(EXAMPLES.find((e) => e.id === 'support'), { model: null, temperature: null, compare: false, media: [] });
}
const saveDraft = debounce(() => { try { localStorage.setItem(KEY, JSON.stringify(draft)); } catch { /* storage full */ } }, 250);
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(draft)); } catch { /* storage full */ } };
const tplMode = () => !!draft.tpl && !draft.editing;          // running the template as it is saved
const hasVars = () => !!draft.tpl && Object.keys(draft.tpl.variables || {}).length > 0;
const keepHistory = () => store.prefs.keepHistory !== false;

function parseState() {
  if (draft.stateMode === 'json') {
    try { return { value: JSON.parse(draft.stateText) }; } catch (e) { return { error: `情境不是有效的 JSON：${e.message}` }; }
  }
  return { value: draft.stateText };
}

export function buildRequest() {
  if (!String(draft.stateText).trim()) return { error: '请先描述情境：粘贴邮件、工单、消息或 JSON。', field: 'state' };
  const st = parseState();
  if (st.error) return { error: st.error, field: 'state' };
  const built = buildQuestions(draft.questions, model(draft.model));
  if (built.error) return built;
  const request = { model: draft.model, state: st.value, questions: built.questions };
  if (draft.temperature) request.settings = { temperature: draft.temperature };
  if (draft.media.length) request.media = draft.media.map((m) => ({ type: m.type, path: m.id, name: m.name }));
  return { request };
}

// The body for POST /v1/studio/decisions. -> { body } or { error, field?, uid? }. needsPreview: the state comes from the
// template's variables, rendered by the studio first (editing a template's questions).
function studioBody() {
  const t = draft.tpl;
  const media = draft.media.map((m) => (String(m.id).startsWith('file_') ? { type: m.type, file_id: m.id, name: m.name } : { type: m.type, path: m.id, name: m.name }));
  if (t) {
    const out = {};
    if (hasVars()) {
      const v = varValues(t, draft.vars, draft.varMedia);
      if (v.error) return { error: v.error, field: `var:${v.field}` };
      out.variables = v.values;
    } else {
      if (!String(draft.stateText).trim()) return { error: '请先描述情境：此模板将整个情境作为 state。', field: 'state' };
      const st = parseState();
      if (st.error) return { error: st.error, field: 'state' };
      out.state = st.value;
    }
    if (!draft.editing) {
      out.template = `${t.id}@${t.version}`;
      if (draft.model) out.model = draft.model;
      if (draft.questions.length) {
        const built = buildQuestions(draft.questions, model(draft.model));
        if (built.error) return built;
        out.questions = built.questions;
      }
      const ao = addOptionsBody(t, draft.addOptions);
      if (Object.keys(ao).length) out.add_options = ao;
      if (draft.skip.length) out.skip = [...draft.skip];
      const s = {};
      if (draft.tplAt != null) s.act_threshold = draft.tplAt;
      if (draft.tplT != null) s.temperature = draft.tplT;
      if (Object.keys(s).length) out.settings = s;
      if (media.length) out.media = media;
      out.include = ['input'];
      if (!keepHistory()) out.store = false;
      return { body: out };
    }
    // editing: an ad hoc decision with the edited questions, recorded as a draft of this version
    const built = buildQuestions(draft.questions, model(draft.model));
    if (built.error) return built;
    const body = { model: draft.model, questions: built.questions, settings: { act_threshold: store.prefs.threshold },
      metadata: { 'basal.draft_of': `${t.id}@${t.version}` } };
    if (draft.temperature) body.settings.temperature = draft.temperature;
    if (out.state !== undefined) body.state = out.state;
    if (media.length) body.media = media;
    if (!keepHistory()) body.store = false;
    return { body, needsPreview: hasVars() ? out.variables : null };
  }
  const built = buildRequest();
  if (built.error) return built;
  const r = built.request;
  const body = { ...r, settings: { ...(r.settings || {}), act_threshold: store.prefs.threshold } };
  if (r.media) body.media = media;
  if (!keepHistory()) body.store = false;
  return { body };
}

// The threshold a result's verdict was made with; a different one now means the slider shows a "what if".
const gateKey = () => (tplMode() ? `t${draft.tplAt}` : `p${store.prefs.threshold}`);
const whatIfThreshold = () => (tplMode() ? draft.tplAt ?? tplDefaults().at : store.prefs.threshold);
function tplDefaults() {
  const s = draft.tpl?.settings || {};
  const m = s.models?.[draft.model] || {};
  return { at: m.act_threshold ?? s.act_threshold ?? 0.9, t: m.temperature ?? s.temperature ?? 1 };
}

// Used by Evaluate to hand over a fitted calibration temperature.
export function setTemperature(t) {
  draft.temperature = t || null;
  try { localStorage.setItem(KEY, JSON.stringify(draft)); } catch { /* ignore */ }
}
// Replays a request (state and questions) as a free decision.
export function loadRequest(req, modelId) {
  const isObj = typeof req.state !== 'string';
  draft = { ...draft, ...NO_TEMPLATE, example: null, model: modelId || req.model || draft.model, stateMode: isObj ? 'json' : 'text', stateText: isObj ? JSON.stringify(req.state, null, 2) : (req.state ?? ''),
    questions: Object.entries(req.questions || {}).map(([k, q]) => fromQuestion(k, q)), media: [] };
  last = null;
  persist();
}

// Opens a template version in the Playground (from the Templates page, History or the template menu).
export function openTemplate(t, { edit = false, vars = null, keepState = false } = {}) {
  const m = model(t.model);
  draft = { ...draft, ...NO_TEMPLATE, example: null, tpl: t, vars: vars || initialVars(t), editing: edit, media: [],
    questions: edit ? Object.entries(t.questions).map(([k, q]) => fromQuestion(k, q)) : [],
    stateMode: keepState ? draft.stateMode : 'text', stateText: keepState ? draft.stateText : '' };
  if (m && (m.downloaded || m.worker)) draft.model = m.id;
  last = null;
  persist();
  if (root?.isConnected) render();
}

// Opens a decision from History: in its template (with its variables and per-decision changes) when it had one.
export async function loadDecision(d) {
  const inp = d.input || {};
  if (d.template && inp.variables && ['explicit', 'draft'].includes(d.template.attribution) && !d.template.id.startsWith('builtin/')) {
    try {
      const t = await studio(`/templates/${d.template.id}?version=${d.template.version}`);
      openTemplate(t, { vars: varsFromDecision(t, inp.variables) });
      const ext = d.extensions || {};
      draft.questions = (ext.questions || []).filter((k) => inp.questions?.[k]).map((k) => fromQuestion(k, inp.questions[k]));
      draft.skip = [...(ext.skipped || [])];
      draft.addOptions = JSON.parse(JSON.stringify(ext.options || {}));
      if (d.model) draft.model = d.model;
      persist();
      return;
    } catch { /* the template is gone: replay as a free decision */ }
  }
  if (d.template && !inp.variables && d.template.attribution === 'explicit') {
    try {
      const t = await studio(`/templates/${d.template.id}?version=${d.template.version}`);
      openTemplate(t);
      const isObj = typeof inp.state !== 'string';
      draft.stateMode = isObj ? 'json' : 'text'; draft.stateText = isObj ? JSON.stringify(inp.state, null, 2) : (inp.state ?? '');
      if (d.model) draft.model = d.model;
      persist();
      return;
    } catch { /* fall through */ }
  }
  loadRequest({ state: inp.state, questions: inp.questions || {} }, d.model);
}

const statePlaceholder = () => (draft.stateMode === 'json' ? '{ "ticket": "..." }' : guideFor(draft.model)?.state || '粘贴邮件、工单、评价、日志行……');

// An example exactly as shipped (not edited), so it can be swapped for one that suits the chosen model.
function pristineExample() {
  const ex = EXAMPLES.find((e) => e.id === draft.example);
  if (!ex) return false;
  const p = fromExample(ex, {});
  return draft.stateText === p.stateText && draft.questions.length === p.questions.length
    && draft.questions.every((q, i) => q.text === p.questions[i].text && q.type === p.questions[i].type);
}

function loadExample(ex) {
  draft = fromExample(ex); last = null; saveDraft();
  if (ex.needsMedia && !model(draft.model)?.modalities.includes(ex.needsMedia)) {
    const alt = (store.state?.models || []).find((m) => m.modalities.includes(ex.needsMedia) && (m.worker || m.downloaded));
    if (alt) { draft.model = alt.id; toast(`已切换到 ${alt.name}：可读取图像。`); }
  }
  render();
  if (ex.sample) attachSample(ex.sample);
}

// Choosing a model while an untouched example is showing swaps in an example made for that model, so what the
// model is good at is visible straight away (CLM opens on an agent's next action, not a support ticket).
function showModelExample({ quiet = false } = {}) {
  const g = guideFor(draft.model);
  if (!g || !pristineExample() || g.examples.includes(draft.example)) return;
  const ex = EXAMPLES.find((e) => e.id === g.examples[0]);
  if (!ex) return;
  const before = { draft: JSON.parse(JSON.stringify(draft)), last };
  const keepModel = draft.model;
  draft = fromExample(ex); draft.model = keepModel; last = null; saveDraft();
  if (root?.isConnected) { render(); if (ex.sample) attachSample(ex.sample); }
  const m = model(keepModel);
  if (quiet) return;
  toast(`正在展示为 ${m?.name || '此模型'} 准备的示例。`, '', { action: '撤销', onAction: () => { draft = before.draft; last = before.last; saveDraft(); if (root?.isConnected) render(); } });
}

// ------------------------------------------------------------------ page lifecycle
export async function mount(el, params = {}) {
  root = el;
  reg = await registry();
  if (params.new) { draft = { ...draft, ...NO_TEMPLATE, example: null, stateMode: 'text', stateText: '', questions: [], media: [] }; last = null; persist(); }
  if (params.template) {
    try { openTemplate(await studio(`/templates/${params.template}${params.version ? `?version=${params.version}` : ''}`)); } catch (e) { toast(e.message, 'error'); }
  }
  if (params.example) {
    const ex = EXAMPLES.find((e) => e.id === params.example);
    if (ex) {
      draft = fromExample(ex); last = null;
      if (ex.needsMedia) {
        const can = (store.state?.models || []).filter((m) => m.modalities.includes(ex.needsMedia) && (m.downloaded || m.worker));
        if (can.length) draft.model = (can.find((m) => m.worker?.status === 'ready') || can[0]).id;
      }
      saveDraft();
      if (ex.sample) setTimeout(() => attachSample(ex.sample), 0);
    }
  }
  pendingModel = params.model || null;
  exampleForPending = !params.example && !!params.model;
  applyPendingModel();
  pickDefaultModel();
  if (inspOpen === null) inspOpen = false;
  render();
  keyHandler = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); pickModel(); }
  };
  document.addEventListener('keydown', keyHandler);
  maybeAutorun();
}
export function unmount() {
  document.removeEventListener('keydown', keyHandler);
  clearTimeout(autorunTimer);     // leaving before the first-visit run fires: there is no Playground to run it in
}
// The page shares one container with every other page, so "still here" means the Playground's own markup is in it.
const mounted = () => !!root?.isConnected && !!$('#play', root);

function applyPendingModel() {
  if (!pendingModel || !store.state) return false;
  if (model(pendingModel)) { draft.model = pendingModel; saveDraft(); }
  pendingModel = null;
  if (exampleForPending) { exampleForPending = false; showModelExample(); }
  return true;
}

// First visit in this browser session: if a model is already loaded, run the example so the answer is the first thing seen.
function maybeAutorun() {
  if (pendingModel) return;
  if (last || busy || sessionStorage.getItem('bud.autorun') || model(draft.model)?.worker?.status !== 'ready') return;
  sessionStorage.setItem('bud.autorun', '1');
  autorunTimer = setTimeout(run, 350);
}

export function onState() {
  if (!root?.isConnected || !$('#play', root)) return;
  if (applyPendingModel()) { renderMedia(); builder.render(); }
  pickDefaultModel();
  renderModelChip();
  renderStateMeta();
  if (!last && !busy) renderOut();
  maybeAutorun();
}

// The model the Playground decides with: the chosen one while it can be used, otherwise the one it would choose
// (a ready one first). Undefined when the model list has not arrived or nothing is downloaded.
function usableModel() {
  const ms = store.state?.models || [];
  const cur = ms.find((m) => m.id === draft.model);
  if (cur && (cur.downloaded || cur.worker)) return cur;
  return readyModels()[0] || ms.find((m) => m.worker) || ms.find((m) => m.badge === 'Start here' && m.downloaded) || ms.find((m) => m.id === 'laya' && m.downloaded) || ms.find((m) => m.downloaded);
}

function pickDefaultModel() {
  const pick = usableModel();
  if (pick && pick.id !== draft.model) { draft.model = pick.id; saveDraft(); showModelExample({ quiet: true }); }
}

async function pickModel() {
  const id = await openLoader({ current: draft.model });
  if (!id || !root?.isConnected) return;
  draft.model = id; setPref('lastModel', id); saveDraft();
  if (pristineExample() && !guideFor(id)?.examples.includes(draft.example)) { showModelExample(); return; }
  renderModelChip(); renderMedia(); renderStateMeta(); builder.render();
  const st = $('#state', root); if (st) st.placeholder = statePlaceholder();
  if (!last) renderOut();
}

// ------------------------------------------------------------------ layout
function render() {
  const t = draft.tpl;
  const vars = hasVars();
  const extras = !t || draft.editing || t.extensions?.questions;
  root.innerHTML = `<div class="view play" id="play">
    <section class="spec" id="spec" aria-label="决策">
      <div class="spec-top">
        <button class="model-chip" id="mchip" aria-haspopup="dialog" aria-label="选择模型"></button>
        <button class="btn tpl-btn ${t ? 'on' : ''}" id="tplbtn" aria-haspopup="menu" data-tip="${t ? '模板选项' : '使用或另存为模板'}">${icon('stack')}${t ? `<span class="tpl-name">${esc(t.name)}</span><span class="v">v${t.version}</span>` : '模板'}${icon('caret-down', 'chev')}</button>
        <button class="btn" id="newdec" data-tip="新建空白决策：自定义情境与问题">${icon('plus')}新建</button>
        ${t ? '' : `<button class="btn" id="examples" aria-haspopup="menu">${icon('sparkle')}示例</button>`}
      </div>
      <div class="spec-scroll">
        ${t && draft.editing ? `<div class="note violet edit-note">${icon('pencil-simple')}<span>正在编辑 <b>${esc(t.name)}</b>。Decide 会试运行你的修改且不会保存。<b>保存版本 ${t.version + 1}</b> 会保存供所有调用该模板的人使用。</span></div>` : ''}
        ${t && !draft.editing ? `<p class="tpl-lead small muted">${esc(t.description || `模板 ${t.id}`)}</p>` : ''}
        <div class="spec-section">
          <div class="spec-title"><h2>${vars ? '变量' : term('state', '情境')}</h2><span class="muted small">${vars ? '填写情境内容' : '待判断的情境'}</span>
            ${vars ? '' : `<span class="right"><span class="seg" role="group" aria-label="情境格式"><button data-mode="text" aria-pressed="${draft.stateMode === 'text'}">文本</button><button data-mode="json" aria-pressed="${draft.stateMode === 'json'}">JSON</button></span></span>`}</div>
          ${vars ? '<div id="vars"></div>' : `<textarea class="textarea state-box ${draft.stateMode === 'json' ? 'code' : ''}" id="state" spellcheck="${draft.stateMode === 'text'}" aria-label="情境"
            placeholder="${esc(statePlaceholder())}">${esc(draft.stateText)}</textarea>
          <div class="state-meta" id="statemeta"></div>`}
          <div id="media"></div>
        </div>
        <div class="spec-section">
          <div class="spec-title"><h2>问题</h2><span class="right small muted" id="qcount"></span></div>
          ${t && !draft.editing ? '<div class="branches" id="tqs"></div>' : ''}
          ${extras ? `${t && !draft.editing ? '<div class="spec-title sub"><h3>本决策中的附加问题</h3><span class="muted small">与模板问题一并提问，不会写入模板</span></div>' : ''}
            <div class="branches" id="qs"></div>
            ${addGridHTML(t && !draft.editing ? { title: '添加问题', text: '仅在本决策中额外提问，模板本身不变。' } : undefined)}` : ''}
        </div>
      </div>
      <div class="decide-bar"><button class="btn btn-primary" id="decide">${icon(draft.compare && !t ? 'columns' : 'play')}${draft.compare && !t ? '对比' : '决策'}</button><span class="small muted hide-sm"><kbd>Ctrl</kbd> <kbd>Enter</kbd></span>
        <span class="right">${saveButton()}</span></div>
    </section>
    <section class="results" aria-label="答案">
      <div class="results-head">
        <div class="utabs" role="tablist" id="tabs">${[['answers', '答案', 'chart-bar'], ['json', 'JSON', 'brackets-curly'], ['code', '代码', 'code']].map(([k, n, i]) => `<button role="tab" data-tab="${k}" aria-pressed="${tab === k}" aria-selected="${tab === k}">${icon(i)}${n}</button>`).join('')}</div>
        <button class="icon-btn" id="insptoggle" aria-pressed="${inspOpen}" aria-label="决策设置" data-tip="决策设置">${icon('sliders-horizontal')}</button>
      </div>
      <div class="results-body">
        <div class="run-stamp" id="stamp"></div>
        <div id="out" aria-live="polite"></div>
      </div>
    </section>
    <aside class="inspector" id="insp" ${inspOpen ? '' : 'hidden'} aria-label="决策设置"></aside>
  </div>`;

  const qs = $('#qs', root);
  builder = qs ? createBuilder(qs, {
    list: () => draft.questions,
    spec: () => model(draft.model),
    onChange: () => { saveDraft(); renderCount(); if (tab === 'code') renderOut(); },
    onStructure: () => { renderCount(); clearHint(); if (!last && !busy) renderOut(); },
  }) : { render() {}, setStrict() {}, focus() {}, add() {} };
  builder.render();
  renderTemplateParts();
  renderModelChip(); renderStateMeta(); renderMedia(); renderCount(); renderInspector(); renderOut();
  bind();
}

function saveButton() {
  const t = draft.tpl;
  if (!t) return `<button class="btn" id="savetpl" data-tip="将问题、模型与设置保存为可复用模板">${icon('stack')}另存为模板</button>`;
  if (draft.editing) return `<button class="btn" id="discard">放弃编辑</button><button class="btn" id="savever">${icon('git-commit')}保存版本 ${t.version + 1}</button>`;
  if (t.origin === 'builtin') return '';
  return `<button class="btn btn-quiet" id="editq" data-tip="修改模板自带问题">${icon('pencil-simple')}编辑问题</button>`;
}

// The template's variables form and its locked questions.
function renderTemplateParts() {
  const t = draft.tpl;
  if (!t) return;
  const vb = $('#vars', root);
  if (vb) {
    vb.innerHTML = varFormHTML(t, draft.vars, draft.varMedia);
    bindVarForm(vb, {
      vars: draft.vars,
      onChange: () => { saveDraft(); clearHint(); if (tab === 'code') renderOut(); if (!last && !busy) renderOut(); },
      onFile: async (name, file) => {
        const form = new FormData(); form.append('file', file);
        try { const r = await api('/api/uploads', { method: 'POST', form }); draft.varMedia[name] = { id: r.id, type: r.type, name: r.name, url: r.url }; saveDraft(); renderTemplateParts(); }
        catch (e) { toast(e.message, 'error'); }
      },
      onUnfile: (name) => { delete draft.varMedia[name]; saveDraft(); renderTemplateParts(); },
    });
  }
  const qb = $('#tqs', root);
  if (qb) {
    qb.innerHTML = lockedQuestionsHTML(t, draft);
    bindLocked(qb, { skip: draft.skip, addOptions: draft.addOptions, tpl: t, onChange: (_, focus) => { saveDraft(); renderTemplateParts(); renderCount(); if (focus) $(focus, qb)?.focus(); } });
  }
}

function bind() {
  const st = $('#state', root);
  st?.addEventListener('input', () => {
    const had = !!draft.stateText.trim();
    draft.stateText = st.value; saveDraft(); renderStateMeta(); clearHint();
    if (had !== !!st.value.trim() && !last && !busy) renderOut();
  });
  $$('[data-mode]', root).forEach((b) => b.addEventListener('click', () => {
    const mode = b.dataset.mode;
    if (mode === draft.stateMode) return;
    if (mode === 'json' && draft.stateText.trim() && !/^[[{]/.test(draft.stateText.trim())) draft.stateText = JSON.stringify({ text: draft.stateText }, null, 2);
    else if (mode === 'text') { try { const v = JSON.parse(draft.stateText); if (typeof v?.text === 'string' && Object.keys(v).length === 1) draft.stateText = v.text; } catch { /* keep as is */ } }
    draft.stateMode = mode; saveDraft(); render();
  }));
  $$('[data-add-type]', root).forEach((b) => b.addEventListener('click', () => builder.add(b.dataset.addType)));
  $('#mchip', root).addEventListener('click', pickModel);
  $('#tplbtn', root).addEventListener('click', (e) => templateMenu(e.currentTarget));
  $('#examples', root)?.addEventListener('click', (e) => examplesMenu(e.currentTarget));
  $('#newdec', root).addEventListener('click', newDecision);
  $('#decide', root).addEventListener('click', run);
  $('#savetpl', root)?.addEventListener('click', saveAsTemplate);
  $('#savever', root)?.addEventListener('click', saveVersion);
  $('#editq', root)?.addEventListener('click', () => { openTemplate(draft.tpl, { edit: true, vars: draft.vars, keepState: true }); });
  $('#discard', root)?.addEventListener('click', () => { openTemplate(draft.tpl, { vars: draft.vars, keepState: true }); toast('已放弃编辑'); });
  $('#tabs', root).addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; $$('[data-tab]', root).forEach((x) => { x.setAttribute('aria-pressed', x === b); x.setAttribute('aria-selected', x === b); }); renderOut({ instant: true }); } });
  $('#insptoggle', root).addEventListener('click', (e) => { inspOpen = !inspOpen; e.currentTarget.setAttribute('aria-pressed', inspOpen); $('#insp', root).hidden = !inspOpen; });
}

function renderCount() {
  const m = model(draft.model);
  const el = $('#qcount', root);
  if (!el) return;
  const n = (tplMode() ? Object.keys(draft.tpl.questions).filter((k) => !draft.skip.includes(k)).length : 0) + draft.questions.length;
  el.textContent = n ? `${n}${m?.max_questions ? ` / 最多 ${m.max_questions}` : ''}, 一次作答` : '暂无';
}

function renderStateMeta() {
  const el = $('#statemeta', root);
  if (!el) return;
  const m = model(draft.model);
  const tokens = Math.round(draft.stateText.length / 4);
  let msg = `<span>约 ${tokens.toLocaleString()} ${term('token', '词元')}</span>`;
  if (m?.context_tokens) {
    msg += tokens / m.context_tokens > 0.9 ? `<span style="color:var(--orange-text)">${icon('warning')} 接近 ${esc(m.name)} 的 ${m.context_tokens.toLocaleString()} 词元上限</span>` : `<span>${esc(m.name)} 最多读取 ${m.context_tokens.toLocaleString()} 词元</span>`;
  }
  if (draft.stateMode === 'json') { const p = parseState(); msg += p.error ? `<span style="color:var(--red-text)">${icon('warning-circle')} ${esc(p.error.replace('情境不是有效的 JSON：', 'JSON 无效：'))}</span>` : '<span>JSON 有效</span>'; }
  if (el.innerHTML !== msg) el.innerHTML = msg;
}

// ------------------------------------------------------------------ model button (opens the loader)
function renderModelChip() {
  const box = $('#mchip', root);
  if (!box) return;
  const m = model(draft.model);
  let html;
  if (!m) html = `<span class="logo">${icon('cube')}</span><span><b>选择模型</b><span class="sub">尚未下载任何模型</span></span>${icon('caret-down', 'chev')}`;
  else {
    const r = reg?.models[m.id] || {};
    const mk = reg?.makers[r.maker_id] || {};
    const src = mk.avatar || r.logo || mk.logo;
    const p = phaseOf(m);
    html = `<span class="logo">${src ? `<img src="/ui/${esc(src)}" alt="">` : icon('cube')}</span>
      <span style="min-width:0"><b>${esc(m.name)}</b><span class="sub">${phaseTrack(m)}${esc(p.word)}, ${esc(m.params)}, ${fmtGB(m.memory_gb)}</span></span>
      <span class="chev" style="display:flex;align-items:center;gap:6px"><kbd>Ctrl</kbd><kbd>L</kbd>${icon('caret-down')}</span>`;
  }
  if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
  setSub(m ? `${esc(m.name)}, ${esc(phaseOf(m).word.toLowerCase())}` : '');
}

function examplesMenu(anchor) {
  const groups = [...new Set(EXAMPLES.map((e) => e.group))];
  const blank = `<div class="menu-group">开始</div><button class="menu-item" role="menuitem" data-pick="__blank">${icon('plus')}<span><b>空白决策</b><span>从零开始自定义情境与问题。</span></span></button>`;
  const m = model(draft.model), g = guideFor(draft.model);
  const mine = (g?.examples || []).map((id) => EXAMPLES.find((e) => e.id === id)).filter(Boolean);
  const item = (e) => `<button class="menu-item" role="menuitem" data-pick="${e.id}">${icon(e.needsMedia ? 'image' : 'sparkle')}<span><b>${esc(e.title)}</b><span>${esc(e.blurb)}</span></span></button>`;
  const made = mine.length ? `<div class="menu-group">适用于 ${esc(m?.name || '此模型')}</div>${mine.map(item).join('')}` : '';
  popMenu(anchor, made + blank + groups.map((gr) => [gr, EXAMPLES.filter((e) => e.group === gr && !mine.includes(e))]).filter(([, list]) => list.length).map(([gr, list]) => `<div class="menu-group">${esc(gr)}</div>${list.map((e) => item(e)).join('')}`).join(''), {
    onPick: (id) => {
      if (id === '__blank') { newDecision(); return; }
      loadExample(EXAMPLES.find((e) => e.id === id));
    },
  });
}

// ------------------------------------------------------------------ inspector: decision settings
function renderInspector() {
  const box = $('#insp', root);
  if (!box) return;
  const tm = tplMode();
  const def = tm ? tplDefaults() : null;
  const at = tm ? draft.tplAt ?? def.at : store.prefs.threshold;
  const t = tm ? draft.tplT ?? def.t : draft.temperature || 1;
  const own = (v, d, what) => (v != null ? `<span class="help">仅本决策；模板默认值为 ${what(d)}. <button class="linklike" data-reset="${what === pctText ? 'at' : 't'}">使用模板默认值</button></span>` : `<span class="help">来自模板${def && draft.tpl.settings?.models?.[draft.model] ? `（针对 ${esc(model(draft.model)?.name || draft.model)}）` : ''}。可修改以在本决策中尝试其他值。</span>`);
  box.innerHTML = `<div class="insp-head"><h2>决策设置</h2><button class="icon-btn" id="inspclose" aria-label="关闭决策设置" style="margin-left:auto">${icon('x')}</button></div>
    <div class="insp-body">
      <div class="insp-sec"><h3>何时自动执行</h3>
        <div class="setting"><div class="top"><label for="th-n">${term('threshold', '行动阈值')}</label><input class="input num-field" id="th-n" type="number" min="50" max="99" step="1" value="${Math.round(at * 100)}" aria-label="行动阈值（百分比）"></div>
          <input type="range" id="th" min="0.5" max="0.99" step="0.01" value="${at}" aria-label="行动阈值">
          ${tm ? own(draft.tplAt, def.at, pctText) : '<span class="help">概率不低于此值的答案显示「自动执行」，其余显示「请人工处理」。</span>'}</div></div>
      <div class="insp-sec"><h3>校准</h3>
        <div class="setting"><div class="top"><label for="tp-n">${term('temperature', '温度')}</label><input class="input num-field" id="tp-n" type="number" min="0.25" max="4" step="0.05" value="${t}" aria-label="校准温度"></div>
          <input type="range" id="tp" min="0.25" max="4" step="0.05" value="${t}" aria-label="校准温度">
          ${tm ? own(draft.tplT, def.t, (x) => fmtNum(x)) : '<span class="help">1 表示保持模型原始概率。大于 1 更不确定，小于 1 更确定。评测可为你拟合。</span>'}</div></div>
      <div class="insp-sec"><h3>历史记录</h3>
        <label class="switch" style="justify-content:space-between"><span>将本决策保留在历史中</span><input type="checkbox" id="keep" ${keepHistory() ? 'checked' : ''}></label>
        <span class="help">${keepHistory() ? '保存在本机并含答案，可标注、对比版本与复用。' : '关闭：不保存任何决策信息（API 的 <code>"store": false</code>）。'} <a href="#/history">打开历史记录</a></span></div>
      ${draft.tpl ? '' : `<div class="insp-sec"><h3>对比</h3>
        <label class="switch" style="justify-content:space-between"><span>询问所有已加载模型</span><input type="checkbox" id="cmp" ${draft.compare ? 'checked' : ''}></label>
        <span class="help">Decide 将同一请求发给全部 ${readyModels().length || '已加载'} 个模型并显示一致之处。</span></div>
      <div class="insp-sec"><h3>稳健性</h3>
        <button class="btn" id="order">${icon('shuffle')}测试选项顺序</button>
        <span class="help">对单选与排序题打乱选项后重跑，以检查 ${term('order_bias', '选项顺序偏差')}.</span></div>`}
    </div>`;
  const fill = (r) => r.style.setProperty('--fill-pct', `${((r.value - r.min) / (r.max - r.min || 1)) * 100}%`);
  const th = $('#th', box), thn = $('#th-n', box), tp = $('#tp', box), tpn = $('#tp-n', box);
  fill(th); fill(tp);
  const setTh = (v) => {
    v = Math.min(0.99, Math.max(0.5, v));
    if (tm) draft.tplAt = v; else setPref('threshold', v);
    saveDraft();
    if (last?.kind === 'result' && tab === 'answers') renderOut({ instant: true });
  };
  th.addEventListener('input', () => { thn.value = Math.round(th.value * 100); fill(th); setTh(+th.value); });
  thn.addEventListener('change', () => { th.value = thn.value / 100; fill(th); setTh(thn.value / 100); });
  const setT = (v) => { if (tm) draft.tplT = v > 0 ? v : null; else draft.temperature = v > 0 && Math.abs(v - 1) > 0.001 ? v : null; saveDraft(); };
  tp.addEventListener('input', () => { tpn.value = tp.value; fill(tp); setT(+tp.value); });
  tpn.addEventListener('change', () => { tp.value = tpn.value; fill(tp); setT(+tpn.value); });
  $$('[data-reset]', box).forEach((b) => b.addEventListener('click', () => { if (b.dataset.reset === 'at') draft.tplAt = null; else draft.tplT = null; saveDraft(); renderInspector(); if (last?.kind === 'result') renderOut({ instant: true }); }));
  $('#keep', box).addEventListener('change', (e) => { setPref('keepHistory', e.target.checked); renderInspector(); });
  $('#cmp', box)?.addEventListener('change', (e) => { draft.compare = e.target.checked; saveDraft(); $('#decide', root).innerHTML = `${icon(draft.compare ? 'columns' : 'play')}${draft.compare ? '对比' : '决策'}`; });
  $('#order', box)?.addEventListener('click', orderTest);
  $('#inspclose', box).addEventListener('click', () => { inspOpen = false; box.hidden = true; $('#insptoggle', root).setAttribute('aria-pressed', 'false'); });
}
const pctText = (x) => `${Math.round(x * 100)}%`;

// ------------------------------------------------------------------ media (images, audio, video)
function renderMedia() {
  const box = $('#media', root);
  if (!box) return;
  const sel = model(draft.model);
  let can = sel?.modalities?.filter((x) => x !== 'text') || [];
  if (draft.tpl) {   // only what the template accepts, and not when its own variables take the files
    const vtypes = Object.values(draft.tpl.variables || {}).map((v) => v.type);
    can = can.filter((m) => draft.tpl.modalities.includes(m) && !vtypes.includes(m));
  }
  if (!can.length && !draft.media.length) { box.innerHTML = ''; return; }
  const accept = can.map((k) => `${k}/*`).join(',') || 'image/*';
  const bad = [...new Set(draft.media.map((x) => x.type))].filter((t) => !can.includes(t));
  box.innerHTML = `<div style="display:grid;gap:8px">
    <label class="dropzone" id="dz"><input type="file" id="file" accept="${accept}" multiple hidden>
      ${icon('file-arrow-up')}<span><b style="font-weight:500">附加 ${can.join('、') || '媒体'}</b> <span class="muted">或将文件拖放到此处</span></span></label>
    ${can.includes('image') ? `<div class="presets">示例： <button data-sample="receipt.png">购物收据</button><button data-sample="revenue-chart.png">收入图表</button></div>` : ''}
    ${draft.media.length ? `<div class="thumbs">${draft.media.map((x, i) => `<div class="thumb">${x.type === 'image' ? `<img src="${esc(x.url)}" alt="${esc(x.name)}">` : `${esc(x.name).slice(0, 16)}`}<button data-rm="${i}" aria-label="移除 ${esc(x.name)}">${icon('x')}</button></div>`).join('')}</div>` : ''}
    ${bad.length ? `<div class="note amber">${icon('warning')}<span>${esc(sel?.name || '此模型')} 无法读取 ${bad.join(' 或 ')}。请选择支持的模型或移除文件。</span></div>` : ''}</div>`;
  const dz = $('#dz', box);
  const handle = async (files) => {
    for (const f of files) {
      const form = new FormData(); form.append('file', f);
      try { const r = await api('/api/uploads', { method: 'POST', form }); draft.media.push({ id: r.id, type: r.type, name: r.name, url: r.url }); }
      catch (e) { toast(e.message, 'error'); }
    }
    saveDraft(); renderMedia();
  };
  $('#file', box).addEventListener('change', (e) => handle(e.target.files));
  $$('[data-sample]', box).forEach((b) => b.addEventListener('click', () => attachSample(b.dataset.sample, true)));
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); handle(e.dataTransfer.files); });
  $$('[data-rm]', box).forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); draft.media.splice(+b.dataset.rm, 1); saveDraft(); renderMedia(); }));
}

async function attachSample(name, add = false) {
  try {
    const blob = await (await fetch(`/ui/samples/${name}`)).blob();
    const form = new FormData(); form.append('file', new File([blob], name, { type: blob.type || 'image/png' }));
    const r = await api('/api/uploads', { method: 'POST', form });
    const item = { id: r.id, type: r.type, name: r.name, url: r.url };
    draft.media = add ? [...draft.media, item] : [item];
    saveDraft(); renderMedia();
  } catch (e) { toast(e.message, 'error'); }
}

// ------------------------------------------------------------------ running
function showProblem(built) {
  clearHint();
  hint = toast(built.error, 'error');
  if (built.uid) { builder.setStrict(true); builder.focus(built.uid); }
  if (built.field === 'state') $('#state', root)?.focus();
  if (built.field?.startsWith('var:')) $(`[data-var="${built.field.slice(4)}"]`, root)?.focus();
  if (built.field === 'questions') showCreatePanel();
}

// The TypeSafe-shaped request (compare, order test, code snippets).
function validated() {
  const built = buildRequest();
  if (built.error) { showProblem(built); return null; }
  return built.request;
}

// The studio API body for Decide.
function validatedStudio() {
  const built = studioBody();
  if (built.error) { showProblem(built); return null; }
  return built;
}

// The server's own error, as close to the field as it says.
function serverProblem(e) {
  const det = e.data?.error?.details || [];
  const first = det[0];
  if (first?.param?.startsWith('variables.')) $(`[data-var="${first.param.split('.')[1]}"]`, root)?.focus();
  return det.length > 1 ? det.map((d) => d.message).join(' ') : e.message;
}

// While the model reads, each question card lights up in turn.
function reading(on) {
  const spec = $('#spec', root);
  if (!spec) return () => {};
  if (!on) { spec.classList.remove('reading'); $$('.q', spec).forEach((q) => q.classList.remove('lit')); return () => {}; }
  spec.classList.add('reading');
  const qs = $$('.branches .q', spec);
  let i = 0;
  const t = setInterval(() => { if (i < qs.length) qs[i].classList.add('lit'); i++; if (i > qs.length) clearInterval(t); }, 90);
  return () => clearInterval(t);
}

async function run() {
  if (busy || !mounted()) return;
  const btn = $('#decide', root);
  if (!btn) return;
  const sb = validatedStudio();
  if (!sb) return;
  builder.setStrict(false);
  busy = true; btn.disabled = true;
  let stop = () => {};
  let request = sb.body;
  try {
    if (draft.compare && !draft.tpl) {
      const req = validated();
      const ids = readyModels().map((m) => m.id);
      if (!ids.length) throw new Error('对比需所有已加载模型。请先至少加载一个模型。');
      renderBusy(`正在同时询问 ${ids.length} 个模型`);
      stop = reading(true);
      const res = await api('/api/compare', { method: 'POST', body: { models: ids, request: { ...req, ...(keepHistory() ? {} : { store: false }) } } });
      last = { kind: 'compare', request: req, results: res.results, run: nextRun() };
    } else {
      await ensureReady(draft.model, (m) => renderLoading(m));
      renderBusy('正在阅读情境');
      stop = reading(true);
      if (sb.needsPreview) {   // editing a template: the studio renders its variables into the state first
        const p = await studio('/decisions/preview', { method: 'POST', body: { template: `${draft.tpl.id}@${draft.tpl.version}`, variables: sb.needsPreview, model: draft.model } });
        request = { ...request, state: p.state };
      }
      const { data, meta } = await decide(request);
      last = { kind: 'result', request, data, meta, model: draft.model, run: nextRun(), gate: gateKey() };
      markLearned('ran');
    }
    if (tab !== 'answers') tab = 'answers';
  } catch (e) {
    last = { kind: 'error', request, error: e.data?.error ? serverProblem(e) : e.message, status: e.status, data: e.data, model: draft.model };
    tab = 'answers';
  } finally {
    busy = false; stop(); reading(false);
    if (btn.isConnected) btn.disabled = false;
    $$('[data-tab]', root).forEach((x) => { x.setAttribute('aria-pressed', x.dataset.tab === tab); x.setAttribute('aria-selected', x.dataset.tab === tab); });
    renderOut();
    revealAnswer();
  }
}

function revealAnswer() {
  if (!matchMedia('(max-width: 860px)').matches) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('.results', root)?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
}

function nextRun() {
  const n = (+sessionStorage.getItem('bud.run') || 0) + 1;
  sessionStorage.setItem('bud.run', n);
  return n;
}

async function orderTest() {
  if (draft.tpl) { toast('选项顺序测试仅适用于无模板的决策。'); return; }
  const request = validated();
  if (!request) return;
  const targets = Object.entries(request.questions).filter(([, q]) => ['choice', 'rank'].includes(q.type) && Object.keys(q.criteria).length > 2);
  if (!targets.length) { toast('顺序测试需要至少有三个选项的单选或排序题。'); return; }
  const btn = $('#order', root); if (btn) { btn.disabled = true; btn.innerHTML = `${icon('hourglass-medium')}测试中`; }
  try {
    await ensureReady(draft.model, (m) => renderLoading(m));
    renderBusy('正在打乱选项，共 5 次运行');
    const runs = [];
    for (let r = 0; r < 5; r++) {
      const qs = {};
      for (const [id, q] of targets) {
        const keys = Object.keys(q.criteria);
        if (r > 0) for (let i = keys.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [keys[i], keys[k]] = [keys[k], keys[i]]; }
        qs[id] = { ...q, criteria: Object.fromEntries(keys.map((k) => [k, q.criteria[k]])) };
      }
      const { data } = await decide({ ...request, questions: qs, settings: { ...(request.settings || {}), act_threshold: store.prefs.threshold }, ...(keepHistory() ? {} : { store: false }) }, { surface: 'order_test' });
      runs.push({ order: Object.fromEntries(Object.entries(qs).map(([id, q]) => [id, Object.keys(q.criteria)])), answers: data.answers });
    }
    last = { kind: 'order', request, runs, ids: targets.map(([id]) => id), model: draft.model };
    tab = 'answers';
    $$('[data-tab]', root).forEach((x) => { x.setAttribute('aria-pressed', x.dataset.tab === tab); x.setAttribute('aria-selected', x.dataset.tab === tab); });
  } catch (e) { toast(e.message, 'error'); }
  finally { if (btn?.isConnected) { btn.disabled = false; btn.innerHTML = `${icon('shuffle')}测试选项顺序`; } renderOut(); revealAnswer(); }
}

// ------------------------------------------------------------------ results pane
function stamp(html) { const s = $('#stamp', root); if (s && s.innerHTML !== html) { s.innerHTML = html; animate(s); } }

function renderBusy(word) {
  const out = $('#out', root);
  if (!out || tab !== 'answers') return;
  const m = model(draft.model);
  stamp(`<span class="phase busy"><i class="on"></i><i class="on"></i><i class="on"></i><i class="now"></i></span><b>${esc(draft.compare ? '对比' : m?.name || '')}</b><span>${esc(word)}</span>`);
  out.innerHTML = ghost(true);
}

function renderLoading(m) {
  const out = $('#out', root);
  if (!out) return;
  const p = m.worker?.progress;
  stamp(`${phaseTrack(m)}<b>${esc(m.name)}</b><span>${esc(m.worker?.stage || '启动中')}</span><span class="num">${Math.round(m.worker?.elapsed || 0)} s</span>`);
  out.innerHTML = `<div class="empty"><div class="glyph">${icon('cpu')}</div><h2>正在加载 ${esc(m.name)}</h2>
    <p>将 ${esc(m.params)} 个${term('parameters', '参数')}一次性读入内存; 之后每次请求都很快（GPU 上为毫秒级）。</p>
    <span class="progress" style="width:min(360px,80%)"><i style="width:${Math.round((p || 0.04) * 100)}%"></i></span>
    <p class="small">加载后约占用 ${fmtGB(m.memory_gb)} 内存。</p></div>`;
}

// The empty figures the answer will land in.
function ghost(busyNow = false) {
  const n = draft.questions.length;
  const m = model(draft.model);
  return `<div class="figs">${draft.questions.slice(0, 4).map((q) => `<figure class="fig" style="margin:0">
      <div class="fig-head"><span class="fig-title">${esc(q.text || '问题')}</span></div>
      <div class="fig-answer"><span style="display:block;width:40%;height:22px;border-radius:6px;background:var(--fill)"></span></div>
      <div class="hplot">${[0, 0, 0].map(() => '<div class="row"><span class="lab"><span style="display:block;width:70%;height:9px;border-radius:4px;background:var(--fill)"></span></span><span class="track"></span><span class="val"></span></div>').join('')}</div>
    </figure>`).join('')}</div>
    ${!busyNow && guideFor(m?.id)?.tip ? `<p class="note" style="margin-top:16px;max-width:64ch">${icon('lightbulb')}<span><b>${esc(m.name)} 使用提示：</b> ${esc(guideFor(m.id).tip)}</span></p>` : ''}
    ${!busyNow && m ? `<p class="muted" style="margin-top:16px;max-width:64ch">按 <b>决策</b>。 ${esc(m.name)} reads the situation once and ${n === 1 ? '回答问题' : `一并回答全部 ${n} 个问题`}. 每个答案在此显示，各选项概率为 0–100% 刻度。</p>` : ''}`;
}

function emptyState() {
  const ms = store.state?.models || [];
  if (!store.state) return '<div class="empty"><p>正在连接 Studio。</p></div>';
  if (!ms.some((m) => m.downloaded || m.worker)) {
    const first = ms.find((m) => m.id === 'laya') || ms[0];
    return `<div class="empty"><div class="glyph">${icon('download-simple')}</div><h2>下载模型以开始</h2>
      <p>${esc(first.name)} 是最常用的开源决策模型： ${fmtBytes(first.download_bytes)}, 约一分钟即可就绪。</p>
      <button class="btn btn-primary" data-dl="${first.id}">${icon('download-simple')}下载 ${esc(first.name)}</button></div>`;
  }
  const m = model(draft.model);
  stamp(m ? `${phaseTrack(m)}<b>${esc(m.name)}</b><span>${esc(phaseOf(m).word)}</span>` : '');
  if (draft.tpl) return tplGhost(m);
  return draft.stateText.trim() && draft.questions.length ? ghost() : guide(m);
}

// Template mode before the first Decide: which questions will be answered, and where the answers are kept.
function tplGhost(m) {
  const t = draft.tpl;
  const qs = Object.entries(t.questions).filter(([k]) => draft.editing || !draft.skip.includes(k));
  return `<div class="figs">${qs.slice(0, 4).map(([, q]) => `<figure class="fig" style="margin:0">
      <div class="fig-head"><span class="fig-title">${esc(typeof q.instructions === 'string' ? q.instructions.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g, (m, v) => draft.vars[v] || t.variables?.[v]?.default || '...') : '问题')}</span></div>
      <div class="fig-answer"><span style="display:block;width:40%;height:22px;border-radius:6px;background:var(--fill)"></span></div>
      <div class="hplot">${[0, 0, 0].map(() => '<div class="row"><span class="lab"><span style="display:block;width:70%;height:9px;border-radius:4px;background:var(--fill)"></span></span><span class="track"></span><span class="val"></span></div>').join('')}</div>
    </figure>`).join('')}</div>
    <p class="muted" style="margin-top:16px;max-width:64ch">${hasVars() ? '填写变量后按 <b>决策</b>。' : '描述情境后按 <b>决策</b>。'} ${esc(m?.name || '该模型')} 回答模板的 ${qs.length} 个问题${draft.questions.length ? ` 以及你的 ${draft.questions.length} 个` : ''}. ${keepHistory() ? `决策保存在 <a href="#/templates/${esc(t.id)}">${esc(t.name)}</a> 的历史中，版本 ${t.version}.` : ''}</p>`;
}

// A blank or half-written decision: what to do next, ticked off as it is done.
function guide(m) {
  const hasState = !!draft.stateText.trim(), hasQ = draft.questions.length > 0;
  const step = (done, n, title, body, go) => `<li class="${done ? 'done' : ''}"><span class="n">${done ? icon('check') : n}</span>
    <span><button class="step-title" ${go ? `data-go="${go}"` : 'disabled'}>${title}</button><span class="small muted">${body}</span></span></li>`;
  return `<div class="guide">
    <h2>${hasState || hasQ ? '完成你的决策' : '开始一次决策'}</h2>
    <ol class="guide-steps">
      ${step(hasState, 1, '描述情境', guideFor(m?.id) ? `在 <b>情境</b> 下。 ${esc(guideFor(m.id).state)}` : '在 <b>情境</b> 下输入或粘贴：邮件、工单、评价、日志行或 JSON。', 'state')}
      ${step(hasQ, 2, '添加问题', '在 <b>新建决策</b> 下选择答案类型，再写问题与选项。', 'questions')}
      ${step(false, 3, '按决策', `${esc(m?.name || '该模型')} 读一次情境并在此回答每个问题，均以图表展示。`, '')}
    </ol>
    ${modelCard(m)}
    <button class="btn btn-plain" data-go="examples">${icon('sparkle')}更多示例</button>
  </div>`;
}

// What the chosen model is made for, with its own examples to try in one click.
function modelCard(m) {
  const g = guideFor(m?.id);
  if (!g) return '';
  const mine = g.examples.map((id) => EXAMPLES.find((e) => e.id === id)).filter(Boolean);
  return `<div class="model-card"><span class="small muted">${esc(m.name)} 的适用场景</span><p>${esc(g.madeFor)}</p>
    ${g.tip ? `<p class="small muted">${esc(g.tip)}</p>` : ''}
    <div class="model-card-ex">${mine.map((e) => `<button class="btn" data-ex="${e.id}">${icon(e.needsMedia ? 'image' : 'play')}${esc(e.title)}</button>`).join('')}</div></div>`;
}

function showCreatePanel() {
  const panel = $('.create-dec', root);
  if (!panel) return;
  panel.scrollIntoView({ block: 'center', behavior: 'smooth' });
  panel.classList.remove('pulse'); void panel.offsetWidth; panel.classList.add('pulse');
  setTimeout(() => $('[data-add-type]', panel)?.focus({ preventScroll: true }), 350);
}

// Start from scratch: empty situation, no questions, no attachments, no answers. The model and settings stay.
function newDecision() {
  const before = { draft: JSON.parse(JSON.stringify(draft)), last };
  draft = { ...draft, ...NO_TEMPLATE, example: null, stateMode: 'text', stateText: '', questions: [], media: [] };
  last = null; tab = 'answers';
  saveDraft(); render();
  $('#state', root)?.focus();
  toast('已开始新决策。', '', { action: '撤销', onAction: () => { draft = before.draft; last = before.last; saveDraft(); if (root?.isConnected) render(); } });
}

function renderOut({ instant = false } = {}) {
  const out = $('#out', root);
  if (!out) return;
  if (tab === 'code') return renderCode(out);
  if (tab === 'json') return renderJSON(out);
  if (busy) return;
  if (!last) {
    out.innerHTML = emptyState();
    $$('[data-dl]', out).forEach((b) => b.addEventListener('click', () => download(b.dataset.dl)));
    $$('[data-go]', out).forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.go === 'state') $('#state', root)?.focus();
      if (b.dataset.go === 'questions') showCreatePanel();
      if (b.dataset.go === 'examples') examplesMenu(b);
    }));
    $$('[data-ex]', out).forEach((b) => b.addEventListener('click', () => loadExample(EXAMPLES.find((e) => e.id === b.dataset.ex))));
    return;
  }
  if (last.kind === 'error') { stamp(''); out.innerHTML = errorView(); return; }
  if (last.kind === 'compare') { out.innerHTML = compareView(); animate(out, { instant }); return; }
  if (last.kind === 'order') { out.innerHTML = orderView(); return; }
  const { data, meta, request } = last;
  const m = model(last.model);
  const n = Object.keys(data.answers).length;
  const saved = meta.stored === 'full' || meta.stored === 'answers_only';
  stamp(`<b>${esc(m?.name || data.model)}</b><span>回答了 ${n} 个问题，用时</span><span class="num">${odo(fmtMs(data.latency_ms ?? meta.roundtrip))}</span>
    <span>${data.passes === 1 ? term('one_pass', '一次通过') : ''}</span><span class="num">${(data.usage?.input_tokens ?? 0).toLocaleString()} 词元</span>
    ${data.template ? `<span class="chip">${icon('stack')}${esc(data.template.id.replace(/^builtin\//, ''))} v${data.template.version}${data.template.attribution === 'draft' ? ', 已编辑' : ''}</span>` : ''}
    ${data.settings?.temperature && data.settings.temperature !== 1 ? `<span class="chip">T ${fmtNum(data.settings.temperature)}</span>` : ''}
    ${saved ? `<a class="btn btn-plain sm" href="#/history/${esc(meta.decisionId)}">${icon('clock-counter-clockwise')}已保存到历史</a>` : '<span class="faint small">未保存</span>'}
    <button class="btn btn-plain sm" data-copy-id="${esc(meta.requestId || '')}" aria-label="复制请求 ID">${icon('copy')}请求 ID</button>`);
  $('[data-copy-id]', root)?.addEventListener('click', (e) => copy(e.currentTarget.dataset.copyId, '已复制请求 ID'));
  const whatIf = last.gate !== gateKey() ? whatIfThreshold() : undefined;
  const notes = [...(data.notes || []), ...(data.warnings || []).filter((w) => w.code !== 'unknown_field_ignored').map((w) => w.message)];
  out.innerHTML = `${notes.length ? `<div class="note" style="margin-bottom:12px">${icon('info')}<span>${notes.map(esc).join('<br>')}</span></div>` : ''}
    ${whatIf != null ? `<div class="note violet" style="margin-bottom:12px">${icon('sliders-horizontal')}<span>预览行动阈值 ${pctText(whatIf)}。决策时使用 ${pctText(data.settings?.act_threshold ?? 0.9)}；按决策以使用新值重新执行。</span></div>` : ''}
    ${figures(data, { questions: data.input?.questions || request.questions || {} }, { run: last.run, threshold: whatIf })}`;
  animate(out, { instant });
}

function errorView() {
  const m = model(last.model);
  const hints = [];
  if (last.status === 422 || last.status === 400) hints.push('请求未通过校验。提示会指出字段；JSON 标签页显示完整错误。');
  if (last.status === 503 || last.status === 504) hints.push(`${m?.name || '该模型'} 未及时应答。请重试；若重复出现，请弹出并重新加载。`);
  if (/memory|CUDA/i.test(last.error)) hints.push('模型内存不足。弹出未使用的模型后重试。');
  return `<div class="empty"><div class="glyph" style="background:var(--red-tint);color:var(--red)">${icon('warning-circle')}</div><h2>决策未能运行</h2>
    <p>${last.status ? `HTTP ${last.status}: ` : ''}${esc(last.error)}</p>${hints.map((h) => `<p class="small">${esc(h)}</p>`).join('')}</div>`;
}

function compareView() {
  const { results, request } = last;
  const keys = Object.keys(request.questions);
  const ok = results.filter((r) => r.status === 200);
  const agree = (k) => {
    const vals = ok.map((r) => JSON.stringify(decisionOf(r.response.answers?.[k])));
    if (vals.length < 2) return '';
    const top = Object.entries(vals.reduce((a, v) => ({ ...a, [v]: (a[v] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1])[0];
    return `<span class="chip ${top[1] === vals.length ? 'ok' : 'amber'}">${top[1]} / ${vals.length} 一致</span>`;
  };
  stamp(`<b>对比</b><span>${results.length} 个模型，同一请求，同时运行</span>`);
  return `<div class="matrix" style="grid-template-columns:minmax(180px,1.1fr) repeat(${results.length}, minmax(150px,1fr));overflow-x:auto">
      <div class="mhead">问题</div>
      ${results.map((r) => `<div class="mhead">${esc(model(r.model)?.name || r.model)}<span class="muted num" style="margin-left:auto;font-weight:400">${r.status === 200 ? fmtMs(r.response.latency_ms) : `HTTP ${r.status}`}</span></div>`).join('')}
      ${keys.map((k) => `<div class="qlabel">${esc(request.questions[k].instructions || k)}<div style="margin-top:6px">${agree(k)}</div></div>
        ${results.map((r) => `<div class="small">${r.status === 200 ? mini(r.response.answers?.[k]) : `<span style="color:var(--red-text)">${esc(String(r.response?.detail || '失败')).slice(0, 140)}</span>`}</div>`).join('')}`).join('')}
    </div>
    <p class="help" style="margin-top:10px">各模型独立进程并行作答。若不一致，输入宜人工查看或换更大模型。</p>`;
}

function orderView() {
  const { runs, ids, request } = last;
  stamp(`<b>选项顺序测试</b><span>${esc(model(last.model)?.name || '')}，5 次运行，首次之后打乱选项</span>`);
  return `<div class="figs">${ids.map((id) => {
    const winners = runs.map((r) => decisionOf(r.answers[id]));
    const stable = winners.every((w) => w === winners[0]);
    return `<figure class="fig ${stable ? '' : 'unsure'}" style="margin:0">
      <div class="fig-head"><span class="fig-title">${esc(request.questions[id].instructions)}</span><span class="chip ${stable ? 'ok' : 'amber'}">${stable ? '稳定' : '随顺序变化'}</span></div>
      <table class="table" style="margin-top:10px"><thead><tr><th>运行</th><th>所示顺序</th><th>答案</th><th class="num">概率</th></tr></thead><tbody>
      ${runs.map((r, i) => `<tr><td class="num">${i + 1}${i === 0 ? ' <span class="muted">（当前）</span>' : ''}</td><td class="small muted">${r.order[id].map(esc).join(', ')}</td><td><b>${esc(winners[i])}</b></td><td class="num">${fmtPct(r.answers[id].probabilities?.[winners[i]])}</td></tr>`).join('')}
      </tbody></table>
      <figcaption class="fig-cap"><span>${stable ? '每次答案相同：该问题对选项顺序不敏感。' : '答案随选项顺序变化。宜视为不确定、改写选项或换更大模型。'}</span></figcaption>
    </figure>`;
  }).join('')}</div>`;
}

function renderJSON(out) {
  const built = studioBody();
  const request = last?.request || built.body;
  if (!request) { out.innerHTML = `<div class="note amber">${icon('warning')}<span>${esc(built.error)}</span></div>`; return; }
  const resp = last?.kind === 'result' ? last.data : last?.kind === 'error' ? last.data : last?.kind === 'compare' ? { results: last.results } : null;
  out.innerHTML = `<div class="two">
    <div style="display:grid;gap:8px"><div class="small muted" style="display:flex;gap:8px;align-items:center"><span class="chip violet">POST</span><code>${last?.kind === 'compare' ? '/api/compare' : '/v1/studio/decisions'}</code></div>${jsonTree(request, { file: '请求', openDepth: 4 })}</div>
    <div style="display:grid;gap:8px">${resp ? `<div class="small muted" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${last.meta ? `<span class="chip ${last.meta.status === 200 ? 'ok' : 'danger'}">HTTP ${last.meta.status}</span><code>x-typesafe-request-id: ${esc(last.meta.requestId || '')}</code>` : '<span class="chip">响应</span>'}</div>
      ${jsonTree(resp, { file: '响应', openDepth: 3, collapse: ['legend', 'model_extras'] })}` : '<div class="empty"><p>按决策后在此查看响应。</p></div>'}</div>
  </div>
  <p class="help" style="margin-top:12px">试验台使用 studio API，将决策记入历史，并按问题给出裁决。 ${draft.tpl ? '你的代码发送相同请求体。' : '相同问题可用于 <code>POST /v1/systemone</code>（TypeSafe 格式）；见代码标签页。'}</p>`;
}

function renderCode(out) {
  if (draft.tpl && !draft.editing) return renderTemplateCode(out);
  const built = buildRequest();
  if (built.error) { out.innerHTML = `<div class="note amber">${icon('warning')}<span>${esc(built.error)} 请求完整后才会显示代码。</span></div>`; return; }
  const req = { ...built.request };
  delete req.media;
  const L = LANGS[lang];
  out.innerHTML = `<div style="display:grid;gap:12px">
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <span class="seg" role="group" aria-label="语言">${Object.entries(LANGS).map(([k, v]) => `<button data-lang="${k}" aria-pressed="${k === lang}">${esc(v.name)}</button>`).join('')}</span>
      ${L.sdk ? '' : `<select class="select" id="fmt" style="width:auto" aria-label="API format">${Object.entries(FORMATS).map(([k, f]) => `<option value="${k}" ${k === format ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>`}
      <span class="help">${L.sdk ? 'TypeSafe 官方 SDK，指向本 Studio。' : esc(FORMATS[format].note)}</span>
    </div>
    ${codeBlock(snippet(lang, req, { format }), { lang: L.lang, file: L.file })}
    <p class="help">本机无需 API 密钥。 ${draft.media.length ? '附件未包含；请以 base64 data: URL 的 media 项发送。 ' : ''}<a href="#/api">API 参考</a></p>
  </div>`;
  $$('[data-lang]', out).forEach((b) => b.addEventListener('click', () => { lang = b.dataset.lang; renderCode(out); markLearned('code'); }));
  $('#fmt', out)?.addEventListener('change', (e) => { format = e.target.value; renderCode(out); });
}

// Template mode: the studio API call your code makes.
function renderTemplateCode(out) {
  const built = studioBody();
  if (built.error) { out.innerHTML = `<div class="note amber">${icon('warning')}<span>${esc(built.error)} 决策完整后才会显示代码。</span></div>`; return; }
  const body = { ...built.body };
  delete body.include; delete body.media;
  if (body.variables) for (const [k, v] of Object.entries(draft.tpl.variables)) if (v.sensitive && body.variables[k] != null) body.variables[k] = '...';
  const langs = { curl: 'curl', python: 'Python', javascript: 'JavaScript' };
  const l = langs[lang] ? lang : 'python';
  out.innerHTML = `<div style="display:grid;gap:12px">
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <span class="seg" role="group" aria-label="语言">${Object.entries(langs).map(([k, v]) => `<button data-lang="${k}" aria-pressed="${k === l}">${esc(v)}</button>`).join('')}</span>
      <span class="help">studio API，模板 <code>${esc(draft.tpl.id)}</code> 固定版本 ${draft.tpl.version}。去掉 <code>@${draft.tpl.version}</code> 则始终使用最新版。</span>
    </div>
    ${codeBlock(studioSnippet(l, body), { lang: l === 'curl' ? 'bash' : l, file: l === 'curl' ? 'decide.sh' : l === 'python' ? 'decide.py' : 'decide.mjs' })}
    <p class="help">本机无需 API 密钥。 每次调用记入模板历史，除非发送 <code>"store": false</code>. <a href="#/api">API 参考</a></p>
  </div>`;
  $$('[data-lang]', out).forEach((b) => b.addEventListener('click', () => { lang = b.dataset.lang; renderTemplateCode(out); }));
}

// ------------------------------------------------------------------ templates: open, save, save a version
async function templateMenu(anchor) {
  const t = draft.tpl;
  let mine = [];
  try { mine = (await studio('/templates?origin=user&limit=100')).data; } catch { /* history off */ }
  const item = (x) => `<button class="menu-item" data-pick="open:${esc(x.id)}">${icon('stack')}<span><b>${esc(x.name)}</b><span>${esc(x.description || x.id)} (v${x.version})</span></span></button>`;
  popMenu(anchor, `${t ? `<div class="menu-group">${esc(t.name)}，版本 ${t.version}</div>
      <button class="menu-item" data-pick="page">${icon('arrow-square-out')}<span><b>打开模板页</b><span>历史、版本对比、测试示例。</span></span></button>
      ${t.origin === 'builtin' ? '' : `<button class="menu-item" data-pick="${draft.editing ? 'stopedit' : 'edit'}">${icon('pencil-simple')}<span><b>${draft.editing ? '停止编辑' : '编辑其问题'}</b><span>${draft.editing ? '返回已保存版本。' : '试用修改后另存为新版本。'}</span></span></button>`}
      <button class="menu-item" data-pick="leave">${icon('x')}<span><b>离开模板</b><span>将问题保留为自由决策。</span></span></button>`
    : `<button class="menu-item" data-pick="save">${icon('stack')}<span><b>将本决策另存为模板</b><span>在代码与此处复用其问题、模型与设置。</span></span></button>`}
    <div class="menu-group">你的模板</div>${mine.map(item).join('') || '<div class="small muted" style="padding:6px 12px">暂无。</div>'}
    <div class="menu-sep"></div><button class="menu-item" data-pick="all">${icon('squares-four')}<span><b>全部模板</b><span>含入门模板。</span></span></button>`, {
    onPick: async (v) => {
      if (v === 'page') location.hash = `#/templates/${t.id}`;
      if (v === 'all') location.hash = '#/templates';
      if (v === 'save') saveAsTemplate();
      if (v === 'edit') openTemplate(t, { edit: true, vars: draft.vars, keepState: true });
      if (v === 'stopedit') openTemplate(t, { vars: draft.vars, keepState: true });
      if (v === 'leave') leaveTemplate();
      if (v.startsWith('open:')) { try { openTemplate(await studio(`/templates/${v.slice(5)}`)); } catch (e) { toast(e.message, 'error'); } }
    },
  });
}

function leaveTemplate() {
  const t = draft.tpl;
  const rows = draft.editing ? draft.questions : [...Object.entries(t.questions).filter(([k]) => !draft.skip.includes(k)).map(([k, q]) => fromQuestion(k, q)), ...draft.questions];
  let stateMode = draft.stateMode, stateText = draft.stateText;
  if (hasVars()) {
    const v = varValues(t, draft.vars, draft.varMedia);
    const vals = v.values || {};
    stateMode = 'json'; stateText = JSON.stringify(vals, null, 2);
  }
  draft = { ...draft, ...NO_TEMPLATE, questions: rows, stateMode, stateText };
  last = null; persist(); render();
  toast('已离开模板，问题现为自由决策。');
}

const slugId = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'my-template';

async function saveAsTemplate() {
  // A fresh window may not have the model list yet: wait for it once, before reading the page, so the template gets
  // the model named in the dialog. refresh() never throws; with no list, the dialog says there is no default model.
  if (!store.state) await refresh();
  if (!mounted()) return;
  const built = buildRequest();
  if (built.error) { showProblem(built); return; }
  const r = built.request;
  const tm = usableModel();
  const found = [...new Set([...String(draft.stateText).matchAll(/\{\{\s*([a-z_][a-z0-9_]{0,63})\s*\}\}/g)].map((m) => m[1]))];
  const d = document.createElement('dialog');
  const guess = Object.values(r.questions)[0]?.instructions?.replace(/\?$/, '').slice(0, 48) || '我的决策';
  d.innerHTML = `<form method="dialog" style="width:min(520px,92vw)"><div class="dialog-body"><h2 style="font-size:17px">另存为模板</h2>
    <p class="small muted">含 ${Object.keys(r.questions).length} 个问题，${tm ? `默认模型为 ${esc(tm.name)}` : '尚无默认模型（每次使用当时加载的模型）'}，及当前行动阈值${draft.temperature ? ' 与温度' : ''}。每次调用都会记入其历史。</p>
    <label class="field"><span class="label">名称</span><input class="input" name="name" value="${esc(guess)}" required></label>
    <label class="field"><span class="label">ID（代码中使用）</span><input class="input code" name="id" value="${esc(slugId(guess))}" pattern="[a-z0-9][a-z0-9_\\-]{0,63}" title="小写字母、数字、短横线与下划线，以字母或数字开头；最多 64 个字符。" required></label>
    <div class="note ${found.length ? 'violet' : ''}">${icon(found.length ? 'brackets-curly' : 'text-t')}<span>${found.length
      ? `情境含占位符，调用方填写 ${found.map((x) => `<code>${esc(x)}</code>`).join(', ')}，其余文本固定。`
      : '每次由调用方发送完整情境。若要固定结构，请在情境中写 <code>{{name}}</code> 占位符，例如 <code>{{customer_message}}</code>，再保存。'}</span></div>
    <div id="saveerr"></div></div>
    <div class="dialog-foot"><button class="btn" value="cancel" formnovalidate>取消</button><button class="btn btn-primary" id="dosave" value="ok">${icon('stack')}保存模板</button></div></form>`;
  document.body.append(d);
  const name = d.querySelector('[name=name]'), id = d.querySelector('[name=id]');
  let idEdited = false;
  id.addEventListener('input', () => { idEdited = true; });
  name.addEventListener('input', () => { if (!idEdited) id.value = slugId(name.value); });
  d.addEventListener('close', () => d.remove());
  d.querySelector('#dosave').addEventListener('click', async (e) => {
    e.preventDefault();
    if (!d.querySelector('form').reportValidity()) return;
    const body = { id: id.value.trim(), name: name.value.trim(), note: '在试验台中保存', questions: r.questions, ...(tm ? { model: tm.id } : {}),
      settings: { act_threshold: store.prefs.threshold, ...(draft.temperature ? { temperature: draft.temperature } : {}) },
      modalities: ['text', ...new Set(draft.media.map((m) => m.type))] };
    if (found.length) {
      body.variables = Object.fromEntries(found.map((v) => [v, { type: 'string' }]));
      body.state = draft.stateMode === 'json' ? parseState().value : draft.stateText;
    }
    try {
      const t = await studio('/templates', { method: 'POST', body });
      d.close();
      openTemplate(t, { keepState: !found.length });
      toast(`已保存模板 ${t.id}。使用它的决策会记入其历史。`, '', { action: '打开', onAction: () => { location.hash = `#/templates/${t.id}`; } });
    } catch (err) {
      const det = err.data?.error?.details || [];
      d.querySelector('#saveerr').innerHTML = `<div class="note danger" style="margin-top:8px">${icon('warning-circle')}<span>${det.length ? det.map((x) => esc(x.message)).join('<br>') : esc(err.message)}</span></div>`;
    }
  });
  d.showModal();
  name.select();
}

async function saveVersion() {
  const t = draft.tpl;
  const built = buildQuestions(draft.questions, model(draft.model));
  if (built.error) { showProblem(built); return; }
  const qs = built.questions;
  const settings = JSON.parse(JSON.stringify(t.settings || {}));
  const keepQ = (o) => { if (o?.questions) { for (const k of Object.keys(o.questions)) if (!qs[k] || (o.questions[k].multi_threshold != null && qs[k].type !== 'multi')) delete o.questions[k]; } };
  keepQ(settings);
  for (const m of Object.values(settings.models || {})) keepQ(m);
  const ext = JSON.parse(JSON.stringify(t.extensions || {}));
  if (Array.isArray(ext.options)) ext.options = ext.options.filter((k) => qs[k] && ['choice', 'multi', 'rank', 'number'].includes(qs[k].type));
  if (Array.isArray(ext.skip)) ext.skip = ext.skip.filter((k) => qs[k]);
  const note = await askText({ title: `保存 ${t.name} 的版本 ${t.version + 1}`, label: '做了哪些更改？会显示在版本历史中。', value: '在试验台中编辑', confirm: '保存版本' });
  if (note == null) return;
  const body = { modalities: t.modalities, variables: t.variables, state: t.state, questions: qs, model: t.model, settings, extensions: ext, note, base_version: t.version };
  try {
    const v = await studio(`/templates/${t.id}/versions`, { method: 'POST', body });
    const fresh = await studio(`/templates/${t.id}`);
    openTemplate(fresh, { vars: draft.vars, keepState: true });
    toast(v.version === t.version ? '无变更，未保存新版本。' : `已保存版本 ${v.version}。${v.changes.breaking_for_callers ? '部分调用方可能被拒绝；请查看版本标签页。' : '使用最新版的调用方现已生效。'}`);
  } catch (e) {
    if (e.status === 412) {
      toast(`自你打开后 ${t.name} 已在别处保存（现为版本 ${e.data?.error?.current_version}）。请重新加载查看；你的编辑会保留至此操作前。`, 'error',
        { action: '重新加载', onAction: async () => { try { openTemplate(await studio(`/templates/${t.id}`), { edit: true, vars: draft.vars, keepState: true }); } catch (err) { toast(err.message, 'error'); } } });
    } else toast(e.data?.error ? serverProblem(e) : e.message, 'error');
  }
}
