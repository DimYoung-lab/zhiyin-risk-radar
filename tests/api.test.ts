import { it, expect, afterEach, vi } from "vitest";
import { api } from "../src/client/api";
afterEach(() => vi.unstubAllGlobals());
it("网关返回HTML/纯文本503时给出可理解的重试说明", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response("Your worker is restarting", { status: 503 }),
      ),
  );
  await expect(api("/tasks")).rejects.toThrow("服务暂不可用");
});
it("网络断开时不展示底层异常字符串", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("fetch implementation internals")),
  );
  await expect(api("/tasks")).rejects.toThrow("网络连接失败");
});
it("保留后端规则/额度错误解释", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: "版本已变化，请刷新后再编辑" }, { status: 409 }),
      ),
  );
  await expect(api("/tasks", "PATCH", {})).rejects.toThrow("版本已变化");
});
