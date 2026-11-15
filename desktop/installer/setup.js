// Setup screens. First launch: Welcome (hardware check), Where models run, Install, Ready, then the studio opens
// and asks which models to download. Later launches skip straight to starting the studio.
//
// Opened in a plain browser (no Tauri), the page simulates the app so the screens can be previewed:
// ?hw=gb10 | mac | intel | cpu picks the simulated computer, ?installed=1 shows the launch splash.

import { ICONS } from './assets/phosphor.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (n) => `<svg class="i" viewBox="0 0 256 256" aria-hidden="true">${ICONS[n] || ''}</svg>`;
const T = window.__TAURI__ || mockTauri();
const invoke = (cmd, args) => T.core.invoke(cmd, args);
const msg = (e) => String(e?.message ?? e);

const OS = { linux: 'Linux', macos: 'macOS', windows: 'Windows' };
const ARCH = { x86_64: 'Intel 或 AMD 64 位', aarch64: 'ARM 64 位' };
const KIND = { nvidia: 'NVIDIA GPU', apple: 'Apple GPU', intel: 'Intel GPU', amd: 'AMD GPU', cpu: '处理器' };

const S = { step: 'welcome', info: null, hw: null, hwError: null, device: null, log: [], progress: 0, stepId: null, stepsSeen: [], error: null, result: null, started: 0 };
const again = new URLSearchParams(location.search).get('setup') === 'again';

// ------------------------------------------------------------------ start
(async function start() {
  S.info = await invoke('app_info');
  $('#version').textContent = `版本 ${S.info.version}`;
  if (S.info.installed && !again) return launch();
  $('#setup').hidden = false;
  go('welcome');
  try { S.hw = await invoke('detect_hardware'); S.device = S.hw.recommended; } catch (e) { S.hwError = msg(e); }
  if (S.step === 'welcome') go('welcome');
  // Unattended setup (BUD_STUDIO_DEVICE): the same screens, advancing on their own.
  const auto = S.info.unattended;
  if (auto && S.hw) {
    if (auto !== 'recommended' && S.hw.accelerators.some((a) => a.id === auto)) S.device = auto;
    setTimeout(() => go('device'), 1500);
    setTimeout(async () => { await runInstall(); if (S.step === 'ready') setTimeout(openStudio, 2500); }, 3500);
  }
})();

async function launch() {
  $('#splash').hidden = false;
  $('#splashmsg').textContent = '正在启动引擎';
  try { await invoke('start_studio'); } catch (e) { splashError(msg(e)); }
}

function splashError(msg) {
  const [head, ...rest] = msg.split('\n\n');
  $('#splash .bar').hidden = true;
  $('#splashmsg').textContent = `${head} 请重试，或重新运行安装程序以修复引擎。`;
  const box = $('#splasherr');
  box.hidden = false;
  box.innerHTML = `${rest.length ? `<pre>${esc(rest.join('\n\n'))}</pre>` : ''}
    <div class="acts">${rest.length ? '<button class="btn" id="copyerr">复制详情</button>' : ''}<button class="btn" id="resetup">重新运行安装</button><button class="btn btn-primary" id="retry">重试</button></div>`;
  $('#copyerr')?.addEventListener('click', () => navigator.clipboard?.writeText(msg));
  $('#retry').onclick = () => { box.hidden = true; $('#splash .bar').hidden = false; launch(); };
  $('#resetup').onclick = () => { location.search = '?setup=again'; };
}

// ------------------------------------------------------------------ navigation
const ORDER = ['welcome', 'device', 'install', 'ready'];
function go(step) {
  S.step = step;
  const at = ORDER.indexOf(step);
  document.querySelectorAll('#steps li').forEach((li) => {
    const i = ORDER.indexOf(li.dataset.step);
    li.className = i < at ? 'done' : i === at ? 'current' : '';
    li.toggleAttribute('aria-current', i === at);
  });
  ({ welcome, device, install, ready })[step]();
  $('#body').firstElementChild?.classList.add('fade');
}

function foot({ note = '', back = null, next = null, nextLabel = '继续', nextDisabled = false }) {
  $('#footnote').innerHTML = note;
  const b = $('#back'), n = $('#next');
  b.hidden = !back; b.onclick = back;
  n.hidden = !next; n.onclick = next; n.textContent = nextLabel; n.disabled = nextDisabled;
}

