// API: a developer page after LM Studio's. The server, the endpoints for each published format and for the studio API
// (templates and history), one quick-start example, and the reference folded into rows. History has its own page.

import { EXAMPLES } from '../examples.js';
import { codeBlock, jsonTree } from '../format.js';
import { setSub } from '../shell.js';
import { FORMATS, LANGS, base, snippet, studioSnippet } from '../snippets.js';
import { markLearned, readyModels } from '../store.js';
import { $, $$, copy, esc, icon, term } from '../util.js';

let root, lang = 'python', format = 'studio';

const ENDPOINTS = {
  typesafe: [['POST', '/v1/systemone', '按 TypeSafe 标准格式发起决策。官方 TypeSafe SDK 调用此端点。', true], ['GET', '/v1/models', '可在 "model" 中指定的模型列表。']],
  openrouter: [['POST', '/api/alpha/decisions', 'OpenRouter 决策 API。响应额外含 id、provider 与 usage.cost。', true], ['POST', '/api/v1/systemone', 'OpenRouter System One 路由，请求体相同。', true]],
  vercel: [['POST', '/typesafe/v1/systemone', 'Vercel AI Gateway 的 TypeSafe 路由。响应含 provider_metadata。', true], ['GET', '/typesafe/v1/models', 'Vercel 路由上的模型列表。'], ['POST', '/v1/evaluate', 'Vercel 评估 API，含布尔问题与 camelCase usage。', true]],
  studio: [['POST', '/v1/studio/decisions', '发起决策：可用模板（"template": "support-triage", "variables"）或直接传 "state"、"questions"。返回决策 id、答案，以及是否自动执行或需人工。', true],
    ['GET', '/v1/studio/decisions', '历史：按模板、版本、模型、答案、时间、反馈筛选；用 after 分页。'],
    ['GET', '/v1/studio/decisions/{id}', '单条决策：输入、答案、设置及每项设置的来源。'],
    ['POST', '/v1/studio/decisions/{id}/feedback', '标注正确答案。标注用于按模板版本统计准确率。'],
    ['PUT', '/v1/studio/templates/{id}', '创建或更新模板。每次修改产生新版本。'],
    ['GET', '/v1/studio/templates/{id}/compare', '在真实流量上对比两个版本，含相同输入。'],
    ['GET', '/v1/studio/templates/{id}/stats', '按版本统计执行率、答案、准确率与延迟。'],
    ['POST', '/v1/studio/templates/{id}/examples', '测试示例：带正确答案的输入。'],
    ['GET, PATCH', '/v1/studio/settings', '历史记录保留内容与时长。']],
};
const STUDIO_NOTE = '工作室自有 API：可持久保存的决策、可复用模板，以及可搜索、标注与对比的历史。TypeSafe、OpenRouter 与 Vercel 格式并行可用、无需改动。完整参考见 docs/studio-api.md 与交互式参考。';
const STRICT = {
  model: 'laya',
  answers: {
    team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.8952, technical: 0.0785, sales: 0.0263 }, confidence: 0.8428 },
    urgency: { type: 'score', score: 1.4468, legend: { 0: 'low', 1: 'medium', 2: 'high' }, probabilities: { 0: 0.0551, 1: 0.443, 2: 0.5019 }, confidence: 0.1702 },
    refund: { type: 'noul', noul: 0.9486 },
  },
  usage: { input_tokens: 456, output_tokens: 0 },
};
const EXTENDED = {
  topics: { type: 'multi', selected: ['billing', 'crash'], probabilities: { billing: 0.9495, crash: 0.9953, shipping: 0.0677 }, threshold: 0.5 },
  first: { type: 'rank', ranking: ['double charge', 'login crash', 'ui colour'], probabilities: { 'double charge': 0.8964, 'login crash': 0.094, 'ui colour': 0.0096 } },
  days_left: { type: 'number', estimate: 1.08, most_likely: 0, range: [0, 3], unit: 'days', probabilities: { 0: 0.6731, 1: 0.2108, 3: 0.0717, 7: 0.0295, 30: 0.0149 } },
};

