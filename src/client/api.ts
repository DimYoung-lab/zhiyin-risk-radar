export async function api<T>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api" + path, {
      method,
      credentials: "same-origin",
      headers: data ? { "Content-Type": "application/json" } : {},
      body: data ? JSON.stringify(data) : undefined,
    });
  } catch {
    throw new Error("网络连接失败，请检查网络后重试。");
  }
  if (!response.headers.get("Content-Type")?.includes("application/json"))
    throw new Error(
      response.status >= 500
        ? "服务暂不可用，配置和历史记录已保存，请稍后重试。"
        : "接口响应异常，请刷新页面后重试。",
    );
  let value: T & { error?: string };
  try {
    value = (await response.json()) as T & { error?: string };
  } catch {
    throw new Error("服务响应不完整，请稍后重试。");
  }
  if (!response.ok) throw new Error(value.error || "操作未完成，请稍后重试。");
  return value;
}
