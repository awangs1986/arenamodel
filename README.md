# ArenaModel — know which model arena.ai is serving right now
# ArenaModel —— 识别 arena.ai 当前正在用的模型

**[English](#english)** | **[中文说明](#中文说明)**

A minimal re-implementation of the `LMArenaBridge` project's model-discovery logic.
It answers one question: **which models does `https://arena.ai` serve right now — and which one is my current chat using?**
一个对 `LMArenaBridge` 项目模型发现原理的精简复刻，只回答一个问题：**`arena.ai` 当前有哪些可用模型——以及我正在聊的这个对话用的是哪一个？**

- 🐍 Python fetch + parse + query service · 🔌 Chrome/Edge & Firefox extensions with a popup UI
- 🐍 Python 抓取解析查询服务 · 🔌 Chrome/Edge 与 Firefox 插件（弹窗界面）

---

<a id="english"></a>
## English

### What it is

Two ways to use, same engine underneath:

- **Browser extension (recommended, zero dependency):** `extension/` for Chrome/Edge, `firefox/` for Firefox.
  Load unpacked → open `arena.ai` → click the toolbar icon. Besides the full model list with search,
  the popup header and a badge at the page corner show **which model the current chat is using**.
  Note: after updating the extension, reload all `arena.ai` tabs — the page-world probe script
  is not hot-swapped, so stale tabs keep running the old build.
- **Python version:** CLI + FastAPI query service exposing an OpenAI-style `/api/v1/models`.

The repo ships a real snapshot in `models.json` (1066 raw / 315 valid entries as of 2026-09-16), so `list` works out of the box.

### How it works

1. **The model list is already in the page.** LMArena's homepage is server-rendered Next.js; the hydration
   payload embeds the full catalog as `{\"initialModels\":[...],\"initialModelXId...}`.
   No private API, no auth token — just read what's already there.
2. **Extract with the same regex as the original project.** This mirrors
   `LMArenaBridge.get_initial_data()`: fetch `await page.content()`, match
   `{\\"initialModels\\":(\[.*?\]),\\"initialModel[A-Z]Id`, then `unicode_escape`-decode + `json.loads`.
   Each entry carries `id` (internal UUID), `publicName` (display name), `organization`, `capabilities`.
3. **Fetch pipeline that survives Cloudflare.** Primary path drives a real headless browser (Camoufox)
   past the Turnstile challenge and snapshots the settled DOM; if that fails it falls back to plain `httpx`.
   A background task re-fetches every 30 minutes, same cadence as the original project.
4. **Current-chat detection (extension `detector.js`, Python `src/chat.py`, same strategy).**
   Direct chats are identified via URL params (`?model=` / `modelId` / `modelAId` / `modelBId`, path id),
   then via the model-switch button text (exact match first, longest-name-contains second).
   Anonymous battles are detected by their vote buttons ("A is better", "Tie", "Both are bad"):
   **before voting the identities are genuinely unknowable** — the server never sends them to the frontend,
   so the UI honestly reports "in battle, identities hidden". After the reveal, both names are captured
   from the result text (a `MutationObserver` re-checks the DOM as streaming/voting mutates it).
5. **Agent pages (`/agent/xxx`): the run-trace chain — Arena's own telemetry tells the truth.**
   Agent chats have no model switcher and never name their model in the DOM, but every turn flows
   through Trigger.dev realtime sessions carrying a `public-access-token` JWT (scope
   `read:runs:<runId>` / `read/write:sessions:<sessionId>`). The extension harvests that token from
   whichever carrier is active — response-stream header frames, the SPA's own `/api/chat/trigger-token`
   responses, request `Authorization` headers, or the paired `turn-complete` + `public-access-token`
   records on `/out/records` — then reads the run's trace (direct `api.trigger.dev` or the same-origin
   `/ai-proxy/` mirror) and picks the cube-icon labels inside the `ai.streamText.doStream` span:
   the internal model ids the worker actually ran (source badge: "run trace"). Each turn gets its own
   token/run, so **per-turn model switches are tracked automatically**; a run-trace verdict cannot be
   overwritten by DOM/button findings within the same turn. Page-data scanning and network sniffing
   stay as auxiliary evidence. (Needs at least one message sent in the page; not supported in Python.)