export function mount(el) {
  root = el;
  setSub('工作室 API，以及 TypeSafe、OpenRouter 与 Vercel 格式');
  root.innerHTML = `<div class="view scroll"><div class="pad" style="display:grid;gap:18px">
    <div class="group">
      <div class="grow"><span class="chip ok">${icon('check-circle')}运行中</span><span class="k" style="display:flex;gap:8px;align-items:center">基础 URL <code>${esc(base())}</code><button class="icon-btn" id="cpbase" aria-label="复制基础 URL" data-tip="复制">${icon('copy')}</button></span>
        <span class="v"><a class="btn sm" href="/docs" target="_blank" rel="noopener">${icon('book-open')}交互式参考</a></span></div>
      <div class="grow"><span class="k">认证</span><span class="v">本机无需认证。设置 <code>BASAL_API_KEY</code> 后，其他机器需提供密钥。</span></div>
      <div class="grow"><span class="k">模型名称</span><span class="v">工作室 ID，如 <code>laya</code>；或 <code>jev-latest</code> 表示最近加载的模型</span></div>
      <div class="grow"><span class="k">当前可用</span><span class="v" id="ready"></span></div>
      <div class="grow"><span class="k">历史</span><span class="v">任意端点的每次决策都会保存到<a href="#/history">历史</a>。请求体中发送 <code>"store": false</code> 可不保存该次调用。</span></div>
    </div>

    <div class="two" style="grid-template-columns:minmax(0,1.15fr) minmax(0,0.85fr)">
      <div style="display:grid;gap:18px">
        <section class="card card-pad" style="display:grid;gap:12px">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="font-size:15px">端点</h2>
            <span class="seg" role="group" aria-label="API 格式" style="margin-left:auto"><button data-fmt="studio" aria-pressed="${format === 'studio'}">工作室 API</button>${Object.entries(FORMATS).map(([k, f]) => `<button data-fmt="${k}" aria-pressed="${k === format}">${esc(f.name.replace(' Jev API', '').replace(' Decisions API', '').replace(' AI Gateway', ''))}</button>`).join('')}</span></div>
          <p class="help" id="fmtnote"></p>
          <div id="eps" style="display:grid;gap:12px"></div>
        </section>
        <section class="card card-pad" style="display:grid;gap:12px">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="font-size:15px">快速开始</h2>
            <span class="seg" role="group" aria-label="语言" style="margin-left:auto">${Object.entries(LANGS).map(([k, v]) => `<button data-lang="${k}" aria-pressed="${k === lang}">${esc(v.name)}</button>`).join('')}</span></div>
          <div id="snip"></div>
          <p class="help" id="sniphelp"></p>
        </section>
      </div>
      <section class="card card-pad" style="display:grid;gap:4px;align-content:start">
        <h2 style="font-size:15px;margin-bottom:8px">参考</h2>
        <details class="disclose"><summary>响应格式${icon('caret-right', 'chev')}</summary><div class="body">
          <p class="help">单选、量表与是/否答案严格携带 TypeSafe 字段。请求 ID 在 <code>x-typesafe-request-id</code> 响应头中返回。</p>
          ${jsonTree(STRICT, { file: '200 OK', openDepth: 3 })}</div></details>
        <details class="disclose"><summary>工作室扩展${icon('caret-right', 'chev')}</summary><div class="body">
          <p class="help">另外三种问题类型 <code>multi</code>、<code>rank</code>、<code>number</code>，以及图像/音频/视频的 <code>media</code>，和用于${term('temperature', '校准温度')}的 <code>settings.temperature</code>。发送 <code>X-Basal-Extensions: 1</code> 可同时收到 <code>decision</code>、<code>top_probability</code> 与 <code>latency_ms</code>。官方 SDK 会忽略未知字段。</p>
          ${jsonTree({ answers: EXTENDED }, { file: '扩展答案', openDepth: 2 })}</div></details>
        <details class="disclose"><summary>历史与选择退出${icon('caret-right', 'chev')}</summary><div class="body">
          <p class="help">默认 30 天内，任意端点的每次决策都会保存在本机历史中：情境、问题、答案、模型与耗时。响应头 <code>x-basal-stored</code> 说明保留了什么，<code>x-basal-decision-id</code> 给出 ID。若要少存：</p>
          <div class="group">
            <div class="grow stack"><span class="k">请求体中的 <code>"store": false</code></span><span class="v small">该次调用不保存任何内容。<code>"answers_only"</code> 仅保留答案、不保留情境。TypeSafe 自有服务器会忽略该字段，同一代码可两边运行。</span></div>
            <div class="grow stack"><span class="k">请求头 <code>X-Basal-Store: 0</code></span><span class="v small">同上，适用于无法改请求体的客户端。以两者中更严格的一方为准。</span></div>
            <div class="grow stack"><span class="k">模板的 <b>storage</b></span><span class="v small">对该模板下每次决策设置上限。</span></div>
            <div class="grow stack"><span class="k">历史设置</span><span class="v small">在历史页面或 <code>PATCH /v1/studio/settings</code> 配置保留内容与时长。</span></div>
          </div>
          <p class="help">标记为 <code>sensitive</code> 的变量会参与决策但永不落盘。发送 <code>Idempotency-Key</code> 可安全重试。</p></div></details>
        <details class="disclose"><summary>错误${icon('caret-right', 'chev')}</summary><div class="body"><div class="group">
          <div class="grow stack"><span class="k"><b>422</b> 请求无效</span><span class="v small"><code>{"detail": [{"type", "loc", "msg", "input"}]}</code>。OpenRouter 与 Vercel 格式以各自结构返回 400。</span></div>
          <div class="grow stack"><span class="k"><b>403</b> 需要 API 密钥但未提供</span><span class="v small"><code>{"detail": {"error_type": "authentication_error", "message"}}</code></span></div>
          <div class="grow stack"><span class="k"><b>401</b> API 密钥错误</span><span class="v small">响应体与 403 相同。</span></div>
          <div class="grow stack"><span class="k"><b>404</b> 未知模型或路径</span><span class="v small"><code>{"detail": "Not Found"}</code> 或指明模型的消息。</span></div>
          <div class="grow stack"><span class="k"><b>503, 504</b> 模型加载中或超时</span><span class="v small">稍后重试。</span></div></div></div></details>
        <details class="disclose"><summary>从其他机器调用${icon('caret-right', 'chev')}</summary><div class="body">
          <p class="help">工作室默认仅监听本机。使用 <code>./run.sh --host 0.0.0.0</code> 并设置 <code>BASAL_API_KEY</code>；客户端发送 <code>Authorization: Bearer &lt;key&gt;</code>。网页管理调用需头 <code>X-Basal-Client: 1</code>。</p></div></details>
        <details class="disclose"><summary>OpenAI Decisions API${icon('caret-right', 'chev')}</summary><div class="body">
          <p class="help">OpenAI 于 2026 年 9 月 29 日宣布 Decisions API 有限预览，尚无公开端点、模式或 SDK。工作室不会臆测实现；规范发布后再加入。上文 OpenRouter Decisions API 是目前最接近的公开格式。</p></div></details>
      </section>
    </div>
  </div></div>`;
  $('#cpbase', root).addEventListener('click', () => copy(base(), '基础 URL 已复制'));
  $$('[data-fmt]', root).forEach((b) => b.addEventListener('click', () => { format = b.dataset.fmt; $$('[data-fmt]', root).forEach((x) => x.setAttribute('aria-pressed', x === b)); renderEndpoints(); renderSnippet(); }));
  $$('[data-lang]', root).forEach((b) => b.addEventListener('click', () => { lang = b.dataset.lang; $$('[data-lang]', root).forEach((x) => x.setAttribute('aria-pressed', x === b)); markLearned('code'); renderSnippet(); }));
  renderReady(); renderEndpoints(); renderSnippet();
}
export function onState() { if (root?.isConnected) renderReady(); }

