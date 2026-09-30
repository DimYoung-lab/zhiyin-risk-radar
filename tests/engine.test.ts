import { describe, it, expect } from "vitest";
import {
  combine,
  evaluate,
  decide,
  nextRun,
  inWindow,
} from "../src/shared/engine";
import { ruleSchema, type Task, type Rule } from "../src/shared/types";
import { demoRule, demoBundle } from "../src/shared/demo";
import { freshness, policyIssue } from "../src/server/providers";
const now = Date.parse("2026-09-30T10:00:00+08:00");
function task(patch: Partial<Task> = {}): Task {
  return {
    id: "t",
    workspace: "w",
    title: "test",
    mode: "demo",
    rule: demoRule,
    version: 1,
    enabled: true,
    health: "pending",
    lastReason: "",
    lastRunAt: null,
    nextRunAt: now,
    cooldownUntil: 0,
    episode: 0,
    lastTruth: "unknown",
    notifiedEpisode: -1,
    failCount: 0,
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}
describe("组合逻辑保留证据异常", () => {
  it.each([
    ["and", ["false", "unknown"], "false"],
    ["and", ["true", "unknown"], "unknown"],
    ["or", ["true", "unknown"], "true"],
    ["or", ["false", "unknown"], "unknown"],
  ] as const)("%s + %s → %s", (logic, values, expected) =>
    expect(combine([...values], logic)).toBe(expected),
  );
  it("OR已有可靠条件满足时仍提示局部数据异常", () => {
    const r = evaluate(
      { ...demoRule, logic: "or" },
      demoBundle("failed", now),
      now,
    );
    expect(r.truth).toBe("true");
    expect(r.health).toBe("degraded");
    expect(r.checks[0].actual).toBeNull();
  });
  it.each(["stale", "failed", "conflict"] as const)(
    "%s不会用旧值判断正常",
    (s) => {
      const r = evaluate(demoRule, demoBundle(s, now), now);
      expect(r.truth).toBe("unknown");
      expect(r.health).toBe("degraded");
    },
  );
});
describe("提醒周期与冷却", () => {
  it("持续满足只提醒一次，跨重载仍去重", () => {
    const first = decide(
      task(),
      evaluate(demoRule, demoBundle("matched", now), now),
      now,
    );
    expect(first.result.decision).toBe("alert");
    const persisted = JSON.parse(JSON.stringify({ ...task(), ...first }));
    expect(
      decide(
        persisted,
        evaluate(demoRule, demoBundle("matched", now + 1000), now + 1000),
        now + 1000,
      ).result.decision,
    ).toBe("dedup");
  });
  it("未知不重置触发周期，避免恢复后重复提醒", () => {
    const t = task({ episode: 1, lastTruth: "true", notifiedEpisode: 1 });
    const unknown = decide(
      t,
      evaluate(demoRule, demoBundle("failed", now), now),
      now,
    );
    expect(unknown.lastTruth).toBe("true");
    expect(
      decide(
        { ...t, ...unknown },
        evaluate(demoRule, demoBundle("matched", now + 1000), now + 1000),
        now + 1000,
      ).result.decision,
    ).toBe("dedup");
  });
  it("新周期冷却等待，到期仍满足才提醒", () => {
    const t = task({
      episode: 1,
      lastTruth: "false",
      notifiedEpisode: 1,
      cooldownUntil: now + 5000,
    });
    const waiting = decide(
      t,
      evaluate(demoRule, demoBundle("matched", now), now),
      now,
    );
    expect(waiting.result.decision).toBe("cooldown");
    expect(waiting.episode).toBe(2);
    const expired = decide(
      { ...t, ...waiting },
      evaluate(demoRule, demoBundle("matched", now + 6000), now + 6000),
      now + 6000,
    );
    expect(expired.result.decision).toBe("alert");
    expect(expired.episode).toBe(2);
  });
  it("零冷却仍按周期去重", () => {
    const t = task({
      rule: { ...demoRule, cooldownMinutes: 0 },
      episode: 1,
      lastTruth: "true",
      notifiedEpisode: 1,
    });
    expect(
      decide(t, evaluate(t.rule, demoBundle("matched", now), now), now).result
        .decision,
    ).toBe("dedup");
  });
});
describe("榜单与数值口径", () => {
  it("完整Top30的榜外标的可确定未进前10，但不虚构名次", () => {
    const bundle = demoBundle("matched", now);
    bundle.heat!.fields = { hot_rank: null, outsideTop30: true, coverage: 30 };
    const r = evaluate(demoRule, bundle, now);
    expect(r.truth).toBe("false");
    expect(r.checks[1].actual).toBe("未进入前30");
  });
  it("不完整榜单的空名次为未知", () => {
    const bundle = demoBundle("matched", now);
    bundle.heat!.fields = { hot_rank: null, outsideTop30: false, coverage: 10 };
    expect(evaluate(demoRule, bundle, now).truth).toBe("unknown");
  });
  it("跌3%使用-3而非-0.03", () => {
    const bundle = demoBundle("matched", now);
    bundle.quote!.fields.change_pct = -0.03;
    expect(evaluate(demoRule, bundle, now).truth).toBe("false");
  });
  it("空字段不能作为0参与比较", () => {
    const bundle = demoBundle("matched", now);
    bundle.quote!.fields.change_pct = null;
    expect(evaluate(demoRule, bundle, now).checks[0].truth).toBe("unknown");
  });
});
describe("时间与输入边界", () => {
  it("午间跳到13点，收盘后跳到翌日盘中，不预设翌日为交易日", () => {
    expect(nextRun(demoRule, Date.parse("2026-09-30T11:29:00+08:00"))).toBe(
      Date.parse("2026-09-30T13:00:00+08:00"),
    );
    expect(nextRun(demoRule, Date.parse("2026-09-30T15:00:00+08:00"))).toBe(
      Date.parse("2026-10-01T09:30:00+08:00"),
    );
  });
  it("盘中窗口采用上海时区", () => {
    expect(inWindow(demoRule, now)).toBe(true);
    expect(inWindow(demoRule, Date.parse("2026-09-30T12:00:00+08:00"))).toBe(
      false,
    );
  });
  it("跨日、未来异常时间和缺失时间都不能新鲜", () => {
    expect(freshness(now - 86400000, now, 86400000)).toBe("stale");
    expect(freshness(now + 600000, now, 600000)).toBe("conflict");
    expect(freshness(null, now, 600000)).toBe("missing");
  });
  it("收盘必须是当日收盘阶段快照", () => {
    expect(
      freshness(now, Date.parse("2026-09-30T15:10:00+08:00"), 43200000, true),
    ).toBe("stale");
  });
  it.each(["2026-02-30", "2026-13-01", "2026-00-00"])(
    "拒绝无效日历日期%s",
    (value) =>
      expect(
        ruleSchema.safeParse({
          ...demoRule,
          conditions: [{ field: "date", operator: "eq", value }],
        }).success,
      ).toBe(false),
  );
  it("拒绝榜外阈值与超过6个条件", () => {
    expect(
      ruleSchema.safeParse({
        ...demoRule,
        conditions: [{ field: "hot_rank", operator: "lte", value: 31 }],
      }).success,
    ).toBe(false);
    expect(
      ruleSchema.safeParse({
        ...demoRule,
        conditions: Array(7).fill(demoRule.conditions[0]),
      }).success,
    ).toBe(false);
  });
  it("阻止交易建议与收益保证", () => {
    expect(policyIssue("预测股价并推荐买入")).toBeTruthy();
    expect(policyIssue("贵州茅台跌3%时提醒我")).toBeNull();
  });
  it("指定日期由上海时钟确定，不需要编造金融数据", () => {
    const rule: Rule = {
      ...demoRule,
      conditions: [{ field: "date", operator: "eq", value: "2026-09-30" }],
    };
    expect(evaluate(rule, {}, now).truth).toBe("true");
  });
});