// ------------------------------------------------------------------ 1. welcome and hardware check
function welcome() {
  const hw = S.hw;
  const rows = !hw && !S.hwError
    ? [1, 2, 3].map(() => `<div class="row"><span class="ic"></span><span class="t"><span class="skel" style="width:40%"></span><span class="skel" style="width:62%;margin-top:7px"></span></span></div>`).join('')
    : hw ? [
      `<div class="row"><span class="ic">${icon('desktop')}</span><span class="t"><b>本机</b><span>${esc(OS[hw.os] || hw.os)}，${esc(ARCH[hw.arch] || hw.arch)}${hw.memory_gb ? `，${Math.round(hw.memory_gb)} GB 内存` : ''}</span></span></div>`,
      ...hw.accelerators.map((a) => `<div class="row"><span class="ic ${a.kind !== 'cpu' ? 'gpu' : ''}">${icon(a.kind === 'cpu' ? 'cpu' : 'lightning')}</span>
        <span class="t"><b>${esc(a.name)}</b><span>${esc(kindLine(a))}</span></span>${a.experimental ? '<span class="chip orange">实验性</span>' : ''}</div>`),
      `<div class="row"><span class="ic">${icon('hard-drives')}</span><span class="t"><b>可用磁盘空间</b><span>每个模型约 1–24 GB；引擎约 ${planFor(hw.recommended)?.download_gb ?? 3} GB</span></span><span class="v">${hw.disk_free_gb != null ? `${Math.round(hw.disk_free_gb)} GB` : ''}</span></div>`,
    ].join('') : '';
  $('#body').innerHTML = `<div>
    <h1>${again ? '重新设置' : '欢迎使用 Bud Decision Studio'}</h1>
    <p class="lede">${again
      ? `模型当前在 ${esc(S.info.config?.device_name || '本机')} 上运行。可重新选择以换到其他处理器，或修复引擎。`
      : '在本机运行开放的决策模型。给出情境和几个问题，即可得到每个答案的概率，通常在毫秒内完成。'}</p>
    <p class="lede" style="margin-top:8px">安装程序会检测本机、安装运行模型所需的引擎，然后让你选择要下载的模型。无需安装其他软件。</p>
    ${S.info.can_move_to_applications ? `<div class="note move">${icon('arrow-square-out')}<span><b>要先移到「应用程序」吗？</b>应用当前从${/Volumes/.test(location.href) ? '磁盘映像' : '下载文件夹'}运行。移到「应用程序」后可固定在启动台和程序坞。</span><button class="btn" id="moveapp">移到应用程序</button></div>` : ''}
    <div class="section-title">${hw ? '在本机检测到' : S.hwError ? '检测本机失败' : '正在检测本机'}</div>
    ${S.hwError ? `<div class="note error">${icon('warning')}<span>${esc(S.hwError)}</span></div>` : `<div class="group">${rows}</div>`}
    ${(hw?.notes || []).map((n) => `<div class="note warn">${icon('warning')}<span>${esc(n)}</span></div>`).join('')}
  </div>`;
  $('#moveapp')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true; e.currentTarget.textContent = '正在移动';
    try { await invoke('move_to_applications'); } catch (err) { e.currentTarget.textContent = msg(err); }
  });
  foot({
    note: hw ? '' : S.hwError ? '' : '正在检测处理器与显卡',
    next: S.hwError ? () => location.reload() : () => go('device'),
    nextLabel: S.hwError ? '重试' : '继续',
    nextDisabled: !hw && !S.hwError,
  });
}

function kindLine(a) {
  const parts = [KIND[a.kind] || '处理器'];
  if (a.kind === 'nvidia' && a.cuda) parts.push(`CUDA ${a.cuda}`);
  if (a.kind === 'cpu' && a.cores) parts.push(`${a.cores} 核`);
  if (a.memory_gb) parts.push(`${Math.round(a.memory_gb)} GB ${a.unified_memory ? '共享' : ''}内存`);
  return parts.join(', ');
}
const planFor = (id) => S.hw?.plans?.[id];

