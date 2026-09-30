import { writeFileSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
const base = "https://zhiyin-risk-radar.dimyoung-0719.workers.dev";
const path = ".env.cron-proof.json";
const localDate = (n) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(n);
const localTime = (n) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(n);
if (process.argv[2] === "prepare") {
  const h = await fetch(base + "/api/health");
  const cookie = h.headers.get("set-cookie").split(";")[0];
  const createdAt = Date.now();
  const rule = {
    title: "后台调度验收 · 当日价格证据",
    symbol: "600519.SH",
    symbolName: "贵州茅台",
    originalText:
      "每天指定时间检查贵州茅台价格大于1元且日期为当日。仅用于后台调度验收。",
    logic: "and",
    conditions: [
      { field: "price", operator: "gt", value: 1 },
      { field: "date", operator: "eq", value: localDate(createdAt) },
    ],
    schedule: {
      mode: "daily",
      intervalMinutes: 5,
      at: localTime(createdAt + 120000),
    },
    cooldownMinutes: 1440,
  };
  const r = await fetch(base + "/api/tasks", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: base,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ rule }),
  });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error);
  writeFileSync(
    path,
    JSON.stringify({
      cookie,
      id: v.task.id,
      createdAt,
      nextRunAt: v.task.nextRunAt,
    }),
  );
  chmodSync(path, 0o600);
  console.log(
    JSON.stringify({
      id: v.task.id,
      createdAt: new Date(createdAt).toISOString(),
      due: new Date(v.task.nextRunAt).toISOString(),
      client: "This process exits now; it does not run or trigger checks.",
    }),
  );
} else {
  const saved = JSON.parse(readFileSync(path, "utf8"));
  const headers = { Cookie: saved.cookie };
  const r = await fetch(base + "/api/tasks/" + saved.id, { headers });
  const v = await r.json();
  const health = await (await fetch(base + "/api/health", { headers })).json();
  const cron = v.runs?.find(
    (r) => r.kind === "cron" && r.status === "complete",
  );
  console.log(
    JSON.stringify({
      heartbeat: health.heartbeat,
      cron: cron
        ? {
            id: cron.id,
            at: cron.startedAt,
            decision: cron.result.decision,
            source: cron.evidence.map((e) => e.source),
          }
        : null,
    }),
  );
  if (cron) {
    const proof = {
      url: base,
      createdAt: saved.createdAt,
      due: saved.nextRunAt,
      observedAt: Date.now(),
      clientExitedBeforeRun: true,
      heartbeat: health.heartbeat,
      run: cron,
    };
    mkdirSync("artifacts", { recursive: true });
    writeFileSync("artifacts/cron-proof.json", JSON.stringify(proof, null, 2));
    await fetch(base + "/api/tasks/" + saved.id + "/actions", {
      method: "POST",
      headers: { ...headers, Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    });
  }
}
