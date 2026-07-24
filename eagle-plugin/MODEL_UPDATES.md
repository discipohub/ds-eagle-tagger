# 模型更新维护说明

插件只显示维护者加入批准清单的模型，不会直接跟随上游 `main` 分支。

## 发布一个批准模型

1. 下载候选版本的 `model.onnx` 和 `selected_tags.csv`。
2. 在支持的 Windows、NVIDIA GPU 和 Eagle 版本上完成推理、标签格式与质量测试。
3. 计算两个文件的精确字节数和 SHA-256。
4. 在 `model-catalog.json` 的 `releases` 中增加一项，并递增 `sequence`。
5. 若现有引擎兼容，保持 `min_engine_version` 为当前版本；否则先发布兼容的新插件。
6. 将完整的 `model-catalog.json` 发布到维护者控制的稳定 HTTPS 地址。

`config.json` 中的 `model_catalog_urls` 用于配置在线批准清单，例如：

```json
{
  "model_catalog_urls": [
    "https://raw.githubusercontent.com/discipohub/ds-eagle-tagger/main/model-catalog.json"
  ]
}
```

远程清单可以增加版本，也可以更新同 ID 条目。文件下载完成后，插件会按清单中的大小和 SHA-256 校验，再原子写入 `model-selection.json` 切换版本。

模型缓存按仓库名和完整 revision 分目录保存，因此升级不会直接覆盖旧模型。当前版本暂不自动删除旧模型，便于故障回退。

## 发布渠道

正式版使用 GitHub `main` 分支中的 `model-catalog.json` 作为在线批准清单。发布新的批准模型前，应先完成测试、文件大小与 SHA-256 校验，再更新该文件。

建议同时提供官方源和国内只读镜像；两者应发布完全相同的清单。远程地址一旦公开，应保持长期稳定。
