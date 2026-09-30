import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { ruleSchema, localDate, type Rule } from "../shared/types";
import { evaluate } from "../shared/engine";
import { demoRule, scenarios, type Scenario } from "../shared/demo";
import {
  AppError,
  boundedJSON,
  record,
  collect,
  searchSymbols,
  parseIntent,
  policyIssue,
} from "./providers";
import {
  createTask,
  editTask,
  toggleTask,
  runTask,
  tick,
  listTasks,
  listRuns,
  listAlerts,
  getTask,
  quota,
} from "./store";

type Context = { Bindings: Env; Variables: { workspace: string } };
const app = new Hono<Context>();
const bytes = (s: string) => new TextEncoder().encode(s);
const hex = (b: ArrayBuffer) =>
  Array.from(new Uint8Array(b))
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
async function workspace(cookie: string | undefined, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  if (cookie && /^[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(cookie)) {
    const [id, sig] = cookie.split(".");
    const signature = new Uint8Array(
      sig.match(/.{2}/g)!.map((v) => parseInt(v, 16)),
    );
    if (await crypto.subtle.verify("HMAC", key, signature, bytes(id)))
      return { id, cookie };
  }
  const id = crypto.randomUUID();
  return {
    id,
    cookie: id + "." + hex(await crypto.subtle.sign("HMAC", key, bytes(id))),
  };
}
app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  if (!c.env.SESSION_SECRET) throw new AppError("服务尚未配置完成", 503);
  if (!["GET", "HEAD"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    const expected = new URL(c.req.url).origin;
    if (!origin || origin !== expected)
      throw new AppError("请求来源不匹配，请从产品页面操作", 403);
    if (!c.req.header("Content-Type")?.startsWith("application/json"))
      throw new AppError("请使用 JSON 请求", 415);
  }
  const session = await workspace(
    getCookie(c, "radar_session"),
    c.env.SESSION_SECRET,
  );
  setCookie(c, "radar_session", session.cookie, {
    httpOnly: true,
    sameSite: "Strict",
    secure: c.req.url.startsWith("https:"),
    path: "/",
    maxAge: 30 * 86400,
  });
  c.set("workspace", session.id);
  await next();
});
const body = async (request: Request) =>
  record(await boundedJSON(new Response(request.body), 16384));
