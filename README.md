# ds Eagle Tagger

一款轻量 Eagle 插件，通过一键安装的本地 GPU 引擎生成 WD14 英文标签并写回 Eagle。既可仅处理无标签图片，也可保留手动标签并补充模型新标签。识别完全在本机完成，运行期间不会出现额外的命令行窗口。

[![下载](https://img.shields.io/badge/下载-v0.7.2-f4511e)](https://github.com/discipohub/ds-eagle-tagger/releases/latest)
![平台](https://img.shields.io/badge/平台-Windows%2010%20%2F%2011-0078d4)
![许可证](https://img.shields.io/badge/License-PolyForm--NC-purple)

[下载 Windows 最新版](https://github.com/discipohub/ds-eagle-tagger/releases/latest) · [问题反馈](https://github.com/discipohub/ds-eagle-tagger/issues)

项目源代码采用 PolyForm Noncommercial 1.0.0。普通用户只需下载成品安装包，不需要配置源码环境。

## 快速开始

1. 双击 `.eagleplugin` 安装包，由 Eagle 完成安装。
2. 首次打开插件时点击”开始安装”，自动配置本地推理引擎。
3. 首次识别时自动下载约 1.26 GB 的 WD14 模型，后续直接使用。

要求 Windows 10 / 11 x64、NVIDIA 显卡；建议至少 6 GB 显存并预留 5 GB 空间。

## 插件功能

- 在插件内搜索并勾选 Eagle 文件夹，支持含子级批量选择。
- 支持只处理当前选中的图片，或处理整个图库。
- 默认跳过已有标签，不覆盖用户已有整理结果。
- “补充已有标签”保留原标签、追加模型新标签并自动去重，相同条件下不会重复处理。
- 自动适配显存，显存不足时自动降级；也可手动调整 Batch。
- 支持仅预览、实时进度、安全停止，失败项可在 Eagle 中定位。
- 支持模型更新和 Logo / 文字图误识别过滤。

## 模型

默认模型为 [SmilingWolf/wd-eva02-large-tagger-v3](https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3)，更适合动漫、插画和风格化游戏美术；写实照片、纯 Logo、复杂排版和 3D 渲染可能出现误识别。

## 隐私与卸载

图片、路径和标签均在本机处理；联网仅用于下载 Python 运行组件、推理依赖和模型。插件不包含账号、广告或遥测。

卸载插件后，如需同时删除引擎、模型和缓存，请先关闭插件，再手动删除 `%LOCALAPPDATA%\EagleAutoTagger`。完整说明见插件包内的 `PRIVACY.md` 与 `THIRD_PARTY_NOTICES.md`。

## 安装验证失败

0.7.2 起，安装界面会显示本地推理引擎的真实错误，并把完整诊断写入：

```text
%LOCALAPPDATA%\EagleAutoTagger\logs\setup.log
```

- Visual C++ 或 DLL 加载失败：安装最新的 [Microsoft Visual C++ v14 Redistributable（x64）](https://aka.ms/vc14/vc_redist.x64.exe)，重启后修复引擎。
- NVIDIA、CUDA、cuDNN 或 cublas：更新 NVIDIA 驱动，重启后重试。
- 拒绝访问：在安全软件中允许 Eagle 及 `%LOCALAPPDATA%\EagleAutoTagger` 下的本地 Python 运行。

## 作者

由 [discipo](https://github.com/discipohub) 创建和维护。模型与第三方组件沿用各自的许可条款，详见 `eagle-plugin/THIRD_PARTY_NOTICES.md`。

ds Eagle Tagger 源码采用 [PolyForm Noncommercial 1.0.0](LICENSE)，商业用途需[联系作者](https://github.com/discipohub/ds-eagle-tagger/issues)获得授权。