function renderReady() {
  const box = $('#ready', root);
  if (!box) return;
  const r = readyModels();
  const html = r.length ? r.map((m) => `<code>${esc(m.id)}</code>`).join(' ') : '未加载模型。请求中指定已下载模型时会先加载。';
  if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
}

function renderEndpoints() {
  $('#fmtnote', root).textContent = format === 'studio' ? STUDIO_NOTE : FORMATS[format].note;
  $('#eps', root).innerHTML = ENDPOINTS[format].map(([m, p, d, saved]) => `<div class="ep"><span class="m ${['POST', 'PUT'].includes(m) ? 'post' : ''}">${m}</span><code>${esc(p)}</code>${saved ? `<a class="chip violet ep-saved" href="#/history" data-tip="每次调用都会保存到历史；响应头 x-basal-decision-id 为其 ID">${icon('clock-counter-clockwise')}已存入历史</a>` : ''}<span class="d">${esc(d)}</span></div>`).join('');
}

function renderSnippet() {
  const ex = EXAMPLES.find((e) => e.id === 'support');
  const req = { model: readyModels()[0]?.id || 'laya', state: ex.state, questions: ex.questions };
  const L = LANGS[lang];
  $('#sniphelp', root).innerHTML = format === 'studio' && !L.sdk
    ? '通过入门模板 <code>builtin/support</code> 处理工单。响应为已保存的决策：可在<a href="#/history">历史</a>中按 ID 打开。自定义决策请用试验台的「代码」标签。'
    : `官方 TypeSafe SDK 使用 TypeSafe 格式${format === 'studio' ? '，故本示例使用 <code>/v1/systemone</code>' : ''}；调用同样会存入<a href="#/history">历史</a>。自定义决策请用试验台的「代码」标签。`;
  if (format === 'studio' && !L.sdk) {
    const l = lang.startsWith('js') || lang === 'javascript' ? 'javascript' : lang === 'curl' ? 'curl' : 'python';
    $('#snip', root).innerHTML = codeBlock(studioSnippet(l, { template: 'builtin/support', model: req.model, state: ex.state }), { lang: l === 'curl' ? 'bash' : l, file: l === 'curl' ? 'decide.sh' : l === 'python' ? 'decide.py' : 'decide.mjs', maxHeight: 420 });
    return;
  }
  $('#snip', root).innerHTML = codeBlock(snippet(lang, req, { format: L.sdk || format === 'studio' ? 'typesafe' : format }), { lang: L.lang, file: L.file, maxHeight: 420 });
}