function ruleFrom(value: unknown): Rule {
  const parsed = ruleSchema.safeParse(value);
  if (!parsed.success)
    throw new AppError(parsed.error.issues.map((i) => i.message).join("；"));
  const issue = policyIssue(parsed.data.originalText + " " + parsed.data.title);
  if (issue) throw new AppError(issue);
  return parsed.data;
}
app.get("/api/health", async (c) => {
  const heartbeat = await c.env.DB.prepare(
    "SELECT value,updated_at FROM meta WHERE key='cron'",
  ).first<{ value: string; updated_at: number }>();
  return c.json({
    serverTime: Date.now(),
    timezone: "Asia/Shanghai",
    model: c.env.LLM_MODEL,
    aiConfigured: !!c.env.LLM_API_KEY,
    dataConfigured: !!c.env.FUYAO_API_KEY,
    heartbeat: heartbeat
      ? { ...JSON.parse(heartbeat.value), receivedAt: heartbeat.updated_at }
      : null,
    limits: {
      perWorkspaceActive: 3,
      globalActive: Number(c.env.MAX_ACTIVE_TASKS),
      dailyAI: Number(c.env.MAX_DAILY_AI),
    },
  });
});
app.get("/api/symbols", async (c) => {
  const q = c.req.query("q") ?? "";
  if (q.trim().length < 2) return c.json({ items: [] });
  return c.json({ items: await searchSymbols(c.env, q) });
});
app.post("/api/rules/parse", async (c) => {
  const input = await body(c.req.raw);
  const text = z.string().trim().min(4).max(1200).safeParse(input.text);
  if (!text.success) throw new AppError("请输入4–1200字的监控意图");
  const issue = policyIssue(text.data);
  if (issue) throw new AppError(issue);
  await quota(c.env.DB, "ai-global", Number(c.env.MAX_DAILY_AI));
  await quota(c.env.DB, "ai-workspace:" + c.get("workspace"), 20);
  const id = crypto.randomUUID();
  const parsed = await parseIntent(c.env, text.data);
  const draft = parsed.draft;
  const clarifications = Array.isArray(draft.clarifications)
    ? draft.clarifications.map(String)
    : [];
  const unsupported = Array.isArray(draft.unsupported)
    ? draft.unsupported.map(String)
    : [];
  const query =
    typeof draft.symbolQuery === "string" ? draft.symbolQuery.trim() : "";
  const symbols = query ? await searchSymbols(c.env, query) : [];
  if (!query) clarifications.push("请明确要监控的证券名称或代码");
  if (query && !symbols.length)
    clarifications.push("未找到匹配A股证券，请核对名称或6位代码");
  if (
    symbols.length > 1 &&
    !symbols.some(
      (s) =>
        s.symbol === query ||
        s.symbol.slice(0, 6) === query ||
        s.name === query,
    )
  )
    clarifications.push("找到多个证券，请在规则编辑器中明确选择");
  const symbol =
    symbols.find(
      (s) =>
        s.symbol === query ||
        s.symbol.slice(0, 6) === query ||
        s.name === query,
    ) ?? (symbols.length === 1 ? symbols[0] : undefined);
  const candidate = {
    ...draft,
    originalText: text.data,
    symbol: symbol?.symbol ?? "",
    symbolName: symbol?.name ?? "",
  };
  const validated = ruleSchema.safeParse(candidate);
  if (!validated.success && !clarifications.length && !unsupported.length)
    clarifications.push("模型草稿未通过规则校验，请使用手动配置明确条件");
  const ready =
    validated.success && !clarifications.length && !unsupported.length;
  await c.env.DB.prepare(
    "INSERT INTO ai_audit(id,workspace,model,input_hash,status,usage_json,created_at) VALUES(?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      c.get("workspace"),
      parsed.model,
      hex(await crypto.subtle.digest("SHA-256", bytes(text.data))),
      ready ? "validated" : "needs_clarification",
      JSON.stringify(parsed.usage),
      Date.now(),
    )
    .run();
  return c.json({
    auditId: id,
    model: parsed.model,
    usage: parsed.usage,
    rule: ready ? validated.data : null,
    draft: candidate,
    symbols,
    clarifications,
    unsupported,
    defaults:
      "未指定频率时每5分钟盘中检查；未指定冷却时24小时。请检查后确认启用。",
  });
});
app.post("/api/rules/preview", async (c) => {
  const rule = ruleFrom((await body(c.req.raw)).rule);
  const now = Date.now();
  const bundle = await collect(c.env, rule, now);
  return c.json({
    result: evaluate(rule, bundle, now),
    evidence: Object.values(bundle).filter(Boolean),
    at: now,
  });
});
app.get("/api/tasks", async (c) =>
  c.json({
    tasks: await listTasks(c.env.DB, c.get("workspace")),
    alerts: await listAlerts(c.env.DB, c.get("workspace")),
  }),
);
app.post("/api/tasks", async (c) => {
  const rule = ruleFrom((await body(c.req.raw)).rule);
  const symbols = await searchSymbols(c.env, rule.symbol);
  if (
    !symbols.some((s) => s.symbol === rule.symbol && s.name === rule.symbolName)
  )
    throw new AppError("证券代码与名称未通过数据源核验，请重新检索选择");
  const task = await createTask(c.env, c.get("workspace"), rule, "live");
  return c.json({ task }, 201);
});
app.get("/api/tasks/:id", async (c) => {
  const task = await getTask(c.env.DB, c.req.param("id"), c.get("workspace"));
  const versions = await c.env.DB.prepare(
    "SELECT version,rule_json,created_at FROM versions WHERE task_id=? ORDER BY version DESC",
  )
    .bind(task.id)
    .all<{ version: number; rule_json: string; created_at: number }>();
  return c.json({
    task,
    runs: await listRuns(c.env.DB, task.id),
    versions: versions.results.map((v) => ({
      version: v.version,
      rule: JSON.parse(v.rule_json),
      createdAt: v.created_at,
    })),
  });
});
app.patch("/api/tasks/:id", async (c) => {
  const input = await body(c.req.raw);
  if (!Number.isInteger(input.previousVersion))
    throw new AppError("需要提供原版本号");
  const rule = ruleFrom(input.rule);
  const symbols = await searchSymbols(c.env, rule.symbol);
  if (
    !symbols.some((s) => s.symbol === rule.symbol && s.name === rule.symbolName)
  )
    throw new AppError("请重新核验证券名称与代码");
  return c.json({
    task: await editTask(
      c.env,
      c.get("workspace"),
      c.req.param("id"),
      rule,
      Number(input.previousVersion),
    ),
  });
});
app.post("/api/tasks/:id/actions", async (c) => {
  const input = await body(c.req.raw),
    id = c.req.param("id"),
    ws = c.get("workspace");
  await getTask(c.env.DB, id, ws);
  if (input.action === "pause" || input.action === "resume")
    return c.json({
      task: await toggleTask(c.env, ws, id, input.action === "resume"),
    });
  if (input.action === "run")
    return c.json(await runTask(c.env, id, "manual", { workspace: ws }));
  throw new AppError("不支持的操作");
});
app.post("/api/demo", async (c) => {
  await body(c.req.raw);
  return c.json(
    { task: await createTask(c.env, c.get("workspace"), demoRule, "demo") },
    201,
  );
});
app.post("/api/tasks/:id/demo", async (c) => {
  const input = await body(c.req.raw),
    id = c.req.param("id"),
    ws = c.get("workspace"),
    task = await getTask(c.env.DB, id, ws);
  if (task.mode !== "demo") throw new AppError("真实任务禁止注入构造数据");
  if (typeof input.scenario !== "string" || !(input.scenario in scenarios))
    throw new AppError("场景无效");
  const scenario = input.scenario as Scenario;
  let now = Math.max(Date.now(), (task.lastRunAt ?? 0) + 1000);
  if (scenario === "duplicate") {
    await runTask(c.env, id, "demo", {
      scenario: "matched",
      now,
      workspace: ws,
    });
    now += 1000;
  }
  if (scenario === "recover") {
    await runTask(c.env, id, "demo", {
      scenario: "failed",
      now,
      workspace: ws,
    });
    now += 1000;
  }
  if (scenario === "cooldown") {
    await runTask(c.env, id, "demo", {
      scenario: "matched",
      now,
      workspace: ws,
    });
    now += 1000;
    await runTask(c.env, id, "demo", {
      scenario: "unmatched",
      now,
      workspace: ws,
    });
    now += 1000;
  }
  if (scenario === "expired") {
    now = Math.max(now, task.cooldownUntil + 1000);
    await runTask(c.env, id, "demo", {
      scenario: "unmatched",
      now,
      workspace: ws,
    });
    now += 1000;
  }
  return c.json(
    await runTask(c.env, id, "demo", { scenario, now, workspace: ws }),
  );
});
app.get("/api/ai-audit", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id,model,status,usage_json,created_at FROM ai_audit WHERE workspace=? ORDER BY created_at DESC LIMIT 10",
  )
    .bind(c.get("workspace"))
    .all();
  return c.json({ items: rows.results });
});
app.notFound((c) => c.json({ error: "接口不存在" }, 404));
app.onError((error, c) => {
  if (error instanceof AppError)
    return c.json({ error: error.message }, error.status as 400);
  console.error(
    JSON.stringify({ event: "api_error", path: c.req.path, type: error.name }),
  );
  return c.json({ error: "服务暂时异常，请稍后重试；检查记录会保留" }, 500);
});
export default {
  fetch: app.fetch,
  async scheduled(event, env) {
    await tick(env, event.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
