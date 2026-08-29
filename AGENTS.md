# 1688 采集器操作须知

## Coolify 应用

- 采集器：`1688-dom-collector`，UUID `kc1izz5i6mnhs9z29ckl1ajp`
- 采集器地址：<https://collector.yiswim.cloud>
- 集成 noVNC：<https://collector.yiswim.cloud/login/vnc.html?autoconnect=1&resize=remote&path=login/websockify>

## 重要约束

- 采集和登录模式共用 Persistent Volume 的 `/app/storage/browser-profile`，必须通过浏览器模式 API 互斥切换。
- 不要手工启动第二个 Chromium 或直接复用该 profile。
- 不要在对话、日志或提交中输出 Cookie、token、Secret 或代理密码。
- Coolify 操作前必须先读取 `coolify` skill，并检查应用当前状态；不要凭猜测索要用户手动执行。

## 登录/采集模式切换

1. 调用 `POST /api/browser-mode/login`；该接口会暂停任务领取、等待当前浏览器操作结束、关闭采集 Chromium，再启动可视 Chromium/noVNC。
2. 通过集成 noVNC URL 登录；noVNC 仍有独立 Basic Auth。
3. 登录完成后调用 `POST /api/browser-mode/collector`；该接口会保存会话、关闭可视 Chromium，再恢复采集 Chromium和任务 worker。
4. 调用 `POST /api/plugin-session/check` 并轮询任务，确认插件登录有效。

用 `GET /api/browser-mode` 检查实际模式。不要只根据浏览器页面是否显示登录状态判断，也不要通过重启/重新部署代替模式切换。

## 采集接口

全店商品：

```text
POST https://collector.yiswim.cloud/api/shop-scans/all
```

请求体只需提供：

```json
{"url":"https://shop1442128638027.1688.com/page/offerlist.htm"}
```

接口使用现有 Bearer API 认证；测试时只报告状态、总数、页数、请求次数和耗时，不报告商品 ID 或认证信息。

## 故障排查顺序

1. 查看 Coolify 应用状态和最近部署日志。
2. 确认两个应用没有同时运行。
3. 确认 `/app/storage` 已挂载且可写。
4. 检查 noVNC 和健康接口的 HTTP 状态。
5. 再检查 1688 登录状态，最后才重新部署。
