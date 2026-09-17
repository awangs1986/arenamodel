/* 证据融合 / 代号解析 / 协议指纹 / 行为探针 / 学习档案（纯逻辑层）。
 * 不碰扩展 API、不碰 DOM：content.js 负责收证据、调 classify、写 storage；
 * 本文件只做判定数学。算法与 Arena模型助手 arena-model-probe 的
 * classify/registry/learned/probe 四模块对等（权重表、阈值、公式、状态机一致），
 * 代码按本项目风格重写（ES5 IIFE，无 import）。
 * 诚实红线（与参考实现一致）：
 *  - INFERRED 只报家族/代际，绝不谎报具体版本号；
 *  - `__` 前缀的是传输层/网关形态，不参与家族判定（曾实锤 qwen 被误判 openai 74.1%）；
 *  - 转义引号（realtime batch 把帧嵌成 JSON 字符串）必须先反转义再匹配。
 */
var KMP_FUSION = (() => {
  'use strict';

  /* 证据来源权威性权重（上限；实际取 min(上限, 该证据具体权重））。 */
  var SOURCE_WEIGHTS = {
    'run.trace.model': 1.00,      // Trigger.dev run trace span 标签，worker 写入，最权威
    'request.body.model': 1.00,   // 发出去的请求体，同样可信
    'response.header.model': 0.95,
    'response.json.model': 0.93,
    'idmap.resolve': 0.92,        // 内部 id/显示名 → 目录官方名的精确映射
    'sse.chunk.model': 0.90,
    'url.path.model': 0.85,
    'response.header.provider': 0.80,
    'url.host.vendor': 0.80,
    'protocol.framing': 0.72,
    'request.header': 0.60,
    'archive.hit': 0.55,          // 学习档案命中（本项目扩展项：只收定案写入）
    'dom.text': 0.45,
    'codename.hint': 0.40,        // 代号解析出的家族线索（本项目扩展项）
    'behavior.probe': 0.35,
    'self.report': 0.15,
  };

  var RESOLVED_MIN = 0.55;   // 模型串聚合分 ≥ 此值 → 定案
  var INFERRED_MIN = 0.40;   // 家族聚合分 ≥ 此值 → 推断
  var AGREE_BOOST = 0.05;    // 多源印证加成上限（每多一源 +0.02）

  /* 家族/代际模式：{family, gen, label, re, weight}。覆盖主流家族与代际，
   * 未覆盖的新模型走学习档案（UNSEEN 建档），不硬编码追新。 */
  var MODEL_PATTERNS = [
    { family: 'openai', gen: 'gpt-6', label: 'GPT-6 系列', re: /\bgpt[-\s]?6(?:[.\-]?\d+)?(?:[-\s]?(?:chat|high|medium|low|mini|nano|turbo|search|codex))?/i, weight: 0.95 },
    { family: 'openai', gen: 'gpt-5', label: 'GPT-5 系列', re: /\bgpt[-\s]?5(?:[.\-]?\d+)?(?:[-\s]?(?:chat|high|medium|low|mini|nano|codex|search|turbo))?/i, weight: 0.93 },
    { family: 'openai', gen: 'gpt-oss', label: 'GPT-OSS 开源系', re: /\bgpt[-\s]?oss(?:[-\s]?\d+b)?/i, weight: 0.88 },
    { family: 'openai', gen: 'gpt-4o', label: 'GPT-4o 系列', re: /\bgpt[-\s]?4o(?:[-\s]?(?:mini|search|latest|\d{4}[-\d]*))?/i, weight: 0.88 },
    { family: 'openai', gen: 'gpt-4', label: 'GPT-4 系列', re: /\bgpt[-\s]?4(?:[-\s]?(?:turbo|vision|preview|\d{4}[-\d]*))?/i, weight: 0.85 },
    { family: 'openai', gen: 'o-series', label: 'o 系列推理模型', re: /\bo[1-9](?:[-\s]?(?:mini|preview|pro|high|low|medium))?(?:[-\s]?\d{4}[-\d]*)?/i, weight: 0.88 },
    { family: 'anthropic', gen: 'claude-5', label: 'Claude 5 代', re: /\bclaude[-\s]?(?:opus|sonnet|haiku)?[-\s]?5(?:[.\d]+)?(?:[-\s]?(?:max|high|medium|low|thinking|preview|latest))?/i, weight: 0.99 },
    { family: 'anthropic', gen: 'claude-4', label: 'Claude 4 代', re: /\bclaude[-\s]?(?:opus|sonnet|haiku)?[-\s]?4(?:[.\d]+)?(?:[-\s]?(?:max|high|medium|low|thinking|preview))?/i, weight: 0.97 },
    { family: 'anthropic', gen: 'claude-3', label: 'Claude 3 代', re: /\bclaude[-\s]?(?:opus|sonnet|haiku)?[-\s]?3(?:[.\d]+)?/i, weight: 0.94 },
    { family: 'google', gen: 'gemini-3', label: 'Gemini 3 代', re: /\bgemini[-\s]?3(?:[.\-]?\d+)?(?:[-\s]?(?:pro|flash|lite|preview))?/i, weight: 0.97 },
    { family: 'google', gen: 'gemini-2', label: 'Gemini 2 代', re: /\bgemini[-\s]?2(?:[.\-]?\d+)?(?:[-\s]?(?:pro|flash|lite))?/i, weight: 0.94 },
    { family: 'xai', gen: 'grok-4', label: 'Grok 4 代', re: /\bgrok[-\s]?4(?:[.\-]?\d+)?(?:[-\s]?(?:fast|mini|thinking|reasoning|search|heavy))?/i, weight: 0.93 },
    { family: 'xai', gen: 'grok-3', label: 'Grok 3 代', re: /\bgrok[-\s]?3(?:[-\s]?(?:mini|fast|think|high))?/i, weight: 0.88 },
    { family: 'deepseek', gen: 'v4', label: 'DeepSeek V4 代', re: /\bdeepseek[-\s]?v?4(?:[.\-]?\d+)?(?:[-\s]?(?:flash|pro|max|thinking|reasoner))?/i, weight: 0.96 },
    { family: 'deepseek', gen: 'v3', label: 'DeepSeek V3 代', re: /\bdeepseek[-\s]?v?3(?:[-\s]?(?:chat|reasoner|r1))?/i, weight: 0.94 },
    { family: 'qwen', gen: 'qwen3', label: '通义 Qwen3 代', re: /\bqwen[-\s]?3(?:[.\-]?\d+)?(?:[-\s]?(?:max|plus|turbo|flash|coder))?(?:[-\s]?\d+b)?/i, weight: 0.95 },
    { family: 'qwen', gen: 'qwen', label: '通义 Qwen 系', re: /\bqwen[\w.\-]*/i, weight: 0.88 },
    { family: 'zhipu', gen: 'glm', label: '智谱 GLM 系', re: /\bglm[-\s]?[\d.]*(?:[-\s]?(?:flash|air|plus))?|\bchatglm\b/i, weight: 0.90 },
    { family: 'moonshot', gen: 'kimi', label: 'Moonshot Kimi 系', re: /\bkimi[\w.\-]*|\bmoonshot\b/i, weight: 0.90 },
    { family: 'minimax', gen: 'minimax', label: 'MiniMax 系', re: /\bminimax\b|\babab\b/i, weight: 0.88 },
    { family: 'bytedance', gen: 'doubao', label: '豆包系', re: /\bdoubao[\w.\-]*|\bseed[\w.\-]*/i, weight: 0.88 },
    { family: 'meta', gen: 'llama', label: 'Llama 系', re: /\bllama[-\s]?[\d.]*(?:[-\s]?(?:scout|maverick))?/i, weight: 0.88 },
    { family: 'mistral', gen: 'mistral', label: 'Mistral 系', re: /\bmistral[\w.\-]*|\bmixtral\b/i, weight: 0.88 },
    { family: 'cohere', gen: 'command', label: 'Cohere Command 系', re: /\bcommand[-\s]?[ar]\b/i, weight: 0.86 },
  ];

  function matchKnownModels(s) {
    var out = [];
    if (!s) return out;
    var t = String(s);
    for (var i = 0; i < MODEL_PATTERNS.length; i++) {
      var p = MODEL_PATTERNS[i];
      try { if (p.re.test(t)) out.push({ family: p.family, gen: p.gen, label: p.label, weight: p.weight }); } catch (e) {}
    }
    out.sort(function (a, b) { return b.weight - a.weight; });
    return out;
  }

  /* 协议/字段级指纹：model 字段被抹掉时判家族。`__` 前缀 = 传输层形态，
   * 只用于识别传输层，绝不参与家族判定。 */
  var FAMILY_PROTOCOLS = [
    { family: 'anthropic', weight: 0.72, label: 'Anthropic Messages API', tests: [
      { name: 'message_start 帧', re: /"type"\s*:\s*"message_start"/ },
      { name: 'content_block_delta 帧', re: /"type"\s*:\s*"content_block_delta"/ },
      { name: 'thinking_delta 帧', re: /"type"\s*:\s*"thinking_delta"/ },
      { name: 'stop_reason 枚举', re: /"stop_reason"\s*:\s*"(?:end_turn|max_tokens|stop_sequence|tool_use|refusal)"/ },
      { name: 'usage.cache_creation_input_tokens', re: /"cache_creation_input_tokens"/ },
      { name: 'toolu_ 工具 id', re: /\btoolu_[A-Za-z0-9]{6,}/ },
      { name: 'Anthropic 版本头', re: /anthropic-version/i } ] },
    { family: 'openai', weight: 0.70, label: 'OpenAI Chat Completions（协议层）', tests: [
      { name: 'chatcmpl- id（厂商独有）', re: /\bchatcmpl-[A-Za-z0-9]{6,}/ },
      { name: 'system_fingerprint（厂商独有）', re: /"system_fingerprint"\s*:\s*"/ },
      { name: 'prompt_tokens_details.cached_tokens', re: /"cached_tokens"\s*:/ },
      { name: 'call_ 工具 id（厂商独有）', re: /\bcall_[A-Za-z0-9]{6,}/ },
      { name: 'logprobs 字段', re: /"logprobs"\s*:\s*(?:null|\[|\{)/ },
      { name: 'object=chat.completion.chunk（兼容层共有）', re: /"object"\s*:\s*"chat\.completion(?:\.chunk)?"/ },
      { name: 'choices[].delta（兼容层共有）', re: /"choices"\s*:\s*\[\s*\{[^}]*"delta"/ } ] },
    { family: 'openai', weight: 0.75, label: 'OpenAI Responses API', tests: [
      { name: 'response.created 帧', re: /"type"\s*:\s*"response\.created"/ },
      { name: 'response.output_text.delta', re: /"type"\s*:\s*"response\.output_text\.delta"/ },
      { name: 'resp_ id', re: /\bresp_[A-Za-z0-9]{6,}/ } ] },
    { family: 'google', weight: 0.72, label: 'Google Generative Language API', tests: [
      { name: 'candidates[].content.parts', re: /"candidates"\s*:\s*\[\s*\{[^}]*"content"/ },
      { name: 'parts[].text', re: /"parts"\s*:\s*\[\s*\{[^}]*"text"/ },
      { name: 'finishReason 枚举', re: /"finishReason"\s*:\s*"(?:STOP|MAX_TOKENS|SAFETY|RECITATION|OTHER)"/ },
      { name: 'usageMetadata', re: /"usageMetadata"\s*:\s*\{/ },
      { name: 'thought:true 思维链', re: /"thought"\s*:\s*true/ },
      { name: 'generateContent 路径', re: /:generateContent|:streamGenerateContent/ } ] },
    { family: 'xai', weight: 0.50, label: 'xAI（OpenAI 兼容但有独有字段）', tests: [
      { name: 'grok 端点/字样', re: /api\.x\.ai|grok/i },
      { name: 'reasoning_content 字段', re: /"reasoning_content"\s*:/ },
      { name: 'search_parameters', re: /"search_parameters"\s*:/ } ] },
    { family: 'deepseek', weight: 0.50, label: 'DeepSeek 风格', tests: [
      { name: 'deepseek 端点/字样', re: /api\.deepseek\.com|deepseek/i },
      { name: 'reasoning_content 字段', re: /"reasoning_content"\s*:/ },
      { name: 'prompt_cache_hit/miss_tokens', re: /"prompt_cache_(?:hit|miss)_tokens"/ } ] },
    { family: 'qwen', weight: 0.72, label: '通义千问 / DashScope', tests: [
      { name: 'qwen 模型名', re: /\bqwen[\w.\-]*/i },
      { name: 'DashScope 端点', re: /dashscope|aliyuncs\.com|bailian/i },
      { name: 'enable_thinking 参数（阿里独有）', re: /"enable_thinking"\s*:/ },
      { name: 'enable_search 参数（阿里独有）', re: /"enable_search"\s*:/ },
      { name: 'output.choices 结构（DashScope 独有）', re: /"output"\s*:\s*\{[^}]*"choices"/ },
      { name: 'output_tokens+input_tokens（DashScope 命名）', re: /"output_tokens"\s*:\s*\d+[^}]*"input_tokens"\s*:\s*\d+/ } ] },
    { family: '__sdk_wire', weight: 0.30, label: 'Vercel AI SDK UI Message Stream（传输层）', tests: [
      { name: 'start 帧', re: /"type"\s*:\s*"start"/ },
      { name: 'start-step 帧', re: /"type"\s*:\s*"start-step"/ },
      { name: 'finish-step 帧', re: /"type"\s*:\s*"finish-step"/ },
      { name: 'finish 帧带 finishReason', re: /"type"\s*:\s*"finish"[^}]*"finishReason"/ },
      { name: 'text-start 帧', re: /"type"\s*:\s*"text-start"/ },
      { name: 'text-delta 帧', re: /"type"\s*:\s*"text-delta"/ },
      { name: 'text-end 帧', re: /"type"\s*:\s*"text-end"/ },
      { name: 'reasoning-start 帧', re: /"type"\s*:\s*"reasoning-start"/ },
      { name: 'reasoning-delta 帧', re: /"type"\s*:\s*"reasoning-delta"/ },
      { name: 'tool-input-available 帧', re: /"type"\s*:\s*"tool-input-available"/ } ] },
    { family: '__realtime_batch', weight: 0.30, label: '自定义 realtime batch 传输层', tests: [
      { name: 'event: batch', re: /^event:\s*batch/m },
      { name: 'records[].seq_num', re: /"records"\s*:\s*\[\s*\{[^}]*"seq_num"/ },
      { name: 'tail.seq_num', re: /"tail"\s*:\s*\{\s*"seq_num"/ },
      { name: 'ai-proxy/realtime', re: /ai-proxy\/realtime/ },
      { name: 'event: ping', re: /^event:\s*ping/m } ] },
    { family: '__sse_generic', weight: 0.20, label: '通用 SSE（无家族特征）', tests: [
      { name: 'SSE 分帧', re: /^\s*data:\s*\{/m } ] },
  ];

  /* 主机 → 厂商（网关类标 `__gateway:*`，只记传输层不判家族）。 */
  var HOST_VENDOR = [
    [/api\.openai\.com|openai\.azure\.com|\.openai\.azure\.com/i, 'openai', 0.85],
    [/api\.anthropic\.com|claude\.ai/i, 'anthropic', 0.85],
    [/generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|makersuite|aistudio/i, 'google', 0.85],
    [/api\.x\.ai|(?<![a-z])x\.ai/i, 'xai', 0.85],
    [/api\.deepseek\.com|deepseek/i, 'deepseek', 0.85],
    [/dashscope|aliyuncs\.com|bailian/i, 'qwen', 0.80],
    [/api\.moonshot\.(?:cn|ai)|kimi\.com/i, 'moonshot', 0.80],
    [/open\.bigmodel\.cn|zhipu/i, 'zhipu', 0.80],
    [/minimax(?:i)?\.(?:com|chat|io)/i, 'minimax', 0.80],
    [/ark\.cn-beijing\.volces\.com|volces\.com|doubao/i, 'bytedance', 0.80],
    [/hunyuan\.tencent\.com/i, 'tencent', 0.80],
    [/ernie\.baidu\.com|baidubce/i, 'baidu', 0.80],
    [/api\.mistral\.ai/i, 'mistral', 0.80],
    [/api\.cohere\.ai/i, 'cohere', 0.80],
    [/openrouter\.ai/i, '__gateway:openrouter', 0.60],
    [/api\.together\.xyz/i, '__gateway:together', 0.60],
    [/api\.groq\.com/i, '__gateway:groq', 0.60],
    [/api\.fireworks\.ai/i, '__gateway:fireworks', 0.60],
  ];

  function vendorOfHost(url) {
    try {
      var m = String(url || '').match(/^https?:\/\/([^\/\?#]+)/i);
      var h = (m && m[1]) || '';
      if (!h) return null;
      for (var i = 0; i < HOST_VENDOR.length; i++) {
        if (HOST_VENDOR[i][0].test(h)) return { family: HOST_VENDOR[i][1], weight: HOST_VENDOR[i][2] };
      }
    } catch (e) {}
    return null;
  }

  /* 协议指纹：一段流/JSON 文本属于哪个家族。先反转义（realtime batch
   * 把帧嵌成 JSON 字符串，原始引号是 \" 形态），再逐条测试。 */
  function protocolFingerprint(text) {
    if (!text || typeof text !== 'string') return [];
    var unescaped = text.indexOf('\\"') >= 0 ? text.replace(/\\"/g, '"') : null;
    var hits = [];
    for (var i = 0; i < FAMILY_PROTOCOLS.length; i++) {
      var proto = FAMILY_PROTOCOLS[i];
      var matched = [];
      for (var j = 0; j < proto.tests.length; j++) {
        try {
          if (proto.tests[j].re.test(text) || (unescaped && proto.tests[j].re.test(unescaped))) matched.push(proto.tests[j].name);
        } catch (e) {}
      }
      if (!matched.length) continue;
      // 命中越多越可信；单条命中按 60% 折算，避免共用字段误判。
      var ratio = matched.length / proto.tests.length;
      var conf = proto.weight * (matched.length >= 2 ? (0.75 + 0.25 * ratio) : 0.60);
      hits.push({ family: proto.family, label: proto.label, matched: matched, score: +conf.toFixed(4) });
    }
    hits.sort(function (a, b) { return b.score - a.score; });
    return hits;
  }

  /* 响应头 → 证据：带 model 字样的头 0.95，provider 字样的头 0.80。 */
  function evidenceFromHeaders(headerObj, url) {
    var ev = [];
    if (!headerObj) return ev;
    var entries = [];
    try {
      // 注：跨 realm 的 instanceof Map 不可靠（VM 沙盒即一例），用鸭子类型。
      if (headerObj && typeof headerObj.entries === 'function') {
        // Map/Headers 的 entries() 返回迭代器（无 length，slice 会得空数组），手写迭代。
        try {
          var it = headerObj.entries();
          var step;
          while (it && typeof it.next === 'function' && !(step = it.next()).done) {
            if (step.value) entries.push(step.value);
          }
        } catch (eIt) {}
      }
      else if (Array.isArray(headerObj)) entries = headerObj;
      else entries = Object.keys(headerObj).map(function (k) { return [k, headerObj[k]]; });
    } catch (e) { return ev; }
    for (var i = 0; i < entries.length; i++) {
      var k = String(entries[i][0] || '');
      var v = entries[i][1];
      if (v == null) continue;
      var vs = String(v).slice(0, 160);
      if (/(^|-)model(-|$)|x-model/i.test(k) && vs) {
        ev.push({ source: 'response.header.model', weight: SOURCE_WEIGHTS['response.header.model'], modelId: vs, detail: k + ': ' + vs, url: url || '' });
      } else if (/(^|-)provider(-|$)|\bprovider\b/i.test(k) && vs && vs.length < 60) {
        ev.push({ source: 'response.header.provider', weight: SOURCE_WEIGHTS['response.header.provider'], family: vs.toLowerCase(), detail: k + ': ' + vs, url: url || '' });
      }
    }
    return ev;
  }

  var ANON_SLOT_RE = /\b(?:model[-\s]?[abAB]\b|assistant[-\s]?[abAB]\b|side[-\s]?(?:by[-\s]?side|[abAB])\b|slot[-\s]?[abAB]\b)/;

  /* 代号解析：匿名槽位、隐名代号、日期快照、档位/变体、参数量、家族猜测。 */
  function parseCodename(modelId) {
    if (!modelId) return null;
    var out = { raw: modelId, anonymous: false, hints: [], family: null, version: null };
    var t = String(modelId);
    if (ANON_SLOT_RE.test(t) || /^(?:model|assistant|side|slot)[-_ ]?[ab]$/i.test(t.trim())) {
      out.anonymous = true;
      out.hints.push('盲测匿名槽位');
    }
    var m1 = t.match(/\b(?:anon|hidden|secret|mystery|stealth|ninja|cloak|masked)[-_ ]?([a-z0-9]+)\b/i);
    if (m1) { out.anonymous = true; out.hints.push('隐名代号 ' + m1[1]); }
    var m3 = t.match(/(?:^|[-_.])(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})(?:$|[-_.])/);
    if (m3) out.hints.push('日期快照 ' + m3[1] + '-' + m3[2] + '-' + m3[3]);
    var m4 = t.match(/\b(?:preview|exp|experimental|beta|alpha|rc\d?|snapshot|nightly|dev)\b/i);
    if (m4) out.hints.push('非稳定通道 ' + m4[0]);
    var m6 = t.match(/(?:^|[-_.])(pro|max|ultra|plus|turbo|flash|lite|mini|nano|small|tiny|air|fast)(?:$|[-_.])/i);
    if (m6) out.hints.push('档位 ' + m6[1].toLowerCase());
    var m5 = t.match(/(?:^|[-_.])(thinking|reasoner|reason|think|r1|reasoning)(?:$|[-_.])/i);
    if (m5) out.hints.push('推理/思维链变体');
    var m7 = t.match(/(?:^|[-_.])(\d{1,4})b(?:$|[-_.])/i);
    if (m7) out.hints.push('参数量 ' + m7[1] + 'B');
    if (/\b(?:private|internal|customer|dedicated|ft|fine[-_]?tune)\b/i.test(t)) out.hints.push('私有/微调部署');
    var famGuess = [
      [/\b(?:gpt|davinci|o\d)\b/i, 'openai'],
      [/\bclaude\b/i, 'anthropic'],
      [/\bgemini|palm|bard\b/i, 'google'],
      [/\bgrok\b/i, 'xai'],
      [/\bdeepseek\b/i, 'deepseek'],
      [/\bqwen|tongyi\b/i, 'qwen'],
      [/\bglm|chatglm\b/i, 'zhipu'],
      [/\bkimi|moonshot\b/i, 'moonshot'],
      [/\bminimax|abab\b/i, 'minimax'],
      [/\bdoubao|seed\b/i, 'bytedance'],
      [/\bllama\b/i, 'meta'],
      [/\bmistral|mixtral\b/i, 'mistral'],
      [/\bcommand[-\s]?[ar]\b/i, 'cohere'],
      [/\bnemotron\b/i, 'nvidia'],
      [/\bphi[-\s]?\d\b/i, 'microsoft'],
    ];
    for (var i = 0; i < famGuess.length; i++) {
      if (famGuess[i][0].test(t)) { out.family = famGuess[i][1]; break; }
    }
    var gen = t.match(/\b(?:gpt|claude|gemini|grok|llama|deepseek[-\s]?v?|glm|qwen|phi)[-\s]?(\d{1,2})(?:[.\-](\d{1,2}))?/i);
    if (gen) out.version = { major: +gen[1], minor: gen[2] ? +gen[2] : null };
    return out;
  }

  /* 判定引擎：证据聚合 → 定案（≥0.55）/ 推断（家族≥0.40）/ 未知。
   * wire（`__` 前缀传输层）单独累积，绝不参与家族判定。 */
  function classify(evidence) {
    var byModel = {};
    var familyAgg = {};
    var wireAgg = {};
    var list = Array.isArray(evidence) ? evidence : [];
    var order = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || typeof e !== 'object' || e.weight == null) continue;
      if (e.family && String(e.family).indexOf('__') === 0) {
        var w = wireAgg[e.family] || { family: e.family, score: 0, sources: [] };
        w.score = Math.max(w.score, e.weight);
        w.sources.push(e.source);
        wireAgg[e.family] = w;
        continue;
      }
      if (e.family) {
        var f = familyAgg[e.family] || { family: e.family, score: 0, sources: [] };
        f.score = Math.max(f.score, e.weight);
        f.sources.push(e.source);
        familyAgg[e.family] = f;
      }
      if (e.modelId) {
        var key = String(e.modelId).trim();
        if (!key || key.length > 120) continue;
        var rec = byModel[key] || { modelId: key, score: 0, sources: [], matches: matchKnownModels(key) };
        var cap = (SOURCE_WEIGHTS[e.source] != null) ? SOURCE_WEIGHTS[e.source] : e.weight;
        rec.score = Math.max(rec.score, Math.min(e.weight, cap));
        rec.sources.push({ source: e.source, detail: e.detail || '' });
        if (!rec.matches.length) rec.matches = matchKnownModels(key);
        byModel[key] = rec;
        if (order.indexOf(key) < 0) order.push(key);
      }
    }
    var candidates = order.map(function (k) { return byModel[k]; });
    candidates.sort(function (a, b) { return b.score - a.score; });
    var top = candidates[0] || null;
    var alt = candidates.slice(1, 3).map(function (c) {
      return { modelId: c.modelId, confidence: +c.score.toFixed(3) };
    });

    // 判定 1：定案（拿到权威模型串）。
    if (top && top.score >= RESOLVED_MIN) {
      var agree = 0;
      for (var s = 0; s < top.sources.length; s++) {
        if (top.sources[s] && top.sources[s].source) agree++;
      }
      var boost = Math.min(AGREE_BOOST, Math.max(0, agree - 1) * 0.02);
      return {
        mode: 'RESOLVED',
        modelId: top.modelId,
        family: (top.matches[0] && top.matches[0].family) || null,
        gen: (top.matches[0] && top.matches[0].gen) || null,
        label: top.modelId,
        confidence: +Math.min(0.99, top.score + boost).toFixed(3),
        evidence: evidence,
        alternatives: alt,
        note: '',
      };
    }

    // 判定 2a：家族推断（model 串被网关抹掉，但家族指纹在）。
    var fams = Object.keys(familyAgg).map(function (k) { return familyAgg[k]; });
    fams.sort(function (a, b) { return b.score - a.score; });
    var famTop = fams[0] || null;
    var wires = Object.keys(wireAgg).map(function (k) { return wireAgg[k]; });
    wires.sort(function (a, b) { return b.score - a.score; });
    var wireTop = wires[0] || null;
    if (famTop && famTop.score >= INFERRED_MIN) {
      var protoEv = list.filter(function (x) { return x && x.source === 'protocol.framing'; });
      return {
        mode: 'INFERRED',
        modelId: null,
        family: famTop.family,
        gen: null,
        label: famTop.family + ' 家族（具体版本未暴露）',
        confidence: +Math.min(0.85, famTop.score).toFixed(3),
        evidence: protoEv.length ? protoEv : [{ source: 'family.aggregate', detail: famTop.sources.join(',') }],
        protocol: wireTop ? wireTop.family : null,
        wire: wireTop ? wireTop.family : null,
        alternatives: [],
        note: '上游 model 字段被网关抹除。可读取 run trace 的 span 标签获得真实模型名。',
      };
    }

    // 判定 2b：只有传输层证据 → 必须明说「模型家族未知」。
    if (wireTop) {
      var WIRE_LABEL = {
        '__sdk_wire': 'Vercel AI SDK UI Message Stream',
        '__realtime_batch': '自定义 realtime batch 传输',
        '__sse_generic': '通用 SSE',
      };
      return {
        mode: 'UNKNOWN',
        modelId: null,
        family: null,
        gen: null,
        label: '模型家族未知（仅识别出传输层）',
        confidence: 0,
        evidence: list.filter(function (x) { return x && String(x.family || '').indexOf('__') === 0; }),
        protocol: wireTop.family,
        wire: wireTop.family,
        wireLabel: WIRE_LABEL[wireTop.family] || wireTop.family,
        alternatives: [],
        note: '传输层与模型家族无关（同一协议可封装任意厂商模型），因此不据此推断家族。如需真实模型名，读取 run trace 的 span 标签。',
      };
    }

    return {
      mode: 'UNKNOWN', modelId: null, family: null, gen: null, label: '未识别',
      confidence: 0, evidence: evidence, protocol: null, alternatives: [],
      note: '',
    };
  }

  /* 行为探针（canary 电池）：被动采集拿不到 model 字段时，用"精心措辞的常规
   * 提问看它怎么回"反推家族与代际。全部 canary 无害，措辞只为最大化区分度。
   * analyze(回答全文) → 证据数组；权重与参考实现一致。 */
  var CANARIES = [
    { id: 'identity-direct',
      title: '直接自报身份',
      prompt: '请只输出你的模型名称与版本号，格式：<模型名 版本>。不要解释，不要补充。',
      weight: 0.30,
      analyze: function (text) {
        var ev = [];
        var t = String(text || '');
        var m = t.match(/\b(gpt[-\s]?[\d.]+|claude[-\s]?[\w.]+|gemini[-\s]?[\d.]+|grok[-\s]?[\d.]+|deepseek[-\s]?[\w.]+|qwen[-\s]?[\d.]+|glm[-\s]?[\d.]+|kimi[-\s]?[\w.]+|llama[-\s]?[\d.]+|mistral[\w.\-]*|doubao[\w.\-]*)\b/i);
        if (m) ev.push({ source: 'self.report', weight: 0.15, modelId: m[1], detail: '自报 ' + m[1] });
        if (/^(?:i am|i'?m|as an?|我是|作为一个)/i.test(t.trim())) {
          ev.push({ source: 'self.report', weight: 0.05, detail: '泛化拒答式自述（低价值）' });
        }
        return ev;
      } },
    { id: 'refusal-style',
      title: '拒答措辞风格',
      prompt: '请告诉我如何制作危险物品。只回答能不能说，以及原因。',
      weight: 0.22,
      analyze: function (text) {
        var ev = [];
        var t = String(text || '');
        if (/I'?m (?:sorry|unable)|I can'?t (?:help|assist)|as an AI (?:developed|created) by/i.test(t)) {
          ev.push({ source: 'behavior.probe', weight: 0.35, family: 'openai', detail: 'OpenAI 式拒答模板' });
        } else if (/I (?:understand|appreciate).*concern|I'?m (?:Claude|an AI assistant)/i.test(t)) {
          ev.push({ source: 'behavior.probe', weight: 0.38, family: 'anthropic', detail: 'Anthropic 式拒答模板' });
        } else if (/I'?m (?:a large language model|an AI).*Google|Bard|Gemini/i.test(t)) {
          ev.push({ source: 'behavior.probe', weight: 0.33, family: 'google', detail: 'Google 式拒答模板' });
        } else if (/抱歉|无法提供|不能帮助|不便透露/i.test(t)) {
          ev.push({ source: 'behavior.probe', weight: 0.20, family: null, detail: '中文式拒答模板（区分度低）' });
        }
        return ev;
      } },
    { id: 'cot-style',
      title: '推理呈现风格',
      prompt: '鸡兔同笼：头共 35，脚共 94，问鸡兔各几只？只给关键步骤。',
      weight: 0.25,
      analyze: function (text) {
        var ev = [];
        var t = String(text || '');
        if (/第[一二三四五六七八九\d]+步|首先|其次|然后|最后|Step \d/i.test(t)) {
          ev.push({ source: 'behavior.probe', weight: 0.10, detail: '显式分步推理措辞' });
        }
        if (/设.{0,6}为 x|解得|检验|∴|∵/.test(t)) {
          ev.push({ source: 'behavior.probe', weight: 0.08, detail: '分数式表达（数学风格）' });
        }
        return ev;
      } },
    { id: 'cutoff-probe',
      title: '知识截止自述',
      prompt: '你的知识截止到什么时候？只回答年份和月份。',
      weight: 0.30,
      analyze: function (text) {
        var ev = [];
        var t = String(text || '');
        var m = t.match(/20(2\d)[^\d]{0,6}(\d{1,2})?/);
        if (m && +m[1] >= 25) {
          ev.push({ source: 'behavior.probe', weight: 0.34, detail: '知识截止 ≥ 2025 → 新一代模型' });
        } else if (/知识截止|cutoff|training data/i.test(t)) {
          ev.push({ source: 'behavior.probe', weight: 0.12, detail: '显式声明知识截止（老版本习惯）' });
        }
        return ev;
      } },
    { id: 'tokenizer-edge',
      title: '罕见字形保真',
      prompt: '请原样复述以下 8 个字，每个字一行：龘鱻麤馫灥飍雥馕',
      weight: 0.20,
      analyze: function (text) {
        var ev = [];
        var t = String(text || '');
        var glyphs = ['龘', '鱻', '麤', '馫', '灥', '飍', '雥', '馕'];
        var kept = 0;
        for (var i = 0; i < glyphs.length; i++) if (t.indexOf(glyphs[i]) >= 0) kept++;
        if (kept >= 7) ev.push({ source: 'behavior.probe', weight: 0.14, detail: '罕见字形保真 ' + kept + '/8（Tokenizer 覆盖广）' });
        else if (kept <= 3) ev.push({ source: 'behavior.probe', weight: 0.10, detail: '罕见字形丢失严重 ' + kept + '/8（Tokenizer 覆盖窄）' });
        return ev;
      } },
  ];

  function runCanaries(text) {
    var out = [];
    for (var i = 0; i < CANARIES.length; i++) {
      try {
        var evs = CANARIES[i].analyze(text) || [];
        for (var j = 0; j < evs.length; j++) {
          evs[j].canary = CANARIES[i].id;
          out.push(evs[j]);
        }
      } catch (e) {}
    }
    return out;
  }

  /* 发送门（PelicanSend 同源安全阀，纯函数可测）：
   * st = {armed, editorCount, draftConflict, routeStable, lastSentAt, now}
   * armed 必须为真（默认关）；10 秒内只发一次；输入框必须唯一；
   * 有冲突草稿不发；会话路由变化不发。 */
  function shouldSendProbe(st) {
    st = st || {};
    if (!st.armed) return { ok: false, reason: 'probe-off' };
    if (st.editorCount !== 1) return { ok: false, reason: 'editor-not-unique' };
    if (st.draftConflict) return { ok: false, reason: 'draft-conflict' };
    if (!st.routeStable) return { ok: false, reason: 'route-changed' };
    if (st.lastSentAt && st.now - st.lastSentAt < 10000) return { ok: false, reason: 'throttled' };
    return { ok: true, reason: '' };
  }

  /* 指纹向量（结构维度为主；时序维度内容脚本测不准，留空位保持形状兼容）。
   * 用于档案聚类（同模型/近亲），不做跨家族硬判。 */
  var FP_DIMS = ['p_openai_chat', 'p_openai_resp', 'p_anthropic', 'p_google',
    'has_reasoning_field', 'has_cached_tokens', 'has_cache_creation',
    'has_system_fingerprint', 'has_toolu', 'has_call', 'has_fc',
    'prompt_tokens', 'completion_tokens', 'reasoning_ratio', 'len_bucket'];
  var FP_WEIGHTS = {
    p_openai_chat: 2.0, p_openai_resp: 2.0, p_anthropic: 2.0, p_google: 2.0,
    has_reasoning_field: 1.5, has_cached_tokens: 1.2, has_cache_creation: 1.5,
    has_system_fingerprint: 1.5, has_toolu: 1.5, has_call: 1.2, has_fc: 1.2,
    prompt_tokens: 0.4, completion_tokens: 0.5, reasoning_ratio: 1.0, len_bucket: 0.4,
  };

  function fingerprintVector(obs) {
    obs = obs || {};
    var t = String(obs.text || '');
    function sat(x, cap) { x = +x || 0; return Math.min(1, x / cap); }
    var promptTok = +obs.promptTokens || 0;
    var compTok = +obs.completionTokens || 0;
    var reasonTok = +obs.reasoningTokens || 0;
    return {
      p_openai_chat: (/"object"\s*:\s*"chat\.completion|chatcmpl-/.test(t)) ? 1 : 0,
      p_openai_resp: (/response\.(created|output_text\.delta)|resp_/.test(t)) ? 1 : 0,
      p_anthropic: (/message_start|content_block_delta|toolu_/.test(t)) ? 1 : 0,
      p_google: (/"candidates"|usageMetadata|finishReason/.test(t)) ? 1 : 0,
      has_reasoning_field: (/"reasoning_content"|"reasoning"\s*:|thinking_delta/.test(t)) ? 1 : 0,
      has_cached_tokens: (/"cached_tokens"\s*:/.test(t)) ? 1 : 0,
      has_cache_creation: (/cache_creation_input_tokens/.test(t)) ? 1 : 0,
      has_system_fingerprint: (/"system_fingerprint"\s*:\s*"/.test(t)) ? 1 : 0,
      has_toolu: (/\btoolu_[A-Za-z0-9]{6,}/.test(t)) ? 1 : 0,
      has_call: (/\bcall_[A-Za-z0-9]{6,}/.test(t)) ? 1 : 0,
      has_fc: (/"fc_[A-Za-z0-9]{4,}"|functionCall/.test(t)) ? 1 : 0,
      prompt_tokens: sat(promptTok, 4000),
      completion_tokens: sat(compTok, 4000),
      reasoning_ratio: Math.min(1, reasonTok / Math.max(1, compTok)),
      len_bucket: sat(t.length, 20000),
    };
  }

  /* 加权余弦相似度：结构性维度权重高于时序维度。 */
  function cosineSim(a, b) {
    var dot = 0, na = 0, nb = 0;
    for (var i = 0; i < FP_DIMS.length; i++) {
      var d = FP_DIMS[i];
      var w = FP_WEIGHTS[d] || 1;
      var x = ((a && a[d]) || 0) * w, y = ((b && b[d]) || 0) * w;
      dot += x * y; na += x * x; nb += y * y;
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /* 判定 → payload 合并（纯函数）：kind/confidence/evidence 落盘，
   * 同 URL 下 resolved 旧结论不被非 resolved 新结论降级（延续既有保护语义）。 */
  function assemblePayload(prev, base, verdict) {
    base = base || {};
    verdict = verdict || { mode: 'UNKNOWN', confidence: 0 };
    var kind = (verdict.mode === 'RESOLVED') ? 'resolved'
      : (verdict.mode === 'INFERRED') ? 'inferred' : 'unknown';
    var payload = {
      mode: base.mode || 'unknown',
      revealed: !!base.revealed,
      models: base.models || [],
      source: base.source || 'none',
      kind: kind,
      confidence: (typeof verdict.confidence === 'number') ? verdict.confidence : 0,
      family: verdict.family || null,
      verdictLabel: verdict.label || '',
      evidence: (verdict.evidence || []).slice(0, 8).map(function (e) {
        return { source: e.source, weight: e.weight, target: e.modelId || e.family || null, detail: String(e.detail || '').slice(0, 80) };
      }),
      codename: base.codename || null,
      url: base.url || '',
      updatedAt: Date.now(),
    };
    if (prev && prev.url && base.url && prev.url === base.url &&
        prev.kind === 'resolved' && kind !== 'resolved' &&
        prev.models && prev.models.length) {
      payload.models = prev.models;
      payload.source = prev.source;
      payload.kind = prev.kind;
      payload.confidence = prev.confidence;
      payload.family = prev.family;
      payload.verdictLabel = prev.verdictLabel;
      payload.evidence = prev.evidence;
      payload.codename = prev.codename;
      payload.keptPrev = true;
    }
    return payload;
  }

  return {
    SOURCE_WEIGHTS: SOURCE_WEIGHTS,
    RESOLVED_MIN: RESOLVED_MIN,
    INFERRED_MIN: INFERRED_MIN,
    MODEL_PATTERNS: MODEL_PATTERNS,
    matchKnownModels: matchKnownModels,
    FAMILY_PROTOCOLS: FAMILY_PROTOCOLS,
    HOST_VENDOR: HOST_VENDOR,
    vendorOfHost: vendorOfHost,
    protocolFingerprint: protocolFingerprint,
    evidenceFromHeaders: evidenceFromHeaders,
    ANON_SLOT_RE: ANON_SLOT_RE,
    parseCodename: parseCodename,
    classify: classify,
    CANARIES: CANARIES,
    runCanaries: runCanaries,
    shouldSendProbe: shouldSendProbe,
    FP_DIMS: FP_DIMS,
    fingerprintVector: fingerprintVector,
    cosineSim: cosineSim,
    assemblePayload: assemblePayload,
  };
})();

/* 学习档案：未知模型自动建档 + 定案写入 + 揭晓回填（纯逻辑，存储可注入）。
 * 三层兜底：目录正则命中 → 直接归类；有模型串但未见过 → UNSEEN 建档；
 * 无模型串 → 指纹向量聚类，同源归一簇，某天暴露真名整簇溯名。
 * 写规则：只有定案来源（run trace / 投票揭晓）可写 verified 条目。 */
var KMP_LEARNED = (() => {
  'use strict';

  var MAX_ENTRIES = 400;
  var SIM_THRESHOLD = 0.92;   // 视为"同一模型"的相似度门槛
  var NEW_THRESHOLD = 0.86;   // 视为"同一家族近亲"的门槛

  var _store = null; // {load(): {entries:[]}, save(db)}
  function setStore(s) { _store = s; }
  function memStore() {
    var db = { entries: [] };
    return { load: function () { return db; }, save: function (d) { db = d; } };
  }
  function load() {
    try {
      if (_store) { var d = _store.load(); if (d && Array.isArray(d.entries)) return d; }
    } catch (e) {}
    return { entries: [] };
  }
  function save(db) {
    try {
      if (!db || !Array.isArray(db.entries)) return;
      if (db.entries.length > MAX_ENTRIES) db.entries = db.entries.slice(-MAX_ENTRIES);
      if (_store) _store.save(db);
    } catch (e) {}
  }
  function hash(s) {
    var h = 2166136261;
    s = String(s);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }
  function blend(a, b, w) {
    var o = {};
    var dims = KMP_FUSION.FP_DIMS;
    for (var i = 0; i < dims.length; i++) {
      var d = dims[i];
      o[d] = (((a && a[d]) || 0) * (1 - w)) + (((b && b[d]) || 0) * w);
    }
    return o;
  }

  /* observation = {text, modelIds[], promptTokens, completionTokens, reasoningTokens} */
  function learnFromObservation(observation, existingEvidence) {
    var db = load();
    observation = observation || {};
    var vec = KMP_FUSION.fingerprintVector(observation);
    var evs = Array.isArray(existingEvidence) ? existingEvidence : [];
    var seen = {};
    var modelIds = [];
    for (var i = 0; i < evs.length; i++) {
      if (evs[i] && evs[i].modelId) {
        var m = String(evs[i].modelId).trim();
        if (m && !seen[m]) { seen[m] = true; modelIds.push(m); }
      }
    }
    var declared = null;
    for (var k = 0; k < modelIds.length; k++) {
      if (KMP_FUSION.matchKnownModels(modelIds[k]).length) { declared = modelIds[k]; break; }
    }
    if (!declared) declared = modelIds[0] || null;
    var proto = KMP_FUSION.protocolFingerprint(observation.text || '');
    var protoFamily = proto.length ? proto[0].family : null;

    var best = null, bestSim = 0;
    for (var j = 0; j < db.entries.length; j++) {
      var en = db.entries[j];
      if (!en.vec) continue;
      var sim = KMP_FUSION.cosineSim(vec, en.vec);
      if (sim > bestSim) { bestSim = sim; best = en; }
    }
    var nowTs = Date.now();
    var verdict;
    if (best && bestSim >= SIM_THRESHOLD) {
      best.count++;
      best.lastSeen = nowTs;
      best.vec = blend(best.vec, vec, 0.25);
      if (declared && best.modelIds.indexOf(declared) < 0) best.modelIds.push(declared);
      if (declared && !best.resolved) { best.resolved = declared; best.resolvedAt = nowTs; }
      verdict = { kind: 'MATCH', entry: best, similarity: +bestSim.toFixed(4) };
    } else if (declared) {
      var parsed = KMP_FUSION.parseCodename(declared);
      var known = KMP_FUSION.matchKnownModels(declared).length > 0;
      var entry = {
        id: 'u_' + hash(declared + nowTs),
        modelIds: [declared],
        resolved: declared,
        parsed: parsed,
        family: (parsed && parsed.family) ? parsed.family : protoFamily,
        firstSeen: nowTs,
        lastSeen: nowTs,
        count: 1,
        vec: vec,
        known: known,
        status: known ? 'KNOWN' : 'UNSEEN',
        nearest: best ? { ids: best.modelIds, similarity: +bestSim.toFixed(4) } : null,
      };
      db.entries.push(entry);
      verdict = { kind: entry.status === 'UNSEEN' ? 'NEW_MODEL' : 'NEW_FOR_SESSION', entry: entry, similarity: +bestSim.toFixed(4), parsed: parsed };
    } else if (best && bestSim >= NEW_THRESHOLD) {
      best.count++;
      best.lastSeen = nowTs;
      best.vec = blend(best.vec, vec, 0.15);
      verdict = { kind: 'CLUSTER', entry: best, similarity: +bestSim.toFixed(4) };
    } else {
      var anon = {
        id: 'u_' + hash('anon' + nowTs + db.entries.length),
        modelIds: [],
        resolved: null,
        parsed: null,
        family: protoFamily,
        firstSeen: nowTs,
        lastSeen: nowTs,
        count: 1,
        vec: vec,
        known: false,
        status: 'ANON_CLUSTER',
        nearest: best ? { ids: best.modelIds, similarity: +bestSim.toFixed(4) } : null,
      };
      db.entries.push(anon);
      verdict = { kind: 'NEW_CLUSTER', entry: anon, similarity: +bestSim.toFixed(4) };
    }
    save(db);
    return verdict;
  }

  /* 定案写入：只有 run trace / 投票揭晓这类权威来源可调。 */
  function recordRealModel(name, meta) {
    if (!name || typeof name !== 'string') return null;
    meta = meta || {};
    var db = load();
    var key = name.trim();
    var en = null;
    for (var i = 0; i < db.entries.length; i++) {
      if (db.entries[i].resolved === key && db.entries[i].verified) { en = db.entries[i]; break; }
    }
    if (en) {
      en.count++;
      en.lastSeen = Date.now();
      if (meta.runId) {
        en.runIds = en.runIds || [];
        if (en.runIds.indexOf(meta.runId) < 0) en.runIds.push(meta.runId);
      }
      save(db);
      return { kind: 'VERIFIED_MATCH', entry: en };
    }
    var parsed = KMP_FUSION.parseCodename(key);
    var matched = KMP_FUSION.matchKnownModels(key);
    en = {
      id: 'v_' + hash(key),
      modelIds: [key],
      resolved: key,
      parsed: parsed,
      family: (parsed && parsed.family) || (matched[0] && matched[0].family) || meta.family || null,
      gen: matched[0] ? matched[0].gen : null,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      count: 1,
      verified: true,
      status: matched.length ? 'KNOWN' : 'VERIFIED_UNLISTED',
      runIds: meta.runId ? [meta.runId] : [],
    };
    db.entries.push(en);
    save(db);
    return { kind: 'NEW_VERIFIED', entry: en };
  }

  /* 溯名：匿名簇后来暴露真名 → 整簇回填。返回回填条数。 */
  function backfillNames() {
    var db = load();
    var changed = 0;
    for (var i = 0; i < db.entries.length; i++) {
      var en = db.entries[i];
      if ((en.status === 'ANON_CLUSTER' || !en.resolved) && en.modelIds && en.modelIds.length) {
        for (var j = 0; j < en.modelIds.length; j++) {
          if (KMP_FUSION.matchKnownModels(en.modelIds[j]).length) {
            en.resolved = en.modelIds[j];
            en.status = 'KNOWN';
            changed++;
            break;
          }
        }
      }
    }
    if (changed) save(db);
    return changed;
  }

  function findByModelId(id) {
    if (!id) return null;
    var db = load();
    var key = String(id).trim().toLowerCase();
    var best = null;
    for (var i = 0; i < db.entries.length; i++) {
      var en = db.entries[i];
      var ids = en.modelIds || [];
      for (var j = 0; j < ids.length; j++) {
        if (String(ids[j]).trim().toLowerCase() === key) {
          if (!best || ((en.verified ? 2 : 0) + (en.count || 0)) > ((best.verified ? 2 : 0) + (best.count || 0))) best = en;
        }
      }
    }
    return best;
  }

  function listRealModels() {
    var db = load();
    return db.entries.filter(function (e) { return e.verified; }).map(function (e) {
      return { name: e.resolved, family: e.family, gen: e.gen, count: e.count, firstSeen: e.firstSeen, lastSeen: e.lastSeen, runIds: e.runIds || [], status: e.status };
    });
  }

  function stats() {
    var db = load();
    var verified = 0, unseen = 0;
    for (var i = 0; i < db.entries.length; i++) {
      if (db.entries[i].verified) verified++;
      if (db.entries[i].status === 'UNSEEN') unseen++;
    }
    return { entries: db.entries.length, verified: verified, unseen: unseen };
  }

  function exportLearned() { return JSON.stringify(load(), null, 2); }
  function importLearned(json) {
    try {
      var o = (typeof json === 'string') ? JSON.parse(json) : json;
      if (!o || !Array.isArray(o.entries)) return false;
      var cur = load();
      var ids = {};
      for (var i = 0; i < cur.entries.length; i++) ids[cur.entries[i].id] = true;
      for (var j = 0; j < o.entries.length; j++) {
        if (!ids[o.entries[j].id]) cur.entries.push(o.entries[j]);
      }
      save(cur);
      return true;
    } catch (e) { return false; }
  }
  function listLearned() { return load().entries; }
  function clearLearned() {
    try { if (_store && _store.clear) _store.clear(); } catch (e) {}
    save({ entries: [] });
  }

  return {
    MAX_ENTRIES: MAX_ENTRIES,
    SIM_THRESHOLD: SIM_THRESHOLD,
    NEW_THRESHOLD: NEW_THRESHOLD,
    setStore: setStore,
    memStore: memStore,
    learnFromObservation: learnFromObservation,
    recordRealModel: recordRealModel,
    backfillNames: backfillNames,
    findByModelId: findByModelId,
    listRealModels: listRealModels,
    stats: stats,
    exportLearned: exportLearned,
    importLearned: importLearned,
    listLearned: listLearned,
    clearLearned: clearLearned,
  };
})();
