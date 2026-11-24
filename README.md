# 主播虚拟形象 Agent

用分层 PSD 制作 Live2D 角色。项目接收已登记的制作素材，调用本地 PSD2Live 完成导入、自动绑定、嘴眼与转头动作编排，并导出可编辑工程、运行时模型和六秒动画预览。

## 试跑制作链

需要 Node.js 24+、FFmpeg、JDK 21 和 Gradle 9.6.1。先准备项目锁定的 PSD2Live 引擎。

```sh
mkdir -p .local/tools
git clone --recurse-submodules https://github.com/tsunehimatoi/psd2live.git .local/tools/psd2live
git -C .local/tools/psd2live checkout bfadd8343774d5b6208146060c4fa175d84a0f4f
git -C .local/tools/psd2live submodule update --init --recursive
# JAVA_HOME 指向 JDK 21，LIVE2D_GRADLE 指向 Gradle 9.6.1 的可执行文件。
sh scripts/build-psd2live.sh
```

从 [PSD2Live 示例发布页](https://github.com/tsunehimatoi/psd2live-examples/releases/tag/assets-v1) 下载 `tml-1.0.0.zip`。将其中的分层 PSD 放到 `assets/upstream/tml/psd-input/tml.psd`。程序按 [素材清单](assets/upstream/tml/manifest.json) 核对 SHA-256。这份素材按 CC0-1.0 发布。若引擎找不到 FFmpeg，设置 `LIVE2D_FFMPEG` 为其绝对路径。

```sh
node scripts/maker.mjs materials
node scripts/maker.mjs make '{"material_id":"tml-cc0-demo"}'
node scripts/maker.mjs making '{"job_id":"<make 返回的 jobId>"}'
```

查询到 `completed` 后，可以在 `openclaw-workspace/outputs/<jobId>/` 取到工程、模型目录、预览和文件引用检查。六秒预览由已编排的参数驱动。摄像头、麦克风和直播场景需要各自的运行环境。

## 代码结构

| 路径 | 负责内容 |
| --- | --- |
| `src/` | 素材接入、制作任务、绑定逻辑、模型检查和本地跟踪控制 |
| `scripts/` | 制作、状态查询、引擎构建和导出入口 |
| `openclaw-plugin/` | 制作工具和附件回传适配 |
| `config/` | 素材来源、引擎版本和项目配置 |
| `test/` | 制作阶段、模型、动作几何和回归检查 |

`npm test` 执行 Node 测试。涉及图像处理的模块另需 Python、Pillow、NumPy 和 OpenCV。公开版可先运行 `node --test test/controller.test.mjs test/maker.test.mjs test/rigging-wave.test.mjs`。完整回归还依赖原项目的私有样本与特定引擎运行清单，这些路径的测试会报告缺少依赖。

`node scripts/cli.mjs status` 检查本地运行状态。VTube Studio 与 OBS 需单独配置。VTubeLeaf 可作本地预览，其接口和现有 VTube Studio 适配不同。单图定制及高清源 PSD 打包属于实验入口，需要另行准备相应的图像工具或服务，以及经核验的同版引擎构建和运行清单。公开配置关闭付费调用。示例 PSD 流程可在本地运行。

项目代码采用 MIT。PSD2Live、VTubeLeaf 和 CC0 示例素材分别沿用各自许可，版本和来源见 [依赖清单](config/upstream.lock.json) 和 [素材说明](assets/upstream/tml/SOURCE.md)。
