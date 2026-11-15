// Learn: what a decision model is, why you would use one, and how to read its answers.

import { EXAMPLES } from '../examples.js';
import { animate, figures } from '../figures.js';
import { GLOSSARY } from '../glossary.js';
import { decide, readyModels, store } from '../store.js';
import { setSub } from '../shell.js';
import { $, esc, fmtMs, fmtPct, icon, term } from '../util.js';

// Shown until a model is loaded; replaced by a live run as soon as one is.
// Real answers recorded from Intern-Decision 4B on an NVIDIA GB10.
const RECORDED = {
  model: 'Intern-Decision 4B', latency_ms: 106.0,
  answers: {
    department: { type: 'choice', probabilities: { billing: 0.9826, technical: 0.0114, sales: 0.0025, other: 0.0035 }, decision: 'billing', top_probability: 0.9826, choice: 'billing', confidence: 0.9768 },
    urgency: { type: 'score', probabilities: { 0: 0.0035, 1: 0.0069, 2: 0.81, 3: 0.1797 }, decision: '2', top_probability: 0.81, score: 2.1659, legend: { 0: 'can wait', 1: 'soon', 2: 'today', 3: 'blocking or at risk of churn' }, confidence: 0.8065 },
    churn_risk: { type: 'noul', probabilities: { false: 0.0066, true: 0.9934 }, decision: 'yes', top_probability: 0.9934, noul: 0.9934 },
  },
};
const EX = EXAMPLES.find((e) => e.id === 'support');
const TYPES = [
  ['choice', '单选', '从你给出的列表中选一项：团队、意图、类别、下一步等。', '「应由哪个部门处理？」billing、technical、sales', 'email'],
  ['score', '量表评分', '在 2–10 级的有序量表上取值，平均值可落在两级之间。', '「有多紧急？」从可等待到阻塞', 'review'],
  ['noul', '是或否', '某陈述为真的概率。TypeSafe 称此类型为 noul。', '「客户是否威胁取消？」', 'injection'],
  ['multi', '多选', '每个适用选项单独判断，对照你设定的阈值。', '「消息涉及哪些主题？」', 'tags'],
  ['rank', '排序', '按从最可能到最不可能排列全部选项。', '「应先修复哪个事件？」', 'backlog'],
  ['number', '数值估计', '在你列出的数值中给出最佳估计与 80% 区间。', '「他们会买多少席位？」', 'estimate'],
];

let root, live = null, liveFor = null, running = false;