// ------------------------------------------------------------------ 2. where models run
function what(a) {
  const big = (a.memory_gb || 0) >= 30;
  switch (a.kind) {
    case 'nvidia': return big ? '最快。可运行全部模型，含用于图像、音频与视频的 Jev-Omni。' : `最快。可运行适合其 ${Math.round(a.memory_gb || 0)} GB 显存内的全部模型。`;
    case 'apple': return big ? '很快。通过 Metal 使用 Mac GPU，可运行全部模型，含 Jev-Omni。' : '很快。通过 Metal 使用 Mac GPU；最大模型所需内存超过本 Mac 配置。';
    case 'intel': return '比仅用处理器更快。通过 oneAPI 使用 Intel GPU。';
    case 'amd': return '使用 ROCm。实验性：部分模型可能无法加载。';
    default: return '适用于任何电脑。小模型约一秒出结果；大模型较慢，Jev-Omni 需要 GPU。';
  }
}

const WHERE = { nvidia: 'NVIDIA GPU', apple: 'Apple GPU', intel: 'Intel GPU', amd: 'AMD GPU', cpu: '仅处理器' };
function hardwareLine(a) {
  const parts = [a.name];
  if (a.kind === 'nvidia' && a.cuda) parts.push(`CUDA ${a.cuda}`);
  if (a.kind === 'cpu' && a.cores) parts.push(`${a.cores} 核`);
  if (a.memory_gb) parts.push(`${Math.round(a.memory_gb)} GB ${a.unified_memory ? '共享' : ''}内存`);
  return parts.join(', ');
}

function device() {
  const hw = S.hw;
  $('#body').innerHTML = `<div>
    <h1>模型应在哪里运行？</h1>
    <p class="lede">GPU 响应快得多。处理器随处可用，适合小模型。安装程序会按你的选择安装对应引擎；之后可重新运行安装以更改。</p>
    <div class="choices" role="radiogroup" aria-label="模型运行位置">
      ${hw.accelerators.map((a) => {
        const p = planFor(a.id) || {};
        return `<button class="choice" role="radio" aria-checked="${a.id === S.device}" data-id="${a.id}" ${p.error ? 'disabled' : ''}>
          <span class="radio"></span><span class="ic ${a.kind !== 'cpu' ? 'gpu' : ''}">${icon(a.kind === 'cpu' ? 'cpu' : 'lightning')}</span>
          <span><span class="name">${WHERE[a.kind] || 'GPU'}${a.id === hw.recommended ? '<span class="chip violet">推荐</span>' : ''}${a.experimental ? '<span class="chip orange">实验性</span>' : ''}</span>
            <span class="kind">${esc(hardwareLine(a))}</span>
            <span class="what">${esc(what(a))}</span>
            <span class="size">${p.error ? esc(p.error) : `将安装 ${esc(p.torch_label)} 与模型库，约 ${p.download_gb} GB。`}</span></span></button>`;
      }).join('')}
    </div>
  </div>`;
  const pick = (id) => { S.device = id; document.querySelectorAll('.choice').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.id === id))); };
  document.querySelectorAll('.choice').forEach((c) => {
    c.onclick = () => pick(c.dataset.id);
    c.onkeydown = (e) => {
      if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
      const all = [...document.querySelectorAll('.choice:not([disabled])')];
      const n = all[(all.indexOf(c) + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length];
      pick(n.dataset.id); n.focus(); e.preventDefault();
    };
  });
  const free = hw.disk_free_gb;
  foot({ note: free != null ? `本机可用 ${Math.round(free)} GB` : '', back: () => go('welcome'), next: () => runInstall(), nextLabel: '安装' });
}

// ------------------------------------------------------------------ 3. install
const STEPS = [['python', '准备 Python'], ['torch', '安装 PyTorch'], ['libs', '安装模型库'], ['models', '安装模型包'], ['verify', '检查设备']];
let unlisten = null, ticker = null;

async function runInstall() {
  Object.assign(S, { log: [], progress: 0, stepId: 'python', stepsSeen: [], error: null, result: null, started: Date.now(), label: '准备中' });
  go('install');
  unlisten ??= await T.event.listen('install', (e) => onEvent(e.payload));
  clearInterval(ticker); ticker = setInterval(() => { if (S.step === 'install' && !S.error) $('#elapsed') && ($('#elapsed').textContent = elapsed()); }, 1000);
  try {
    S.result = await invoke('install_engine', { device: S.device });
    S.progress = 1; clearInterval(ticker);
    go('ready');
  } catch (e) {
    S.error = msg(e); clearInterval(ticker);
    install();
  }
}

