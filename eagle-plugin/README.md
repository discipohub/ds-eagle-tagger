# ds Eagle Tagger 0.7.2（Windows）

一款轻量 Eagle 插件，通过一键安装的本地 GPU 引擎识别图片，并将 WD14 英文标签写回 Eagle。可仅处理无标签图片，也可保留原标签并补充新的模型标签。整个识别过程在本机完成，不会弹出命令行窗口。

## 使用条件

- Windows 10 / 11，64 位系统
- NVIDIA 显卡，建议至少 6 GB 显存
- 建议预留 5 GB 磁盘空间
- 首次安装组件及首次下载模型时需要联网
- Eagle 需保持运行

## 安装与首次使用

1. 双击 `ds-Eagle-Tagger-0.7.2.eagleplugin`，由 Eagle 完成插件安装。
2. 打开插件，点击“开始安装”。插件会在后台准备 Python 3.12 与 NVIDIA GPU 推理组件，不会显示命令行窗口。
3. 安装完成后选择 Eagle 文件夹、当前选中图片或整个图库。
4. 确认任务并开始识别。首次识别会下载约 1.26 GB 的 WD14 模型，界面会显示百分比、容量、速度和预计时间；后续会直接使用本地缓存。

模型下载会先尝试 Hugging Face 官方源，失败后自动切换备用镜像，并支持断点续传、Windows 下载通道兜底及 SHA-256 完整性校验。

Python 3.12 会优先从中国科学技术大学镜像准备，失败后切换 GitHub 官方源；GPU 依赖会依次尝试中国科学技术大学、清华大学和 PyPI 官方源。切换来源时会保留已有下载缓存。

如果无法在线下载模型，可从网盘取得 `model.onnx` 和 `selected_tags.csv`，在设置中点击“导入本地模型”。文件大小和 SHA-256 全部通过校验后才会启用。

本地引擎默认安装到：

```text
%LOCALAPPDATA%\EagleAutoTagger\engine
```

下载缓存位于：

```text
%LOCALAPPDATA%\EagleAutoTagger\cache
```

处理记录默认位于：

```text
%LOCALAPPDATA%\EagleAutoTagger\data\history.sqlite3
```

## 主要功能

- 在插件内读取、搜索并多选 Eagle 逻辑文件夹。
- 父文件夹可使用“含子级 N”一次选中所有下级文件夹。
- 已选文件夹可逐个移除；多文件夹图片会按 Eagle 项目 ID 自动去重。
- 支持“只打标当前选中的图片”和“处理整个图库”。
- 默认跳过已有标签，不覆盖用户已有整理结果。
- 可切换“补充已有标签”：保留全部原标签，仅追加模型新标签并自动去重。
- 记录 Eagle 图片 ID、模型版本、识别设置、上次模型标签和处理时间，避免相同条件下重复识别。
- 用户删除过模型标签、调整阈值或更换模型后，会重新加入待处理范围。
- 处理记录默认保存在本机，也可在设置中迁移到 D、E、N 等其他可写硬盘。
- 跨硬盘迁移会先校验新数据库再删除旧文件；也可选择保留旧文件作为备份。
- 设置中可检查维护者批准的 WD14 模型版本；新模型按 revision 分目录下载，校验成功后才切换。
- 支持从本地选择 `.onnx` 与 `.csv` 文件，校验后导入当前批准模型。
- 旧模型版本暂时保留，模型变化会使同条件处理记录自动失效并重新进入待识别范围。
- 支持 Batch 1 / 2 / 4 / 8、标签阈值、标签上限和 rating 标签设置。
- 启动时检测 NVIDIA 显卡与可用显存，自动推荐 Batch；仍可手动选择 1 / 2 / 4 / 8。
- 推理中如遇显存不足，会按 8 → 4 → 2 → 1 自动降级，并记住当前显卡的安全值。
- 支持仅预览、实时进度、安全停止及失败项目定位。
- 默认启用 Logo / 文字图人物误识别过滤。

## 修复与卸载

若安装停在“验证本地推理引擎”并提示失败，请先根据界面中的具体错误处理：

- 提示 Visual C++ 或 DLL 加载失败：安装最新的 Microsoft Visual C++ v14 Redistributable（x64），重启 Windows 后再进入插件“设置”，点击“修复 / 重新安装引擎”。
- 提示 NVIDIA、CUDA、cuDNN 或 cublas：更新 NVIDIA Studio / Game Ready 驱动，重启 Windows 后重试。
- 提示拒绝访问：在安全软件中允许 Eagle 以及 `%LOCALAPPDATA%\EagleAutoTagger` 下的本地 Python 运行。

0.7.2 及以上版本会把完整安装诊断保存到：

```text
%LOCALAPPDATA%\EagleAutoTagger\logs\setup.log
```

修复引擎不会删除已经下载的模型。

卸载插件后，如果也要移除本地引擎、模型和缓存，请先关闭插件，再删除：

```text
%LOCALAPPDATA%\EagleAutoTagger
```

## 隐私与许可

图片、文件路径和识别结果均在本机处理；插件不包含账号系统、广告、遥测或使用统计。联网仅用于下载运行组件与固定版本模型。详情见 `PRIVACY.md` 和 `THIRD_PARTY_NOTICES.md`。

### 作者

由 [discipo](https://github.com/discipohub) 创建和维护。模型与第三方组件沿用各自的许可条款，详见 `THIRD_PARTY_NOTICES.md`。

ds Eagle Tagger 源码采用 MIT License，完整条款见随包附带的 `LICENSE`。

## 识别范围说明

当前使用 `SmilingWolf/wd-eva02-large-tagger-v3`。该模型更适合动漫、插画和风格化游戏美术；写实照片、纯 Logo、复杂排版及 3D 渲染可能出现不准确标签。建议先对小范围图片使用“仅预览”检查效果。
