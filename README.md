# ds Eagle Tagger

一款轻量 Eagle 插件，通过一键安装的本地 GPU 引擎生成 WD14 英文标签并写回 Eagle。既可仅处理无标签图片，也可保留手动标签并补充模型新标签。识别完全在本机完成，运行期间不会出现额外的命令行窗口。

[![下载](https://img.shields.io/badge/下载-v0.7.2-f4511e)](https://github.com/discipohub/ds-eagle-tagger/releases/latest)
![平台](https://img.shields.io/badge/平台-Windows%2010%20%2F%2011-0078d4)
![许可证](https://img.shields.io/badge/License-MIT-green)

[下载 Windows 最新版](https://github.com/discipohub/ds-eagle-tagger/releases/latest) · [问题反馈](https://github.com/discipohub/ds-eagle-tagger/issues)

项目源码、测试与构建脚本均在本仓库公开，采用 MIT License。可直接下载成品安装包，也可以自行审查和构建。

## Windows 公开版

公开包采用单个 `.eagleplugin` 文件：

1. 用户双击插件包，由 Eagle 完成安装。
2. 首次打开时点击“开始安装”，插件会把本地引擎安装到 `%LOCALAPPDATA%\EagleAutoTagger\engine`。
3. 首次识别时按需下载约 1.26 GB 的固定版本 WD14 模型；界面显示实时百分比、容量、速度和预计时间。
4. 后续直接打开插件使用，不需要运行开发脚本或配置项目路径。

要求 Windows 10 / 11 x64、NVIDIA 显卡；建议至少 6 GB 显存并预留 5 GB 空间。插件包内不包含大体积模型。

模型下载会自动尝试官方源与备用镜像，支持断点续传、Windows 下载通道兜底，并在完成后校验固定大小和 SHA-256；无法联网时不会加载不完整或来源不明的文件。

无法在线下载模型时，可从其他渠道取得 `model.onnx` 与 `selected_tags.csv`，在设置中点击“导入本地模型”。插件会校验固定大小与 SHA-256，两个文件完全匹配后才复制到模型缓存并启用。

首次安装本地引擎时，Python 会按中国科学技术大学镜像、GitHub 官方源的顺序尝试；GPU 依赖会按中国科学技术大学、清华大学、PyPI 官方源的顺序尝试。失败时保留下载缓存并自动切换，不需要用户手动配置镜像。

## 插件功能

- 读取完整 Eagle 文件夹树，在插件内搜索并勾选一个或多个逻辑文件夹。
- 父文件夹可用“含子级 N”选择全部下级；已选文件夹可逐个移除。
- 多文件夹图片逐个读取、合并并按 Eagle 项目 ID 去重。
- 支持只处理 Eagle 当前选中的图片，或处理整个当前图库。
- 默认跳过已有标签，写入前再次检查，不覆盖用户已有整理结果。
- “补充已有标签”会保留原标签、追加模型新标签并自动去重。
- 本地记录 Eagle 图片 ID、模型版本、识别设置和上次模型标签，避免相同条件下重复补充。
- 处理记录可在设置中迁移到 D、E、N 等其他可写硬盘。
- 支持检查维护者批准的模型清单、显示更新说明和大小，并在下载校验成功后安全切换模型。
- 模型缓存按 revision 分目录保存，更新模型不会直接覆盖旧版本。
- 支持 Batch 1 / 2 / 4 / 8、阈值、标签上限、rating 标签与 Logo / 文字图误识别过滤。
- 启动时通过 NVIDIA 官方工具读取显卡型号和当前可用显存，自动选择保守的 Batch；无法读取显存时使用 Batch 2。
- 推理遇到显存不足会按 8 → 4 → 2 → 1 自动降级，并按显卡记住已验证的安全值；用户仍可切换为手动 Batch。
- 支持仅预览、实时进度、速度与剩余时间、安全停止。
- 每条失败记录都可在 Eagle 中单独定位，也可一次选中全部失败项。

## 开发者运行方式

开发脚本统一位于 `scripts/dev`，避免与插件源码混在仓库根目录：

- `scripts/dev/install.bat`：建立开发环境。
- `scripts/dev/run-dryrun.bat`：最多预览 20 张，不写入 Eagle。
- `scripts/dev/run.bat`：处理整个图库。
- `scripts/dev/run-folder.bat`：粘贴一个或多个 Eagle 文件夹链接后处理。

插件与唯一一份 Python 引擎源码均位于 `eagle-plugin`。开发者可直接加载该目录；公开安装包优先使用 `%LOCALAPPDATA%\EagleAutoTagger\engine`，不依赖固定磁盘或项目路径。

发布包使用 `scripts/build-public-plugin.ps1` 构建。测试、文档、构建脚本与插件源码分别归入对应目录。

## 模型与设置

默认模型为 `SmilingWolf/wd-eva02-large-tagger-v3`，锁定 revision、文件大小与 SHA-256。模型更适合动漫、插画和风格化游戏美术；写实照片、纯 Logo、复杂排版和 3D 渲染可能出现误识别。

主要设置包括普通标签阈值、角色标签阈值、每张标签上限、是否写入 rating 分级标签、Logo / 文字图人物误判过滤和仅预览模式。

不要把 API token 写入公开包中的 `config.json`。本地开发可使用环境变量 `EAGLE_TOKEN` 或不进入版本控制的 `config.local.json`。

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

ds Eagle Tagger 源码采用 [MIT License](LICENSE)。
