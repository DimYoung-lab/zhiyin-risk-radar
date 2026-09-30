import type { Bundle, Evidence, Rule } from "./types";
export const demoRule: Rule = {
  title: "茅台波动与关注热度",
  originalText: "贵州茅台跌幅达到3%，并且进入热榜前10时提醒我，冷却24小时。",
  symbol: "600519.SH",
  symbolName: "贵州茅台",
  logic: "and",
  conditions: [
    { field: "change_pct", operator: "lte", value: -3 },
    { field: "hot_rank", operator: "lte", value: 10 },
  ],
  schedule: { mode: "intraday", intervalMinutes: 5, at: "15:10" },
  cooldownMinutes: 1440,
};
export const scenarios = {
  unmatched: "条件未满足",
  matched: "条件满足",
  duplicate: "重复检查",
  stale: "数据过期",
  conflict: "数据冲突",
  failed: "接口失败",
  recover: "恢复正常",
  cooldown: "新一轮 · 冷却中",
  expired: "冷却到期",
};
export type Scenario = keyof typeof scenarios;
export function demoBundle(scenario: Scenario, now: number): Bundle {
  const make = (type: string, fields: Record<string, unknown>): Evidence => ({
    id: crypto.randomUUID(),
    source: "隔离演示 · 构造数据",
    endpoint: "fixture://" + type,
    requestId: null,
    dataAt: now,
    fetchedAt: now,
    fields,
    unit: type === "quote" ? "价格：元；涨跌幅：百分数" : "排名：名",
    quality: "fresh",
    note: "用于验证执行机制，不代表真实行情",
  });
  const matched = scenario !== "unmatched";
  const quote = make("quote", {
    price: matched ? 1248 : 1293.5,
    change_pct: matched ? -4 : -0.5,
    raw: {
      last_price: matched ? 1248 : 1293.5,
      prev_price: 1300,
      price_change_ratio_pct: matched ? -4 : -0.5,
    },
  });
  const heat = make("heat", {
    hot_rank: matched ? 5 : 20,
    outsideTop30: false,
    coverage: 30,
  });
  if (scenario === "stale") {
    quote.dataAt = now - 7200000;
    quote.quality = "stale";
    quote.note = "构造行情已过期2小时，超过盘中10分钟窗口";
  }
  if (scenario === "conflict") {
    quote.fields.change_pct = -8;
    quote.quality = "conflict";
    quote.note =
      "构造涨跌幅为-8%，而价格/前收价推算为-4%，超过0.05个百分点容差";
  }
  if (scenario === "failed") {
    quote.quality = "failed";
    quote.fields = {};
    quote.dataAt = null;
    quote.note = "构造接口超时（HTTP 503 / timeout），不使用旧值继续判断";
  }
  return { quote, heat };
}