export function mount(el) {
  root = el;
  setSub('十分钟了解决策模型');
  root.innerHTML = `<div class="view scroll"><div class="learn-view"><div class="l-main">
    <section class="l-hero">
      <div>
        <h1>做决策，不写长文的模型。</h1>
        <p class="lede">${term('decision_model', '决策模型')}阅读情境并返回你允许的每个答案的概率。无需解析文本、不会编造，在本机 GPU 上毫秒级响应（CPU 上约一秒）。</p>
        <div class="cta"><a class="btn btn-primary lg" href="#/playground">${icon('flask')}立即试用</a><a class="btn lg" href="#/models">${icon('squares-four')}选择模型</a></div>
        <ol class="read-legend" aria-label="如何阅读图表">
          <li><span><b>答案</b>以大字号显示，并附模型认为的可能性。</span></li>
          <li><span><b>每个选项</b>在同一 0–100% 尺度上，便于看出次优选项及差距。</span></li>
          <li><span><b>说明文字</b>用文字概括，并提示自动执行或需人工。</span></li>
        </ol>
      </div>
    </section>

    <section class="l-sec">
      <header><h2>与聊天机器人有何不同？</h2><p>同是神经网络，任务却截然不同。</p></header>
      <div class="prose">
        <p>软件里多数 AI 调用不是对话，而是小判断：工单分给谁、评论是否允许、智能体是否完成任务。用聊天模型意味着为长文付费，再解析成值并祈祷格式不乱。</p>
        <div class="vs">
          <div><h3>聊天模型（LLM）</h3>
            <pre>"根据这条消息，看起来像是账单问题，很可能是重复扣款。我建议转给……"</pre>
            <ul><li>逐词生成自由文本</li><li>自行解析并祈祷格式稳定</li><li>可能回答未提供的选项</li><li>每次数秒；按输出词计费</li></ul></div>
          <div><h3>决策模型</h3>
            <pre>billing 97%   technical 1%   sales 1%   other 1%</pre>
            <ul><li>为你定义的每个选项给出概率</li><li>无法回答选项之外的内容</li><li>所有问题在${term('one_pass', '单次前向')}中完成</li><li>毫秒级；零输出 token</li></ul></div>
        </div>
        <p>该类别由 ${term('jev', 'Jev')} 在 2026 年 9 月以 ${term('system_one', 'System One')} 模型推广。本工作室的模型均为可在自有硬件上运行的开放替代。</p>
      </div>
    </section>

    <section class="l-sec">
      <header><h2>六种问题类型</h2><p>你提出的每个问题都属于其中之一。前三种来自 TypeSafe；工作室在此基础上构建后三种。</p></header>
      <div class="types6">${TYPES.map(([t, n, d, ex, id]) => `<div><h3>${icon(t)}${n}</h3><p>${d}</p><p class="ex">${esc(ex)}</p><a href="#/playground?example=${id}" class="small">打开示例</a></div>`).join('')}</div>
    </section>

    <section class="l-sec">
      <header><h2>读懂数字</h2><p>概率是核心产出。用法如下。</p></header>
      <div class="prose">
        <p><strong>概率</strong>表示模型对每个答案的置信分配；单选问题的选项概率之和恒为 100%，最高者即模型答案。</p>
        <p><strong>${term('calibration', '校准')}</strong>表示这些数字能否直接采信：校准良好的模型说 80% 时，约 80% 的情况确实正确。多数模型略偏自信，在信任阈值前请用几十条自有标注示例验证。<a href="#/evaluate">评测</a>可测量并拟合${term('temperature', '校准温度')}加以校正。</p>
        <p>决策模型的惯用方式是<strong>${term('gating', '置信度门控')}</strong>：当最高答案足够可信时自动执行，其余交给人工或更大模型。拖动阈值可见权衡。</p>
        <div class="gate-demo" id="gatedemo"></div>
      </div>
    </section>

    <section class="l-sec">
      <header><h2>擅长与不擅长</h2><p>了解边界是用好它的关键。</p></header>
      <div class="vs">
        <div><h3>擅长</h3><ul>
          <li>路由与分诊：工单、邮件、告警</li><li>审核、安全与提示注入筛查</li>
          <li>对照来源核验其他 AI 的答案</li><li>为智能体选择下一步工具或动作</li><li>低成本批量打标与评分</li></ul></div>
        <div><h3>不擅长</h3><ul>
          <li>算术、计数与日期计算（应在代码中完成）</li><li>未出现在所给文本中的事实</li>
          <li>多步推理：单次前向无法传递中间结果</li><li>解释原因：无可展示的推理过程</li><li>读取文本中写明的概率，如骰子赔率</li></ul></div>
      </div>
    </section>

    <section class="l-sec">
      <header><h2>教会它你的决策方式</h2><p>当模型答法与团队不一致时。</p></header>
      <p>此处每个模型都可用「文本 + 正确答案」的示例表格来教：一列情境、一列你的答案，通常几百行即可。工作室会留出部分示例做测试，在其余数据上训练，仅当在未见过示例上更好且不忘旧知识时才保留新版本。全程在本机运行，需要 GPU。</p>
      <p><a class="btn btn-quiet sm" href="#/train">${icon('magic-wand')}打开训练</a></p>
    </section>

    <section class="l-sec">
      <header><h2>人们用它做什么</h2><p>每项会在试验台中打开现成示例。</p></header>
      <div class="uses">${EXAMPLES.map((e) => `<a class="use" href="#/playground?example=${e.id}"><b>${esc(e.title)}</b><span>${esc(e.blurb)}</span></a>`).join('')}</div>
    </section>

    <section class="l-sec">
      <header><h2>你的路径</h2><p>进度会随操作自动勾选。</p></header>
      <ol class="steps" id="path"></ol>
    </section>

    <section class="l-sec">
      <header><h2>常见术语</h2><p>在工作室中悬停带点下划线的词可见相同释义。</p></header>
      <dl class="glossary">${Object.values(GLOSSARY).map((g) => `<div><dt>${esc(g.term)}</dt><dd>${esc(g.def)}</dd></div>`).join('')}</dl>
    </section>
  </div><aside class="l-demo" id="demo" aria-label="实时决策示例"></aside></div></div>`;
  renderDemo();
  renderGate(store.prefs.threshold);
  renderPath();
  maybeRunLive();
}

