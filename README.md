# KnowModel —— 识别 arena.ai 当前对话用的是哪个模型

**[English](#english)** | **[中文说明](#中文说明)** · snoop build `20260921-same-run-noreset` · 回归 40 场景全绿

一个浏览器插件（Chrome/Edge + Firefox 双端同源），回答一个问题：**我正在聊的这个 arena.ai 对话，背后是哪个模型在回话？**

- 🔌 零依赖插件，无后台服务器，装上即用
- 🎯 页面角标实时显示当前对话模型，点工具栏图标看定案卡片（模型名 / 置信度 / 证据来源）
- 🧾 证据加权融合 + 运行轨迹追踪 + 学习档案，定案可解释、可导出

---

## 插件安装方法（必看，3 分钟）

### Chrome / Edge（推荐）

1. 把本仓库下载（`Code → Download ZIP` 并解压）或 `git clone` 到本地；
2. 地址栏打开 `chrome://extensions`（Edge 打开 `edge://extensions`），打开右上角**开发者模式**；
3. 点**加载已解压的扩展程序**，选择仓库里的 **`extension/` 文件夹**（注意是选文件夹，不是里面的文件）；
4. 把 KnowModel 图标**固定到工具栏**（拼图图标 → 图钉）；
5. 打开一个 `https://arena.ai/agent/…` 对话页。**首次安装或每次更新插件后，务必刷新已开的 arena.ai 标签页**——探测脚本随页面加载注入，不刷新就还是旧版本在跑。

### Firefox

1. 地址栏打开 `about:debugging#/runtime/this-firefox`；
2. 点**临时载入附加组件**，选择仓库里 **`firefox/manifest.json`**；
3. 打开 `arena.ai` 对话页即用。注意：临时扩展**重启浏览器后失效**，需重新载入一次（书签栏存一下这个地址）。

### 日常使用

- **看角标**：对话页角落的徽章就是当前定案（例如 `Qwen3P8-27B`）；显示"未检测到"说明本轮还没拿到有效证据（见下文"无证据时怎么办"）。
- **点图标**：弹窗顶部是当前对话卡片——对战/直连模式、定案名、置信度、证据来源；中间是模型目录搜索框；底部是诊断区。
- **无证据时怎么办**：点诊断区的**行为探针**（`发送探测`），插件会打一轮探测流量逼页面交出钥匙；若还是没有，点**复制诊断**把 JSON 发给开发者，里面有完整的取证时间线。
- **学习档案**：定案过的模型会自动记入本地档案（只收定案写入，不污染），下次秒定；可在弹窗里复制/清空。

---

<a id="english"></a>
## English

### Install (3 minutes)

**Chrome / Edge:** open `chrome://extensions`, enable **Developer mode** → **Load unpacked** → select the
**`extension/`** folder → pin the icon → open an `arena.ai` chat. **After every update, reload your open
`arena.ai` tabs** — the page-world probe is injected at page load and is not hot-swapped.

**Firefox:** open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → select
**`firefox/manifest.json`** (temporary: reload it after each browser restart).

### How it works (current architecture)

The extension does **not** read a model list and guess. It tails the page's own network traffic and follows
the run to its authoritative label:

1. **Page-world probe** (`content.js`, injected at page load) taps `fetch` / XHR / SSE and harvests two
   kinds of keys by JWT shape + scope: the **session key** (long-lived) and the **per-turn run key**.
   Sources: `/api/chat/trigger-token` (GET, then POST with `sessionId` fallback), `/api/me/pulse`
   self-rescue, `out/records` tails, SSE streams, and `Authorization` request headers.
2. **Run-trace chain**: session key → poll `out/records` for the `turn-complete` control record → take its
   `public-access-token` (the run key) → fetch the run's events → parse the model label the worker wrote.
   That label (`run.trace.model`, weight 1.00) is the highest authority — what the worker says it is, is
   what it is, even if the name is not in any catalog.
3. **Key-renewal rules** (learned from production the hard way): the page rotates the run JWT every few
   seconds and replays the session key on every poll. So: **same run + new key = swap the key, never reset
   the chain**; **same session replay = renew the session key only**; a full reset happens only on a real
   session switch. Before these rules, verdicts flickered ("model appears, then unknown") because every
   key rotation wiped the in-flight chain.
4. **Evidence fusion** (`evidence.js`): every signal votes with a weight; the winner needs a quorum.
   Top weights: run-trace / request-body `1.00`, response header `0.95`, response JSON `0.93`, idmap resolve
   `0.92`, SSE chunk `0.90`, URL path `0.85`, protocol framing `0.72`, learned-archive hit `0.55`,
   DOM text `0.45`, codename hint `0.40`. Plus codename parsing (`qwen3p8-27b` → Qwen3 family / 27B hints),
   protocol fingerprinting, and a learned archive (verdicts only, exportable/clearable from the popup).
5. **Behavior probe & diagnostics**: when evidence is thin, the popup's probe button sends one scripted
   round to force the page to mint keys; **Copy diagnostics** exports the full forensic timeline
   (`accepts` chain, events log) for bug reports.

No private API is called by you, no server component — the extension only reads traffic the page itself
already makes. Regression: `node tests/run.js` — 40 sandboxed scenarios, all green.

---

<a id="中文说明"></a>
## 中文说明

### 安装方法见本页顶部（Chrome 选 `extension/` 文件夹，Firefox 选 `firefox/manifest.json`）

### 技术原理（当前架构：取证 → 跟踪 → 融合）

插件**不是**读个模型列表再猜，而是跟着页面自己的网络流量，一直跟到写死模型名的那条权威记录：

1. **页世界探针**（`content.js`，随页面加载注入）：hook 住 `fetch` / XHR / SSE，按 JWT 形状 + scope 认出两把钥匙——**会话钥匙**（长期有效）和**单轮钥匙**（run token，一轮一换）。钥匙来源：`/api/chat/trigger-token`（GET 不行就带 `sessionId` POST）、`/api/me/pulse` 自救、`out/records` 轮询、SSE 流、`Authorization` 请求头。
2. **运行轨迹链**：会话钥匙 → 轮询 `out/records` 等 `turn-complete` 控制记录 → 取出它的 `public-access-token`（单轮钥匙）→ 拉该 run 的 events → 解析 worker 自己写下的模型标签。这条标签（`run.trace.model`，权重 1.00）是最高权威——**trace 说是谁就是谁**，名字不在目录里也照样定案。
3. **钥匙续命三规则**（线上真金白银踩出来的）：页面每几秒就换一次 run JWT，每次请求还重播会话钥匙。所以：**同 run 换钥匙 = 只换钥匙、不断链**；**同会话重播 = 只续期**；只有真正切会话才全 reset。没这三条之前，定案会"闪一下又灭"——每次换钥匙都把在途的链路推倒重来。
4. **证据融合**（`evidence.js`）：所有信号按权重投票，过了 quorum 才定案。常用权重：运行轨迹/请求体 `1.00`、响应头 `0.95`、响应 JSON `0.93`、id 精确映射 `0.92`、SSE 片段 `0.90`、URL 路径 `0.85`、协议指纹 `0.72`、学习档案命中 `0.55`、DOM 文本 `0.45`、代号线索 `0.40`。另有代号解析（`qwen3p8-27b` → Qwen3 家族 / 27B 参数量线索）、协议指纹、学习档案（只收定案、可导出、可清空）。
5. **行为探针与诊断**：证据不足时点弹窗里的探针按钮，打一轮探测流量逼页面交钥匙；**复制诊断**导出完整取证时间线（`accepts` 钥匙链、events 日志），报 bug 时贴它，定位到钥匙级别。

你本人不调用任何私有接口，也没有服务端组件——插件只读页面自己本来就要发的流量。回归测试：`node tests/run.js`，40 个沙盒场景全绿。

### Python 版（次要：离线抓取 + 查询服务）

```bash
pip install -r requirements.txt
python -m src.main refresh                                  # 抓取一次存入 models.json
python -m src.main chat --url "https://arena.ai/xxxx"       # 检测某对话页模型
python -m src.main list --search "claude"                   # 查缓存
python -m src.main serve --port 8099                        # 查询服务（30 分钟自刷新）
```

### 文件结构

```text
extension/          Chrome/Edge 插件（MV3，主开发目录）
firefox/            Firefox 插件（与 extension/ 十文件同源，改 manifest 适配）
  content.js        页世界探针：取证 + 运行轨迹链 + 钥匙续命（含自愈取 token）
  detector.js       内容世界：DOM 扫描 + 融合定案 + 角标/弹窗数据
  evidence.js       证据融合：加权投票 + 代号解析 + 协议指纹 + 学习档案
  badge.js / popup.* / ext.js / model-utils.js / models-scan.js / background.js
tests/              沙盒回归（node tests/run.js，40 场景：链路/轮换/重播/切页/探针）
src/                Python 版：抓取 + 查询服务
models.json         模型目录快照（插件内置一份，零网络也能搜）
```

### 与原项目（LMArenaBridge）的区别（有意简化）

- 不做 `chat/completions` 转发、不碰 auth token 续期以外的登录态、不做 reCAPTCHA / userscript proxy，只保留"当前对话是谁"识别链路。
- 无 API Key 鉴权，本地用即可。
