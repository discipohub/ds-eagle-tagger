此目录包含 ds Eagle Tagger 的本地引擎源文件和首次安装工具。

首次打开插件时，这些源文件会复制到：
%LOCALAPPDATA%\EagleAutoTagger\engine

Python 环境及推理依赖由随包附带的 uv.exe 在后台安装，并自动尝试国内镜像与官方源。
模型不包含在插件包内，可在首次识别时按需下载，也可在设置中从本地文件导入并校验。
