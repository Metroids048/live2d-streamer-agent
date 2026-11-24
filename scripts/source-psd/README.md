# Layout 源图高清 PSD

离线文件转换，复用本机 PSD2Live 3.6.7 的 `LayoutManifest`、`PsdWriter`、`PsdReader`；不连接编辑器、不改制作阶段、不安装依赖。

```sh
./scripts/node.sh scripts/export-source-psd.mjs \
  --layout /absolute/candidateRoot/artwork/layout.json \
  --output /absolute/new-delivery/角色-源图高清.psd \
  --runtime-manifest evidence/single-image-live2d/03/full-quality-20261104/native-mesh-resolution-runtime.json
```

Node 调用：`exportSourcePsd({layoutPath, outputPath, runtimeManifest, reportPath?, javaPath?, signal?})`，从 `src/artwork/source-psd.mjs` 导入。`candidateRoot` 接入只需传 `path.join(candidateRoot, 'artwork/layout.json')`；名称和 revision 不参与转换。输出目录应由调用方登记为**源素材 PSD**，不冒充已有 Rig 工程导出。所有输出路径必须是新的。

默认主链由 Packaging 1.2.0 在离线打包时自动调用：核对同版 Artwork stage/manifest/Layout/逐层 PNG 与 Dynamics 的身份和哈希，再生成 `editable/source/source.psd`、`readback.json`、`provenance.json`。PackageBundle/包内 manifest 登记 `sourcePsdPath`、`sourcePsdReadbackPath`、`sourcePsdProvenancePath`，产物角色为 `source_psd`、`source_psd_readback`、`source_psd_provenance`；原 `psdPath` 仍指引擎原生导出。完整包和 editable-assets 包均包含源PSD与证明，runtime 包省略编辑素材。公开证明只保留候选相对源路径和工具文件名/哈希，不包含本机绝对路径。运行时默认来自项目已固定的 `config/psd2live-runtime.json`。

打包重入只复验并复用同身份完成包；失败记录和历史缺少高清源PSD的包不自动覆盖重建。历史 1.1 包仍可按原契约独立复验，不能借此声明包含高清源PSD。该转换不接编辑器，不能重放未知引擎作业。

画布缩放倍数为全部图层最大 `源像素尺寸 / Layout 逻辑尺寸` 向上取整，至少 1。每层浮点位置和尺寸按此倍数取最近整数，再用 nearest-neighbour 只放大原 RGBA。因此每个原像素仍能从结果恢复，低分辨率身体也会放大，没有新增细节。图层和组显隐、顺序及不透明度保留；不透明度受 PSD 8-bit 精度限制。画布超过 PSD 的 30,000 像素边长就拒绝。

写后从磁盘真实读回全部图层；校验名字、顺序、组、显隐、不透明度、坐标、全部放大后 RGBA，并逐个恢复全部原始像素检查零丢失、零通道误差。Node 另用现有 PNG 解码器核对源 RGBA 哈希。`*.readback.json` 记录结果、原 ID 到 PSD 数字 ID 映射和坐标误差；`*.psd.provenance.json` 绑定输入、102 个运行时组件、编译器、工具源码/JAR、PSD 和读回报告的 SHA256。临时编译目录自动清理。

限制：这是普通可编辑栅格图层，不是智能对象。坐标各分量最多偏差半个输出像素，原浮点 Layout 仍为权威源；nearest-neighbour 高倍观看可能有像素感。成熟写入器的合并缩略图使用白底，并忽略组显隐/不透明度，编辑图层与组元数据仍保留；不能把缩略图当图层验证。当前读回证明文件结构和源像素保真，不是 Photoshop 人工打开、Artwork 质量、Rig 动态、生产包或用户认可。

小型真实往返回归（不启动引擎）：

```sh
SOURCE_PSD_RUNTIME_MANIFEST=evidence/single-image-live2d/03/full-quality-20261104/native-mesh-resolution-runtime.json \
  ./scripts/node.sh --test test/source-psd.test.mjs
```

未设置运行时环境变量时只运行覆盖保护、运行时哈希保护，真实往返用例明确跳过。

本次 r11 实证：`evidence/single-image-live2d/03/full-quality-20261104/source-psd-r11/delivery/`。800×800 逻辑画布以 9 倍输出 7200×7200；36 层、6 个隐藏状态；脸部源 655×717 → PSD 704×719。全部 4,954,732 个源像素可零误差恢复；最大逻辑坐标分量误差约 0.05534。该文件仅修复源 PSD 缩图问题，不消除源图已有空洞和低分辨率素材问题。
