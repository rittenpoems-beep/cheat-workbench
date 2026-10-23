# Edge 会话连接

工作台不再为每次同步启动额外浏览器。同步复用用户日常 Edge 中已有的抖音创作者中心登录状态：用户安装一次本机扩展、配对一次，工作台与 Edge 重启都自动重连；只有换账号时才要求确认。

- 扩展源码与安装步骤：`apps/workbench/browser-extension/README.md`
- 公共契约：`shared/browser.ts`
- 体验空间（4318）不挂载 `/api/browser/*`，也不接受真实账号。

## 配对与令牌

1. 用户在真实空间生成一次性配对码（8 位，10 分钟内有效，只能用一次；新码作废旧码）。
2. 扩展在 `POST /api/browser/agent/pair` 中提交配对码与自身 origin；服务端记录配对并返回令牌。
3. 令牌形如 `wbc_<32 字节 base64url>`。服务端只保存 `sha256(token)`，扩展把明文令牌保存在 `chrome.storage.local`。
4. 令牌绑定 `chrome-extension://<id>`，只能用于 `/api/browser/agent/*`，并带限速。断开连接或服务端配对记录失效后，旧令牌立即返回 401。

配对记录位于 `apps/workbench/.workbench-data/owner/.workbench/browser.json`，原子写入；文件损坏时失败关闭并要求重新配对，不删除原文件。工作区 Markdown 不包含令牌或配对记录。

长期配对是对“仅内存令牌”的明确放宽：本机能读取浏览器资料或该文件的程序，理论上可冒充扩展访问本机工作台。它无法借此读取抖音 Cookie、发布内容或访问其它站点；用户可随时在扩展弹窗中断开。

## 连接与同步

`connected` 的定义是：配对记录存在、扩展已建立轮询，且最近 45 秒内有过 poll/event。扩展使用 25 秒长轮询；空闲时由 30 秒 alarm 唤醒，不依赖页面常驻。

同步任务：

1. 服务端前置检查：体验空间 403；已有活动同步 409；未配对 409 `BROWSER_UNPAIRED`；扩展离线 409 `BROWSER_OFFLINE`。**不会静默改为启动其他浏览器或读取其他登录态。**
2. 创建任务并下发 `sync` 命令；扩展复用或打开 creator.douyin.com 标签并聚焦。
3. 未登录时任务进入 `waiting`，阶段为 `login`；用户在同一标签本人登录后自动继续。
4. 识别账号时优先比较稳定 ID，其次比较规范化昵称。与上次确认的账号一致则自动继续；不一致或无法识别时必须确认，确认结果持久化。
5. 扩展从页面自身 `fetch` / `XMLHttpRequest` 响应中取作品，只上报白名单字段：作品 ID、标题、发布时间、五项指标；账号只上报名称与 ID。
6. 服务端重新校验 ID 与指标、重建作品 URL、去重并限制数量，再通过 `Workspace.importWorks()` 写入 `videos/*/report.md`。缺失指标保持 `null`，不补 0；至少一条作品含至少一个真实指标才算成功。

取消同步只发送 `cancel` 命令并停止本次采集，不导入部分结果，不关闭用户标签，也不清除 Edge 登录状态。关闭创作者中心标签会以 `TAB_CLOSED` 失败。

## 初始化时的历史对齐

初始化向导可发起一次 `forInitialization: true` 的同步，按用户选择的条数（最多 50，常见为 20）读取近期作品。它与普通同步走同一条 Edge 通道、同一套账号确认与字段校验，不新增浏览器、不读取 Cookie。

完成后写入：

- `metadata.workbench.init.historyImportStatus`: `pending` → `imported` / `failed` / `cancelled`
- `metadata.workbench.init.historySamples`: 实际导入条数
- `metadata.workbench.init.historyBaselinePlays`: 所有有播放数作品的中位数
- `videos/<id>/report.md`: 标题、时间、链接、五项指标与 `source: douyin-creator-edge`；缺失指标保持“未获取”

历史样本不会增加 `calibration_samples`，也不会抬高 confidence。Edge 离线或未配对时初始化仍可完成，状态保持 `pending`，可在方法与设置页重试。

## 权限边界

扩展仅申请 `storage`、`alarms`，host 权限仅 `https://creator.douyin.com/*` 与 `http://127.0.0.1/*`（端口固定 4317）。不申请 `cookies`、`debugger`、`webRequest`、`tabs` 或全站权限，不复制浏览器资料，不启动第二个浏览器，不发布内容。

页面主环境脚本只在同步活动期间解析命中作品/账号接口的 JSON，并以白名单形式转发；页面伪造消息不能变成命令。内容脚本只读取登录状态提示、昵称和分页控件，不读取稿件、私信或其它站点内容。

## 主要错误码

| 错误码 | 含义 |
| --- | --- |
| `BROWSER_UNPAIRED` / `BROWSER_OFFLINE` | 尚未配对 / 扩展当前无响应，任务不会创建 |
| `EXTENSION_TIMEOUT` | 扩展未在 10 秒内接手命令 |
| `TAB_CLOSED` / `PAGE_LOST` | 创作者中心标签被关闭或页面失去响应 |
| `ACCOUNT_UNKNOWN` / `ACCOUNT_CONFIRM_REQUIRED` | 无法识别账号 / 等待账号确认 |
| `NO_WORKS` / `NO_METRICS` / `INVALID_ITEMS` | 没有作品列表 / 没有真实指标 / 没有可识别 ID，均不导入 |
| `EXTENSION_OUTDATED` | 扩展协议版本与工作台不一致，重新加载扩展 |
| `SYNC_TIMEOUT` / `SYNC_INACTIVE` | 总时长超时 / 长时间没有新进度 |

## 测试

```text
cd apps/workbench
npm test                  # BrowserBridge、同步状态机、归一化、UI 状态
npm run extension:test    # 扩展纯函数
npm run extension:e2e     # 合成端到端，需要 Python + Playwright
npm run extension:check   # 扩展脚本语法
```

合成 E2E 使用伪造创作者中心页面和假服务端，覆盖配对、长轮询、账号确认、fetch/XHR 采集、翻页、去重、缺失指标、完成与断开吊销。它不能证明真实账号已经导入；真实登录、换号、标签关闭与指标抽查必须由本人完成。
