# 飞书同步 Worker

这个 Worker 负责安全保存飞书应用凭据，并为 GitHub Pages 提供受同步令牌保护的 `/health`、`/connect` 和 `/sync` 接口。

## 1. 准备账号

1. 注册并登录 Cloudflare。
2. 在飞书开放平台创建“企业自建应用”。
3. 为应用开启多维表格的查看、编辑和管理权限，并发布应用版本。
4. 新建一个空白多维表格，把该表授权给自建应用。

## 2. 部署 Worker

请先安装 Node.js 22 或更高版本，再进入 `worker` 目录：

```powershell
npm install
npx wrangler login
npx wrangler secret put FEISHU_APP_ID
npx wrangler secret put FEISHU_APP_SECRET
npx wrangler secret put SYNC_TOKEN
npm run deploy
```

`SYNC_TOKEN` 请使用密码管理器生成的高强度随机字符串。命令会交互式读取值，密钥不会写入仓库。

如果本地开发端口不是 `8000`，请在 `wrangler.jsonc` 的 `ALLOWED_ORIGINS` 中增加对应来源；线上固定允许 `https://witchear.github.io`。

## 3. 连接管理器

1. 打开秋招管理器，进入“工具”→“飞书同步设置”。
2. 填写部署后显示的 `https://...workers.dev` 地址和 `SYNC_TOKEN`。
3. 在飞书中打开具体数据表，确保地址包含 `/base/...` 和 `?table=...`，复制完整链接。
4. 点击“连接并初始化表格”。Worker 会创建所需字段。
5. 回到首页点击“有未同步变更”，即可批量新增或更新飞书记录。

## 安全边界

- 不要把 `.dev.vars`、`.env`、飞书应用密钥或同步令牌提交到 Git。
- Worker 不保存投递数据，只在请求期间转换并转发到飞书。
- 同步不会删除飞书记录，也不会读取飞书修改覆盖本地数据。
- 建议定期保留管理器导出的 JSON 备份。

## 测试

```powershell
npm test
```
