// Train: teach a model your own decisions. Made for people who know nothing about training or data:
//   1. drop a file of examples (or try the example file),
//   2. check in plain words what it will learn (the question, the answers, the recommended model, the time),
//   3. start, watch it practise, and see whether it got better on examples it never saw.
// Everything technical (splits, LoRA, replay, calibration, the release gate) happens in basal/training and is only
// ever described by its effect.

import { api, store } from '../store.js';
import { loadDecision } from './playground.js';
import { fromQuestion } from '../builder.js';
import { setSub } from '../shell.js';
import { $, $$, confirmDialog, esc, fmtDuration, icon, popMenu, toast } from '../util.js';

let root, timer, params = {};
let caps = null;           // /api/training/capabilities
let ds = null;             // the dataset being reviewed
let chosen = null;         // model id picked on the review screen

export function mount(el, p = {}) {
  root = el;
  params = p;
  clearInterval(timer);
  setSub('教会模型你自己的决策');
  if (p.id) return jobView(p.id);
  if (p.data) return reviewView(p.data);
  homeView();
}

export function unmount() { clearInterval(timer); }
export function onState() {}

const pct = (x) => (x == null ? '' : `${Math.round(x * 100)}%`);
const shell = (inner) => `<div class="view scroll"><div class="pad train">${inner}</div></div>`;

// ------------------------------------------------------------------ 1. start

async function homeView() {
  root.innerHTML = shell('<p class="faint">加载中…</p>');
  const [c, ft, jb] = await Promise.all([
    api('/api/training/capabilities').catch((e) => ({ enabled: false, reason: e.message, models: [] })),
    api('/api/finetunes').catch(() => ({ finetunes: [] })),
    api('/api/training/jobs').catch(() => ({ jobs: [] })),
  ]);
  caps = c;
  const running = jb.jobs.find((j) => ['running', 'queued', 'waiting'].includes(j.state));
  root.innerHTML = shell(`
    <div class="page-title"><div><h1>教会模型你自己的决策</h1>
      <p>用正确答案的示例教它。在大部分示例上练习，再在它从未见过的示例上验证是否变好，
      同时不忘记原有能力。</p></div></div>
    ${running ? `<a class="note violet train-live" href="#/train/${esc(running.id)}">${icon(running.state === 'waiting' ? 'hourglass-medium' : 'pulse')}<span><b>${esc(running.name)}</b> ${running.state === 'waiting' ? '等前一次训练结束后开始' : `正在学习：${esc(running.text || '启动中')}`}。打开</span></a>` : ''}
    ${!c.enabled ? unavailable(c) : ''}
    ${(c.enabled || c.experimental) ? dropPanel() : ''}
    <ol class="train-how">
      <li>${icon('file-arrow-up')}<div><b>提供示例</b><span>表格中一列是文本、一列是正确答案。几百行最理想。</span></div></li>
      <li>${icon('sparkle')}<div><b>练习学习</b><span>在大部分示例上学习，同时巩固已有知识。</span></div></li>
      <li>${icon('seal-check')}<div><b>自我验证</b><span>在从未见过的示例上测试。只有表现更好才会保留新模型。</span></div></li>
    </ol>
    ${finetuneList(ft.finetunes)}
    ${jobList(jb.jobs)}`);
  wireDrop();
  $('#allow-exp', root)?.addEventListener('click', allowExperimental);
  $('#ft-import', root)?.addEventListener('click', () => $('#ft-file', root).click());
  $('#ft-file', root)?.addEventListener('change', (e) => e.target.files[0] && importFinetune(e.target.files[0]));
  $$('[data-use]', root).forEach((b) => b.addEventListener('click', () => {
    const f = ft.finetunes.find((x) => x.id === b.dataset.use);
    useIt(b.dataset.use, { showcase: f?.example ? { request: f.example } : null });
  }));
  $$('[data-del-ft]', root).forEach((b) => b.addEventListener('click', () => deleteFinetune(b.dataset.delFt, b.dataset.name)));
}

