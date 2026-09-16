# knowmodel 浏览器插件

零依赖的「可运行界面」（Chrome / Edge 用本目录，Firefox 用 `../firefox/`，两边逻辑文件完全相同）：用户正常打开 `arena.ai` 即已通过 Cloudflare，
插件直接从页面里提取模型列表，不需要 Python、不需要另起浏览器。

## 安装（Chrome / Edge）

1. 打开 `chrome://extensions`，右上角打开**开发者模式**。
2. 点**加载已解压的扩展程序**，选择本目录（`extension/`）。
3. 把 `knowmodel` 图标固定到工具栏。

## 使用

1. 打开 `https://arena.ai/`，等页面加载完（插件会自动抓取，工具栏角标显示有效模型数）。
2. 点工具栏图标：搜索、查看厂商与能力标签，**点击任意一行即复制它的内部 id**。
3. 模型有更新时点**刷新**即可；没有 `arena.ai` 标签页时点刷新会自动打开一个。

## 原理

与 Python 版 `src/discover.py` 同一条链路，只是执行位置从“另起 Camoufox”
换成了“用户已打开的页面”：内容脚本 `content.js` 取
`document.documentElement.outerHTML`，用同样的 `initialModels` 正则提取，
存入 `chrome.storage.local`，弹窗从里面读。

## 当前对话识别

弹窗顶部新增「当前对话」卡片，页面右下角同时挂一个状态小徽标（点击可隐藏）：

- **直接对话**：显示正在用的模型（名 / 厂商 / 内部 id，点击复制），并标注来源
  （链接参数、页面选择器、页面数据、网络请求）。
- **Agent 页**（/agent/xxx，无模型切换器）：走运行轨迹链——响应流 headers
  帧里的 `public-access-token`（JWT，scope 含 `read:runs:<runId>`）→ 读该 run
  在 Trigger.dev 上的 trace → `ai.streamText.doStream` span 里图标为 cube 的标签
  就是 worker 写入的真实模型名，来源标为「运行轨迹」。需页面发过至少一条消息
  （token 随流下发）；轮询最多约 3 分钟，弹窗诊断区有「轨迹」行可看进度。
- **匿名对战**：投票前服务器根本不下发身份，前端无从得知——如实显示
  「匿名对战中」，投票揭晓渲染进页面后自动捕获双方名字。
- **首页 / 榜单页**：显示「没检测到对话」，去开一个对话再回来。

实现：`detector.js` 纯逻辑（投票按钮判定 → URL 参数 → 选择器文字 → 页面数据里的模型 id，本体不碰扩展 API）；
`models-scan.js` 负责列表提取正则；`badge.js` 负责右下角徽标；`model-utils.js` 收敛能力标签与有效性判定；
嗅探载荷内联在 `content.js`（函数 toString 注入页面上下文），hook fetch/XHR，只把命中的已知模型 id 传出来（对话正文不出页面）；
`content.js` 只做编排（定时抓取 + DOM 去抖重检 + 网络命中合并 + popup 刷新消息；同一 URL 下不降级覆盖已有结论），结果存
`storage.currentChat`，弹窗从里面读。无需新增权限。

## 文件

```
manifest.json   MV3 配置（仅 storage 权限 + arena.ai 主机权限）
ext.js         命名空间兼容层（Chrome 用 chrome，Firefox 用 browser）
model-utils.js  模型小工具：能力标签 + 有效性判定（各处共用）
detector.js     当前对话识别纯逻辑（直接/对战/揭晓/未知，不碰扩展 API）
models-scan.js  模型列表提取（initialModels 正则，与 Python 版同源）
badge.js        右下角徽标：文字映射 + 元素托管
content.js      编排层：目录自救 + 定时抓取 + DOM 去抖重检 + 网络命中合并 + popup 刷新消息（含内联嗅探载荷）
background.js   更新工具栏角标计数
popup.html/js   弹窗界面：当前对话卡片 / 搜索 / 列表 / 点击复制 / 刷新
```
