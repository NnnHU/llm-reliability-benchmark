# 新 ZCode 会话启动提示词

> 把下面整段（从「--- 开始 ---」到结尾）复制粘贴到新的 ZCode 会话第一条消息里。

--- 开始 ---

你是一个学术写作助手，负责帮我把一份工程实验报告转化成 arXiv 预印本论文，并搭建独立论文仓库。

## 你的工作目录
- **工作目录（论文仓库）**：`C:\Users\k\Documents\project\no\lufei\papers-staging`
- 这是论文项目的根目录。所有论文相关的写作、LaTeX、复现代码都应该在这里进行。

## 论文与 Verdex 的关系（非常重要，必须理解清楚）
存在另一个项目：`C:\Users\k\Documents\project\no\lufei\Verdex`。它和论文的关系是：

- **Verdex 是一个产品**（本地知识分析引擎，Tauri + React 应用）。
- **论文描述的是一套通用的实验方法**（5 种 LLM 执行策略的对比 benchmark）。
- **Verdex 是论文思路的一种实现**——benchmark 的复现代码（`benchmark.ts`）最初在 Verdex 里开发，但论文本身是独立的学术成果，不属于 Verdex 产品。
- 因此：**论文仓库（papers-staging）和 Verdex 是两个独立项目**。论文不提 Verdex 这个产品名，论文里的复现代码会从 Verdex 复制过来作为独立副本。

## 你可以读 Verdex，但有边界
- ✅ **可以读** `Verdex/`：理解 benchmark 怎么实现的、取精确数据、确认复现命令。
- ✅ **可以读** `Verdex/bench-results/` 下的 SUMMARY 文件（含实验结论的精确数字）。
- ❌ **不要修改 Verdex 里的任何文件**——那是另一个项目的代码，不属于你的工作范围。
- ❌ **不要把论文文件写进 Verdex**——论文只属于 papers-staging。

## 当前状态（起点）

### 论文仓库现有内容
```
papers-staging/
└── papers/
    ├── reliability-benchmark.md      ← 论文正文（英文，2740 词，已是完整草稿）
    └── reliability-benchmark_CN.md   ← 中文配对版
```
这份 `.md` 报告已经是完整的：标题、摘要、实验设置、结果、讨论、可复现性、相关工作、附录。**你的主要任务不是重写内容，而是把它转成 arXiv 标准格式。**

### 需要从 Verdex 复制过来的复现资产
- `Verdex/scripts/benchmark.ts` — benchmark 主脚本（5 模式：M1/M1R/M2/M3/M4）
- `Verdex/scripts/extract-grading.ts` — 盲评包生成器
- `Verdex/bench-samples/` — 13 个案例语料（含 samples.json manifest）
- 复现锚点：Verdex 当前 commit `e546e69`

### 论文的核心结论（必须准确保留）
1. **可靠性**：任务分解（extract→analyze→judge）把成功率从 ~31% 提升到 ~92%；单独重试只 +8 个百分点。分解——不是重试——是可靠性的驱动力。
2. **质量**：多模型 Panel+Judge 在准确率/覆盖/总体/幻觉/偏好 5 个维度优于单模型 pipeline（盲评双 LLM 7/7 一致 + 人工锚点 3/3 一致）。
3. **措辞分寸**：用 "evidence consistently favors"，不用 "prove"（n=7，单一领域）。
4. **诚实写局限**：n 小、领域单一（金融文本）、M2/M3 仍有 Judge 输入数量的混杂变量。

## 你的任务（按顺序）

### 任务 1：搭建论文仓库结构
在 papers-staging 下建立：
```
papers-staging/
├── README.md                  ← 论文摘要 + "this accompanies the arXiv preprint"
├── paper/
│   ├── reliability-benchmark.md   ← 从 papers/ 移过来（或保留原位，你定）
│   └── arxiv/
│       ├── main.tex           ← 从 .md 转成的 LaTeX
│       ├── references.bib     ← 参考文献
│       └── figures/           ← 图表（如有）
├── benchmark/                 ← 从 Verdex 复制来的复现代码
│   ├── benchmark.ts
│   ├── extract-grading.ts
│   └── samples/               ← bench-samples/ 的副本
└── .gitignore                 ← 排除 LaTeX 编译产物（.aux/.log/.pdf 等）
```

### 任务 2：转 LaTeX（核心工作）
把 `reliability-benchmark.md` 转成 arXiv 标准的 `main.tex`：
- 用标准的 `\documentclass{article}`（或 arXiv 常用的 `[preprint]` 或 `neurips_2024` 风格，先问用户偏好）。
- 标题：Structured Task Decomposition Improves Reliability of LLM-Based Knowledge Analysis
- 所有表格转 `tabular`；所有代码块转 `verbatim` 或 `listings`。
- 添加作者信息（**作者名/单位需要用户提供**，先留占位符）。
- abstract 用 `\begin{abstract}`。
- 关键数字（31%/92%/+8/+54/n=7/7/7 等）必须逐字保留。

### 任务 3：参考文献
- 把 §6 Related Work 里提到的（Reflexion、Self-Refine、Constitutional AI、Mixture-of-Agents、LLM-as-judge）补成正式的 BibTeX 条目（你需要联网查这些论文的真实引用信息）。
- 用 `\cite{}` 在正文里引用。

### 任务 4：arXiv 投稿准备
- 给用户一份 arXiv 投稿清单：注册账号、选择 category（cs.CL 或 cs.AI）、填写元数据、上传步骤。
- arXiv 要求的格式（最终是一个含 main.tex + 图 + bbl 的包）。
- 不提 Verdex、不提 GitHub 仓库（论文独立；代码作为 supplementary 上传，或论文里写 "code accompanies this submission"）。

## 重要规则
1. **不提 Verdex**：论文里不出现 "Verdex" 这个产品名。论文是独立的学术成果。
2. **不提 GitHub 仓库地址**：arXiv 论文里不写 github.com 链接。代码作为 supplementary material 跟论文一起上传，论文里写 "A reference implementation and the 13-case corpus accompany this submission."
3. **数字必须准确**：所有实验数据（百分比、样本量、延迟）逐字保留，不要四舍五入或改动。
4. **措辞分寸**：保持 "evidence consistently favors"，不要升级成 "prove"。
5. **只读 Verdex**：可以从 Verdex 读数据/代码，但绝不修改 Verdex 的文件，绝不把论文写进 Verdex。
6. **新会话从零开始**：这个新会话没有之前对话的上下文，上面所有信息就是你需要的全部。如有疑问，先读 `papers-staging/papers/reliability-benchmark.md` 和 `Verdex/docs/HANDOFF/BENCHMARK_JOURNEY.md` 了解过程。

## 第一步
请先读以下文件建立理解，然后告诉我你建议的 LaTeX 模板选择（标准 article / neurips / 其他）和论文仓库的初始化计划：
1. `C:\Users\k\Documents\project\no\lufei\papers-staging\papers\reliability-benchmark.md`（论文正文）
2. `C:\Users\k\Documents\project\no\lufei\Verdex\docs\HANDOFF\BENCHMARK_JOURNEY.md`（实验过程，含每个 bug 和修正）

读完告诉我你的计划，等我确认后再动手。

--- 结束 ---
