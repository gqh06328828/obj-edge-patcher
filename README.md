# OBJ Edge Patcher / EdgeScope

根据三角网格和网络预测的逐边边界概率，进行几何约束分片，并用交互式桌面查看器检查结果。

本仓库保存当前源代码基线。原始模型、STEP、预测数据、运行结果、下载缓存及 Windows 打包产物保留在本地，不纳入 Git 历史。

## 核心代码

| 路径 | 内容 |
|---|---|
| `readout/geometry_readout.py` | 读出算法、输入映射校验、Python API、命令行与结果导出 |
| `readout/test_readout.py` | 9 项不依赖私有模型的合成回归测试 |
| `readout/DESIGN.md` | 算法目标、参数、约束及限制 |
| `readout/RESULTS.md` | 当前 6 个本地样本的运行摘要；不是 STEP 精度评价 |
| `edge_viewer/` | Three.js 概率/分片查看器 |
| `edge_viewer/desktop/` | Electron 主进程、原生文件选择、后台读出连接与 Windows 打包脚本 |
| `edge_viewer/vendor/` | 固定版本前端依赖及其许可证 |

## 读出算法

当前是定向二次曲面代理的区域图优化：连通微区域初始化 → 联合几何/概率的区域合并 → 必要的重新切分 → 最小规模强制约束 → 保持连通的边界细化。

低概率不会禁止切分；高概率不会强制切分。每片须满足连通、最少三角形数和最小面积限制。算法只读取网格和概率，不把 STEP 或已有分片颜色作为推理输入。

它是第一版局部优化实现，尚不能保证每个分片对应一个 BRep 面。当前边界沿现有网格边，复杂圆环和过渡面可能过分割或欠分割。细节见 [算法设计](readout/DESIGN.md)。

## 安装与运行读出

Python 3.12 是已验证的运行环境。

```shell
python -m venv .venv
# Windows PowerShell: .\.venv\Scripts\Activate.ps1
# Linux/macOS: source .venv/bin/activate
python -m pip install -r readout/requirements.txt
python readout/geometry_readout.py --mesh path/to/model.obj --probabilities path/to/model__edge_boundary_probability.csv --out results/new-run
```

结果包含彩色 PLY、按片分组 OBJ、原三角形标签、边界表、查看器标签 JSON 和验收报告。请选择新的输出目录，程序不会覆盖已有结果。若将自定义结果保存到仓库其他目录，请勿直接 `git add .`；先检查待提交文件。

输入必须是预测时对应的原始三角网格，CSV 顶点/三角形编号从 1 开始。列要求及 PLY 支持范围见 [设计文档](readout/DESIGN.md)。

## 验证

```shell
python -m unittest discover -s readout -p test_readout.py -v
```

这些合成测试无需 `manual_test`。`readout/summarize_results.py`、`edge_viewer/verify.mjs` 则需要本地模型/结果，不能在干净克隆中直接运行。

## 查看器与桌面打包

现有桌面程序可选择模型、CSV/Excel 概率表，调整颜色与筛选，运行分片并对照查看结果。软件窗口关闭后退出。

开发预览：安装 Node.js，将示例数据放在 `manual_test/v3`，运行 `node edge_viewer/server.cjs`。浏览器版提供可视化，后台读出入口在桌面版中。

当前 Windows 打包脚本保留开发机的原始实现，**尚不是跨机器的一键构建**：

1. `edge_viewer/desktop/build.ps1` 需要本地 `edge_viewer/build-cache/electron-v44.3.0-win32-x64.zip` 和同版本 `SHASUMS256.txt`，会校验 SHA256。
2. 运行库来自 [Electron v44.3.0 官方发布页](https://github.com/electron/electron/releases/tag/v44.3.0)。这些下载文件未提交。
3. `build-readout.ps1` 当前读取开发机 Codex 缓存中的 Python 3.12 和 NumPy。换机器时需修改 `$runtimeSource` 指向相应的 Windows Python 3.12 安装目录，并安装 NumPy。
4. 执行 `powershell -NoProfile -ExecutionPolicy Bypass -File edge_viewer/desktop/build.ps1`，生成 `EdgeScope-Windows/`。复制程序时必须复制整个文件夹。

## 版本备份与修改方式

首次基线使用标签 **`readout-v1-baseline`**。Git 提交保存每次明确记录的版本；GitHub 保存已经推送的提交。保存文件本身不会自动生成版本备份。

建议每个算法尝试新开一个分支：

```shell
git switch -c experiment/my-readout-change
# 修改算法并运行测试
git add readout/geometry_readout.py readout/test_readout.py
git diff --cached
git commit -m "Describe the readout change and its purpose"
git push -u origin experiment/my-readout-change
```

首次手动提交前，如 Git 提示缺少身份，请设置自己的 `user.name` 和 `user.email`。初始提交由 Codex 自动创建；不修改本机全局 Git 身份。

查看历史：`git log --oneline --decorate --all`。查看初始算法：`git show readout-v1-baseline:readout/geometry_readout.py`。需要在旧版本上继续实验时，可用 `git switch -c experiment/from-baseline readout-v1-baseline`；有未提交修改时先提交或保存，避免覆盖工作。

仓库保留 Three.js、SheetJS 的原始许可证；当前未替用户选择项目自有代码的开源许可证。
