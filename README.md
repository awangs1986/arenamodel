# knowmodel — arena.ai 当前模型识别器（精简版）

模仿 `LMArenaBridge` 的模型发现原理，只做一件事：**识别 `https://arena.ai` 当前可用的模型列表**。

## 原理（与原项目一致）

1. 用无头浏览器（Camoufox）打开 `https://arena.ai/`，过掉 Cloudflare Turnstile。
2. 取 `await page.content()`（服务端渲染好的 HTML，内含 Next.js 水合数据）。
3. 正则提取 `{\"initialModels\":[...],"initialModelXId...}`，经 `unicode_escape` 解码 + `json.loads` 得到列表。
4. 存入 `models.json`，每项含 `id`（内部 UUID）、`publicName`（显示名）、`organization`、`capabilities`。
5. 对外以 `publicName` 为 `id` 暴露 OpenAI 风格的 `/api/v1/models`；内部 `publicName -> id` 映射即原项目 `chat/completions` 找 `modelAId` 的那一步。

## 方式一：浏览器插件（推荐，零依赖，界面即开即用）

`extension/`（Chrome/Edge）和 `firefox/`（Firefox）目录就是可运行的界面：`chrome://extensions` → 开发者模式 →
加载已解压的扩展程序 → 打开 `arena.ai` → 点工具栏图标。详见 `extension/README.md`。
插件除列出全部模型外，还会在弹窗顶部和页面右下角显示**当前对话正在用的模型**
（直接对话可识别；匿名对战投票前无解、揭晓后自动捕获——这是服务器的设计，不是插件的限制）。

## 方式二：Python 版

## 安装

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium  # 备用；主路径用 camoufox 自带浏览器
# camoufox 首次运行会自动下载浏览器：
python -c "from camoufox.pkgman import install; install()"
```

## 用法

```bash
# 1. 抓取一次并存入 models.json（主功能；仓库自带一份抓取快照，开箱就有数据）
python -m src.main refresh

# 1b. 检测某个对话页正在用的模型（对应插件的「当前对话」卡片）
python -m src.main chat --url "https://arena.ai/xxxx"

# 2. 查看已保存的模型
python -m src.main list --limit 20
python -m src.main list --search "claude"

# 3. 把显示名解析为内部 id（对应原项目 modelAId 查找）
python -m src.main resolve "Claude Sonnet 4.5"

# 4. 启动查询服务（每 30 分钟后台自动刷新）
python -m src.main serve --port 8099
# GET  http://127.0.0.1:8099/api/v1/models
# GET  http://127.0.0.1:8099/api/v1/current-chat   (上次 chat 命令的检测结果)
# POST http://127.0.0.1:8099/api/v1/refresh
# GET  http://127.0.0.1:8099/  (简易面板)
```

## 文件

```
models.json        抓取结果缓存
src/discover.py    核心：浏览器抓取 + 正则解析（对照 LMArenaBridge.get_initial_data）
src/store.py       models.json 读写 + 过滤（对照 get_models/save_models/list_models）
src/chat.py        当前对话识别（与扩展 detector.js 同策略）+ current_chat.json
src/server.py      FastAPI 查询服务（HTML 输出已转义）
src/main.py        CLI 入口
```

## 与原项目的区别（有意简化）

* 不做 `chat/completions` 转发、不做 auth token / reCAPTCHA / userscript proxy，只保留模型识别链路。
* 无 API Key 鉴权，本地查询用即可。
* Turnstile 处理为简化版（点 `iframe[src*=challenges.cloudflare.com]`），过不去时会退回纯 `httpx` 抓取再解析。
