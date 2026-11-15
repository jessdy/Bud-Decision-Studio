// What each model is made for, in one line, plus its own placeholders and signature examples (ids in examples.js,
// best first). The Playground uses these so that choosing a model shows what it is good at straight away: CLM opens
// on an agent choosing its next action, Jev-Omni on an image, Lev on a question with 77 options.

export const GUIDES = {
  'julia-1': {
    madeFor: '将消息快速路由到正确团队，支持 50+ 种语言，在笔记本 CPU 上也很快。',
    state: '粘贴任意语言的客户消息：邮件、聊天或工单。',
    q: { choice: '应由哪支团队处理这条消息？', noul: '客户是否需要在今天得到回复？' },
    examples: ['de-routing', 'multilingual'],
  },
  'laya-multilingual': {
    madeFor: '100+ 种语言的客户消息与内容审核，含日文、阿拉伯文、印地文等文字。',
    state: '粘贴任意语言的消息，例如日语、阿拉伯语、印地语或西班牙语。',
    q: { choice: '应由哪个部门处理？', noul: '客户是否在请求紧急帮助？' },
    examples: ['ja-support', 'multilingual'],
  },
  laya: {
    madeFor: '快速英文分流与护栏：工单路由、评论审核、识别提示注入。',
    state: '粘贴英文邮件、工单、评论或聊天消息（约 350 词以内）。',
    q: { choice: '应由哪支团队处理？', noul: '消息是否试图向 AI 助手下达指令？' },
    examples: ['support', 'moderation', 'injection'],
  },
  'laya-typed-decisions': {
    madeFor: '业务工作流：核对发票、分流安全告警、路由支持、审计 AI 智能体行为。',
    state: '粘贴发票、安全告警、支持消息或 AI 智能体对话记录。',
    q: { noul: '智能体是否遵守策略？', choice: '这是哪类文档？' },
    examples: ['agent-trace', 'invoice-match', 'security-alert'],
  },
  'kev-0.5b': {
    madeFor: '学习决策模型如何工作，适合银行意图、新闻主题与评论星级等场景。',
    state: '粘贴简短的银行消息、新闻标题或产品评论。',
    q: { choice: '客户属于哪种银行意图？', score: '评论者会给几颗星？' },
    examples: ['banking77', 'news-topic'],
  },
  'gliner2.5-decide': {
    madeFor: '快速运营标签（意图、情感、主题、文档类型、紧急度），CPU 上也能跑。',
    state: '粘贴邮件、日志行、消息或待打标签的文档。',
    q: { choice: '哪个标签最贴切？', multi: '适用哪些标签？', noul: '是否需要人工跟进？' },
    examples: ['log-line', 'tags'],
  },
  'intern-decision-4b': {
    madeFor: '强力全能型，还可阅读截图、照片与图表。',
    state: '描述情境，或附加图像并说明其内容。',
    q: { choice: '图像显示什么？', noul: '截图是否包含错误信息？' },
    examples: ['tour', 'image', 'chart'],
  },
  'kev-4b': {
    madeFor: '适用含例外条款的长策略，以及最多 255 个选项的单选；不确定时会说明。',
    state: '粘贴策略与待判案例。含 "policy" 与 "request" 的 JSON 效果很好。',
    q: { noul: '按此策略客户是否有权退款？', choice: '哪条规则决定本案？' },
    examples: ['policy-refund', 'code', 'banking77'],
  },
  lev: {
    madeFor: '在数百个选项（意图、类别、编码）中择一，并对照来源核查陈述。',
    state: '粘贴待分类的消息。Lev 可在单个问题中处理最多 500 个选项。',
    q: { choice: '客户属于哪种意图？', noul: '回答是否陈述了来源未包含的内容？' },
    examples: ['banking77', 'verify'],
  },
  'clm-v0.1-8b': {
    madeFor: 'AI 智能体：从众多候选（最多 1,000）中选择下一步动作或工具。',
    tip: '每个选项写成动作（如「重新安排会议」），并问「智能体下一步应做什么？」。CLM 将情境与每个动作对比；是/否与排序类问题并非其强项。',
    state: '描述智能体目标、已完成步骤与当前所见。',
    q: { choice: '智能体下一步应做什么？' },
    examples: ['agent-browser', 'tool-call', 'text-game'],
  },
  'jev-omni': {
    madeFor: '最难的问题，并支持图像、音频（最长 30 秒）与视频（16 帧）。',
    state: '描述情境，并附加照片、语音备忘或短视频。',
    q: { choice: '图像显示什么？', noul: '说话者听起来是否难过？' },
    examples: ['image', 'chart', 'verify'],
  },
};

export const guideFor = (id) => GUIDES[id] || null;