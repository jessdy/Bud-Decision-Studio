// Evaluate: run one question over many labelled examples on several models. The setup is a column on the left
// (question, examples, models); the results fill the rest: a leaderboard, charts for the selected model,
// one-click recommendations, and every example.

import { buildQuestions, createBuilder, fromQuestion } from '../builder.js';
import { setSub } from '../shell.js';
import { ACT_MIN, ACT_MAX, decide, ensureReady, markLearned, readyModels, registry, setPref, store } from '../store.js';
import { $, $$, esc, fmtMs, fmtPct, icon, term, toast } from '../util.js';
import { setTemperature } from './playground.js';

const SAMPLE = `I was charged twice for my subscription this month, please refund one of them.\tbilling
The app crashes as soon as I open the settings screen.\ttechnical
I can't log in, it says my password is wrong but I just reset it.\taccount
Where is my order? It was supposed to arrive on Monday.\tshipping
Can I get an invoice with my company's VAT number on it?\tbilling
After the latest update, notifications stopped working on Android.\ttechnical
Please delete my account and all my data.\taccount
The package arrived but the box was empty.\tshipping
Do you offer a discount for non-profits?\tother
My card was declined but the money left my bank account.\tbilling
The export to PDF button does nothing.\ttechnical
How do I change the email address on my profile?\taccount
Tracking says delivered but nothing is at my door.\tshipping
I love the new design, great job!\tother
You billed me after I cancelled. I want my money back.\tbilling
Two-factor codes never arrive by SMS.\taccount
The website is extremely slow today, pages take a minute to load.\ttechnical
Can I change the delivery address for an order I placed an hour ago?\tshipping
Is there a student plan?\tother
The receipt shows the wrong amount, I paid 49 not 59.\tbilling
Syncing between my laptop and phone has been broken since Tuesday.\ttechnical
Someone else seems to have logged into my account from another country.\taccount
The courier left my parcel in the rain and it's soaked.\tshipping
Do you have a public roadmap?\tother`;
const SAMPLE_Q = { type: 'choice', instructions: '哪支团队应处理此消息？', criteria: { billing: '付款、扣款、退款、发票', technical: '缺陷、崩溃、错误、变慢', account: '登录、密码、安全、资料、注销', shipping: '配送、物流、包裹、地址', other: '其他' } };
const KEY = 'bud.eval.v2';

let root, builder, reg;
let saved = load();
let selected = new Set();
let run = null;          // { question, keys, rows, results: {model: {items|error}}, running, done, total }
let focus = null;        // model id shown in detail
let budget = 0.05;
let show = 'all';

function load() {
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s?.question) return s; } catch { /* fresh */ }
  return { question: fromQuestion('team', SAMPLE_Q), dataText: SAMPLE };
}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* ignore */ } };

export async function mount(el) {
  root = el;
  saved = load();               // another page (Train's "Compare on Evaluate") may have prepared a question and examples
  try {
    const pre = JSON.parse(sessionStorage.getItem('bud.eval.select') || 'null');
    sessionStorage.removeItem('bud.eval.select');
    if (Array.isArray(pre)) selected = new Set(pre);
  } catch { /* nothing prepared */ }
  reg = await registry();
  setSub('用自有标注示例评测模型');
  root.innerHTML = `<div class="view panes eval-view">
    <section class="spec" aria-label="设置">
      <div class="spec-scroll">
        <div class="spec-section"><div class="spec-title"><h2>1. 问题</h2></div><div id="qb"></div></div>
        <div class="spec-section"><div class="spec-title"><h2>2. 示例</h2><span class="right">
            <button class="btn btn-quiet sm" id="sample">${icon('sparkle')}示例数据</button>
            <label class="btn btn-quiet sm">${icon('file-arrow-up')}打开文件<input type="file" id="file" accept=".txt,.tsv,.csv,.jsonl" hidden></label></span></div>
          <div class="state-card" id="dcard"></div></div>
        <div class="spec-section"><div class="spec-title"><h2>3. 模型</h2><span class="right small muted">已加载的模型并行运行</span></div><div class="group model-checks" id="mbox"></div></div>
      </div>
      <div class="decide-bar"><button class="btn btn-primary" id="go">${icon('play')}运行</button></div>
    </section>
    <section class="pane" aria-label="结果"><div class="pane-body" id="results"></div></section>
  </div>`;
  const list = [saved.question];
  builder = createBuilder($('#qb', root), { list: () => list, spec: () => null, onChange: () => { saved.question = list[0]; save(); }, onStructure: () => { saved.question = list[0]; save(); }, types: ['choice', 'score', 'noul'], single: true });
  builder.render();
  $('#sample', root).addEventListener('click', () => { saved = { question: fromQuestion('team', SAMPLE_Q), dataText: SAMPLE }; save(); list[0] = saved.question; builder.render(); renderData(); });
  $('#file', root).addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; saved.dataText = await f.text(); save(); renderData(); });
  $('#go', root).addEventListener('click', start);
  renderData(); renderModels(); renderResults();
}
export function onState() { if (root?.isConnected && !run?.running) renderModels(); }

