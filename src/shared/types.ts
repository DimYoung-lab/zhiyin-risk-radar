import { z } from "zod";
export const conditionSchema = z
  .object({
    field: z.enum(["price", "change_pct", "hot_rank", "date", "trading_day"]),
    operator: z.enum(["lt", "lte", "gt", "gte", "eq"]),
    value: z.union([z.number(), z.string(), z.boolean()]),
  })
  .superRefine((condition, ctx) => {
    const numberFields = ["price", "change_pct", "hot_rank"];
    if (
      numberFields.includes(condition.field) &&
      typeof condition.value !== "number"
    )
      ctx.addIssue({ code: "custom", message: "数值条件必须填写数字" });
    if (
      condition.field === "price" &&
      typeof condition.value === "number" &&
      condition.value <= 0
    )
      ctx.addIssue({ code: "custom", message: "价格必须大于零" });
    if (
      condition.field === "hot_rank" &&
      typeof condition.value === "number" &&
      (!Number.isInteger(condition.value) ||
        condition.value < 1 ||
        condition.value > 30)
    )
      ctx.addIssue({ code: "custom", message: "实时热榜只支持前 1–30 名" });
    if (
      condition.field === "date" &&
      (typeof condition.value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(condition.value) ||
        Number.isNaN(Date.parse(condition.value + "T00:00:00Z")) ||
        new Date(condition.value + "T00:00:00Z").toISOString().slice(0, 10) !==
          condition.value)
    )
      ctx.addIssue({
        code: "custom",
        message: "请填写有效日期，格式为 YYYY-MM-DD",
      });
    if (
      ["date", "trading_day"].includes(condition.field) &&
      condition.operator !== "eq"
    )
      ctx.addIssue({ code: "custom", message: "日历条件使用等于比较" });
    if (
      condition.field === "trading_day" &&
      typeof condition.value !== "boolean"
    )
      ctx.addIssue({ code: "custom", message: "交易日条件必须是布尔值" });
  });
export const ruleSchema = z.object({
  title: z.string().min(1).max(80),
  originalText: z.string().max(1200),
  symbol: z.string().regex(/^\d{6}\.(SH|SZ|BJ)$/),
  symbolName: z.string().min(1).max(80),
  logic: z.enum(["and", "or"]),
  conditions: z.array(conditionSchema).min(1).max(6),
  schedule: z.object({
    mode: z.enum(["intraday", "close", "daily"]),
    intervalMinutes: z.union([z.literal(5), z.literal(15), z.literal(60)]),
    at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  }),
  cooldownMinutes: z.number().int().min(0).max(10080),
});
export type Rule = z.infer<typeof ruleSchema>;
export type Condition = z.infer<typeof conditionSchema>;
export type Truth = "true" | "false" | "unknown";
export type Health = "pending" | "healthy" | "degraded" | "recovering";
export interface Evidence {
  id: string;
  source: string;
  endpoint: string;
  requestId: string | null;
  dataAt: number | null;
  fetchedAt: number;
  fields: Record<string, unknown>;
  unit: string;
  quality: "fresh" | "stale" | "missing" | "conflict" | "failed";
  note: string;
}
export interface Bundle {
  quote?: Evidence;
  heat?: Evidence;
  calendar?: Evidence;
  error?: string;
}
export interface ConditionResult {
  field: Condition["field"];
  label: string;
  actual: number | string | boolean | null;
  expected: Condition["value"];
  operator: Condition["operator"];
  truth: Truth;
  reason: string;
  evidenceIds: string[];
}
export interface Evaluation {
  truth: Truth;
  health: Health;
  reason: string;
  checks: ConditionResult[];
  decision:
    | "alert"
    | "unmatched"
    | "unknown"
    | "dedup"
    | "cooldown"
    | "skipped"
    | "obsolete";
  cooldownUntil?: number;
  recovered?: boolean;
}
export interface Task {
  id: string;
  workspace: string;
  title: string;
  mode: "live" | "demo";
  rule: Rule;
  version: number;
  enabled: boolean;
  health: Health;
  lastReason: string;
  lastRunAt: number | null;
  nextRunAt: number;
  cooldownUntil: number;
  episode: number;
  lastTruth: Truth;
  notifiedEpisode: number;
  failCount: number;
  createdAt: number;
  updatedAt: number;
}
export interface Run {
  id: string;
  taskId: string;
  version: number;
  startedAt: number;
  finishedAt: number | null;
  kind: string;
  status: string;
  result: Evaluation | null;
  evidence: Evidence[];
}
export interface Alert {
  id: string;
  taskId: string;
  runId: string;
  version: number;
  title: string;
  reason: string;
  createdAt: number;
}
export const fieldLabels: Record<Condition["field"], string> = {
  price: "最新价格",
  change_pct: "当日涨跌幅",
  hot_rank: "热榜排名",
  date: "指定日期",
  trading_day: "是否交易日",
};
export const operators: Record<Condition["operator"], string> = {
  lt: "小于",
  lte: "不超过",
  gt: "大于",
  gte: "不低于",
  eq: "等于",
};
export const unitOf = (field: Condition["field"]) =>
  field === "price"
    ? "元"
    : field === "change_pct"
      ? "%"
      : field === "hot_rank"
        ? "名"
        : "";
export function localDate(now: number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function localTime(now: number) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}
export function ruleSummary(rule: Rule) {
  return rule.conditions
    .map(
      (c) =>
        `${fieldLabels[c.field]}${operators[c.operator]}${c.value === true ? "是" : c.value === false ? "否" : c.value}${unitOf(c.field)}`,
    )
    .join(rule.logic === "and" ? " 且 " : " 或 ");
}