function dropPanel() {
  return `<section class="create-dec train-drop" id="drop">
    <div class="dropzone train-dz" tabindex="0" role="button" aria-label="选择示例文件">
      <span class="dz-icon">${icon('upload-simple')}</span>
      <div><b>将示例文件拖放到此处</b>
      <span>CSV 表格最合适。JSON Lines 和制表符分隔文本也可。</span></div>
    </div>
    <div class="train-drop-actions">
      <button class="btn btn-primary" id="choose">${icon('file-arrow-up')}选择文件</button>
      <button class="btn btn-plain" id="sample">用示例文件试用</button>
      <details class="train-format"><summary>文件应是什么格式？</summary>
        <table class="table small"><thead><tr><th>ticket</th><th>team</th><th>urgent</th></tr></thead><tbody>
        <tr><td>My laptop screen cracked this morning.</td><td>devices</td><td>no</td></tr>
        <tr><td>The whole team can't sign in to Keystone.</td><td>identity</td><td>yes</td></tr></tbody></table>
        <p class="small muted">每行一个示例。文本最多的列供模型阅读；其余列是它要学习的答案。是/否列会变成是/否问题。</p></details>
    </div>
    <input type="file" id="file" accept=".csv,.tsv,.txt,.jsonl,.json" hidden>
  </section>`;
}

function reasonZh(c) {
  const r = String(c.reason || '');
  if (/M1|less than 16 GB/i.test(r)) return '在这台 Mac 上训练属于实验性功能（例如 M1，或统一内存不足约 16 GB）。';
  if (/experimental mode|is experimental/i.test(r)) return '在此 GPU 上训练属于实验性功能，稳定性与速度可能不如推荐硬件。';
  if (/Training needs a GPU|runs models on the processor/i.test(r)) return '训练需要 GPU。本机目前只能在 CPU 上跑推理。';
  if (/macOS 14/i.test(r)) return '在 Mac 上训练需要 macOS 14 或更高版本。';
  if (/too old to train/i.test(r)) return '这张显卡过旧，无法训练这些模型（需 2020 年及以后的 NVIDIA GPU）。';
  return r || '训练需要 GPU。';
}

function unavailable(c) {
  const exp = !!c.experimental;
  return `<section class="note ${exp ? 'amber' : ''} train-off">${icon(exp ? 'warning' : 'info')}
    <div><b>${exp ? '需先开启实验性训练' : '本机无法训练'}</b>
    <p>${esc(reasonZh(c))}</p>
    ${exp ? `<p>开启后下方即可上传示例文件。可能较慢；若训练出错会停止且不会保存任何内容。</p>
      <button class="btn btn-primary" id="allow-exp">${icon('sparkle')}开启并允许在此 GPU 上训练</button>`
      : '<p>所有模型仍可在此运行；只有教授新决策需要 GPU。</p>'}</div></section>`;
}

// A fine-tune exported from another studio (Export on its row): the adapter and its record, a few to a few hundred MB.
// The model it was trained from downloads like any other model.
async function importFinetune(file) {
  const btn = $('#ft-import', root);
  btn.disabled = true;
  btn.innerHTML = `${icon('circle-notch')}正在导入`;
  try {
    const form = new FormData();
    form.append('file', file);
    const man = await api('/api/finetunes/import', { method: 'POST', form });
    toast(`${man.name || '该模型'} 已可使用。`);
    homeView();
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false;
    btn.innerHTML = `${icon('file-arrow-up')}导入已训练模型`;
  }
}

async function allowExperimental() {
  try {
    await api('/api/settings', { method: 'POST', body: { experimental_training: true } });
    toast('实验性训练已开启。可在系统页面关闭。');
    homeView();
  } catch (e) { toast(e.message, 'error'); }
}

