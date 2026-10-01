import { afterEach, expect, it, vi } from "vitest";
import {
  collect,
  parseIntent,
  boundedJSON,
  normalizeDraft,
} from "../src/server/providers";
import { evaluate } from "../src/shared/engine";
import { demoRule } from "../src/shared/demo";
import type { Rule } from "../src/shared/types";
import { ruleSchema } from "../src/shared/types";

const now = Date.parse("2026-09-30T10:00:00+08:00");
const env = {
  FUYAO_API_KEY: "unit-test-placeholder",
  LLM_API_KEY: "unit-test-placeholder",
  LLM_BASE_URL: "https://model.example",
  LLM_MODEL: "deepseek-flash",
} as Env;
const priceRule: Rule = {
  ...demoRule,
  conditions: [{ field: "price", operator: "lt", value: 1300 }],
};
const heatRule: Rule = {
  ...demoRule,
  conditions: [{ field: "hot_rank", operator: "lte", value: 10 }],
};
const response = (data: unknown) =>
  new Response(JSON.stringify({ code: 0, data }), {
    headers: { "x-request-id": "test-request" },
  });
afterEach(() => vi.unstubAllGlobals());

it.each(["intraday", "close"] as const)(
  "%s模式的无效非执行字段规范化，不改变条件",
  (mode) => {
    const draft = normalizeDraft({
      ...demoRule,
      schedule: {
        mode,
        at: null,
        intervalMinutes: mode === "close" ? null : 15,
      },
    });
    const parsed = ruleSchema.parse(draft);
    expect(parsed.schedule.at).toBe("15:10");
    expect(parsed.schedule.intervalMinutes).toBe(mode === "close" ? 5 : 15);
    expect(parsed.conditions).toEqual(demoRule.conditions);
  },
);
it("daily缺少执行时刻仍拒绝，不自动猜时间", () => {
  const draft = normalizeDraft({
    ...demoRule,
    schedule: { mode: "daily", at: null, intervalMinutes: null },
  });
  expect(ruleSchema.safeParse(draft).success).toBe(false);
});
it("intraday缺少执行频率仍拒绝，不自动猜频率", () => {
  const draft = normalizeDraft({
    ...demoRule,
    schedule: { mode: "intraday", at: null, intervalMinutes: null },
  });
  expect(ruleSchema.safeParse(draft).success).toBe(false);
});

it.each([
  [
    "HTTP失败",
    () =>
      Promise.resolve(new Response("upstream-private-body", { status: 502 })),
  ],
  [
    "业务失败",
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ code: 7, message: "upstream-private-body" }),
        ),
      ),
  ],
  ["非JSON响应", () => Promise.resolve(new Response("upstream-private-body"))],
  ["网络或超时异常", () => Promise.reject(new Error("upstream-private-body"))],
])("%s保留失败证据，不泄漏上游正文", async (_name, handler) => {
  vi.stubGlobal("fetch", vi.fn(handler));
  const bundle = await collect(env, priceRule, now);
  expect(bundle.quote?.quality).toBe("failed");
  expect(bundle.quote?.note).not.toContain("upstream-private-body");
  expect(evaluate(priceRule, bundle, now).truth).toBe("unknown");
});

it("空价格字段保留null，不能作为零触发", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response({
        timestamp: now,
        item: [{ thscode: demoRule.symbol, last_price: null }],
      }),
    ),
  );
  const bundle = await collect(env, priceRule, now);
  expect(bundle.quote?.fields.price).toBeNull();
  expect(evaluate(priceRule, bundle, now).decision).toBe("unknown");
});

it("价格与前收盘价推算涨跌幅冲突时不触发", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response({
        timestamp: now,
        item: [
          {
            thscode: demoRule.symbol,
            last_price: 1248,
            prev_price: 1300,
            price_change_ratio_pct: -8,
          },
        ],
      }),
    ),
  );
  const bundle = await collect(env, priceRule, now);
  expect(bundle.quote?.quality).toBe("conflict");
  expect(bundle.quote?.requestId).toBe("test-request");
  expect(evaluate(priceRule, bundle, now).truth).toBe("unknown");
});

it("不完整热榜缺失目标证券时不能推断榜外", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response({ timestamp: now, item: [{ thscode: "000001.SZ", rank: 1 }] }),
    ),
  );
  const bundle = await collect(env, heatRule, now);
  expect(bundle.heat?.quality).toBe("missing");
  expect(evaluate(heatRule, bundle, now).truth).toBe("unknown");
});

it("完整Top30缺失目标只表明未进入前30，不编造具体名次", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response({
        timestamp: now,
        item: Array.from({ length: 30 }, (_, i) => ({
          thscode: `${String(i + 1).padStart(6, "0")}.SZ`,
          rank: i + 1,
        })),
      }),
    ),
  );
  const bundle = await collect(env, heatRule, now);
  expect(bundle.heat?.fields.hot_rank).toBeNull();
  expect(bundle.heat?.fields.outsideTop30).toBe(true);
  expect(evaluate(heatRule, bundle, now).truth).toBe("false");
});

it("当日交易日历不可用时不把今天当作已确认休市", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response({ timestamp: now - 86400000, item: [{ date: "20260929" }] }),
    ),
  );
  const rule: Rule = {
    ...demoRule,
    conditions: [{ field: "trading_day", operator: "eq", value: false }],
  };
  const bundle = await collect(env, rule, now);
  expect(bundle.calendar?.quality).toBe("missing");
  expect(evaluate(rule, bundle, now).truth).toBe("unknown");
});

it.each([
  [
    "模型HTTP失败",
    () => Promise.resolve(new Response("private", { status: 503 })),
  ],
  ["模型超时", () => Promise.reject(new Error("private"))],
  [
    "模型返回非法规则JSON",
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "invalid" } }] }),
        ),
      ),
  ],
])("%s提供可操作的手动配置说明", async (_name, handler) => {
  vi.stubGlobal("fetch", vi.fn(handler));
  await expect(parseIntent(env, "贵州茅台跌幅达到3%时提醒我")).rejects.toThrow(
    /手动配置/,
  );
});

it("超大接口响应被有界读取拒绝", async () => {
  await expect(
    boundedJSON(new Response("x".repeat(1025)), 1024),
  ).rejects.toThrow("响应超过大小限制");
});

it("模型达到输出上限时，即使JSON可解析也不能当作完整草稿", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "length",
                message: { content: JSON.stringify(demoRule) },
              },
            ],
          }),
        ),
    ),
  );
  await expect(parseIntent(env, "贵州茅台跌幅达到3%时提醒我")).rejects.toThrow(
    /长度上限.*手动配置/,
  );
});
