# 可视抖音会话 Worker

这是上游 `adapters/perf-data/douyin-session` 的应用包装层。正常打开创作者中心，被动观察上游已经使用的作品列表响应，复用上游元数据归一化；不修改上游文件。专门覆盖原版的持久 `.auth` 登录方式，改为每任务一个临时 profile；指标缺失保留 `null`。

> **现状**：工作台的作品同步已改用日常 Edge 扩展，不再调用本目录的 `sync` 子命令。这里保留的是热点读取与旧版独立采集能力；下文关于扫码登录、临时 profile 的描述仅适用于单独运行本工具，不代表工作台的行为。

## 安装与自测

```powershell
python -m pip install -r apps/workbench/collector/requirements.txt
python -m playwright install chromium
python -m unittest discover -s apps/workbench/collector -p 'test_*.py' -v
```

## 后端契约

```powershell
python apps/workbench/collector/main.py sync --session-dir D:/safe-job/session --output D:/safe-job/result.json --view D:/safe-job/login.png --confirm D:/safe-job/confirm.json --cancel D:/safe-job/cancel --limit 10
```

- 所有文件路径为绝对路径；`session-dir` 必须不存在或为空目录。所有路径由后端生成，浏览器请求不能传入本地路径。
- 启动后每约 1.5 秒更新登录 PNG，`progress.phase=login`、`viewReady=true` 后可供同空间用户读取。PNG 仅限本机真实空间提供，响应禁用缓存。
- 发出 `account` 事件时暂停。事件包含 `account:{name,id?}`、`identityKnown`、`confirmPath`。此时登录截图已经删除，不再截图后台。`name` 可能为空；UI 必须明示未取得名称，请用户确认本次扫码账号，不能伪造名字。
- 用户确认后，后端原子写入 `confirm` 文件：`{"confirmed":true}`。默认文件路径为 `session-dir/confirm.json`。没有确认就不打开作品列表页。确认默认最多等待 120 秒。
- 用户取消时创建 `cancel` 文件。Worker 0.25 秒轮询取消，页面导航或浏览器关闭期间可能需要等当前 Playwright 调用返回；不要直接杀进程，以确保 `finally` 清理完成。取消文件默认是 `session-dir/cancel`。
- `--visible` 显示独立浏览器，供用户本人正常处理平台额外验证；默认隐藏，二维码在工作台展示。不会读取系统浏览器 profile、任何外部 cookie 或账号令牌。
- `progress` 事件包含 `phase=launch|login|confirm|collect|cleanup`、可选 `count`、`profileRemoved` 等字段；所有标准输出均为 UTF-8 JSONL。没有模拟进度。
- 采集只使用页面正常加载、滚动和可见下一页控件触发的响应，不构造私有请求或签名、不绕过验证、不发布内容。
- 成功必须得到至少一条真实作品，且至少一条作品含非缺失真实指标；扫码成功、HTTP 200、空列表不会算成功。少于目标数量时有明确 warnings。结果 `works` 对齐 `shared/types.ts Work`，未知 `publishedAt` 是空字符串；UI 显示“未获取”。
- 成功结果写入 output，包含 `account`、`works`、`capturedAt`、`requested`、`metricsAvailable`、`warnings`、`cleanup`。先关闭浏览器、删除 profile 和二维码，再输出 `complete`，退出码 0。
- 错误发出 `error`，含 `code` 与可显示中文；非零退出。可能 code：`LOGIN_TIMEOUT`、`CONFIRM_TIMEOUT`、`CANCELLED`、`NO_WORKS`、`NO_METRICS`、`CLEANUP_FAILED`、`BROWSER_ERROR`、`UNSAFE_PATH`、`SESSION_NOT_EMPTY`、`STALE_CONTROL_FILE`。新任务若已有确认/取消文件，拒绝复用，避免旧确认自动生效。
- 任何结束路径清理浏览器 profile、登录图、临时 `login.pending.png` 与确认文件；逐项验证实际不存在，只保留不含凭证的目录标记。目录标记缺失/损坏而 profile 仍存在时明确失败。浏览器关闭/driver 停止异常也不会跳过文件清理，无法验证关闭时返回 `CLEANUP_FAILED`。Windows 进程强杀/断电不能执行 Python finally，后端启动时应根据任务状态处理孤立会话，不能声称已清理。不得对未知目录做递归删除。
- 后端只在同时收到 `complete`、退出码 0、可解析 output、`cleanup.profileRemoved=true`、`cleanup.loginViewRemoved=true`、`cleanup.browserClosed=true` 时将任务置为完成，并复查该任务的 profile、二维码图和临时图在磁盘上不存在。
- 不记录原始响应、cookie、请求 query、头、认证后截图。作品仅保存公开可读元数据与本人的后台指标。保持 owner/demo 空间隔离。

## 公开热榜（可选）

```powershell
python apps/workbench/collector/main.py trends --output D:/safe-job/trends.json --cancel D:/safe-job/cancel --limit 20
```

打开公开 `https://www.douyin.com/hot`，仅从页面实际的 `/hot/search/list` JSON 响应读取词条。输出 `{topics:[{title,url,rank,heat,capturedAt,source:'douyin-hot'}],capturedAt,source}`；`heat` 缺失保持 `null`，rank 为响应 position 或原列表位置。未返回有效热榜则 `NO_TRENDS`，绝不把搜索或外部文章标为抖音热度。完全不使用任何登录 profile。

已于 2026-10-22 在本机实际验证：Python 3.12.10、Playwright 1.62.0、Chromium 151.0.7922.34 可在空 cookie 临时 profile 启动并清理；公开热榜实际返回五条带来源与原始热度的词条。该事实不替代真实账号扫码同步验收。

## 验证边界

20 项单元和生命周期测试覆盖响应形状、去重/补全、空响应、数值缺失、账号提取、取消、超时、异常浏览器关闭、标记损坏和安全清理。真实账号端到端验收须由本人扫码确认，并抽查作品数据；测试通过不代表平台当前可用。
