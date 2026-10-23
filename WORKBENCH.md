# 创作者实验台

这是在 [XBuilderLAB/cheat-on-content](https://github.com/XBuilderLAB/cheat-on-content) 基础上增加的本地图形操作界面，独立产品名为“创作者实验台”。上游固定版本：`5e8fb6ffb8a0f67f8456348ee08932c93e93abf5`。原来的 Skill、模板、参考协议、数据适配器与 MIT 许可均保留。

## 打开

Windows 双击 `apps/workbench/start-workbench.cmd`。首次缺依赖时会执行 npm ci 和前端构建。也可在 `apps/workbench` 中执行 `npm ci`、`npm run build`、`npm start`。

停止时双击 `apps/workbench/stop-workbench.cmd`，程序会等待执行器退出并清理旧版临时会话。开发验收可用 `./start-workbench.ps1 -NoBrowser` 只启动服务，不唤起浏览器。

- 真实工作区：<http://127.0.0.1:4317>
- 独立演示区：<http://127.0.0.1:4318>

前端为 React/TypeScript/Vite，后台为 Express，采集器为 Python/Playwright。本机启动脚本优先使用已存在的 Codex 配套 Node 24 LTS，不修改系统 Node。

## 这是上游的界面层

工作区仍以 `.cheat-state.json`、`scripts/*.md`、`predictions/*.md`、`videos/*/report.md`、`rubric_notes.md` 为真源。应用不以独立数据库替换框架。新稿、冻结版本、预测、发布登记和追加复盘都真实落盘，可从界面查看 Markdown 并导出。应用元数据采用命名空间 `metadata.workbench`。

15 个原始 Skill 可从“框架”页阅读。核心选题、起草、修改、独立评审、预测和复盘会加载对应上游协议执行；其他 Skill 提供明确标注的操作预览，不宣称完成了规则升级等尚未执行的副作用。Web 层负责文件保护、交互确认及结构化输出校验。

预测同时加载上游强制引用的盲预测协议、七组件解剖与状态规范。五档概率、判断因素、锚点或 N/A、逐档反事实和假设会先呈现为提案；用户确认最终稿后才锁定预测和稿件快照。预测数值是待校准的主观判断，界面不会把它叫作已验证的实际成功率。

## 初始化

“初始化创作空间”严格按上游 `cheat-init` 的 Phase 0–5 执行，不是只写名称和领域：

1. Phase 0 读取现状。已有完整初始化时，重新初始化必须先确认；已有作品、选题、预测与校准样本不会被清空。
2. Phase 1–2 依次询问期望、内容形态、时长、更新频率、历史同步方式、数据回收与候选池、常用 hooks。内容形态会映射到对应 starter rubric。
3. Phase 2.5 记录对标账号、风格与至少 3 条样本（推荐 5–10 条）。没有真实样本时标记为待补充，不虚构账号或数字。
4. Phase 3 先合并 `.gitignore`，写入 rubric、模板、对标样本与 hooks 选择，**最后**才写 `.cheat-state.json`。任一文件失败都不会留下“已初始化”的假状态。`initialized_at` 使用本地时间（`+08:00`），`hooks_installed` 为 `false`，`enabled_perf_adapters` 为 `[]`；写 hooks 文件不等于验证了触发。
5. Phase 3.5 历史同步是独立任务，不阻塞初始化。它通过 Edge 读取近期作品并写入 `videos/*/report.md`，数量记录为历史样本，**不会**增加校准样本或抬高 confidence；历史基线取所有有播放数作品的中位数。
6. Phase 4–5 逐项报告 created / preserved / skipped / warnings 与下一步。账号未对齐时初始化仍可完成，界面持续提示“历史未对齐”，之后可重试。

对标分析是受约束的模型调用：只接受样本标题中的原文证据，拒绝指标数字、百分比与权重；成功只写 `benchmark.md` 的定性段、`script_patterns.md` 的借用段（标注 `Imported, untested on my channel`）与 `rubric-memo.md` 的未校准观察，**不写** `rubric_notes.md`。失败不落盘。

## 执行器

默认通道是本机 CodeBuddy CLI。常规选题、起草、改写、预测、复盘与聊天由 CodeBuddy 主 agent 直接执行；程序每次新建空工作目录，关闭会话持久化与 MCP，stdout 有上限，超时即终止。CLI 顺序为 `WORKBENCH_CODEBUDDY_CLI`、PATH 中的 `codebuddy`/`cbc`、常见安装位置（如 WorkBuddy 内置的 `resources/app.asar.unpacked/cli/bin/codebuddy`）。Node 脚本会用当前 Node 执行；可通过“测试连接”确认实际路径、版本与认证方式。

认证有两种：

- 本机 CodeBuddy 登录：使用 CodeBuddy 自己的登录态，不复制、不读取凭据。仅用于非盲任务，不扣本应用的 API 预算。
- 模型 API 后端：把独立模型 API 的 Key 与地址通过环境变量交给 CodeBuddy 子进程，并使用临时配置目录。非盲与盲评都可用；非盲调用会计入共享费用估算。

独立模型 API 也能作为单独通道执行非盲任务。默认 DeepSeek `https://api.deepseek.com`、`deepseek-flash`；模型列表从 `/models` 读取。Key 可在界面填写（仅当前进程保存）或在 `.env` 设置 `DEEPSEEK_API_KEY` / `WORKBENCH_MODEL_API_KEY`。参考 `.env.example`。不要将 Key 发送到聊天、提交到 Git 或写入演示材料。两个空间共享、持久保存 API 用量估算；达到估算阈值后停止后续 API 请求。单次调用可能跨过阈值，取消或断网可能无法取回实际用量；这不是账户账单硬上限，也不包含本机 Agent 的订阅额度。计价采用保守的高峰缓存未命中价格，参考 [DeepSeek 官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。

### 独立盲评：主 agent → 子 agent

盲评固定为 CodeBuddy 主 agent 派生子 agent，不是另一次直接模型调用。主 agent 只拿到调度指令，且仅允许使用 CodeBuddy 内置的 `Agent` 工具：它必须调用一次 `subagent_type: cheat-blind-reviewer`，把评分协议、当前冻结稿件与纯评分规则放进子 agent 的 prompt，不包含创作历史、作品列表、预测、复盘或账号信息。子 agent 由 `--agents` 定义，禁用全部工具，只输出一个评分 JSON。

服务端从 CodeBuddy 的 transcript 校验：存在已完成的 `Agent` 调用且类型正确、对应 tool_result 可解析为评分、主 agent 与子 agent 都没有其它工具调用。评分优先取子 agent 的 tool_result，而不是主 agent 的转述；任一校验失败即任务失败，不保存评分。

隔离依赖临时 `CODEBUDDY_CONFIG_DIR`、`--setting-sources local`、`--strict-mcp-config`、`--no-session-persistence` 与自动记忆/会话摘要禁用。因此盲评只接受模型 API 后端，不接受本机账号登录态；没有 Key 或 CodeBuddy 不可用时直接失败，不会改用其他通道。需要说明：子 agent 是同一 CodeBuddy 进程内的独立会话，不是操作系统级子进程；主 agent 负责调度。若 CodeBuddy 未在 transcript 中暴露子 agent 用量，只记录可见用量并标注“子 agent 用量未暴露”，不编造数字。

注意：本机 CodeBuddy 当前可能未登录；此时默认回退到模型 API 后端并在界面如实显示。Claude CLI、Codex CLI、Qoder CLI 等通用 Agent 接入仍在持续开发，标记为实验性或未接入，暂不保证兼容；当前完整支持 CodeBuddy 与独立模型 API。

## 连接抖音与热点

真实空间顶栏显示 Edge 连接状态。首次使用由本人加载一次本机扩展并粘贴配对码；之后同步复用日常 Edge 中已有的抖音创作者中心登录态，工作台或 Edge 重启都会自动重连。未登录时任务会等待你在同一标签完成登录；只有切换账号才需要再次确认。同步读取最近作品与五项指标并写入 `videos/*/report.md`，缺失指标保持“未获取”，不会补 0。取消或关闭标签都不会导入部分结果，也不会关闭页面或清除登录状态。

扩展仅申请 `storage`、`alarms` 与创作者中心、本机工作台的访问权限；不读取 Cookie，不使用调试器或全站权限，不复制浏览器资料，不启动第二个浏览器，不自动发布。安装、权限、令牌权衡与排障见 `apps/workbench/browser-extension/README.md`，协议见 `apps/workbench/BROWSER_CONNECTION.md`。

Python 采集器仍用于热点读取：`python -m pip install -r collector/requirements.txt`，缺浏览器时执行 `python -m playwright install chromium`。作品同步不再启动临时 Chromium，也不使用 collector 的登录/截图链路。

抖音采集使用上游 `douyin-session` 的接口观察和归一化方法，修正缺失值与清理生命周期。发布标题/文案不等于完整口播稿；缺少原稿时仅分析历史题材与表现。指标是采集当时的快照，不会冒充历史 T+3 数据。

热点先读取抖音公开热榜的真实页面响应，保留榜位和原始热度；需要补充行业事件时读取有链接的公开资讯，并明确标注非抖音热榜。源不可用时如实报告。

## 演示与访问边界

两个端口固定绑定两个独立目录。示例空间不允许连接真实账号或修改提供方密钥；不能通过客户端参数切到真实工作区。演示作品均标注为虚构样例。真实热点和本次 AI 生成另有来源、时间和任务日志。

本次只监听本机。任务进度使用普通 HTTP 轮询；没有将真实工作区或示例空间公开到互联网。

## 检查

```text
cd apps/workbench
npm test
npm run extension:test
npm run extension:e2e
npm run extension:check
python -m unittest discover -s collector -p "test_*.py"
npm run build
```

真实账号导入必须由本人在日常 Edge 中完成一次配对并抽查指标；合成端到端、公开热榜与示例操作通过不等于私人账号导入已验收。

## 与上游的兼容边界

界面执行原方法并保留原文件布局；新增版本/任务元数据有明确命名空间。首次用户的方向性预测会强调无个人校准证据，不宣称精确流量。自动升级评分公式、跨平台多账号、自动发布和自动口播转写不属于本次首版。

上游完整版权和许可见根目录 `LICENSE`。