// ------------------------------------------------------------------ examples
function parseRows(text) {
  const t = text.trim();
  if (!t) return [];
  const lines = t.split('\n').filter((l) => l.trim());
  if (lines.every((l) => l.trim().startsWith('{'))) return lines.map((l) => { const o = JSON.parse(l); return { text: o.text ?? o.state ?? JSON.stringify(o), label: o.label ?? o.answer ?? null }; });
  const header = lines[0].toLowerCase();
  if (header.includes(',') && /(^|,)\s*"?text"?\s*(,|$)/.test(header)) {
    const cols = csvLine(lines[0]).map((c) => c.toLowerCase().trim());
    const ti = cols.indexOf('text'), li = cols.findIndex((c) => ['label', 'answer', 'correct'].includes(c));
    return lines.slice(1).map((l) => { const c = csvLine(l); return { text: c[ti] ?? '', label: li >= 0 ? (c[li] ?? null) : null }; });
  }
  return lines.map((l) => { const i = l.lastIndexOf('\t'); return i > 0 ? { text: l.slice(0, i).trim(), label: l.slice(i + 1).trim() || null } : { text: l.trim(), label: null }; });
}
function csvLine(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') inQ = false; else cur += ch; }
    else if (ch === '"') inQ = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function renderData() {
  const box = $('#dcard', root);
  let rows = [];
  try { rows = parseRows(saved.dataText); } catch { rows = []; }
  const labeled = rows.filter((r) => r.label != null).length;
  box.innerHTML = `<div style="padding:10px 14px;display:flex;gap:8px;align-items:baseline;border-bottom:1px solid var(--line-2)"><b style="font-weight:600">${rows.length} 个示例</b><span class="muted small">${labeled} 个有标准答案</span></div>
    ${rows.length ? `<table class="table ex-preview" style="font-size:12.5px"><tbody>${rows.slice(0, 5).map((r) => `<tr><td><span class="txt" title="${esc(r.text)}">${esc(r.text)}</span></td><td class="muted lbl">${esc(r.label ?? '')}</td></tr>`).join('')}
      ${rows.length > 5 ? `<tr><td colspan="2" class="muted small">另有 ${rows.length - 5} 条</td></tr>` : ''}</tbody></table>` : '<p class="muted small" style="padding:12px 14px">尚无示例。加载示例数据或打开文件。</p>'}
    <details class="disclose" style="border-top:1px solid var(--line-2)"><summary style="padding:0 14px">以文本编辑${icon('caret-right', 'chev')}</summary><div class="body" style="padding:0 14px 14px">
      <textarea class="textarea code" id="data" rows="9" spellcheck="false" placeholder="每行一个示例，Tab 后为标准答案。">${esc(saved.dataText)}</textarea>
      <span class="help">每行示例 + Tab + 答案，或含 <code>text</code> 与 <code>label</code> 列的 CSV，或 JSON Lines。答案可选；无答案仍可得结果表。</span></div></details>`;
  const ta = $('#data', box);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('\t', s, ta.selectionEnd, 'end'); } });
  ta.addEventListener('change', () => { saved.dataText = ta.value; save(); const open = true; renderData(); if (open) $('#dcard details', root).open = true; });
  ta.addEventListener('input', () => { saved.dataText = ta.value; save(); });
  $('#go', root).innerHTML = `${icon('play')}在 ${rows.length} 个示例上运行`;
}

