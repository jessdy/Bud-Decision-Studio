// System: where models run (chosen during setup) and the folder they download to, memory, what each loaded model is
// using, and memory settings.

import { diskUse, showLogs } from './models.js';
import { api, ejectModel, phaseTrack, refresh, store } from '../store.js';
import { setSub } from '../shell.js';
import { $, $$, askText, confirmDialog, esc, fmtBytes, fmtGB, icon, term, toast } from '../util.js';

let root;

export function mount(el) {
  root = el;
  setSub('模型运行位置、内存与各模型占用');
  root.innerHTML = `<div class="view scroll"><div class="pad" style="display:grid;gap:16px">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><p class="muted" style="max-width:80ch" id="sysintro"></p>
      <button class="btn" id="ejectall" style="margin-left:auto">${icon('eject')}弹出全部模型</button></div>
    <div id="runson"></div>
    <div id="sys" style="display:grid;gap:16px"></div>
    <div id="sysset"></div>
  </div></div>`;
  $('#ejectall', root).addEventListener('click', async () => {
    try { await api('/api/eject-all', { method: 'POST' }); toast('已弹出全部模型，内存已释放。'); } catch (e) { toast(e.message, 'error'); }
  });
  update();
}

export function onState() { if (root?.isConnected) update(); }

function update() {
  const st = store.state;
  const box = $('#sys', root);
  if (!st) { box.innerHTML = '<p class="faint">正在连接工作室…</p>'; return; }
  const s = st.system;
  const loaded = st.models.filter((m) => m.worker);
  const modelGB = loaded.reduce((a, m) => a + (m.worker.gpu_gb || 0), 0);
  const other = Math.max(0, s.mem_used_gb - modelGB);
  const pct = (g) => `${Math.max(0, (g / s.mem_total_gb) * 100).toFixed(2)}%`;
  const rt = st.runtime || { device: 'cuda', device_name: s.gpu_name, available: [] };
  const dev = rt.available.find((d) => d.id === rt.device) || {};
  $('#sysintro', root).innerHTML = rt.device === 'cpu'
    ? `模型在处理器（${esc(rt.device_name)}）上运行，使用本机内存。小模型约一秒出答；大模型较慢。`
    : dev.unified_memory
      ? `模型在 ${esc(rt.device_name)} 上运行。GPU 与 CPU 共享${term('unified_memory', '统一内存')}池，已加载模型与其他程序共用。`
      : `模型在 ${esc(rt.device_name)} 上运行。`;
  renderRunsOn(rt, st);
  const detail = rt.device === 'cuda' ? `CUDA ${esc(s.cuda || 'unknown')}，驱动 ${esc(s.driver || 'unknown')}`
    : rt.device === 'mps' ? 'Apple GPU（Metal）' : rt.device === 'xpu' ? 'Intel GPU（oneAPI）' : `${s.cpu_count || ''} 核`;
  const html = `
    <section class="card card-pad" style="display:grid;gap:10px">
      <div class="stats">
        <div class="stat"><span>运行于</span><div class="big" style="font-size:${rt.device_name.length > 18 ? 16 : 20}px;letter-spacing:-.01em;font-variant-numeric:normal">${esc(rt.device_name)}</div><span>${detail}</span></div>
        ${rt.device !== 'cpu' && s.gpu_util != null ? `<div class="stat"><span>GPU 占用</span><div class="big">${Math.round(s.gpu_util)}%</div><span>模型回答时会跳变</span></div>` : `<div class="stat"><span>CPU 占用</span><div class="big">${s.cpu_percent != null ? Math.round(s.cpu_percent) : 'n/a'}%</div><span>模型回答时会跳变</span></div>`}
        ${rt.device !== 'cpu' && s.gpu_temp != null ? `<div class="stat"><span>温度与功耗</span><div class="big">${Math.round(s.gpu_temp)} °C</div><span>${s.gpu_power != null ? `${s.gpu_power.toFixed(1)} W` : ''}</span></div>` : ''}
        <div class="stat"><span>模型可用磁盘</span><div class="big">${fmtGB(s.disk_free_gb)}</div><span>共 ${fmtGB(s.disk_total_gb)}</span></div>
      </div>
    </section>
    <section class="card card-pad" style="display:grid;gap:10px">
      <h2 style="font-size:15px">内存</h2>
      <p class="muted small" style="margin-top:4px">已用 ${fmtGB(s.mem_used_gb)} / ${fmtGB(s.mem_total_gb)}。<b style="color:var(--text)">还可用 ${fmtGB(s.mem_available_gb)}</b> 加载更多模型。</p>
      <div class="memmap" role="img" aria-label="内存占用：模型 ${fmtGB(modelGB)}，其他程序 ${fmtGB(other)}">
        ${loaded.map((m) => { const g = m.worker.gpu_gb || 0; return `<div style="width:${pct(g)}" data-tip="${esc(m.name)}: ${fmtGB(g)}">${g / s.mem_total_gb > 0.07 ? esc(m.name) : ''}</div>`; }).join('')}
        <div class="other" style="width:${pct(other)}" data-tip="本机其他程序：${fmtGB(other)}">${other / s.mem_total_gb > 0.1 ? '其他程序' : ''}</div>
      </div>
      <div class="legend"><span><i style="background:var(--accent)"></i>已加载模型，${fmtGB(modelGB)}</span><span><i style="background:var(--text-3)}"></i>其他程序，${fmtGB(other)}</span><span><i style="background:var(--fill)"></i>空闲</span></div>
    </section>
    <section class="card" style="overflow:hidden">
      <div class="card-pad" style="padding-bottom:6px"><h2 style="font-size:15px">已加载模型</h2></div>
      ${loaded.length ? `<div style="overflow-x:auto"><table class="table"><thead><tr><th>模型</th><th>状态</th><th class="num">内存</th><th class="num">请求数</th><th class="num">加载耗时</th><th>进程</th><th></th></tr></thead><tbody>
        ${loaded.map((m) => `<tr><td><b>${esc(m.name)}</b></td><td><span style="display:inline-flex;gap:7px;align-items:center">${phaseTrack(m)}${m.worker.status === 'ready' ? (m.worker.warning ? `就绪 <span class="chip amber" data-tip="${esc(m.worker.warning)}">在处理器上</span>` : '就绪') : m.worker.status === 'error' ? '<span style="color:var(--red-text)">错误</span>' : esc(m.worker.stage || m.worker.status)}</span></td>
          <td class="num">${fmtGB(m.worker.gpu_gb || 0)}</td><td class="num">${m.worker.requests}</td><td class="num">${m.worker.load_seconds ? `${m.worker.load_seconds} s` : ''}</td>
          <td class="small faint">pid ${m.worker.pid}, ${Object.entries(m.worker.options || {}).map(([k, v]) => `${esc(k)} ${esc(String(v))}`).join(', ')}</td>
          <td style="white-space:nowrap"><button class="btn btn-quiet sm" data-logs="${m.id}">${icon('scroll')}日志</button><button class="btn sm" data-eject="${m.id}">${icon('eject')}弹出</button></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="plate-pad muted">未加载模型。请在模型页面加载，或在试验台中点击「决策」。</p>'}
    </section>`;
  if (box.dataset.html !== html) {
    box.dataset.html = html; box.innerHTML = html;
    $$('[data-eject]', box).forEach((b) => b.addEventListener('click', () => ejectModel(b.dataset.eject)));
    $$('[data-logs]', box).forEach((b) => b.addEventListener('click', () => showLogs(b.dataset.logs)));
  }
  renderSettings(st);
}

// "Where models run": the device chosen during setup, switchable among the ones PyTorch was installed for, and the
// folder models download to.
function renderRunsOn(rt, st) {
  const box = $('#runson', root);
  const md = rt.models_dir;
  const busy = !!st.downloads?.active;
  const key = JSON.stringify([rt.device, rt.available.map((d) => d.id), md, busy]);
  if (!box || box.dataset.key === key) return;
  box.dataset.key = key;
  const label = (d) => (d.id === 'cpu' ? '处理器 (CPU)' : `${d.name} (GPU)`);
  const desktop = !!window.__TAURI__;
  const when = rt.installed ? new Date(rt.installed).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  box.innerHTML = `<div class="group-title">模型运行位置</div><section class="group">
    <div class="grow"><span style="flex:1;min-width:0">运行模型于<span class="help" style="display:block">仅影响此后加载的模型；已加载模型仍在原设备运行。</span></span>
      <div class="seg" role="group" aria-label="运行模型于">${rt.available.map((d) => `<button data-dev="${d.id}" aria-pressed="${d.id === rt.device}">${icon(d.id === 'cpu' ? 'cpu' : 'lightning')}${esc(label(d))}</button>`).join('')}</div></div>
    <div class="grow"><span style="flex:1;min-width:0">已安装引擎<span class="help" style="display:block">${rt.torch ? `PyTorch ${esc(rt.torch)}${when ? `，设置于 ${esc(when)}` : ''}。` : '从源码构建。'} 要换处理器请重新运行安装，会安装对应引擎。</span></span>
      ${desktop ? `<button class="btn" id="resetup">${icon('arrows-clockwise')}重新运行安装</button>` : `<code class="small">./install.sh</code>`}</div>
    ${md ? modelsDirRow(md, busy) : ''}
  </section>`;
  $$('[data-dev]', box).forEach((b) => b.addEventListener('click', async () => {
    try {
      await api('/api/config', { method: 'POST', body: { device: b.dataset.dev } });
      $$('[data-dev]', box).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      toast(`新模型将在${b.dataset.dev === 'cpu' ? '处理器' : 'GPU'}上运行。`);
    } catch (e) { toast(e.message, 'error'); }
  }));
  $('#resetup', box)?.addEventListener('click', () => window.__TAURI__.core.invoke('rerun_setup').catch((e) => toast(String(e), 'error')));
  $('#mdpick', box)?.addEventListener('click', () => pickModelsDir(md));
  $('#mdreset', box)?.addEventListener('click', () => setModelsDir(null, md));
}

// "模型文件夹": where downloads go. The Hugging Face cache unless another folder (say, on an external disk) is chosen.
function modelsDirRow(md, busy) {
  const help = !md.available
    ? '<b style="color:var(--red-text)">不可用。</b> 请连接磁盘或另选文件夹。在此之前，其中的模型会显示为未下载。'
    : md.custom
      ? '新下载会保存到这里。下载到其他文件夹的模型需移到此处才会被使用。'
      : 'Hugging Face 缓存，与其他工具共用。可另选文件夹将模型放在其他磁盘。';
  const dis = busy ? 'disabled' : '';
  return `<div class="grow"><span style="flex:1;min-width:0">模型文件夹<span class="help" style="display:block"><code style="overflow-wrap:anywhere">${esc(md.path)}</code><br>${help}${busy ? ' 请等待当前下载完成后再更改。' : ''}</span></span>
    <span style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">${md.custom ? `<button class="btn btn-quiet" id="mdreset" ${dis}>${icon('arrow-counter-clockwise')}使用默认</button>` : ''}<button class="btn" id="mdpick" ${dis}>${icon('hard-drive')}更改…</button></span></div>`;
}

// The desktop app opens the system's folder picker; in a browser, type the path.
async function pickModelsDir(md) {
  let path;
  if (window.__TAURI__) {
    try { path = await window.__TAURI__.core.invoke('pick_folder', { start: md.available ? md.path : md.default }); }
    catch (e) { toast(String(e), 'error'); return; }
  } else {
    path = await askText({ title: '模型文件夹', label: '下载模型所用的完整路径，例如外置磁盘上的文件夹。', value: md.path, confirm: '使用此文件夹' });
  }
  if (path && path !== md.path) setModelsDir(path, md);
}

// path null: back to the Hugging Face cache. Models already downloaded stay where they are, so say so first.
async function setModelsDir(path, md) {
  const st = store.state;
  const here = st.models.filter((m) => m.downloaded && m.download?.have).length;
  if (here) {
    const [what, stay, its, folders, them] = here === 1 ? ['模型', '仍留在', '其', '文件夹', '它'] : [`${here} 个模型`, '仍留在', '其', '文件夹', '它们'];
    const ok = await confirmDialog({
      title: '将模型下载到此文件夹？',
      body: `<p>新下载将保存到 <code style="overflow-wrap:anywhere">${esc(path ?? md.default)}</code>。</p>
        <p style="margin-top:8px">已下载的${what}（${fmtBytes(diskUse(st.models))}）${stay} <code style="overflow-wrap:anywhere">${esc(md.path)}</code>。工作室只扫描新文件夹，请将${its} <code>models--</code> ${folders}移入以继续使用${them}，或重新下载。</p>`,
      confirm: '使用此文件夹',
    });
    if (!ok) return;
  }
  try {
    await api('/api/config', { method: 'POST', body: { models_dir: path } });
    toast(path ? '新模型将下载到新文件夹。' : '新模型将下载到 Hugging Face 缓存。');
    refresh();
  } catch (e) { toast(e.message, 'error'); }
}

function renderSettings(st) {
  const box = $('#sysset', root);
  if (!box || box.dataset.done) return;
  box.dataset.done = '1';
  box.innerHTML = `<section class="card card-pad" style="display:grid;gap:12px">
      <h2 style="font-size:15px">内存管理</h2>
      <label class="field" style="max-width:520px"><span class="label">弹出超过以下时间未使用的模型</span>
        <select class="select" id="idle" style="max-width:240px">${[[0, '从不（保持加载）'], [15, '15 分钟'], [60, '1 小时'], [240, '4 小时']].map(([v, l]) => `<option value="${v}" ${+st.settings.idle_eject_minutes === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span class="help">自动为其他程序释放内存。弹出后下次使用会重新加载。</span></label>
      <label class="switch"><input type="checkbox" id="autoload" ${st.settings.auto_load ? 'checked' : ''}>按需加载模型</label>
      <span class="help" style="margin-top:-6px">API 请求指定未加载的已下载模型时，先加载再回答，请求会等待。关闭：此类请求将被拒绝。</span>
      <h2 style="font-size:15px;margin-top:8px">训练</h2>
      <label class="switch"><input type="checkbox" id="exptrain" ${st.settings.experimental_training ? 'checked' : ''}>允许实验性训练</label>
      <span class="help" style="margin-top:-6px">允许训练页使用可用但训练尚未充分验证的 GPU：Intel Arc/Core Ultra、Linux 上 AMD、较旧 NVIDIA 与 Apple M1。NVIDIA RTX 30 系及以上与 Apple M2 及以上始终支持训练。</span>
    </section>`;
  $('#idle', box).addEventListener('change', (e) => saveSetting({ idle_eject_minutes: +e.target.value }));
  $('#autoload', box).addEventListener('change', (e) => saveSetting({ auto_load: e.target.checked }));
  $('#exptrain', box).addEventListener('change', (e) => saveSetting({ experimental_training: e.target.checked }));
}

async function saveSetting(patch) {
  try { await api('/api/settings', { method: 'POST', body: patch }); toast('设置已保存'); }
  catch (e) { toast(e.message, 'error'); }
}
