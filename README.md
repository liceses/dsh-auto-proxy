# dsh-auto-proxy

DeepSeek Harness 插件：让 agent 的命令行网络访问**走代理且不再反复试错**。

在代理环境下，agent 用 git/curl 等获取网络资源时经常卡住、乱试、浪费 token。本插件把代理变成一个**确定的、预先注入的**事实：

- **设置 > 插件 > 插件配置 > 网络代理（auto-proxy）** 卡片：`关闭 / 自动检测 / 手动配置` 三模式。
- **自动检测**：读 Windows 系统代理（HKCU Internet Settings 注册表），回退到宿主环境变量；**手动配置**：直接填 HTTP/HTTPS/SOCKS/NO_PROXY。
- **自动注入**：每个 bash/pwsh 命令自动携带 `DSH_PROXY_*` 变量（经 `ctx.shellEnv` 注册，与内置 `DSH_*` 同通道）。
- **提示词指引**：系统提示新增 `网络代理 (auto-proxy)` section，告诉 agent 联网前如何应用代理、Windows 沙箱下 curl.exe/PowerShell HTTPS 必挂（Schannel `SEC_E_NO_CREDENTIALS`）应改用 node/git 等 OpenSSL 系工具。
- **三个工具**：
  - `proxy_env` — 一次调用返回可直接粘贴的 export 块与 git 建议（禁止自行猜代理端口）。
  - `proxy_test` — 走代理/直连探测目标 URL（CONNECT 隧道 / SOCKS5 握手，纯 node OpenSSL 实现，沙箱内可用），返回状态码、耗时与路径。
  - `proxy_git` — 一键应用/清除 git 全局代理（记住原值，可精确还原）。
- **gitApply 开关**：设置页勾选后把解析出的代理写入 `git config --global http.proxy/https.proxy`，关闭时还原原值（两个键分别记录）。

## 安装

```bash
# 构建
npm install && npm run build

# 方式一：运行时注入（免重启）
dsh inject D:/developing/DSH-plugin/dsh-auto-proxy   # 或注入器 dev_inject_plugin / dev_install_package

# 方式二：作为 bundle 插件装配进 profile
dsh plugin --profile web add @icelily/dsh-auto-proxy
```

重启后由 profile `bundles` 列表正常装配。装好后**刷新一次 Web GUI**，在 设置 > 插件 > 插件配置 即可看到配置卡片。

## 配置字段（settings namespace `auto-proxy`，文档 `~/.dsh/settings.yaml`）

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `mode` | `off` / `auto` / `manual` | `auto` |
| `http` / `https` / `socks` | manual 模式的代理地址（URL 或 `host:port`） | `''` |
| `noProxy` | NO_PROXY 逗号列表 | `''` |
| `gitApply` | 是否同步到 git 全局配置（可精确还原原值） | `false` |
| `testUrl` | 连通性探测目标 | `https://www.google.com/generate_204` |
| `pollSeconds` | 系统代理轮询间隔（秒，0 关闭；默认 30） | `30` |

也可在 profile 的插件行配置（composition base）覆盖默认值：

```yaml
- id: auto-proxy
  config:
    mode: manual
    http: http://127.0.0.1:8080
    socks: socks5://127.0.0.1:10808
    gitApply: true
```

## Agent 侧的使用规则（自动注入到系统提示）

```
## 网络代理 (auto-proxy)
当前代理: 模式=auto，来源=registry，HTTP=...，HTTPS=...，SOCKS=...，NO_PROXY=...
规则（联网前必须执行，不要反复试错）：
1. 每个 shell 命令已自动注入 DSH_PROXY_MODE/SOURCE/HTTP/HTTPS/SOCKS/NO_PROXY/READY 变量；需要联网的 bash/pwsh 命令先执行：
   export HTTP_PROXY="$DSH_PROXY_HTTP" http_proxy="$DSH_PROXY_HTTP" HTTPS_PROXY="$DSH_PROXY_HTTPS" https_proxy="$DSH_PROXY_HTTPS" ALL_PROXY="$DSH_PROXY_SOCKS" NO_PROXY="$DSH_PROXY_NO_PROXY"
2. 也可先调用 proxy_env 工具获取现成的 export 块与 git 建议（一次调用，禁止自行猜测代理端口）。
3. git 网络操作建议 socks5h 代理（DNS 走代理防污染）：git -c http.proxy=$DSH_PROXY_SOCKS -c https.proxy=$DSH_PROXY_SOCKS <子命令>；或调用 proxy_git 工具一键应用/清除全局 git 代理。
4. Windows 沙箱硬限制：curl.exe / PowerShell Invoke-WebRequest / .NET HttpClient 的 HTTPS 在受限沙箱内必然报 SEC_E_NO_CREDENTIALS——抓取请改用 OpenSSL 系工具（node 的 fetch、git、npm），或按沙箱规则升级执行。
5. 网络失败时调用一次 proxy_test 定位问题（它报告走代理/直连的连通性与耗时），根据结果决定下一步，禁止连续盲试。
```

## 结构

```
src/
  index.ts         宿主入口：settings 命名空间、shellEnv 注入、prompt section、3 个工具、2 个路由（status/test）
  proxy.ts         代理解析（注册表 / 环境变量 / 手动）+ export 块生成
  probe.ts         连通性探测（CONNECT 隧道、SOCKS5 握手、直连，node:net/tls 实现）
  git.ts           git 全局代理应用 / 还原
  prompt.ts        系统提示 section 构建
  shared-types.ts  宿主/客户端共享类型
  client/          浏览器半区：settings.plugin.item 卡片（keyed by `auto-proxy`；controller + React 组件 + 样式）
smoke.mjs          核心逻辑独立冒烟测试（node smoke.mjs，无需 DSH 运行时）
```

## 验证

```bash
npm run build          # tsc + tsdown
node smoke.mjs         # 解析/探测逻辑冒烟（走真实 v2RayN 10808 SOCKS）
# 运行时：任意 bash 命令 `env | grep DSH_PROXY`；GET /api/dsh-auto-proxy/status
```

## 实时监测

- **轮询**：默认每 30 秒读取一次系统代理（`pollSeconds` 可调），检测到变化（如代理软件换端口）立即更新 `current` 计划——下一个 shell 命令注入的 `DSH_PROXY_*`、下一步系统提示、以及 status/test 路由全部自动反映新值；无变化零开销（仅一次注册表查询）。
- **惰性刷新**：任何工具调用/路由访问都会按需重解析（1 秒 TTL 去抖），所以设置保存后立即生效。
- 轮询用平台原生 `setInterval` 挂在 fiber effect 上，插件停止/热重载/卸载自动清理。

## 已知边界

- `auto` 模式只能发现 Windows 注册表/环境变量里已有的条目；v2RayN 的 SOCKS 端口若未写入注册表，需在 manual 模式填写。
- `proxy_test` 与 `gitApply` 的目标直连/还原由本机网络状况决定；探测超时默认 10s。
- 客户端卡片在 Web GUI 刷新后生效（client bundle 由 client-modules 服务）。

## License

MIT