// ------------------------------------------------------------------ models
function renderModels() {
  const box = $('#mbox', root);
  const st = store.state;
  if (!st || !box) return;
  const usable = st.models.filter((m) => m.downloaded || m.worker);
  const ready = new Set(readyModels().map((m) => m.id));
  if (!selected.size) ready.forEach((id) => selected.add(id));
  const html = usable.length ? usable.map((m) => {
    const r = reg.models[m.id] || {}; const mk = reg.makers[r.maker_id] || {}; const src = mk.avatar || r.logo || mk.logo;
    return `<label><input type="checkbox" value="${m.id}" ${selected.has(m.id) ? 'checked' : ''}><span class="logo sm">${src ? `<img src="/ui/${esc(src)}" alt="">` : ''}</span>
      <span class="nm"><b>${esc(m.name)}</b><span>${ready.has(m.id) ? '已加载' : '将先加载'}，${esc(m.params)}</span></span></label>`;
  }).join('') : '<p class="muted small" style="padding:12px 14px">请先在「模型」页面下载模型。</p>';
  if (box.dataset.html === html) return;
  box.dataset.html = html; box.innerHTML = html;
  $$('input[type=checkbox]', box).forEach((c) => c.addEventListener('change', () => { c.checked ? selected.add(c.value) : selected.delete(c.value); box.dataset.html = ''; }));
}

// ------------------------------------------------------------------ running
async function start() {
  if (run?.running) return;
  let question, rows;
  const built = buildQuestions([saved.question], null);
  if (built.error) { toast(built.error, 'error'); builder.setStrict(true); return; }
  question = Object.values(built.questions)[0];
  try { rows = parseRows(saved.dataText); } catch (e) { toast(`无法读取示例：${e.message}`, 'error'); return; }
  if (!rows.length) { toast('请至少添加一个示例。', 'error'); return; }
  if (rows.length > 2000) { toast('每次运行最多 2,000 个示例。', 'error'); return; }
  const models = [...selected].filter((id) => store.state.models.some((m) => m.id === id && (m.downloaded || m.worker)));
  if (!models.length) { toast('请至少选择一个模型。', 'error'); return; }
  const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.type === 'score' ? question.criteria.map((_, i) => String(i)) : ['false', 'true'];
  rows = rows.map((r) => ({ ...r, gold: matchLabel(r.label, question, keys) }));
  const unmatched = rows.filter((r) => r.label != null && r.gold == null).length;
  if (unmatched) toast(`${unmatched} 个答案未匹配任何选项，将不参与计分。`);
  run = { question, keys, rows, results: {}, running: true, done: 0, total: rows.length * models.length, started: performance.now() };
  focus = models[0];
  $('#go', root).disabled = true;
  renderResults();
  await Promise.all(models.map((mid) => runModel(mid)));
  run.running = false;
  run.seconds = (performance.now() - run.started) / 1000;
  if (run.rows.some((r) => r.gold != null)) markLearned('evaluated');
  const best = Object.entries(run.results).filter(([, R]) => R.items).map(([id, R]) => [id, metrics(R.items, run.rows)?.acc ?? -1]).sort((a, b) => b[1] - a[1])[0];
  if (best) focus = best[0];
  $('#go', root).disabled = false;
  renderResults();
}

