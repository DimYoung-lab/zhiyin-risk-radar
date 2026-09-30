# 知因雷达

把自然语言关注点转成可检查、可修改的规则，持续运行，并解释为什么提醒或没有提醒。

## 开发

Node.js 22+。安装依赖后，将密钥放入本地 `.dev.vars`（已忽略），运行 `npm run types`、`npm run db:local`、`npm run build`、`npm run dev:api`。产品与 API 同时位于 `http://localhost:8787`。

项目采用 React + TypeScript + Hono + Cloudflare Workers / D1 / Cron。AI 只生成规则草稿；确定性引擎执行判断。完整设计、验证记录和交付说明随开发持续补充。
