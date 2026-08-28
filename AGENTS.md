# 1688 采集器操作须知

## Coolify 应用

- 采集器：`1688-dom-collector`，UUID `kc1izz5i6mnhs9z29ckl1ajp`
- 登录/noVNC：`1688-collector-login`，UUID `lel8d5rmvlos9hr6c81ap5vh`
- 采集器地址：<https://collector.yiswim.cloud>
- noVNC 地址：<https://collector-login.yiswim.cloud>

## 重要约束

- 两个应用共享同一个 Persistent Volume 的 `/app/storage`，不能同时运行，否则会争用 Chromium profile。
- 不要在对话、日志或提交中输出 Cookie、token、Secret 或代理密码。
- Coolify 操作前必须先读取 `coolify` skill，并检查应用当前状态；不要凭猜测索要用户手动执行。

## 首次登录/切换流程

1. 停止 `1688-dom-collector`。
2. 启动 `1688-collector-login`。
3. 检查 noVNC URL 返回正常页面后，让用户在其中登录 1688。
4. 调用登录检测接口确认登录成功。
5. 停止 `1688-collector-login`，等待容器完全停止。
6. 启动 `1688-dom-collector`，再次调用登录检测接口。

每一步都要核实 Coolify 状态、容器健康状态和 HTTP 返回结果。不要只根据浏览器页面是否显示登录状态判断。

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