async function runModel(mid) {
  const m = store.state.models.find((x) => x.id === mid);
  if (m.worker?.status !== 'ready') {
    try { await ensureReady(mid, () => setProgress(`正在加载 ${m.name}`)); }
    catch (e) { run.results[mid] = { error: e.message }; return; }
  }
  const out = [];
  run.results[mid] = { items: out };
  for (const r of run.rows) {
    try {
      const { data: res } = await decide({ model: mid, state: r.text, questions: { q: run.question } }, { surface: 'eval' });
      const a = res.answers.q;
      const probs = run.keys.map((k) => a.probabilities[k] ?? 0);
      const pi = probs.indexOf(Math.max(...probs));
      out.push({ probs, pred: pi, top: probs[pi], latency: res.latency_ms });
    } catch (e) { out.push({ error: e.message }); }
    run.done++;
    if (run.done % 3 === 0 || run.done === run.total) setProgress(`${run.done} / ${run.total} 次决策`);
    liveRender();
  }
}

let liveTimer = null;
function liveRender() { if (liveTimer) return; liveTimer = setTimeout(() => { liveTimer = null; if (run?.running && root?.isConnected) renderResults(); }, 500); }
function setProgress(t) { if (run) run.progressText = t; const el = $('#prog', root); if (el) el.textContent = t; }

function matchLabel(label, question, keys) {
  if (label == null) return null;
  const l = String(label).trim().toLowerCase();
  if (question.type === 'noul') { if (['yes', 'true', '1', 'y'].includes(l)) return 1; if (['no', 'false', '0', 'n'].includes(l)) return 0; return null; }
  if (question.type === 'score') { if (/^\d+$/.test(l) && +l < keys.length) return +l; const i = question.criteria.findIndex((c) => String(c).toLowerCase() === l); return i >= 0 ? i : null; }
  const i = keys.findIndex((k) => k.toLowerCase() === l);
  return i >= 0 ? i : null;
}

