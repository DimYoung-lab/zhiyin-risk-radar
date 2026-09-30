import {
  localDate,
  localTime,
  fieldLabels,
  type Rule,
  type Bundle,
  type ConditionResult,
  type Evaluation,
  type Task,
  type Truth,
  type Evidence,
} from "./types";
const valid = (e?: Evidence) => e?.quality === "fresh";
function compare(
  actual: number | string | boolean,
  operator: string,
  expected: number | string | boolean,
): boolean {
  if (operator === "eq") return actual === expected;
  if (typeof actual !== "number" || typeof expected !== "number") return false;
  return operator === "lt"
    ? actual < expected
    : operator === "lte"
      ? actual <= expected
      : operator === "gt"
        ? actual > expected
        : actual >= expected;
}
export function combine(truths: Truth[], logic: "and" | "or"): Truth {
  if (logic === "and") {
    if (truths.includes("false")) return "false";
    return truths.includes("unknown") ? "unknown" : "true";
  }
  if (truths.includes("true")) return "true";
  return truths.includes("unknown") ? "unknown" : "false";
}
export function evaluate(rule: Rule, bundle: Bundle, now: number): Evaluation {
  const checks: ConditionResult[] = rule.conditions.map((c) => {
    const base = {
      field: c.field,
      label: fieldLabels[c.field],
      expected: c.value,
      operator: c.operator,
      evidenceIds: [] as string[],
    };
    let actual: number | string | boolean | null = null;
    let evidence: Evidence | undefined;
    if (c.field === "date") actual = localDate(now);
    else {
      evidence =
        c.field === "hot_rank"
          ? bundle.heat
          : c.field === "trading_day"
            ? bundle.calendar
            : bundle.quote;
      if (evidence) base.evidenceIds = [evidence.id];
      if (!valid(evidence))
        return {
          ...base,
          actual: null,
          truth: "unknown" as Truth,
          reason: evidence?.note || bundle.error || "必要数据尚未取得",
        };
      if (c.field === "hot_rank" && evidence!.fields.outsideTop30 === true) {
        const truth = ["gt", "gte"].includes(c.operator) ? "true" : "false";
        return {
          ...base,
          actual: "未进入前30",
          truth: truth as Truth,
          reason: "完整前30名榜单中未出现该证券；具体名次未知",
        };
      }
      const raw = evidence!.fields[c.field];
      actual =
        typeof raw === "number" ||
        typeof raw === "string" ||
        typeof raw === "boolean"
          ? raw
          : null;
    }
    if (actual === null)
      return {
        ...base,
        actual,
        truth: "unknown" as Truth,
        reason: "字段缺失，无法判断",
      };
    const truth = compare(actual, c.operator, c.value) ? "true" : "false";
    return {
      ...base,
      actual,
      truth: truth as Truth,
      reason: truth === "true" ? "条件满足" : "条件未满足",
    };
  });
  const truth = combine(
    checks.map((c) => c.truth),
    rule.logic,
  );
  const degraded = checks.some((c) => c.truth === "unknown");
  const reason =
    truth === "true"
      ? "配置的监控条件已满足"
      : truth === "false"
        ? `未触发：${checks
            .filter((c) => c.truth === "false")
            .map((c) => c.label)
            .join("、")}未满足`
        : "必要证据不足，暂时无法判断";
  return {
    truth,
    health: degraded ? "degraded" : "healthy",
    reason:
      degraded && truth !== "unknown" ? reason + "；部分条件数据异常" : reason,
    checks,
    decision:
      truth === "true" ? "alert" : truth === "false" ? "unmatched" : "unknown",
  };
}
export function decide(task: Task, result: Evaluation, now: number) {
  let episode = task.episode;
  let notifiedEpisode = task.notifiedEpisode;
  let cooldownUntil = task.cooldownUntil;
  if (result.truth === "true") {
    if (task.lastTruth === "false" || task.episode === 0) episode++;
    if (notifiedEpisode === episode)
      result = {
        ...result,
        decision: "dedup",
        reason: "条件持续满足，属于同一轮触发；已提醒，本次不重复发送",
      };
    else if (now < cooldownUntil)
      result = {
        ...result,
        decision: "cooldown",
        reason: "条件满足，但仍处于冷却期；到期后仍满足才提醒",
        cooldownUntil,
      };
    else {
      notifiedEpisode = episode;
      cooldownUntil = now + task.rule.cooldownMinutes * 60000;
      result = { ...result, decision: "alert", cooldownUntil };
    }
  }
  const lastTruth = result.truth === "unknown" ? task.lastTruth : result.truth;
  return { result, episode, notifiedEpisode, cooldownUntil, lastTruth };
}
export function nextRun(rule: Rule, now: number) {
  if (rule.schedule.mode === "intraday") {
    const candidate = now + rule.schedule.intervalMinutes * 60000;
    const time = localTime(candidate),
      date = localDate(candidate);
    if (time < "09:30") return Date.parse(`${date}T09:30:00+08:00`);
    if (time > "11:30" && time < "13:00")
      return Date.parse(`${date}T13:00:00+08:00`);
    if (time > "15:00") return Date.parse(`${date}T09:30:00+08:00`) + 86400000;
    return candidate;
  }
  const date = localDate(now);
  const at = rule.schedule.mode === "close" ? "15:10" : rule.schedule.at;
  const today = Date.parse(`${date}T${at}:00+08:00`);
  return today > now ? today : today + 86400000;
}
export function inWindow(rule: Rule, now: number): boolean {
  const time = localTime(now);
  if (rule.schedule.mode === "intraday")
    return (
      (time >= "09:30" && time <= "11:30") ||
      (time >= "13:00" && time <= "15:00")
    );
  if (rule.schedule.mode === "close") return time >= "15:10";
  return time >= rule.schedule.at;
}
