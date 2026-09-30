// Requires the actual Wrangler runtime (npm run dev:api), not a mocked API.
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const base = process.env.RADAR_TEST_URL ?? "http://127.0.0.1:8787";
let cookie = "";
const report = [];
let liveId;
async function request(path, method = "GET", data, options = {}) {
  const response = await fetch(base + "/api" + path, {
    method,
    headers: {
      ...(data ? { "Content-Type": "application/json", Origin: base } : {}),
      ...(cookie && !options.isolated ? { Cookie: cookie } : {}),
      ...options.headers,
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  if (!options.isolated && response.headers.get("set-cookie"))
    cookie = response.headers.get("set-cookie").split(";")[0];
  const value = await response.json();
  return { status: response.status, value };
}
async function check(name, work) {
  const started = Date.now();
  try {
    await work();
    report.push({ name, passed: true, durationMs: Date.now() - started });
    console.log("PASS " + name);
  } catch (error) {
    report.push({ name, passed: false, error: error.message });
    console.log("FAIL " + name + ": " + error.message);
  }
}
await check("真实数据与模型凭证已配置", async () => {
  const r = await request("/health");
  assert.equal(r.status, 200);
  assert.equal(r.value.aiConfigured, true);
  assert.equal(r.value.dataConfigured, true);
});
let id, rule, version;
await check("创建隔离演示任务并持久化", async () => {
  const r = await request("/demo", "POST", {});
  assert.equal(r.status, 201);
  id = r.value.task.id;
  rule = r.value.task.rule;
  version = r.value.task.version;
  const loaded = await request("/tasks/" + id);
  assert.equal(loaded.value.task.id, id);
  assert.equal(loaded.value.versions.length, 1);
});
async function scene(s) {
  const r = await request("/tasks/" + id + "/demo", "POST", { scenario: s });
  assert.equal(r.status, 200);
  return r.value;
}
await check("未满足不提醒", async () => {
  const r = await scene("unmatched");
  assert.equal(r.run.result.decision, "unmatched");
});
await check("首次满足提醒且原始证据可追溯", async () => {
  const r = await scene("matched");
  assert.equal(r.run.result.decision, "alert");
  assert.equal(r.run.evidence[0].fields.raw.prev_price, 1300);
  assert.ok(r.run.result.checks.every((c) => c.evidenceIds.length));
});
await check("重载后同周期不重复提醒", async () => {
  await request("/tasks/" + id);
  const r = await scene("duplicate");
  assert.equal(r.run.result.decision, "dedup");
  assert.equal(
    (await request("/tasks")).value.alerts.filter((a) => a.taskId === id)
      .length,
    1,
  );
});
await check("数据过期不误判", async () => {
  const r = await scene("stale");
  assert.equal(r.run.result.truth, "unknown");
  assert.equal(r.run.evidence[0].quality, "stale");
});
await check("字段冲突不误判", async () => {
  const r = await scene("conflict");
  assert.equal(r.run.result.truth, "unknown");
  assert.equal(r.run.evidence[0].quality, "conflict");
});
await check("接口故障进入重试状态", async () => {
  const r = await scene("failed");
  assert.equal(r.task.health, "degraded");
  assert.ok(r.task.failCount > 0);
  assert.equal(r.run.result.decision, "unknown");
});
await check("恢复后保留原周期，记录恢复，不重复提醒", async () => {
  const r = await scene("recover");
  assert.equal(r.task.health, "healthy");
  assert.equal(r.run.result.recovered, true);
  assert.equal(r.run.result.decision, "dedup");
});
await check("新周期冷却中不提醒", async () => {
  const r = await scene("cooldown");
  assert.equal(r.run.result.decision, "cooldown");
  assert.equal(
    (await request("/tasks")).value.alerts.filter((a) => a.taskId === id)
      .length,
    1,
  );
});
await check("冷却到期仍满足才提醒", async () => {
  const r = await scene("expired");
  assert.equal(r.run.result.decision, "alert");
  assert.equal(
    (await request("/tasks")).value.alerts.filter((a) => a.taskId === id)
      .length,
    2,
  );
});
await check("暂停禁止执行，恢复不造历史触发", async () => {
  await request("/tasks/" + id + "/actions", "POST", { action: "pause" });
  assert.equal(
    (await request("/tasks/" + id + "/demo", "POST", { scenario: "matched" }))
      .status,
    409,
  );
  const r = await request("/tasks/" + id + "/actions", "POST", {
    action: "resume",
  });
  assert.match(r.value.task.lastReason, /不补造/);
});
await check("规则编辑生成新版本并保留冷却", async () => {
  const before = (await request("/tasks/" + id)).value.task;
  const r = await request("/tasks/" + id, "PATCH", {
    rule: { ...rule, title: "集成验证 v2", cooldownMinutes: 60 },
    previousVersion: version,
  });
  assert.equal(r.status, 200);
  version = r.value.task.version;
  assert.equal(version, 2);
  assert.equal(r.value.task.cooldownUntil, before.cooldownUntil);
  const v = (await request("/tasks/" + id)).value.versions;
  assert.equal(v.length, 2);
  assert.equal(v[1].rule.cooldownMinutes, 1440);
});
await check("过期版本提交返回409", async () => {
  const r = await request("/tasks/" + id, "PATCH", {
    rule,
    previousVersion: 1,
  });
  assert.equal(r.status, 409);
});
await check("并发执行由数据库租约协调", async () => {
  const outcomes = await Promise.all(
    Array.from({ length: 4 }, () =>
      request("/tasks/" + id + "/demo", "POST", { scenario: "matched" }),
    ),
  );
  assert.ok(outcomes.some((r) => r.status === 200));
  assert.ok(outcomes.every((r) => [200, 409].includes(r.status)));
  const alerts = (await request("/tasks")).value.alerts.filter(
    (a) => a.taskId === id && a.version === 2,
  );
  assert.ok(alerts.length <= 1);
});
await check("不同浏览器无法访问任务或证据", async () => {
  assert.equal(
    (await request("/tasks/" + id, "GET", undefined, { isolated: true }))
      .status,
    404,
  );
});
await check("拒绝跨域写入", async () => {
  assert.equal(
    (
      await request(
        "/demo",
        "POST",
        {},
        { headers: { Origin: "https://other.example" } },
      )
    ).status,
    403,
  );
});
await check("拒绝错误JSON内容类型", async () => {
  assert.equal(
    (
      await request(
        "/demo",
        "POST",
        {},
        { headers: { "Content-Type": "text/plain" } },
      )
    ).status,
    415,
  );
});
await check("证券检索使用真实数据", async () => {
  const r = await request("/symbols?q=600519");
  assert.equal(r.status, 200);
  assert.ok(
    r.value.items.some(
      (s) => s.symbol === "600519.SH" && s.name === "贵州茅台",
    ),
  );
});
await check("DeepSeek真实解析与校验", async () => {
  const r = await request("/rules/parse", "POST", {
    text: "贵州茅台跌幅达到3%，并进入热榜前10时提醒我，冷却24小时",
  });
  assert.equal(r.status, 200);
  assert.equal(r.value.model, "deepseek-flash");
  assert.equal(r.value.rule.symbol, "600519.SH");
  assert.equal(
    r.value.rule.conditions.find((c) => c.field === "change_pct").value,
    -3,
  );
  assert.ok(r.value.auditId);
});
await check("模糊阈值需要澄清", async () => {
  const r = await request("/rules/parse", "POST", {
    text: "贵州茅台大跌时提醒我",
  });
  assert.equal(r.status, 200);
  assert.equal(r.value.rule, null);
  assert.ok(r.value.clarifications.length);
});
await check("尚未支持的事件不能替换成行情条件", async () => {
  const r = await request("/rules/parse", "POST", {
    text: "贵州茅台发布回购公告时提醒我",
  });
  assert.equal(r.status, 200);
  assert.equal(r.value.rule, null);
  assert.ok(r.value.unsupported.length);
});
await check("交易建议在调用模型前阻止", async () => {
  const r = await request("/rules/parse", "POST", {
    text: "预测明天股价，推荐买入稳赚的股票",
  });
  assert.equal(r.status, 400);
});
await check("真实数据预检保存源时间、单位与原字段", async () => {
  const r = await request("/rules/preview", "POST", { rule });
  assert.equal(r.status, 200);
  assert.ok(r.value.evidence.length === 2);
  assert.ok(
    r.value.evidence.every((e) =>
      e.endpoint.startsWith("https://fuyao.aicubes.cn/"),
    ),
  );
  assert.ok(r.value.evidence.every((e) => e.dataAt && e.unit));
});
await check("真实任务创建、执行与演示注入隔离", async () => {
  const r = await request("/tasks", "POST", { rule });
  assert.equal(r.status, 201);
  liveId = r.value.task.id;
  assert.equal(
    (
      await request("/tasks/" + liveId + "/demo", "POST", {
        scenario: "matched",
      })
    ).status,
    400,
  );
  const run = await request("/tasks/" + liveId + "/actions", "POST", {
    action: "run",
  });
  assert.equal(run.status, 200);
  assert.equal(run.value.task.mode, "live");
  assert.ok(run.value.run.finishedAt >= run.value.run.startedAt);
  assert.ok(
    run.value.run.evidence.every(
      (e) => e.fetchedAt <= run.value.run.finishedAt,
    ),
    "运行完成时间不能早于证据采集时间",
  );
  await request("/tasks/" + liveId + "/actions", "POST", { action: "pause" });
});
await check("不支持的热榜范围由后端拒绝", async () => {
  const r = await request("/rules/preview", "POST", {
    rule: {
      ...rule,
      conditions: [{ field: "hot_rank", operator: "lte", value: 31 }],
    },
  });
  assert.equal(r.status, 400);
});
await check("无效日期由后端拒绝", async () => {
  const r = await request("/rules/preview", "POST", {
    rule: {
      ...rule,
      conditions: [{ field: "date", operator: "eq", value: "2026-02-30" }],
    },
  });
  assert.equal(r.status, 400);
});
mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/integration-report.json",
  JSON.stringify(
    {
      base,
      at: new Date().toISOString(),
      passed: report.filter((x) => x.passed).length,
      total: report.length,
      checks: report,
    },
    null,
    2,
  ),
);
console.log(`${report.filter((x) => x.passed).length}/${report.length} passed`);
if (report.some((r) => !r.passed)) process.exitCode = 1;