// ------------------------------------------------------------------ metrics
function scale(p, T) {
  if (T === 1) return p;
  const w = p.map((x) => Math.exp(Math.log(Math.max(x, 1e-12)) / T)); const s = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / s);
}
function metrics(items, rows, T = 1) {
  const pairs = items.map((it, i) => [it, rows[i]]).filter(([it, r]) => it && !it.error && r.gold != null);
  const n = pairs.length;
  if (!n) return null;
  let correct = 0, brier = 0, nll = 0, confWrong = 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, acc: 0 }));
  for (const [it, r] of pairs) {
    const p = scale(it.probs, T);
    const pi = p.indexOf(Math.max(...p)); const top = p[pi]; const ok = pi === r.gold;
    correct += ok; nll -= Math.log(Math.max(p[r.gold], 1e-12));
    brier += p.reduce((a, x, k) => a + (x - (k === r.gold ? 1 : 0)) ** 2, 0);
    if (top >= 0.9 && !ok) confWrong++;
    const b = bins[Math.min(9, Math.floor(top * 10))]; b.n++; b.conf += top; b.acc += ok;
  }
  const ece = bins.reduce((a, b) => a + (b.n ? Math.abs(b.acc / b.n - b.conf / b.n) * b.n / n : 0), 0);
  return { n, acc: correct / n, brier: brier / n, nll: nll / n, ece, confWrong, bins: bins.map((b, i) => ({ lo: i / 10, n: b.n, conf: b.n ? b.conf / b.n : null, acc: b.n ? b.acc / b.n : null })) };
}
function fitTemperature(items, rows) {
  let best = { T: 1, nll: Infinity };
  for (let i = 0; i <= 60; i++) {
    const T = Math.exp(Math.log(0.25) + (Math.log(8) - Math.log(0.25)) * i / 60);
    const m = metrics(items, rows, T);
    if (m && m.nll < best.nll) best = { T, nll: m.nll };
  }
  return best.T;
}
function coverage(items, rows, th) {
  const pairs = items.map((it, i) => [it, rows[i]]).filter(([it, r]) => it && !it.error && r.gold != null);
  const cov = pairs.filter(([it]) => it.top >= th);
  const acc = cov.length ? cov.filter(([it, r]) => it.pred === r.gold).length / cov.length : null;
  return { share: pairs.length ? cov.length / pairs.length : 0, acc, n: cov.length };
}
// The lowest act threshold, within the range the app offers (50% to 99%, the Playground's slider and the chart below),
// that keeps mistakes under the error budget. Whole steps of half a percent, so no rounding drift.
function safeThreshold(items, rows) {
  // fewer than three examples reach even the lowest threshold: the model is not wrong, it is never sure enough
  if (coverage(items, rows, ACT_MIN).n < 3) return { unsure: true };
  for (let i = Math.round(ACT_MIN * 200); i <= Math.round(ACT_MAX * 200); i++) {
    const t = i / 200;
    const c = coverage(items, rows, t);
    if (c.n >= 3 && c.acc >= 1 - budget) return { t, ...c };
  }
  return null;
}
const nameOf = (id) => esc(store.state?.models.find((m) => m.id === id)?.name || id);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// ------------------------------------------------------------------ results
function renderResults() {
  const box = $('#results', root);
  if (!box) return;
  if (!run) {
    box.innerHTML = `<div class="empty" style="min-height:60vh"><div class="glyph">${icon('list-checks')}</div><h2>模型在你的数据上表现如何？</h2>
      <p>编写一个问题、添加带标准答案的示例、选择模型并运行。可查看各模型正确率、概率是否可信，以及哪个${term('threshold', '自动执行阈值')}能在误差预算内控制失误。</p>
      <p class="small">示例为 24 条客服工单，标注了应处理的团队。</p></div>`;
    return;
  }
  const ids = Object.keys(run.results);
  const labeled = run.rows.some((r) => r.gold != null);
  const pctDone = run.total ? Math.round((run.done / run.total) * 100) : 0;
  const head = `<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="font-size:17px">结果</h2>
      ${run.running ? `<span class="progress" style="width:160px"><i style="width:${pctDone}%"></i></span><span class="small muted" id="prog">${esc(run.progressText || '')}</span>` : `<span class="small muted">${run.total} 次决策，用时 ${run.seconds?.toFixed(1)} 秒</span>`}
      <span style="margin-left:auto;display:flex;gap:8px;align-items:center">${labeled ? `<label class="small muted" style="display:flex;gap:6px;align-items:center">误差预算 <select class="select" id="budget" style="width:auto">${[0.01, 0.02, 0.05, 0.1, 0.2].map((b) => `<option value="${b}" ${b === budget ? 'selected' : ''}>${fmtPct(b)}</option>`).join('')}</select></label>` : ''}
        <button class="btn sm" id="csv" ${run.running ? 'disabled' : ''}>${icon('file-csv')}导出 CSV</button></span></div>`;
  box.innerHTML = `${head}${labeled ? leaderboard(ids) : plainBoard(ids)}${labeled && focus && run.results[focus]?.items ? detail(focus) : ''}${examplesTable(ids, labeled)}`;
  $('#budget', box)?.addEventListener('change', (e) => { budget = +e.target.value; renderResults(); });
  $('#csv', box)?.addEventListener('click', exportCsv);
  $$('[data-focus]', box).forEach((r) => r.addEventListener('click', () => { focus = r.dataset.focus; renderResults(); }));
  $$('[data-show]', box).forEach((b) => b.addEventListener('click', () => { show = b.dataset.show; renderResults(); }));
  $('[data-use-t]', box)?.addEventListener('click', (e) => { setTemperature(+e.currentTarget.dataset.useT); toast(`试验台已应用校准温度 ${e.currentTarget.dataset.useT}。`); });
  $('[data-use-th]', box)?.addEventListener('click', (e) => { setPref('threshold', +e.currentTarget.dataset.useTh); toast(`自动执行阈值已设为 ${fmtPct(store.prefs.threshold, 1)}。`); });
}