6. **Self-healing token chain.** The front-gate route keeps flip-flopping between deploys
   (`trigger-token` was 403'd, later returned; `/api/me/pulse` once carried a token, then stopped),
   so the snoop knocks both doors on rescue, rejects expired tokens on arrival, never lets a stale
   token block a fresh one, and slow-polls indefinitely instead of giving up. The popup ships a
   one-click diagnostic export (full JSON state: taps, request headers, streams, errors).
7. **Validity filter.** Only entries with a `text` / `search` / `image` output capability **and** an
   `organization` are shown — this drops internal `stealth` placeholders, matching the original `list_models`.
8. **Name → id mapping.** The `publicName → internal id` lookup (`resolve` / `/lookup`) is exactly the
   step the original project performs to find `modelAId` before calling `chat/completions`.

### Usage

```bash
# Python: install
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium  # backup; main path uses camoufox's bundled browser
python -c "from camoufox.pkgman import install; install()"  # downloads browser on first run

# fetch once into models.json (main feature)
python -m src.main refresh

# detect which model a chat page is using (mirrors the extension's "current chat" card)
python -m src.main chat --url "https://arena.ai/xxxx"

# browse the cache
python -m src.main list --limit 20
python -m src.main list --search "claude"

# display name -> internal id (the modelAId lookup step)
python -m src.main resolve "Claude Sonnet 4.5"

# query service (auto-refreshes in background every 30 min)
python -m src.main serve --port 8099
# GET  http://127.0.0.1:8099/api/v1/models
# GET  http://127.0.0.1:8099/api/v1/current-chat   (last `chat` result)
# POST http://127.0.0.1:8099/api/v1/refresh
# GET  http://127.0.0.1:8099/  (simple dashboard)
```

```text
models.json        fetch-result cache (ships a real snapshot)
src/discover.py    core: browser fetch + regex parse (cf. LMArenaBridge.get_initial_data)
src/store.py       models.json I/O + filtering (cf. get_models/save_models/list_models)
src/chat.py        current-chat detection, same strategy as the extension's detector.js
src/server.py      FastAPI query service (HTML output escaped)
src/main.py        CLI entry point
```

### Deliberately simplified vs. the original

- No `chat/completions` proxying, no auth tokens / reCAPTCHA minting / userscript proxy — model-identification chain only.
- No API-key auth; local queries only.
- Simplified Turnstile handling (clicks `iframe[src*=challenges.cloudflare.com]`), with `httpx` fallback if it fails.

---

<a id="中文说明"></a>
## 中文说明

### 项目介绍

同一套引擎，两种用法：

- **浏览器插件（推荐，零依赖）**：`extension/` 给 Chrome/Edge，`firefox/` 给 Firefox。
  解压加载 → 打开 `arena.ai` → 点工具栏图标。除了带搜索的完整模型列表，弹窗顶部和页面右下角还会显示**当前对话正在用的模型**。
  注意：更新扩展后请刷新所有 `arena.ai` 标签页——已注入页面的探测脚本不会热替换，旧标签页会继续跑旧版逻辑。
- **Python 版**：CLI + FastAPI 查询服务，对外是 OpenAI 风格的 `/api/v1/models`。

仓库自带一份真实抓取快照 `models.json`（2026-09-16：1066 原始 / 315 有效），`list` 开箱就有数据。

### 实现原理

1. **模型列表本来就在页面里。** arena.ai 首页是服务端渲染的 Next.js，水合（hydration）数据里嵌着完整目录
   `{\"initialModels\":[...]}`。不需要私有接口、不需要登录 token，读现成的就行。
2. **用和原项目一模一样的正则提取。** 对照 `LMArenaBridge.get_initial_data()`：取 `await page.content()`，
   匹配 `{\\"initialModels\\":(\[.*?\]),\\"initialModel[A-Z]Id`，再 `unicode_escape` 解码 + `json.loads`。
   每项包含 `id`（内部 UUID）、`publicName`（显示名）、`organization`、`capabilities`。
3. **能扛住 Cloudflare 的抓取链路。** 主路径用真无头浏览器（Camoufox）过掉 Turnstile 验证后快照 DOM；
   失败则降级到纯 `httpx`。后台每 30 分钟自动重抓一次，和原项目同频率。
4. **当前对话识别（插件 `detector.js` 与 Python `src/chat.py` 同策略）。**
   直接对话先看 URL 参数（`?model=` / `modelId` / `modelAId` / `modelBId`、路径 id），再看模型切换按钮文字
   （精确命中优先，其次最长名字包含匹配）。匿名对战靠投票按钮判定（"A is better" / "Tie" / "Both are bad"）：
   **投票前双方身份是真的看不到**——服务器根本不下发到前端，所以界面会如实显示"对战中、身份未公开"；
   揭晓后从结果文本捕获双方名字（`MutationObserver` 在流式输出/投票改 DOM 时去抖重检）。
5. **Agent 页（/agent/xxx，无模型切换器）：运行轨迹链——Arena 自家遥测里藏着真身**
   （学自原项目 `arena-model-probe.inject.js` 的 runmodel 模块）。Agent 对话的 DOM 里永远不出现模型名，
   但每轮回答都流经 Trigger.dev 实时会话，token 藏在四条载体里任一条：响应流 headers 帧里的
   `public-access-token`（JWT，scope 含 `read:runs:<runId>` 或 `read/write:sessions:<sessionId>`）、
   SPA 自己的 `/api/chat/trigger-token` 响应、请求侧 `Authorization` 头、
   `/out/records` 里 `turn-complete` + `public-access-token` 成对记录——拿到后读该 run 在
   Trigger.dev 上的 trace（直连或走同源 `/ai-proxy/` 镜像均可），取 `ai.streamText.doStream`
   span 里图标为 cube 的标签，即 worker 实际执行用的内部模型 id（来源标为「运行轨迹」，
   同轮的终局结论，DOM/按钮结论不覆盖它）。每轮各拿各的 token/run，
   **Arena 每轮换模型也能轮轮跟上**。页面脚本里的模型 id 名单（≥3 个命中判存疑）与网络嗅探作为辅助证据。
   （需页面发过至少一条消息；Python 版不支持该链路，匿名抓取加载不出 agent 对话。）
6. **自愈的 token 链。** 正门路由在部署间反复横跳（trigger-token 曾 403 又复活；pulse 曾带 token 又撤空），
   自救时两扇门都敲（先 trigger-token、pulse 兜底），过期 token 入场即拒收、绝不占槽挡住新鲜 token，
   慢轮询不死（等到终局为止）。弹窗内置一键复制诊断 JSON（taps、请求头、流、错误全量状态）。
7. **有效性过滤。** 只展示有 `text` / `search` / `image` 输出能力**且**有 `organization` 的项——
   滤掉内部 `stealth` 占位模型，与原项目 `list_models` 一致。
8. **显示名 → 内部 id 映射。** `resolve` / `/lookup` 这一步，正是原项目调 `chat/completions` 之前找 `modelAId` 的那一步。

### 用法

```bash
# Python 版安装
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium  # 备用；主路径用 camoufox 自带浏览器
python -c "from camoufox.pkgman import install; install()"  # 首次运行自动下载浏览器

# 抓取一次并存入 models.json（主功能）
python -m src.main refresh

# 检测某个对话页正在用的模型（对应插件的「当前对话」卡片）
python -m src.main chat --url "https://arena.ai/xxxx"

# 查看缓存
python -m src.main list --limit 20
python -m src.main list --search "claude"

# 显示名解析为内部 id（对应原项目 modelAId 查找）
python -m src.main resolve "Claude Sonnet 4.5"

# 启动查询服务（每 30 分钟后台自动刷新）
python -m src.main serve --port 8099
# GET  http://127.0.0.1:8099/api/v1/models
# GET  http://127.0.0.1:8099/api/v1/current-chat   (上次 chat 命令的检测结果)
# POST http://127.0.0.1:8099/api/v1/refresh
# GET  http://127.0.0.1:8099/  (简易面板)
```

```text
models.json        抓取结果缓存（自带真实快照）
src/discover.py    核心：浏览器抓取 + 正则解析（对照 LMArenaBridge.get_initial_data）
src/store.py       models.json 读写 + 过滤（对照 get_models/save_models/list_models）
src/chat.py        当前对话识别（与扩展 detector.js 同策略）+ current_chat.json
src/server.py      FastAPI 查询服务（HTML 输出已转义）
src/main.py        CLI 入口
```

插件安装与界面细节见 [`extension/README.md`](extension/README.md)（Firefox 见 [`firefox/README.md`](firefox/README.md)）。

### 与原项目的区别（有意简化）

- 不做 `chat/completions` 转发、不做 auth token / reCAPTCHA / userscript proxy，只保留模型识别链路。
- 无 API Key 鉴权，本地查询用即可。
- Turnstile 处理为简化版（点 `iframe[src*=challenges.cloudflare.com]`），过不去时会退回纯 `httpx` 抓取再解析。
