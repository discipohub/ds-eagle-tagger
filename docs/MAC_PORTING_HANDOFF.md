# ds Eagle Tagger：Mac 版开发交接说明

## 目标

在不影响现有 Windows 0.7.2 版本的前提下，制作一个面向 Apple Silicon 的独立 Mac 版本。稳定后再考虑 Windows 与 Mac 通用包，以及 Intel Mac 支持。

现有 HTML、CSS、Eagle 文件夹选择、任务确认、进度、失败定位和标签写入逻辑可以复用。主要改造范围是首次安装器、平台路径、Python 环境和 ONNX Runtime 推理后端。

## 推荐开发方式

1. 从本交接包的 `source` 建立独立 Mac 分支或副本。
2. 不要直接覆盖 Windows 0.7.2。
3. 第一阶段仅支持 Apple Silicon 原生 Eagle。
4. 先生成独立的 Mac `.eagleplugin` 测试包，再考虑合并通用包。

## Eagle 清单

Mac 测试包可先使用：

```json
{
  "platform": "mac",
  "arch": "arm"
}
```

长期通用包可以使用 `platform: all`、`arch: all`，再通过 `eagle.app.platform`、`eagle.app.arch` 和 `eagle.app.runningUnderARM64Translation` 选择引擎。

## 本地安装目录

Windows 当前使用 `%LOCALAPPDATA%\\EagleAutoTagger`。Mac 建议使用：

```text
~/Library/Application Support/EagleAutoTagger
```

虚拟环境解释器路径：

```text
Windows: .venv\\Scripts\\python.exe
Mac:     .venv/bin/python
```

Mac 包应附带官方 Apple Silicon 版 `uv`，首次运行前执行 `fs.chmodSync(uvPath, 0o755)`。子进程继续使用 `shell: false`，不要打开 Terminal。

## Mac 依赖

新增 `requirements-mac.txt`，不要安装 CUDA、cuDNN 或 NVIDIA 依赖。建议从以下版本开始验证：

```text
onnxruntime==1.23.2
numpy==2.5.1
pillow==12.3.0
requests==2.34.2
```

## Core ML 推理

`wd14.py` 中按平台选择 Provider：

```python
if sys.platform == "darwin":
    preferred = ["CoreMLExecutionProvider", "CPUExecutionProvider"]
else:
    preferred = [
        "CUDAExecutionProvider",
        "DmlExecutionProvider",
        "CPUExecutionProvider",
    ]
```

Core ML 会话建议从以下配置开始测试：

```python
providers = [
    (
        "CoreMLExecutionProvider",
        {
            "ModelFormat": "MLProgram",
            "MLComputeUnits": "ALL",
            "RequireStaticInputShapes": "0",
            "ModelCacheDirectory": coreml_cache_dir,
        },
    ),
    "CPUExecutionProvider",
]
```

启动后必须检查 `ort.get_available_providers()`。没有 Core ML 时应明确显示 CPU 后备状态，不能显示 GPU 已启用。仅看到 Provider 名称也不能证明全部算子已进入 Core ML，需要通过性能或 profiling 验证是否大面积回退 CPU。

## 模型与下载

继续使用现有 `model.onnx` 和 `selected_tags.csv`，revision、文件大小和 SHA-256 不变。保留官方源、备用镜像、断点续传、下载进度和完整性校验。

Mac 下将 `curl.exe` 兜底改为 `/usr/bin/curl` 或 `shutil.which("curl")`。第一次加载可能需要编译 Core ML 模型，界面应显示“正在首次编译 Core ML 模型”，并使用 `ModelCacheDirectory` 保留编译缓存。

## UI 调整

- 首次安装条件改为 Apple Silicon 和建议内存，不再显示 NVIDIA/RTX。
- 状态栏改为 `Apple Silicon · Core ML · Batch 1`。
- 第一版默认 Batch 1，再实际测试 2 和 4。
- 检测 Rosetta 时提示用户安装 Apple Silicon 原生版 Eagle。
- Core ML 不可用时提示 CPU 模式会更慢。

## Gatekeeper 与签名

必须使用从网络下载的真实 `.eagleplugin` 测试，而不能只在开发目录运行。确认：

- 插件内的 `uv` 是否保留执行权限。
- Gatekeeper 是否阻止辅助程序。
- 如被阻止，评估 Developer ID 签名与公证。
- 插件关闭时能否正确终止 Python 子进程。

## 最低验收清单

1. 全新 Apple Silicon Mac、未安装 Python，也能一键安装。
2. 安装和推理期间不出现 Terminal。
3. 实际检测到 `CoreMLExecutionProvider`。
4. 首次模型下载显示百分比、容量、速度和剩余时间。
5. 下载中断后可以续传，错误文件不能加载。
6. 首次 Core ML 编译有状态提示，第二次启动复用缓存。
7. 测试 Batch 1 / 2 / 4 的速度、内存和稳定性。
8. 中文路径、空格路径、外置磁盘图片可处理。
9. 与 Windows 对同一批图片的结果基本一致。
10. M1 8 GB 等低配机器不会因默认设置直接崩溃。
11. 插件停止和关闭能终止后台任务。
12. 从 Eagle 安装的成品包通过 Gatekeeper 测试。

## 交接包说明

- `eagle-plugin/`：插件与唯一一份 Python 引擎源码。
- `scripts/`：构建与开发辅助脚本。
- Windows 成品位于 GitHub Releases，可用于观察 UI 和行为，不可作为 Mac 引擎直接使用。
- 模型未包含在源码中；固定版本与校验信息位于 `eagle-plugin/engine/config.json`。