function wireDrop() {
  const dz = $('.train-dz', root);
  if (!dz) return;
  const input = $('#file', root);
  const pick = () => input.click();
  dz.addEventListener('click', pick);
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  $('#choose', root).addEventListener('click', pick);
  input.addEventListener('change', () => input.files[0] && upload(input.files[0]));
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => e.dataTransfer.files[0] && upload(e.dataTransfer.files[0]));
  $('#sample', root).addEventListener('click', async () => {
    const r = await fetch('/ui/samples/support-tickets.csv');
    upload(new File([await r.blob()], 'support-tickets.csv', { type: 'text/csv' }));
  });
}

async function upload(file) {
  const dz = $('.train-dz', root);
  dz?.classList.add('busy');
  if (dz) dz.querySelector('b').textContent = `正在读取 ${file.name}…`;
  const form = new FormData();
  form.append('file', file);
  try {
    const meta = await api('/api/training/datasets', { method: 'POST', form });
    location.hash = `#/train?data=${meta.id}`;
  } catch (e) {
    toast(e.message, 'error');
    homeView();
  }
}

function finetuneList(list) {
  const importer = `<button class="btn btn-quiet sm" id="ft-import">${icon('file-arrow-up')}导入已训练模型</button>
    <input type="file" id="ft-file" accept=".zip" hidden>`;
  if (!list.length) return `<section class="train-sec train-import-only">${importer}</section>`;
  return `<section class="train-sec"><div class="train-sec-head"><h2>你已训练的模型</h2>${importer}</div><div class="card train-list">
    ${list.map((f) => `<div class="train-row">
      <span class="train-row-main"><b>${esc(f.name)}</b><span class="muted small">基座 ${esc(baseName(f.base_model))}，${esc(dateOf(f.created))}</span></span>
      ${f.accuracy_before != null ? `<span class="train-delta" title="在训练时未见的示例上">${pct(f.accuracy_before)} ${icon('arrow-right')} <b>${pct(f.accuracy_after)}</b></span>` : ''}
      <span class="train-row-acts"><button class="btn btn-quiet sm" data-use="${esc(f.id)}" data-ft="1">使用</button>
      <a class="icon-btn" href="/api/finetunes/${encodeURIComponent(f.id)}/export" download title="导出，以便在其他电脑上使用" aria-label="导出 ${esc(f.name)}">${icon('download-simple')}</a>
      <button class="icon-btn" data-del-ft="${esc(f.id)}" data-name="${esc(f.name)}" aria-label="删除 ${esc(f.name)}">${icon('trash')}</button></span>
    </div>`).join('')}</div></section>`;
}

function jobList(jobs) {
  if (!jobs.length) return '';
  const chip = (j) => ({ done: j.result?.accepted ? '<span class="chip ok">已改进</span>' : '<span class="chip">保留原版</span>',
    running: '<span class="chip violet">学习中</span>', queued: '<span class="chip violet">启动中</span>', waiting: '<span class="chip">等待中</span>',
    paused: '<span class="chip orange">已暂停</span>', failed: '<span class="chip danger">已停止</span>', cancelled: '<span class="chip">已取消</span>' }[j.state] || '');
  return `<section class="train-sec"><h2>最近训练</h2><div class="card train-list">
    ${jobs.slice(0, 8).map((j) => `<a class="train-row" href="#/train/${esc(j.id)}">
      <span class="train-row-main"><b>${esc(j.name || j.model_id)}</b><span class="muted small">${esc(j.result?.message || j.message || j.text || '')}</span></span>
      ${chip(j)}${icon('caret-right')}</a>`).join('')}</div></section>`;
}