function onEvent(ev) {
  if (ev.type === 'step') { S.stepId = ev.id; S.label = ev.label; S.progress = ev.progress; if (!S.stepsSeen.includes(ev.id)) S.stepsSeen.push(ev.id); }
  if (ev.type === 'log' || ev.type === 'error') { S.log.push(ev.line ?? ev.message); if (S.log.length > 400) S.log.splice(0, S.log.length - 400); }
  if (S.step === 'install') paintInstall();
}

const elapsed = () => { const s = Math.round((Date.now() - S.started) / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; };

function install() {
  const p = planFor(S.device) || {};
  $('#body').innerHTML = `<div>
    <h1>${S.error ? '安装未完成' : '正在安装引擎'}</h1>
    <p class="lede">${S.error ? '应用目录外未做任何更改。请查看下方详情后重试。' : `正在下载 ${esc(p.torch_label || 'PyTorch')} 与模型库，约 ${p.download_gb || 3} GB。网速快时约需数分钟，可保持窗口打开。`}</p>
    <div class="progress-head"><b id="plabel"></b><span id="elapsed">${elapsed()}</span></div>
    <span class="bar ${S.error ? 'failed' : 'working'}" id="pbar"><i></i></span>
    <ul class="checklist" id="checks"></ul>
    ${S.error ? `<div class="note error">${icon('warning')}<span>${esc(S.error)}</span></div>` : ''}
    <details class="log" ${S.error ? 'open' : ''}><summary>详情</summary><pre id="log"></pre></details>
  </div>`;
  foot(S.error
    ? { back: () => go('device'), next: () => runInstall(), nextLabel: '重试', note: `<button class="btn" id="copylog">${icon('copy')}复制详情</button>` }
    : { note: '请保持应用打开直至安装完成。' });
  // The log already ends with the error when the installer reported it; add it only when it came from elsewhere.
  $('#copylog')?.addEventListener('click', () => navigator.clipboard?.writeText([...S.log, ...(S.log.at(-1) === S.error ? [] : [S.error])].join('\n')));
  paintInstall();
}

function paintInstall() {
  const at = STEPS.findIndex(([id]) => id === S.stepId);
  $('#plabel').textContent = S.error ? '已停止' : S.label || '准备中';
  $('#pbar i').style.width = `${Math.max(3, Math.round(S.progress * 100))}%`;
  $('#checks').innerHTML = STEPS.map(([id, label], i) => `<li class="${i < at ? 'done' : i === at ? (S.error ? 'failed' : 'active') : ''}"><span class="mark"></span>${label}</li>`).join('');
  const log = $('#log');
  if (log) {
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
    log.textContent = S.log.slice(-250).join('\n');
    if (stick) log.scrollTop = log.scrollHeight;
  }
}

// ------------------------------------------------------------------ 4. ready
function ready() {
  const c = S.result || {};
  $('#body').innerHTML = `<div>
    <div class="done-mark" aria-hidden="true"></div>
    <h1>Bud Decision Studio 已就绪</h1>
    <p class="lede">安装耗时 ${elapsed()}。</p>
    <div class="section-title">已配置为</div>
    <div class="group">
      <div class="row"><span class="ic ${c.device !== 'cpu' ? 'gpu' : ''}">${icon(c.device === 'cpu' ? 'cpu' : 'lightning')}</span><span class="t"><b>模型运行于 ${esc(c.device_name)}</b><span>${c.device === 'cpu' ? '处理器' : 'GPU'}，PyTorch ${esc(c.torch)}</span></span></div>
    </div>
    <div class="next-up"><span class="ic">${icon('cloud-arrow-down')}</span><span><b>接下来，选择模型</b>
      <p>打开工作室后会显示为本机挑选的短列表。勾选你想要的模型；它们会在后台依次下载，你可同时探索其他功能。</p></span></div>
  </div>`;
  foot({ next: openStudio, nextLabel: '打开 Bud Decision Studio' });
}

async function openStudio() {
  const n = $('#next');
  n.disabled = true; n.textContent = '正在启动';
  try { await invoke('start_studio'); } catch (e) {
    $('#setup').hidden = true; $('#splash').hidden = false; splashError(msg(e));
  }
}

// ------------------------------------------------------------------ preview without Tauri
function mockTauri() {
  const q = new URLSearchParams(location.search);
  const HW = {
    gb10: { os: 'linux', arch: 'aarch64', memory_gb: 121.6, disk_free_gb: 96, recommended: 'cuda', notes: [],
      accelerators: [{ id: 'cuda', kind: 'nvidia', name: 'NVIDIA GB10', memory_gb: 121.6, unified_memory: true, cuda: '13.0' }, { id: 'cpu', kind: 'cpu', name: 'Cortex-X925 + Cortex-A725', memory_gb: 121.6, cores: 20 }],
      plans: { cuda: { torch_label: 'PyTorch 2.11.0 for CUDA 13.0', download_gb: 4.4 }, cpu: { torch_label: 'PyTorch 2.11.0 for the CPU', download_gb: 1.5 } } },
    mac: { os: 'macos', arch: 'aarch64', memory_gb: 36, disk_free_gb: 212, recommended: 'mps', notes: [],
      accelerators: [{ id: 'mps', kind: 'apple', name: 'Apple M3 Pro', memory_gb: 36, unified_memory: true }, { id: 'cpu', kind: 'cpu', name: 'Apple M3 Pro', memory_gb: 36, cores: 12 }],
      plans: { mps: { torch_label: 'PyTorch 2.11.0 with Apple Metal (MPS)', download_gb: 1.6 }, cpu: { torch_label: 'PyTorch 2.11.0 for the CPU', download_gb: 1.5 } } },
    intel: { os: 'windows', arch: 'x86_64', memory_gb: 32, disk_free_gb: 310, recommended: 'xpu', notes: [],
      accelerators: [{ id: 'xpu', kind: 'intel', name: 'Intel Arc Graphics', memory_gb: 32, unified_memory: true }, { id: 'cpu', kind: 'cpu', name: 'Intel Core Ultra 7 155H', memory_gb: 32, cores: 22 }],
      plans: { xpu: { torch_label: 'PyTorch 2.11.0 for Intel GPUs (XPU)', download_gb: 3 }, cpu: { torch_label: 'PyTorch 2.11.0 for the CPU', download_gb: 1.5 } } },
    cpu: { os: 'windows', arch: 'x86_64', memory_gb: 16, disk_free_gb: 120, recommended: 'cpu', notes: [],
      accelerators: [{ id: 'cpu', kind: 'cpu', name: 'Intel Core i5-1235U', memory_gb: 16, cores: 12 }],
      plans: { cpu: { torch_label: 'PyTorch 2.11.0 for the CPU', download_gb: 1.5 } } },
  };
  const hw = HW[q.get('hw')] || HW.gb10;
  const listeners = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    event: { listen: async (_n, fn) => { listeners.push(fn); return () => {}; } },
    core: {
      invoke: async (cmd, args) => {
        if (cmd === 'app_info') return { version: '0.1.0', installed: q.get('installed') === '1', config: { device_name: hw.accelerators[0].name }, unattended: q.get('auto'), can_move_to_applications: q.get('hw') === 'mac' };
        if (cmd === 'detect_hardware') { await sleep(+(q.get('delay') || 900)); return hw; }
        if (cmd === 'install_engine') {
          const emit = (ev) => listeners.forEach((f) => f({ payload: ev }));
          const p = hw.plans[args.device];
          const steps = [['python', '准备 Python 3.12', 0], ['torch', `正在安装 ${p.torch_label}`, 0.05], ['libs', '正在安装模型库', 0.6], ['models', '正在安装模型包', 0.88], ['verify', `正在检查 ${hw.accelerators.find((a) => a.id === args.device).name}`, 0.95]];
          const stopAt = q.get('stop');
          for (const [id, label, progress] of steps) {
            emit({ type: 'step', id, label, progress });
            for (let k = 0; k < 4; k++) { emit({ type: 'log', line: `Resolved ${12 + k} packages in ${40 + k * 7}ms` }); await sleep(+(q.get('speed') || 350)); }
            if (stopAt === id) throw new Error(q.get('fail') || { python: '无法创建 Python 环境。', torch: '无法安装 PyTorch。请检查网络后重试。', libs: '无法安装模型库。', models: '无法安装模型包。', verify: '无法使用该设备。' }[id]);
          }
          const a = hw.accelerators.find((x) => x.id === args.device);
          return { device: args.device === 'rocm' ? 'cuda' : args.device, device_name: a.name, torch: '2.11.0' };
        }
        if (cmd === 'start_studio') { await sleep(1200); if (q.get('startfail')) throw new Error('工作室未能启动。\n\nTraceback (most recent call last):\n  ...\nModuleNotFoundError: No module named \'torch\''); return 'http://127.0.0.1:8420/'; }
        return null;
      },
    },
  };
}
