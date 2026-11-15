// Talks to the studio server and keeps one shared, regularly refreshed picture of its state.

import { toast } from './util.js';

const listeners = new Set();
// The act threshold the app offers everywhere: the Playground's slider, Evaluate's chart and its recommendation.
export const ACT_MIN = 0.5, ACT_MAX = 0.99;
const clampAct = (v) => (Number.isFinite(+v) ? Math.min(ACT_MAX, Math.max(ACT_MIN, +v)) : 0.9);
// (declared before `store`: loadPrefs() runs on the next line and reads them)
export const store = { state: null, error: null, prefs: loadPrefs() };

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) { try { fn(store.state); } catch (e) { console.error(e); } } }

export async function api(path, { method = 'GET', body, raw = false, form, headers = {} } = {}) {
  const opts = { method, headers: { 'x-basal-client': 'ui', ...headers } };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  const r = await fetch(path, opts);
  if (raw) return r;
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text }; }
  if (!r.ok) {
    const err = new Error(errorText(data));
    err.status = r.status; err.data = data; throw err;
  }
  return data;
}

// Turns any of the published error shapes into one readable sentence.
export function errorText(data) {
  const d = data?.detail ?? data?.error ?? data;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return d.map((e) => `${(e.loc || []).filter((p) => p !== 'body').join('.')}: ${e.msg}`).join('; ');
  if (d?.message) return d.message;
  return JSON.stringify(d);
}

// The studio API (/v1/studio): templates, history, feedback, examples, settings.
export const studio = (path, opts) => api(`/v1/studio${path}`, opts);

// One decision through the studio API, recorded in History. `surface` says where it came from (playground, eval,
// order_test); eval and order-test runs are kept out of the default History list. The response is the full decision
// object; latency_ms and wall_ms are added for the figures and the run stamp.
export async function decide(request, { surface = 'playground' } = {}) {
  const t = performance.now();
  const r = await api('/v1/studio/decisions', { method: 'POST', body: request, raw: true, headers: { 'x-basal-surface': surface } });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { detail: text }; }
  const meta = { status: r.status, requestId: r.headers.get('x-request-id') || r.headers.get('x-typesafe-request-id'),
    decisionId: r.headers.get('x-basal-decision-id'), stored: r.headers.get('x-basal-stored'), roundtrip: performance.now() - t };
  if (!r.ok) { const e = new Error(errorText(data)); e.status = r.status; e.data = data; e.meta = meta; throw e; }
  data.latency_ms = data.timing?.model_ms; data.wall_ms = data.timing?.total_ms;
  return { data, meta };
}

let failures = 0;
export async function refresh() {
  try {
    store.state = await api('/api/state');
    store.error = null; failures = 0;
  } catch {
    failures++;
    store.error = failures > 2 ? '与工作室服务器失去连接，请确认服务仍在运行。' : null;
  }
  emit();
}
export function startPolling() {
  const tick = async () => { await refresh(); setTimeout(tick, document.hidden ? 5000 : 1200); };
  tick();
}

export const model = (id) => store.state?.models.find((m) => m.id === id);
export const loadedModels = () => (store.state?.models || []).filter((m) => m.worker);
export const readyModels = () => (store.state?.models || []).filter((m) => m.worker?.status === 'ready');

// Lifecycle phase of a model, used by every phase track: 0 not downloaded, 1 on disk, 2 loading, 3 ready.
export function phaseOf(m) {
  if (!m) return { n: 0, word: '未知' };
  if (m.worker?.status === 'ready') return { n: 3, word: '就绪' };
  if (m.worker?.status === 'error') return { n: 2, word: '加载失败', error: true };
  if (m.worker) return { n: 2, word: m.worker.stage || '加载中', busy: true };
  if (m.downloaded) return { n: 1, word: '已下载' };
  const dl = store.state?.downloads;
  if (dl?.active?.model_id === m.id) return { n: 0, word: '下载中', busy: true };
  if (dl?.queue?.includes(m.id)) return { n: 0, word: '排队中' };
  return { n: 0, word: '未下载' };
}
export function phaseTrack(m) {
  const p = phaseOf(m);
  const seg = (i) => `<i class="${i < p.n ? 'on' : i === p.n ? 'now' : ''}"></i>`;
  return `<span class="phase ${p.busy ? 'busy' : ''} ${p.error ? 'error' : ''}" role="img" aria-label="${p.word}">${[0, 1, 2, 3].map(seg).join('')}</span>`;
}
export function downloadPct(m) {
  const d = m?.download;
  if (!d?.total) return 0;
  return Math.min(100, Math.round(((d.have + d.partial) / d.total) * 100));
}

// ------------------------------------------------------------------ actions used by several pages
export async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); await refresh(); return r; }
  catch (e) { toast(e.message, 'error'); await refresh(); throw e; }
}
export const download = (id) => act(() => api(`/api/models/${id}/download`, { method: 'POST' }), '已加入下载队列');
export const cancelDownload = (id) => act(() => api(`/api/models/${id}/download/cancel`, { method: 'POST' }), '已取消下载');
export const loadModel = (id, options = {}) => act(() => api(`/api/models/${id}/load`, { method: 'POST', body: { options } }));
export const ejectModel = (id) => act(() => api(`/api/models/${id}/eject`, { method: 'POST' }), '已卸载，内存已释放。');

// Waits until a model is loaded and ready, loading it first if needed. onTick(model) reports progress.
export async function ensureReady(id, onTick) {
  let m = model(id);
  if (!m) throw new Error('请先选择模型。若列表为空，请在模型页下载一个。');
  if (m.worker?.status === 'ready') return m;
  if (!m.downloaded && !m.worker) throw new Error(`${m.name} 尚未下载，请在模型页下载。`);
  if (!m.worker || m.worker.status === 'error') await loadModel(id);
  const t0 = Date.now();
  for (;;) {
    await refresh();
    m = model(id);
    if (m.worker?.status === 'ready') return m;
    if (!m.worker || m.worker.status === 'error') throw new Error(`${m.name} 加载失败：${m.worker?.error || '未知错误'}`);
    onTick?.(m);
    if (Date.now() - t0 > 15 * 60 * 1000) throw new Error('加载时间过长，请在系统页查看模型日志。');
    await new Promise((r) => setTimeout(r, 600));
  }
}

// ------------------------------------------------------------------ preferences (this browser only)
function loadPrefs() {
  const d = { threshold: 0.9, theme: 'light', lastModel: null, learned: {} };
  try {
    const p = { ...d, ...JSON.parse(localStorage.getItem('basal.prefs') || '{}') };
    p.threshold = clampAct(p.threshold);     // a value saved outside the range (an old Evaluate suggestion) is brought in
    return p;
  } catch { return d; }
}
export function setPref(k, v) {
  if (k === 'threshold') v = clampAct(v);
  store.prefs[k] = v;
  try { localStorage.setItem('basal.prefs', JSON.stringify(store.prefs)); } catch { /* storage blocked */ }
}
export function markLearned(step) { setPref('learned', { ...store.prefs.learned, [step]: true }); }

// Registry facts (logos, benchmarks, Jev comparisons) ship as a static file next to the UI.
let registryP;
export const registry = () => (registryP ??= fetch('/ui/registry.json').then((r) => r.json()).catch(() => ({ models: {}, makers: {}, jev: {} })));