function leaderboard(ids) {
  const rows = ids.map((id) => {
    const R = run.results[id];
    if (R.error) return `<tr><td>${nameOf(id)}</td><td colspan="4" style="color:var(--red-text)">${esc(R.error)}</td></tr>`;
    const m = metrics(R.items, run.rows);
    const lat = median(R.items.filter((i) => i.latency != null).map((i) => i.latency));
    if (!m) return `<tr><td>${nameOf(id)}</td><td colspan="4" class="muted">运行中</td></tr>`;
    return `<tr data-focus="${id}" class="${id === focus ? 'sel' : ''}" tabindex="0"><td><b style="font-weight:600">${nameOf(id)}</b><div class="small muted">${m.n} 条已计分${run.running ? '，运行中' : ''}</div></td>
      <td><span class="bar"><i style="width:${(m.acc * 100).toFixed(1)}%"></i></span><b class="num">${fmtPct(m.acc)}</b></td>
      <td class="num">${m.ece.toFixed(3)}</td><td class="num">${m.confWrong}</td><td class="num">${fmtMs(lat)}</td></tr>`;
  }).join('');
  return `<div class="card" style="overflow:hidden"><table class="table hover board"><thead><tr><th>模型</th><th>正确率</th><th class="num"><span class="term" data-term="calibration" tabindex="0">校准误差</span></th><th class="num"><span class="term" tabindex="0" data-tip="置信度 ≥90% 却答错：最危险的失误类型。">高置信错误</span></th><th class="num">典型耗时</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function plainBoard(ids) {
  return `<div class="card" style="overflow:hidden"><table class="table"><thead><tr><th>模型</th><th class="num">完成</th><th class="num">典型耗时</th><th class="num">错误</th></tr></thead><tbody>
    ${ids.map((id) => { const R = run.results[id]; if (R.error) return `<tr><td>${nameOf(id)}</td><td colspan="3" style="color:var(--red-text)">${esc(R.error)}</td></tr>`;
      return `<tr><td>${nameOf(id)}</td><td class="num">${R.items.length} / ${run.rows.length}</td><td class="num">${fmtMs(median(R.items.filter((i) => i.latency != null).map((i) => i.latency)))}</td><td class="num">${R.items.filter((i) => i.error).length}</td></tr>`; }).join('')}
  </tbody></table></div><p class="help">为每个示例添加标准答案（Tab 后）即可查看准确率、校准与安全阈值。</p>`;
}

function detail(id) {
  const items = run.results[id].items;
  const m = metrics(items, run.rows);
  if (!m) return '';
  const T = run.running ? null : fitTemperature(items, run.rows);
  const mT = T ? metrics(items, run.rows, T) : null;
  const safe = run.running ? undefined : safeThreshold(items, run.rows);
  const small = m.n < 50 ? ` 仅 ${m.n} 个示例，结果较粗略；建议 ≥100 个更可靠。` : '';
  let tempRow = '';
  if (T) {
    tempRow = mT.ece >= m.ece - 0.005
      ? `<div class="grow stack"><span class="k"><b style="font-weight:600">调整温度无益</b></span><span class="v small">最佳拟合（${T.toFixed(2)}）无法将校准误差 ${m.ece.toFixed(3)} 再降低，请保留模型原始概率。${small}</span></div>`
      : `<div class="grow rec"><span class="k" style="display:grid;gap:2px"><b style="font-weight:600">校准温度 ${T.toFixed(2)}</b><span class="small muted">将校准误差从 ${m.ece.toFixed(3)} 降至 ${mT.ece.toFixed(3)}，且不改变任何答案；此处模型${T > 1 ? '过度自信' : '不够自信'}。${small}</span></span><span class="v"><button class="btn sm" data-use-t="${T.toFixed(2)}">在试验台中使用</button></span></div>`;
  }
  let thRow = '';
  if (safe !== undefined) {
    thRow = safe?.unsure
      ? `<div class="grow stack"><span class="k" style="color:var(--orange-text)"><b style="font-weight:600">置信不足，无法自动执行</b></span><span class="v small">不足 3 个示例达到最低阈值 ${fmtPct(ACT_MIN)}，暂无法自动化。请转人工、澄清选项，或换用其他模型。</span></div>`
      : safe
      ? `<div class="grow rec"><span class="k" style="display:grid;gap:2px"><b style="font-weight:600">自动执行阈值 ${fmtPct(safe.t, 1)}</b><span class="small muted">在误差低于 ${fmtPct(budget)} 的前提下，自动处理 ${fmtPct(safe.share)} 的示例（准确率 ${fmtPct(safe.acc)}），其余转人工。</span></span><span class="v"><button class="btn sm" data-use-th="${safe.t.toFixed(3)}">使用此阈值</button></span></div>`
      : `<div class="grow stack"><span class="k" style="color:var(--orange-text)"><b style="font-weight:600">无安全阈值</b></span><span class="v small">即便最高置信答案，错误率仍高于 ${fmtPct(budget)}。请转人工或换用其他模型。</span></div>`;
  }
  return `<div style="display:grid;gap:10px">
    <div style="display:flex;align-items:baseline;gap:8px"><h3 style="font-size:15px">${nameOf(id)}</h3><span class="small muted">在上方表格中选择其他模型进行对比。</span></div>
    <div class="chart-row" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
      <div class="chart-card"><h3>概率是否可信？</h3><span class="sub">自称的把握程度与实际正确率。点落在虚线上为诚实；低于虚线表示过度自信。</span>${reliability(m)}</div>
      <div class="chart-card"><h3>各自动执行阈值的效果</h3><span class="sub">自动处理占比（浅紫）与自动处理时的正确率（深紫）。橙线为误差预算。</span>${thresholdChart(items, safe)}</div>
    </div>
    ${tempRow || thRow ? `<div class="group">${thRow}${tempRow}</div>` : ''}
  </div>`;
}

function reliability(m) {
  const W = 360, H = 220, L = 38, B = 26, T = 10, R = 12;
  const x = (v) => L + v * (W - L - R), y = (v) => T + (1 - v) * (H - T - B);
  const pts = m.bins.filter((b) => b.n);
  const maxN = Math.max(...pts.map((b) => b.n));
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return `<figure class="reliability" style="margin:0"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="可靠性图：置信度与准确率">
    ${ticks.map((t) => `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${t * 100}%</text><text x="${x(t)}" y="${H - 8}" text-anchor="middle">${t * 100}%</text>`).join('')}
    <line class="diag" x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}"/>
    ${pts.length > 1 ? `<polyline class="curve" points="${pts.map((b) => `${x(b.conf)},${y(b.acc)}`).join(' ')}"/>` : ''}
    ${pts.map((b) => { const r = 3.5 + 3.5 * Math.sqrt(b.n / maxN); const tip = `自称 ${fmtPct(b.lo)}–${fmtPct(b.lo + 0.1)} 把握：${b.n} 个示例，正确率 ${fmtPct(b.acc)}`;
      return `<circle class="pt" cx="${x(b.conf)}" cy="${y(b.acc)}" r="${r.toFixed(1)}"/><circle class="hit" cx="${x(b.conf)}" cy="${y(b.acc)}" r="12" data-tip="${esc(tip)}"/>`; }).join('')}
  </svg></figure>`;
}

function thresholdChart(items, safe) {
  const W = 360, H = 220, L = 38, B = 26, T = 10, R = 12;
  const xs = Array.from({ length: 50 }, (_, i) => 0.5 + i * 0.01);
  const x = (v) => L + ((v - 0.5) / 0.49) * (W - L - R), y = (v) => T + (1 - v) * (H - T - B);
  const pts = xs.map((t) => [t, coverage(items, run.rows, t)]);
  const cov = pts.map(([t, c]) => `${x(t).toFixed(1)},${y(c.share).toFixed(1)}`).join(' ');
  const acc = pts.filter(([, c]) => c.acc != null).map(([t, c]) => `${x(t).toFixed(1)},${y(c.acc).toFixed(1)}`).join(' ');
  return `<figure class="reliability" style="margin:0"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="按自动执行阈值的自动化占比与准确率">
    ${[0, 0.25, 0.5, 0.75, 1].map((t) => `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${t * 100}%</text>`).join('')}
    ${[0.5, 0.6, 0.7, 0.8, 0.9, 0.99].map((t) => `<text x="${x(t)}" y="${H - 8}" text-anchor="middle">${Math.round(t * 100)}%</text>`).join('')}
    <line class="budget" x1="${L}" x2="${W - R}" y1="${y(1 - budget)}" y2="${y(1 - budget)}"/>
    ${safe && safe.t >= 0.5 ? `<line class="pick" x1="${x(safe.t)}" x2="${x(safe.t)}" y1="${T}" y2="${H - B}"/>` : ''}
    <polyline class="cov" points="${cov}"/><polyline class="acc" points="${acc}"/>
  </svg></figure>`;
}

function examplesTable(ids, labeled) {
  const label = (i) => i == null ? '' : run.question.type === 'noul' ? (i ? 'yes' : 'no') : run.question.type === 'score' ? run.question.criteria[i] : run.keys[i];
  const rows = run.rows.map((r, i) => ({ r, i })).filter(({ r, i }) => {
    if (show === 'all' || !labeled) return true;
    const outs = ids.map((id) => run.results[id].items?.[i]).filter((x) => x && !x.error);
    if (show === 'wrong') return outs.some((o) => o.pred !== r.gold);
    return outs.some((o) => o.pred !== r.gold && o.top >= 0.9);
  });
  return `<div class="card" style="overflow:hidden">
    <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line-2);flex-wrap:wrap"><h3 style="font-size:13.5px">全部示例</h3>
      ${labeled ? `<span class="seg" role="group" style="margin-left:auto">${[['all', '全部'], ['wrong', '错误'], ['confident', '高置信错误']].map(([k, l]) => `<button data-show="${k}" aria-pressed="${show === k}">${l}</button>`).join('')}</span>` : ''}</div>
    <div class="tscroll"><table class="table ex-table"><thead><tr><th class="num">#</th><th>示例</th>${labeled ? '<th>标准答案</th>' : ''}${ids.map((id) => `<th>${nameOf(id)}</th>`).join('')}</tr></thead><tbody>
    ${rows.slice(0, 400).map(({ r, i }) => `<tr><td class="num muted">${i + 1}</td><td><span class="txt" title="${esc(r.text)}">${esc(r.text)}</span></td>
      ${labeled ? `<td>${esc(label(r.gold))}</td>` : ''}
      ${ids.map((id) => { const o = run.results[id].items?.[i]; if (!o) return '<td class="muted">...</td>'; if (o.error) return `<td class="tag-bad" title="${esc(o.error)}">错误</td>`;
        const mark = r.gold == null ? '' : o.pred === r.gold ? `<span class="tag-ok" aria-label="正确">${icon('check')}</span>` : `<span class="tag-bad" aria-label="错误">${icon('x')}</span>`;
        return `<td style="white-space:nowrap">${mark} ${esc(label(o.pred))} <span class="muted num">${fmtPct(o.top)}</span></td>`; }).join('')}</tr>`).join('')}
    </tbody></table></div>${rows.length > 400 ? `<p class="help" style="padding:10px 14px">显示 400 / ${rows.length} 条。导出 CSV 可获取全部。</p>` : ''}</div>`;
}

function exportCsv() {
  const ids = Object.keys(run.results).filter((id) => run.results[id].items);
  const label = (i) => i == null ? '' : run.question.type === 'noul' ? (i ? 'yes' : 'no') : run.question.type === 'score' ? run.question.criteria[i] : run.keys[i];
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const head = ['text', 'correct', ...ids.flatMap((id) => [`${id}_answer`, `${id}_probability`])];
  const lines = run.rows.map((r, i) => [q(r.text), q(label(r.gold)), ...ids.flatMap((id) => { const o = run.results[id].items[i]; return o && !o.error ? [q(label(o.pred)), o.top.toFixed(4)] : ['', '']; })].join(','));
  const blob = new Blob([`${head.join(',')}\n${lines.join('\n')}\n`], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'bud-decision-results.csv' });
  // Kept for a minute: the desktop app reads the file after asking where to save it, not during the click.
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
