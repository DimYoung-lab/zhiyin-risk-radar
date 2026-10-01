import {
  localDate,
  type Task,
  type Rule,
  type Run,
  type Alert,
  type Bundle,
  type Evaluation,
  type Health,
  type Truth,
} from "../shared/types";
import { decide, evaluate, inWindow, nextRun } from "../shared/engine";
import { demoBundle, type Scenario } from "../shared/demo";
import { collect, AppError } from "./providers";

interface TaskRow {
  id: string;
  workspace: string;
  title: string;
  mode: "live" | "demo";
  rule_json: string;
  version: number;
  enabled: number;
  health: Health;
  last_reason: string;
  last_run_at: number | null;
  next_run_at: number;
  cooldown_until: number;
  episode: number;
  last_truth: Truth;
  notified_episode: number;
  fail_count: number;
  created_at: number;
  updated_at: number;
}
interface RunRow {
  id: string;
  task_id: string;
  version: number;
  started_at: number;
  finished_at: number | null;
  kind: string;
  status: string;
  result_json: string | null;
  evidence_json: string | null;
}
interface AlertRow {
  id: string;
  task_id: string;
  run_id: string;
  version: number;
  title: string;
  reason: string;
  created_at: number;
}
export const taskFrom = (r: TaskRow): Task => ({
  id: r.id,
  workspace: r.workspace,
  title: r.title,
  mode: r.mode,
  rule: JSON.parse(r.rule_json),
  version: r.version,
  enabled: !!r.enabled,
  health: r.health,
  lastReason: r.last_reason,
  lastRunAt: r.last_run_at,
  nextRunAt: r.next_run_at,
  cooldownUntil: r.cooldown_until,
  episode: r.episode,
  lastTruth: r.last_truth,
  notifiedEpisode: r.notified_episode,
  failCount: r.fail_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
export const runFrom = (r: RunRow): Run => ({
  id: r.id,
  taskId: r.task_id,
  version: r.version,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  kind: r.kind,
  status: r.status,
  result: r.result_json ? JSON.parse(r.result_json) : null,
  evidence: r.evidence_json ? JSON.parse(r.evidence_json) : [],
});
export async function getTask(db: D1Database, id: string, workspace?: string) {
  const row = await db
    .prepare(
      "SELECT * FROM tasks WHERE id=?" + (workspace ? " AND workspace=?" : ""),
    )
    .bind(...(workspace ? [id, workspace] : [id]))
    .first<TaskRow>();
  if (!row) throw new AppError("任务不存在", 404);
  return taskFrom(row);
}
export async function listTasks(db: D1Database, workspace: string) {
  return (
    await db
      .prepare(
        "SELECT * FROM tasks WHERE workspace=? ORDER BY created_at DESC LIMIT 100",
      )
      .bind(workspace)
      .all<TaskRow>()
  ).results.map(taskFrom);
}
export async function listRuns(db: D1Database, id: string) {
  return (
    await db
      .prepare(
        "SELECT * FROM runs WHERE task_id=? ORDER BY started_at DESC,id DESC LIMIT 40",
      )
      .bind(id)
      .all<RunRow>()
  ).results.map(runFrom);
}
export async function getRun(db: D1Database, taskId: string, id: string) {
  const row = await db
    .prepare("SELECT * FROM runs WHERE task_id=? AND id=?")
    .bind(taskId, id)
    .first<RunRow>();
  if (!row) throw new AppError("检查记录不存在", 404);
  return runFrom(row);
}
export async function listAlerts(db: D1Database, workspace: string) {
  return (
    await db
      .prepare(
        "SELECT * FROM alerts WHERE workspace=? ORDER BY created_at DESC LIMIT 100",
      )
      .bind(workspace)
      .all<AlertRow>()
  ).results.map(
    (r) =>
      ({
        id: r.id,
        taskId: r.task_id,
        runId: r.run_id,
        version: r.version,
        title: r.title,
        reason: r.reason,
        createdAt: r.created_at,
      }) satisfies Alert,
  );
}
export async function quota(db: D1Database, key: string, limit: number) {
  const row = await db
    .prepare(
      "INSERT INTO quota(key,count,day) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count<? RETURNING count",
    )
    .bind(key + ":" + localDate(Date.now()), localDate(Date.now()), limit)
    .first();
  if (!row)
    throw new AppError("今日使用额度已达上限；可使用手动配置和隔离演示", 429);
}
export async function createTask(
  env: Env,
  workspace: string,
  rule: Rule,
  mode: "live" | "demo",
) {
  const now = Date.now(),
    id = crypto.randomUUID();
  const insert = env.DB.prepare(
    `INSERT INTO tasks(id,workspace,title,mode,rule_json,next_run_at,created_at,updated_at)
 SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM tasks WHERE workspace=?)<30
 AND (?='demo' OR ((SELECT COUNT(*) FROM tasks WHERE mode='live' AND enabled=1)< ? AND (SELECT COUNT(*) FROM tasks WHERE workspace=? AND mode='live' AND enabled=1)<3))`,
  ).bind(
    id,
    workspace,
    rule.title,
    mode,
    JSON.stringify(rule),
    nextRun(rule, now),
    now,
    now,
    workspace,
    mode,
    Number(env.MAX_ACTIVE_TASKS),
    workspace,
  );
  const inserted = await env.DB.batch([
    insert,
    env.DB.prepare(
      "INSERT INTO versions(task_id,version,rule_json,created_at) SELECT id,1,rule_json,created_at FROM tasks WHERE id=?",
    ).bind(id),
  ]);
  if (!inserted[0].meta.changes) {
    const total = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM tasks WHERE workspace=?",
    )
      .bind(workspace)
      .first<{ count: number }>();
    throw new AppError(
      total && total.count >= 30
        ? "已达到30个总任务上限；请删除不再需要的任务后再创建。暂停不会释放总任务额度。"
        : "运行中的真实任务已达上限：每个浏览器3个、全站12个。请暂停或删除已有真实任务后重试。",
      409,
    );
  }
  return getTask(env.DB, id, workspace);
}
export async function deleteTask(env: Env, workspace: string, id: string) {
  // One scoped DELETE atomically removes the task and its FK-linked history.
  // In-flight checks lose their task / lease fence and cannot recreate alerts.
  const result = await env.DB.prepare(
    "DELETE FROM tasks WHERE id=? AND workspace=?",
  )
    .bind(id, workspace)
    .run();
  if (!result.meta.changes) throw new AppError("任务不存在或已删除", 404);
}
export async function editTask(
  env: Env,
  workspace: string,
  id: string,
  rule: Rule,
  version: number,
) {
  const now = Date.now();
  const batch = await env.DB.batch([
    env.DB.prepare(
      `UPDATE tasks SET title=?,rule_json=?,version=version+1,episode=0,last_truth='unknown',notified_episode=-1,health='pending',fail_count=0,last_reason='规则已更新，等待新版本检查；保留原冷却截止时间',next_run_at=?,lease_until=0,lease_token=NULL,updated_at=? WHERE id=? AND workspace=? AND version=?`,
    ).bind(
      rule.title,
      JSON.stringify(rule),
      nextRun(rule, now),
      now,
      id,
      workspace,
      version,
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO versions(task_id,version,rule_json,created_at) SELECT id,version,rule_json,? FROM tasks WHERE id=? AND workspace=? AND version=?",
    ).bind(now, id, workspace, version + 1),
  ]);
  if (!batch[0].meta.changes)
    throw new AppError("版本已变化，请刷新后再编辑", 409);
  return getTask(env.DB, id, workspace);
}
export async function toggleTask(
  env: Env,
  workspace: string,
  id: string,
  enabled: boolean,
) {
  await getTask(env.DB, id, workspace);
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE tasks SET enabled=?,next_run_at=?,lease_token=NULL,lease_until=0,updated_at=?,last_reason=? WHERE id=? AND workspace=? AND (?=0 OR enabled=1 OR mode='demo' OR ((SELECT COUNT(*) FROM tasks WHERE mode='live' AND enabled=1)<? AND (SELECT COUNT(*) FROM tasks WHERE workspace=? AND mode='live' AND enabled=1)<3))`,
  )
    .bind(
      +enabled,
      now,
      now,
      enabled
        ? "已恢复，将检查当前数据；暂停期间不补造历史触发"
        : "任务已暂停，后台不再检查",
      id,
      workspace,
      +enabled,
      Number(env.MAX_ACTIVE_TASKS),
      workspace,
    )
    .run();
  if (!result.meta.changes)
    throw new AppError("运行中的真实任务已达体验上限", 409);
  return getTask(env.DB, id, workspace);
}
export async function runTask(
  env: Env,
  id: string,
  kind: "manual" | "cron" | "demo",
  options: { scenario?: Scenario; now?: number; workspace?: string } = {},
) {
  let task = await getTask(env.DB, id, options.workspace);
  if (!task.enabled) throw new AppError("请先恢复任务，再执行检查", 409);
  if (kind === "cron" && task.mode !== "live")
    throw new AppError("演示任务不参与后台调度");
  if (kind === "demo" && task.mode !== "demo")
    throw new AppError("构造场景只允许用于隔离演示任务");
  if (kind === "manual" && task.mode !== "live")
    throw new AppError("演示任务请使用场景按钮");
  const now = options.now ?? Date.now(),
    realNow = Date.now(),
    token = crypto.randomUUID();
  const lease = await env.DB.prepare(
    "UPDATE tasks SET lease_until=?,lease_token=? WHERE id=? AND version=? AND enabled=1 AND lease_until<?",
  )
    .bind(realNow + 90000, token, id, task.version, realNow)
    .run();
  if (!lease.meta.changes)
    throw new AppError("任务正在检查或版本已变化，请稍后刷新", 409);
  // A previous check may have committed between our initial read and acquiring the lease.
  // Reload latched truth / cooldown under this lease, then fence every write with its token.
  const current = await env.DB.prepare(
    "SELECT * FROM tasks WHERE id=? AND version=? AND lease_token=?",
  )
    .bind(id, task.version, token)
    .first<TaskRow>();
  if (!current) throw new AppError("任务已暂停或规则已变化，请刷新", 409);
  task = taskFrom(current);
  await env.DB.prepare(
    "UPDATE runs SET status='obsolete',finished_at=?,result_json=? WHERE task_id=? AND status='running'",
  )
    .bind(
      realNow,
      JSON.stringify({
        truth: "unknown",
        health: "degraded",
        decision: "obsolete",
        checks: [],
        reason:
          "此前检查被中断或租约过期，本次已重新取得执行权；未补造历史触发",
      } satisfies Evaluation),
      id,
    )
    .run();
  const runId = crypto.randomUUID(),
    slot =
      kind === "cron" ? "cron:" + Math.floor(now / 60000) : kind + ":" + runId;
  const started = await env.DB.prepare(
    `INSERT OR IGNORE INTO runs(id,task_id,version,slot,kind,started_at,status)
     SELECT ?,id,version,?,?,?,'running' FROM tasks WHERE id=? AND version=? AND lease_token=? AND enabled=1`,
  )
    .bind(runId, slot, kind, now, id, task.version, token)
    .run();
  if (!started.meta.changes) {
    await env.DB.prepare(
      "UPDATE tasks SET lease_until=0,lease_token=NULL WHERE id=? AND lease_token=?",
    )
      .bind(id, token)
      .run();
    return { busy: true };
  }
  let bundle: Bundle = {},
    result: Evaluation;
  if (kind === "cron" && !inWindow(task.rule, now))
    result = {
      truth: "unknown",
      health: task.health,
      reason: "当前不在配置的检查时段；保持上次条件状态，下次按上海时间调度",
      checks: [],
      decision: "skipped",
    };
  else {
    bundle =
      kind === "demo"
        ? demoBundle(options.scenario ?? "unmatched", now)
        : await collect(
            env,
            task.rule,
            now,
            kind === "cron" && task.rule.schedule.mode !== "daily",
          );
    if (
      kind === "cron" &&
      task.rule.schedule.mode !== "daily" &&
      bundle.calendar?.quality !== "fresh"
    )
      result = {
        truth: "unknown",
        health: "degraded",
        reason: "交易日历不可用，暂停本次盘中/收盘判断并重试",
        checks: [],
        decision: "unknown",
      };
    else if (
      kind === "cron" &&
      task.rule.schedule.mode !== "daily" &&
      bundle.calendar?.fields.trading_day === false
    )
      result = {
        truth: "unknown",
        health: task.health,
        reason: "今天不是交易日，跳过本次检查；不使用旧行情触发",
        checks: [],
        decision: "skipped",
      };
    else result = evaluate(task.rule, bundle, now);
  }
  const decision = decide(task, result, now);
  result = decision.result;
  if (
    task.failCount > 0 &&
    result.health === "healthy" &&
    result.decision !== "skipped"
  ) {
    result = {
      ...result,
      recovered: true,
      reason: "数据已恢复。" + result.reason,
    };
  }
  const failCount =
    result.decision === "skipped"
      ? task.failCount
      : result.health === "degraded"
        ? task.failCount + 1
        : 0;
  let due = kind === "cron" ? nextRun(task.rule, now) : task.nextRunAt;
  if (result.health === "degraded" && result.decision !== "skipped")
    due = realNow + [60000, 300000, 900000][Math.min(failCount - 1, 2)];
  if (kind === "demo") due = 0;
  const evidence = Object.values(bundle).filter(
    (x): x is NonNullable<Bundle["quote"]> =>
      typeof x === "object" && x !== null,
  );
  const finishedAt = kind === "demo" ? now : Date.now();
  const done = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO alerts(id,task_id,workspace,run_id,version,episode,title,reason,created_at) SELECT ?,id,workspace,?,version,?,?,?,? FROM tasks WHERE id=? AND version=? AND lease_token=? AND ?='alert'`,
    ).bind(
      crypto.randomUUID(),
      runId,
      decision.episode,
      task.title,
      result.reason,
      now,
      id,
      task.version,
      token,
      result.decision,
    ),
    env.DB.prepare(
      `UPDATE runs SET finished_at=?,status='complete',result_json=?,evidence_json=? WHERE id=? AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND version=? AND lease_token=?)`,
    ).bind(
      finishedAt,
      JSON.stringify(result),
      JSON.stringify(evidence),
      runId,
      id,
      task.version,
      token,
    ),
    env.DB.prepare(
      `UPDATE tasks SET health=?,last_reason=?,last_run_at=?,next_run_at=?,cooldown_until=?,episode=?,last_truth=?,notified_episode=?,fail_count=?,lease_until=0,lease_token=NULL,updated_at=? WHERE id=? AND version=? AND lease_token=?`,
    ).bind(
      result.health,
      result.reason,
      now,
      due,
      decision.cooldownUntil,
      decision.episode,
      decision.lastTruth,
      decision.notifiedEpisode,
      failCount,
      realNow,
      id,
      task.version,
      token,
    ),
  ]);
  if (!done[2].meta.changes) {
    await env.DB.prepare(
      `UPDATE runs SET status='obsolete',finished_at=?,result_json=?,evidence_json=? WHERE id=? AND status='running'`,
    )
      .bind(
        kind === "demo" ? now : Date.now(),
        JSON.stringify({
          ...result,
          decision: "obsolete",
          reason:
            "检查期间任务被暂停或规则版本已变化，本结果未写入任务状态、未发送提醒",
        }),
        JSON.stringify(evidence),
        runId,
      )
      .run();
  }
  return {
    task: await getTask(env.DB, id),
    run: (await listRuns(env.DB, id)).find((r) => r.id === runId),
  };
}
export async function tick(env: Env, now: number) {
  const rows = await env.DB.prepare(
    `SELECT id FROM tasks WHERE mode='live' AND enabled=1 AND next_run_at<=? AND lease_until<? ORDER BY next_run_at LIMIT 4`,
  )
    .bind(now, Date.now())
    .all<{ id: string }>();
  const outcomes = await Promise.allSettled(
    rows.results.map((r) => runTask(env, r.id, "cron", { now })),
  );
  const value = {
    at: now,
    checked: rows.results.length,
    errors: outcomes.filter((x) => x.status === "rejected").length,
  };
  await env.DB.prepare(
    "INSERT INTO meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
  )
    .bind("cron", JSON.stringify(value), Date.now())
    .run();
  console.log(JSON.stringify({ event: "cron_tick", ...value }));
}