export function onState() {
  if (!root?.isConnected) return;
  renderPath();
  maybeRunLive();
}

async function maybeRunLive() {
  const ready = readyModels();
  const pick = ready.find((m) => m.id === 'intern-decision-4b') || ready[0];
  if (!pick || running || liveFor === pick.id) return;
  running = true;
  try {
    const { data } = await decide({ model: pick.id, state: EX.state, questions: EX.questions });
    live = { ...data, modelName: pick.name };
    liveFor = pick.id;
    renderDemo();
  } catch { /* keep the recorded example */ }
  running = false;
}

function renderDemo() {
  const box = $('#demo', root);
  if (!box) return;
  const r = live || RECORDED;
  const caption = live
    ? `本机 ${esc(live.modelName)} 实时结果：三个答案共 ${fmtMs(live.latency_ms)}。`
    : `在 NVIDIA GB10 上由 ${esc(RECORDED.model)} 录制：三个答案共 ${fmtMs(RECORDED.latency_ms)}。加载模型后将实时运行。`;
  box.innerHTML = `<div class="card card-pad" style="display:grid;gap:8px"><span class="label">情境</span><p class="muted">${esc(EX.state)}</p></div>
    ${figures(r, { questions: EX.questions }, { run: 1, threshold: store.prefs.threshold })}
    <p class="help">${caption}</p>`;
  const g = $('.figs', box); if (g) g.style.gridTemplateColumns = 'minmax(0, 1fr)';
  animate(box);
}

const GATE_ITEMS = [
  ['明确的退款请求（账单类）', 0.97], ['密码重置邮件', 0.93], ['愤怒差评、主题混杂', 0.71],
  ['西班牙语错误报告', 0.88], ['含糊的「不好用」', 0.46], ['夹杂真实问题的垃圾邮件', 0.62],
];
function renderGate(th) {
  const box = $('#gatedemo', root);
  const acted = GATE_ITEMS.filter(([, p]) => p >= th).length;
  box.innerHTML = `<label class="field"><span class="label">${term('threshold', '执行阈值')}: <b class="num">${fmtPct(th)}</b></span>
      <input type="range" min="0.4" max="0.99" step="0.01" value="${th}" id="gth" aria-label="执行阈值"></label>
    <div style="display:grid;gap:4px">${GATE_ITEMS.map(([t, p]) => `<div class="gate-row"><span>${esc(t)}</span><span class="num muted">${fmtPct(p)}</span>
      <span class="gate ${p >= th ? 'act' : 'ask'}" style="display:inline-flex;gap:6px;align-items:center;font-weight:600">${icon(p >= th ? 'act' : 'ask')}${p >= th ? '自动执行' : '需人工'}</span></div>`).join('')}</div>
    <p class="small muted"><b style="color:var(--text)">${acted} / ${GATE_ITEMS.length}</b> 条自动处理。阈值越高误判越少、人工越多；这种权衡称为 ${term('cascade', '级联')}。</p>`;
  const s = $('#gth', box);
  s.addEventListener('input', () => { renderGate(+s.value); $('#gth', root).focus(); });
}

function renderPath() {
  const box = $('#path', root);
  if (!box) return;
  const st = store.state;
  const L = store.prefs.learned || {};
  const steps = [
    [st?.models.some((m) => m.downloaded), '下载模型', 'Laya 最受欢迎（850 MB）。Intern-Decision 4B 综合最佳。', '#/models', '模型'],
    [st?.models.some((m) => m.worker?.status === 'ready'), '加载到内存', '小模型数秒，最大模型约一两分钟。', '#/models', '模型'],
    [L.ran, '运行首次决策', '从示例开始，改文本并观察概率变化。', '#/playground', '试验台'],
    [L.evaluated, '用自有示例测评', '在标注示例上评分，校正过度自信并选择安全阈值。', '#/evaluate', '评测'],
    [L.code, '在代码中调用', '复制与你构建的请求一致的现成代码片段。', '#/api', 'API'],
  ];
  box.innerHTML = steps.map(([done, t, d, href, cta], i) => `<li class="${done ? 'done' : ''}"><span class="n">${done ? icon('check') : i + 1}</span><div><b>${t}</b><span>${d}</span></div><a class="btn sm ${done ? 'btn-quiet' : ''}" href="${href}">${cta}</a></li>`).join('');
}
