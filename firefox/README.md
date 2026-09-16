# knowmodel Firefox 版

与 Chrome 版共用同一套逻辑文件（`ext.js` / `model-utils.js` / `detector.js` /
`models-scan.js` / `badge.js` / `net-snoop.js` / `content.js` / `popup.js` /
`background.js` / `popup.html` 完全相同），只有 `manifest.json` 是 Firefox 专用的。
原理、界面、用法都一样，详见 `../extension/README.md`。

## 与 Chrome 版 manifest 的三处差异

| 项目 | Chrome | Firefox |
|---|---|---|
| 后台脚本 | `service_worker` | `scripts`（event page，各 ESR 版本都稳） |
| 命名空间 | `chrome` | `browser`（由 `ext.js` 自动适配） |
| 专用配置 | 无 | `browser_specific_settings.gecko` |

## 安装

1. 打开 `about:debugging` → 左侧 **此 Firefox** → **临时载入附加组件**。
2. 在弹出的文件框中选中本目录下的 `manifest.json`。
3. 打开 `https://arena.ai/`，等页面加载完，点工具栏图标即可使用。

注意：临时载入的附加组件在 Firefox 重启后会消失（重装一次即可）；
要永久使用需经 AMO 签名发布，届时会用到 manifest 里的 `gecko.id`。
