# Claude GUI 图标

应用图标采用暖白色底板、细边框终端窗口与陶土橙 Claude Code 像素角色。通过克制的渐变、顶部命令提示符与轻微投影增加层次；窗口尽量铺满画布，角色保留宽扁比例，确保小尺寸下仍清晰。

唯一设计源文件是 [logo.svg](logo.svg)。README、侧边栏、浏览器、PWA 和桌面安装包均使用它生成的资源。

## 重新生成

在仓库根目录安装开发依赖后执行：

```powershell
node public/generate-icons.js
npm run desktop:icon:mac
```

第一条命令生成网页 SVG / PNG、favicon、PWA 图标和 Windows ICO；第二条命令生成 macOS PNG / ICNS。无需在线转换服务。

| 资源 | 输出 |
| --- | --- |
| 网页与通知 | `public/logo-32.png` 至 `public/logo-512.png` |
| 浏览器标签 | `public/favicon.svg`、`public/favicon.png` |
| PWA 与移动端 | `public/icons/icon-*.svg`、`public/icons/icon-*.png` |
| Windows 桌面与安装包 | `electron/assets/logo-windows.ico` |
| macOS 桌面 | `electron/assets/logo-macos.png`、`electron/assets/logo-macos.icns` |

Windows ICO 包含 16、24、32、48、64、128 和 256 像素条目。生成后重新打包桌面应用即可使用新图标。

提供商自身的 Logo（Claude、Codex、Cursor 等）单独保留，便于在会话列表中区分 CLI。