async function deleteFinetune(id, name) {
  const ok = await confirmDialog({ title: `删除 ${name}？`, body: '其训练的基座模型不受影响。此操作无法撤销。', confirm: '删除', danger: true });
  if (!ok) return;
  try { await api(`/api/finetunes/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast('已删除'); homeView(); } catch (e) { toast(e.message, 'error'); }
}

// ------------------------------------------------------------------ 2. review

async function reviewView(id) {
  root.innerHTML = shell('<p class="faint">正在读取你的示例…</p>');
  try { ds = await api(`/api/training/datasets/${encodeURIComponent(id)}`); } catch (e) { toast(e.message, 'error'); location.hash = '#/train'; return; }
  chosen = ds.recommended?.id || null;
  renderReview();
}

function renderReview() {
  const rep = ds.report;
  const errors = rep.problems.filter((p) => p.level === 'error');
  const warns = rep.problems.filter((p) => p.level !== 'error');
  const model = ds.models.find((m) => m.id === chosen);
  const qs = Object.entries(rep.questions);
  root.innerHTML = shell(`
    <div class="page-title"><div>${errors.length || !rep.usable
      ? `<h1>此文件需要一些修改</h1><p>${esc(ds.filename)} 尚不能用于训练。请按下方说明修改后重新选择。</p>`
      : `<h1>它将学习的内容</h1><p>来自 ${esc(ds.filename)} 的 ${rep.examples.toLocaleString()} 条示例。请确认每个问题的表述符合你的习惯。</p>`}</div>
      <div class="actions"><a class="btn btn-quiet" href="#/train">${icon('arrow-left')}选择其他文件</a></div></div>
    <div class="train-review">
      <div class="train-qs">${qs.map(([qid, q], i) => questionCard(qid, q, i)).join('')}
        ${errors.map((p) => `<div class="note danger">${icon('warning-circle')}<span>${esc(p.message)}</span></div>`).join('')}
        ${warns.map((p) => `<div class="note amber">${icon('warning')}<span>${esc(p.message)}</span></div>`).join('')}</div>
      <aside class="card card-pad train-side">
        <div class="label">要训练的模型</div>
        ${model ? `<div class="train-model"><b>${esc(model.name)}</b>${model.id === ds.recommended?.id ? '<span class="chip violet">推荐</span>' : ''}
          <span class="muted small">${esc(model.tagline || '')}</span></div>`
          : `<div class="note amber">${icon('warning')}<span>${esc(noModelReason())}</span></div>`}
        <button class="btn btn-quiet sm" id="change">${icon('swap')}更换模型</button>
        ${model?.eta_minutes && rep.usable && !errors.length ? `<p class="small muted">在本机上约需 ${model.eta_minutes} 分钟。学习期间可继续使用工作室。</p>` : ''}
        <label class="label" for="ftname">新模型名称</label>
        <input class="input" id="ftname" value="${esc(model ? `${model.name} · ${prettyFile(ds.filename)}` : '')}">
        <button class="btn btn-primary train-go" id="go" ${!model || errors.length || !rep.usable ? 'disabled' : ''}>${icon('sparkle')}开始训练</button>
        <p class="small muted">会留出部分示例用于自测，你能如实看到是否变好。</p>
      </aside>
    </div>`);
  $$('[data-q]', root).forEach((inp) => inp.addEventListener('change', () => saveQuestion(inp.dataset.q, inp.value)));
  $('#change', root).addEventListener('click', (e) => chooseModel(e.currentTarget));
  $('#go', root).addEventListener('click', start);
}

function questionCard(qid, q, i) {
  const counts = Object.entries(q.counts || {}).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...counts.map(([, n]) => n));
  const kind = q.type === 'noul' ? '是或否' : q.type === 'score' ? `${q.options.length} 级量表` : q.type === 'multi' ? `多选（${q.options.length}）` : `单选（${q.options.length}）`;
  const shown = counts.slice(0, 8);
  return `<section class="card card-pad train-q">
    <div class="train-q-head"><span class="muted small">问题 ${i + 1}</span><span class="chip">${kind}</span><span class="muted small train-q-n">已标注 ${q.labelled.toLocaleString()}</span></div>
    <input class="input train-q-text" data-q="${esc(qid)}" value="${esc(q.instructions || '')}" aria-label="问题 ${i + 1}">
    <div class="hplot train-counts">${shown.map(([name, n]) => `<div class="row row-2"><span class="lab" title="${esc(name)}">${esc(name)}</span>
      <span class="track"><span class="bar" style="transform:scaleX(${(n / max).toFixed(3)})"></span></span><span class="val">${n}</span></div>`).join('')}</div>
    ${counts.length > shown.length ? `<p class="small muted">另有 ${counts.length - shown.length} 个答案</p>` : ''}
  </section>`;
}

async function saveQuestion(qid, text) {
  try {
    ds = await api(`/api/training/datasets/${ds.id}/questions`, { method: 'POST', body: { questions: { [qid]: { instructions: text } } } });
    toast('问题已更新');
  } catch (e) { toast(e.message, 'error'); }
}

function noModelReason() {
  const r = ds.models.find((m) => m.reason)?.reason;
  return r ? `尚无已下载模型能在此学习此任务。${r}` : '本机没有能学习此任务的已下载模型。请在模型页面下载一个。';
}

function chooseModel(anchor) {
  const items = ds.models.map((m) => `<button class="menu-item train-mi" data-pick="${esc(m.id)}" ${m.trainable ? '' : 'disabled'}>
    <span><b>${esc(m.name)}</b> <span class="muted">${esc(m.params)}</span>${m.id === ds.recommended?.id ? ' <span class="chip violet sm">推荐</span>' : ''}
    <br><span class="small muted">${esc(m.trainable ? (m.eta_minutes ? `约 ${m.eta_minutes} 分钟` : m.tagline) : m.reason)}</span></span>
    ${m.id === chosen ? icon('check') : ''}</button>`).join('');
  popMenu(anchor, items, { onPick: (id) => { chosen = id; renderReview(); } });
}

async function start() {
  const btn = $('#go', root);
  btn.disabled = true;
  btn.innerHTML = `${icon('circle-notch')}正在启动`;
  try {
    // Experimental GPUs (e.g. M1) need an explicit allow before a job can start.
    if (caps && !caps.enabled && caps.experimental) {
      await api('/api/settings', { method: 'POST', body: { experimental_training: true } });
      caps = { ...caps, enabled: true };
    }
    const job = await api('/api/training/jobs', { method: 'POST', body: { dataset_id: ds.id, model_id: chosen, name: $('#ftname', root).value.trim() } });
    location.hash = `#/train/${job.id}`;
  } catch (e) {
    toast(/experimental/i.test(e.message) ? reasonZh({ reason: e.message }) : e.message, 'error');
    btn.disabled = false;
    btn.innerHTML = `${icon('sparkle')}开始训练`;
  }
}

// ------------------------------------------------------------------ 3. progress and result

async function jobView(id) {
  root.innerHTML = shell('<p class="faint">加载中…</p>');
  const tick = async () => {
    let j;
    try { j = await api(`/api/training/jobs/${encodeURIComponent(id)}`); } catch (e) { clearInterval(timer); root.innerHTML = shell(`<div class="note danger">${icon('warning-circle')}<span>${esc(e.message)}</span></div>`); return; }
    renderJob(j);
    if (!['running', 'queued', 'waiting'].includes(j.state)) clearInterval(timer);
  };
  await tick();
  clearInterval(timer);
  timer = setInterval(tick, 1500);
}

function renderJob(j) {
  const live = ['running', 'queued', 'waiting'].includes(j.state);
  const model = store.state?.models.find((m) => m.id === j.model_id);
  const name = esc(model?.name || j.model_id);
  const title = live ? `正在训练 ${name}` : j.result?.accepted ? `${name} 已改进` : j.state === 'done' ? `已完成训练 ${name}`
    : j.state === 'paused' ? `训练 ${name}（已暂停）` : `正在训练 ${name}`;
  const head = `<div class="page-title"><div><h1>${title}</h1>
    <p>${esc(j.name || '')}</p></div><div class="actions"><a class="btn btn-quiet" href="#/train">${icon('arrow-left')}全部训练</a></div></div>`;
  let body;
  if (live) body = progressCard(j);
  else if (j.state === 'done' && j.result?.accepted) body = resultCard(j, model);
  else if (j.state === 'done') body = keptCard(j, model);
  else if (j.state === 'paused') body = `<div class="note amber">${icon('pause')}<div><b>已暂停</b><p>${esc(j.message || '')}</p>
      <p class="small">已学内容会保留，可从当前进度继续。</p>
      <button class="btn btn-primary sm" data-act="resume">${icon('play')}继续</button> <button class="btn btn-quiet sm" data-act="delete">放弃</button></div></div>`;
  else if (j.state === 'cancelled') body = `<div class="note">${icon('x-circle')}<div><b>已取消</b><p>未做任何更改。</p>
      <a class="btn btn-quiet sm" href="#/train">重新开始</a></div></div>`;
  else body = `<div class="note danger">${icon('warning-circle')}<div><b>训练已停止</b><p>${esc(j.message || '出了点问题。')}</p>
      <p class="small">未做任何更改。任务文件夹中有日志可供查看。</p>
      <button class="btn btn-quiet sm" data-act="resume">重试</button></div></div>`;
  const html = shell(head + body);
  if (root.dataset.html === html) return;
  root.dataset.html = html;
  const scroll = $('.view', root)?.scrollTop || 0;
  root.innerHTML = html;
  $('.view', root).scrollTop = scroll;
  $$('[data-act]', root).forEach((b) => b.addEventListener('click', () => jobAction(j, b.dataset.act)));
  $('[data-use]', root)?.addEventListener('click', (e) => useIt(e.currentTarget.dataset.use, j.result));
  $('[data-compare]', root)?.addEventListener('click', () => compare(j));
  if (j.state === 'done' && !j.result?.accepted) offerAnother(j);
}

function progressCard(j) {
  const p = Math.max(0.02, Math.min(1, j.progress || 0));
  const eta = j.eta_seconds ? `约剩余 ${fmtDuration(j.eta_seconds)}` : '';
  const waiting = j.state === 'waiting' || j.state === 'queued';
  return `<section class="card card-pad train-progress">
    <div class="train-stage">${icon(waiting ? 'hourglass-medium' : 'sparkle')}<b>${esc(j.text || (waiting ? '等待开始' : '进行中'))}</b></div>
    <span class="progress train-bar"><i style="width:${(p * 100).toFixed(1)}%"></i></span>
    <div class="small muted train-meta"><span>${Math.round(p * 100)}%</span><span>${esc(eta)}</span></div>
    ${curve(j)}
    ${(j.notes || []).slice(-2).map((n) => `<p class="small muted">${esc(n)}</p>`).join('')}
    <div class="train-acts">${waiting ? '' : `<button class="btn btn-quiet sm" data-act="pause">${icon('pause')}暂停</button>`}
      <button class="btn btn-quiet sm" data-act="cancel">${icon('x')}取消</button>
      <span class="small muted">${waiting ? '其他训练结束后会自动开始。' : '可离开此页面，训练会在后台继续。'}</span></div>
  </section>`;
}

function curve(j) {
  const pts = j.curve || [];
  if (j.baseline_accuracy == null || pts.length < 1) return '';
  const all = [{ step: 0, accuracy: j.baseline_accuracy }, ...pts];
  const W = 520, H = 120, maxS = Math.max(1, j.total_steps || all[all.length - 1].step);
  const ys = all.map((p) => p.accuracy);
  const lo = Math.max(0, Math.min(...ys) - 0.1), hi = Math.min(1, Math.max(...ys) + 0.1);
  const x = (s) => 8 + (s / maxS) * (W - 16), y = (a) => H - 18 - ((a - lo) / Math.max(0.01, hi - lo)) * (H - 36);
  const path = all.map((p, i) => `${i ? 'L' : 'M'}${x(p.step).toFixed(1)},${y(p.accuracy).toFixed(1)}`).join(' ');
  const last = all[all.length - 1];
  return `<figure class="train-curve"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="练习得分从 ${pct(j.baseline_accuracy)} 到 ${pct(last.accuracy)}">
    <line x1="8" x2="${W - 8}" y1="${y(j.baseline_accuracy).toFixed(1)}" y2="${y(j.baseline_accuracy).toFixed(1)}" class="base"/>
    <path d="${path}" class="line"/><circle cx="${x(last.step).toFixed(1)}" cy="${y(last.accuracy).toFixed(1)}" r="3.5" class="dot"/>
    <text x="${W - 8}" y="${(y(j.baseline_accuracy) - 5).toFixed(1)}" text-anchor="end" class="lbl">训练前：${pct(j.baseline_accuracy)}</text></svg>
    <figcaption class="small muted">在未用于学习的示例上的练习得分：当前 ${pct(last.accuracy)}，开始前 ${pct(j.baseline_accuracy)}。</figcaption></figure>`;
}

function resultCard(j, model) {
  const r = j.result;
  const bars = [['训练前', r.accuracy_before, false], ['训练后', r.accuracy_after, true]];
  const guard = r.guard_before != null && r.guard_after != null
    ? (r.guard_after < r.guard_before - 0.005
      ? `<p>在原本擅长的通用决策上略低：${pct(r.guard_after)}（之前 ${pct(r.guard_before)}），相对你在示例上的收益是可接受的小代价。原版模型仍可处理其他任务。</p>`
      : `<p>在原本擅长的通用决策上得分 ${pct(r.guard_after)}（之前 ${pct(r.guard_before)}），未发生遗忘。</p>`) : '';
  return `<section class="card card-pad train-result">
    <div class="train-big"><span class="num">${pct(r.accuracy_after)}</span><span>在${r.test_questions ? `${r.test_questions} 个` : ''}从未见过的问题上答对，高于训练前的 ${pct(r.accuracy_before)}</span></div>
    <div class="hplot train-ba">${bars.map(([lab, v, win]) => `<div class="row ${win ? 'row-win' : ''}"><span class="lab">${lab}</span>
      <span class="track"><span class="bar" style="transform:scaleX(${(v || 0).toFixed(3)})"></span></span><span class="val">${pct(v)}</span></div>`).join('')}</div>
    ${guard}
    ${showcase(r.showcase)}
    <p class="small muted">从 ${(r.data?.train || 0).toLocaleString()} 个已标注问题学习，在 ${(r.data?.test || 0).toLocaleString()} 个未见问题上测试${r.seconds ? `，耗时 ${fmtDuration(r.seconds)}` : ''}。置信度已校准以匹配实际准确率。</p>
    <div class="train-acts">${r.finetune_id ? `<button class="btn btn-primary" data-use="${esc(r.finetune_id)}">${icon('play')}立即使用</button>` : ''}
      <button class="btn btn-quiet" data-compare>${icon('list-checks')}在评测页对比</button></div>
  </section>`;
}

// One held-out example the original model got wrong and the new one gets right: the improvement, made concrete.
function showcase(sc) {
  if (!sc || !sc.questions?.length) return '';
  const fixed = sc.fixed > 0;
  return `<figure class="train-case"><figcaption class="small muted">${fixed ? '过去会答错的一例' : '从未见过的一例'}</figcaption>
    <blockquote>${esc(sc.text)}</blockquote>
    <table class="table small"><thead><tr><th>问题</th><th>训练前</th><th>现在</th></tr></thead><tbody>
    ${sc.questions.map((q) => `<tr><td>${esc(q.question)}</td>
      <td>${q.before == null ? '' : `<span class="train-ans ${q.before === q.right ? 'ok' : 'bad'}">${icon(q.before === q.right ? 'check' : 'x')}${esc(q.before)}</span>`}</td>
      <td><span class="train-ans ok">${icon('check')}${esc(q.after)}</span></td></tr>`).join('')}</tbody></table></figure>`;
}

// Evaluate, prepared: the held-out examples (never trained on) and both models, the original and the new one.
function compare(j) {
  const ev = j.result?.evaluate;
  if (ev) {
    try {
      localStorage.setItem('bud.eval.v2', JSON.stringify({ question: fromQuestion(ev.question_id, ev.question), dataText: ev.text }));
      sessionStorage.setItem('bud.eval.select', JSON.stringify([j.model_id, j.result.finetune_id].filter(Boolean)));
    } catch { /* storage unavailable: Evaluate opens as it was */ }
  }
  location.hash = '#/evaluate';
}

async function useIt(id, r) {
  if (r?.showcase?.request) {
    try { await loadDecision({ input: r.showcase.request, model: id }); } catch { /* opens with the model only */ }
    location.hash = '#/playground';
    return;
  }
  location.hash = `#/playground?model=${encodeURIComponent(id)}`;
}

function keptCard(j, model) {
  const r = j.result || {};
  return `<section class="card card-pad train-result">
    <div class="note">${icon('info')}<div><b>${esc(model?.name || '该模型')} 未改动</b><p>${esc(r.message || '')}</p></div></div>
    <p class="small muted">没有损失：新版本未予保留。${r.outcome === 'not_improved' && r.accuracy_before < 0.85 ? '以下通常有帮助：' : ''}</p>
    ${r.outcome === 'not_improved' && r.accuracy_before < 0.85 ? `<ul class="small train-tips"><li>更多示例：每种答案几百条较理想。</li>
      <li>更易区分的答案，或更清晰的问题。</li>
      <li>换一个模型：某些任务更容易学习。</li></ul>` : ''}
    <div class="train-acts" id="alt-acts"><a class="btn btn-quiet" href="#/train">重新开始</a></div>
  </section>`;
}

// After a result that was not kept: offer the next model that can learn the same examples, in one click.
async function offerAnother(j) {
  const box = $('#alt-acts', root);
  if (!box || !j.dataset_id || box.dataset.done) return;
  box.dataset.done = '1';
  let ds2;
  try { ds2 = await api(`/api/training/datasets/${encodeURIComponent(j.dataset_id)}`); } catch { return; }
  const tried = new Set([j.model_id]);
  const alt = (ds2.models || []).find((m) => m.trainable && !tried.has(m.id));
  if (!alt || !$('#alt-acts', root)) return;
  const was = baseName(j.model_id);
  const name = (j.name || '').startsWith(was) ? alt.name + j.name.slice(was.length) : `${alt.name} for ${prettyFile(ds2.filename)}`;
  box.insertAdjacentHTML('afterbegin', `<button class="btn btn-primary" id="alt-go">${icon('sparkle')}改为训练 ${esc(alt.name)}</button>
    <span class="small muted">${alt.eta_minutes ? `约 ${alt.eta_minutes} 分钟。` : ''}相同示例；不同模型对不同任务的学习难度不同。</span>`);
  $('#alt-go', box).addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      const job = await api('/api/training/jobs', { method: 'POST', body: { dataset_id: j.dataset_id, model_id: alt.id, name } });
      location.hash = `#/train/${job.id}`;
    } catch (err) { toast(err.message, 'error'); e.currentTarget.disabled = false; }
  });
}

async function jobAction(j, act) {
  if (act === 'cancel' && !(await confirmDialog({ title: '停止训练？', body: '不会做任何更改。可稍后重新开始。', confirm: '停止', danger: true }))) return;
  try {
    await api(`/api/training/jobs/${encodeURIComponent(j.id)}/${act}`, { method: 'POST' });
    if (act === 'delete') { location.hash = '#/train'; return; }
    delete root.dataset.html;
    jobView(j.id);
  } catch (e) { toast(e.message, 'error'); }
}

// ------------------------------------------------------------------ helpers

function baseName(id) { return store.state?.models.find((m) => m.id === id)?.name || caps?.models?.find((m) => m.id === id)?.name || id; }
function dateOf(s) { try { return new Date(s).toLocaleDateString('zh-CN', { day: 'numeric', month: 'short' }); } catch { return ''; } }
function prettyFile(name) { return String(name || '你的示例').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' '); }
