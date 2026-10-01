import React, { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  Radar,
  Activity,
  Bell,
  Layers,
  ArrowUpRight,
  ArrowRight,
  Plus,
  Search,
  Play,
  Pause,
  Pencil,
  Check,
  ChevronRight,
  ShieldCheck,
  Clock,
  RefreshCw,
  AlertTriangle,
  Radio,
  FileText,
  X,
  LoaderCircle,
  ExternalLink,
  Trash2,
} from "lucide-react";
import {
  fieldLabels,
  operators,
  ruleSummary,
  unitOf,
  type Rule,
  type Task,
  type Run,
  type Alert,
  type Condition,
  type Evaluation,
  type Evidence,
} from "../shared/types";
import { scenarios, type Scenario } from "../shared/demo";
import "./style.css";

import { api } from "./api";
const fmt = (n: number | null | undefined, short = false) =>
  n
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        ...(short ? {} : { second: "2-digit" }),
      }).format(n)
    : "尚无记录";
const val = (v: unknown) =>
  v === null || v === undefined
    ? "—"
    : v === true
      ? "是"
      : v === false
        ? "否"
        : String(v);
const healthLabel: Record<string, string> = {
  pending: "等待检查",
  healthy: "正常",
  degraded: "数据异常",
  recovering: "恢复中",
};
const decisions: Record<string, string> = {
  alert: "已提醒",
  unmatched: "未触发",
  unknown: "无法判断",
  dedup: "已去重",
  cooldown: "冷却中",
  skipped: "时段跳过",
  obsolete: "旧版本作废",
};
const sampleTexts = [
  "贵州茅台跌幅达到3%，并进入热榜前10时提醒我，冷却24小时",
  "宁德时代价格超过300元时提醒我，每15分钟检查一次",
  "在2026年10月9日的09:30提醒我关注贵州茅台",
];
interface Health {
  serverTime: number;
  model: string;
  aiConfigured: boolean;
  dataConfigured: boolean;
  heartbeat: {
    at: number;
    checked: number;
    errors: number;
    receivedAt: number;
  } | null;
}
interface Detail {
  task: Task;
  runs: Run[];
  versions: { version: number; rule: Rule; createdAt: number }[];
}
interface Preview {
  result: Evaluation;
  evidence: Evidence[];
  at: number;
}
interface ParseResult {
  rule: Rule | null;
  model: string;
  auditId: string;
  clarifications: string[];
  unsupported: string[];
  defaults: string;
}
const blank: Rule = {
  title: "我的价格监控",
  symbol: "",
  symbolName: "",
  originalText: "",
  logic: "and",
  conditions: [{ field: "price", operator: "gte", value: 1300 }],
  schedule: { mode: "intraday", intervalMinutes: 5, at: "15:10" },
  cooldownMinutes: 1440,
};

function EvidenceList({ items }: { items: Evidence[] }) {
  return (
    <div className="evidence-list">
      {items.map((e) => (
        <details key={e.id} className="evidence">
          <summary>
            <span className={"quality-dot " + e.quality} />
            <span>
              {e.source} ·{" "}
              {e.endpoint.includes("/hot-stock-list") ||
              e.endpoint.endsWith("/heat")
                ? "热榜"
                : e.endpoint.includes("calendar")
                  ? "交易日历"
                  : "行情"}
            </span>
            <small>
              {e.quality === "fresh"
                ? "证据有效"
                : e.quality === "failed"
                  ? "取数失败"
                  : e.quality === "conflict"
                    ? "数据冲突"
                    : e.quality === "stale"
                      ? "数据过期"
                      : "字段缺失"}
            </small>
            <ChevronRight aria-hidden="true" size={14} />
          </summary>
          <div className="evidence-body">
            <p>{e.note}</p>
            <dl>
              <div>
                <dt>源时间</dt>
                <dd>{fmt(e.dataAt)}</dd>
              </div>
              <div>
                <dt>取数时间</dt>
                <dd>{fmt(e.fetchedAt)}</dd>
              </div>
              <div>
                <dt>口径 / 单位</dt>
                <dd>{e.unit}</dd>
              </div>
              <div>
                <dt>证据 ID</dt>
                <dd className="mono">{e.id}</dd>
              </div>
              <div>
                <dt>请求 ID</dt>
                <dd className="mono">{e.requestId ?? "源接口未返回"}</dd>
              </div>
              <div>
                <dt>接口</dt>
                <dd className="mono break">{e.endpoint}</dd>
              </div>
            </dl>
            <pre>{JSON.stringify(e.fields, null, 2)}</pre>
          </div>
        </details>
      ))}
    </div>
  );
}
function Result({
  result,
  evidence,
}: {
  result: Evaluation;
  evidence: Evidence[];
}) {
  return (
    <>
      <div
        className={
          "result " +
          (result.health === "degraded"
            ? "warn"
            : result.truth === "true"
              ? "success"
              : "neutral")
        }
      >
        <div className="result-icon">
          {result.health === "degraded" ? (
            <AlertTriangle aria-hidden="true" size={18} />
          ) : result.truth === "true" ? (
            <Check aria-hidden="true" size={18} />
          ) : (
            <Activity aria-hidden="true" size={18} />
          )}
        </div>
        <div>
          <b>{decisions[result.decision]}</b>
          <p>{result.reason}</p>
        </div>
      </div>
      <div className="checks">
        {result.checks.map((c, i) => (
          <div className="condition-check" key={i}>
            <span className={"truth " + c.truth}>
              {c.truth === "true" ? (
                <Check aria-hidden="true" size={14} />
              ) : c.truth === "unknown" ? (
                "?"
              ) : (
                "—"
              )}
            </span>
            <div>
              <b>{c.label}</b>
              <small>
                {operators[c.operator]} {val(c.expected)}
                {unitOf(c.field)}
              </small>
            </div>
            <div
              className={
                "actual " +
                (c.field === "change_pct" && typeof c.actual === "number"
                  ? c.actual > 0
                    ? "market-up"
                    : c.actual < 0
                      ? "market-down"
                      : ""
                  : "")
              }
            >
              <strong title={val(c.actual)}>
                {typeof c.actual === "number" &&
                ["price", "change_pct"].includes(c.field)
                  ? c.actual.toFixed(2)
                  : val(c.actual)}
              </strong>
              <small>
                {typeof c.actual === "number" ? unitOf(c.field) : ""}
              </small>
            </div>
            <p>{c.reason}</p>
          </div>
        ))}
      </div>
      <EvidenceList items={evidence} />
    </>
  );
}

function Editor({
  initial,
  onSave,
  onClose,
  busy,
  editing,
  onDirtyChange,
}: {
  initial: Rule;
  onSave: (rule: Rule) => Promise<void>;
  onClose: () => void;
  busy: boolean;
  editing: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [rule, setRuleState] = useState<Rule>(structuredClone(initial));
  const [query, setQuery] = useState(initial.symbolName);
  const [items, setItems] = useState<{ symbol: string; name: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [previewNotice, setPreviewNotice] = useState("");
  const previewSequence = useRef(0);
  const ruleRef = useRef(rule);
  const errorRef = useRef<HTMLParagraphElement>(null);
  function setRule(next: Rule) {
    ++previewSequence.current;
    if (preview || checking)
      setPreviewNotice("规则已修改，请重新预检当前数据。");
    ruleRef.current = next;
    setRuleState(next);
    setPreview(null);
    setChecking(false);
    setError("");
  }
  useEffect(
    () => () => {
      ++previewSequence.current;
    },
    [],
  );
  useEffect(() => {
    onDirtyChange(JSON.stringify(rule) !== JSON.stringify(initial));
  }, [rule, initial, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const change = (index: number, patch: Partial<Condition>) => {
    setPreview(null);
    setRule({
      ...rule,
      conditions: rule.conditions.map((c, i) =>
        i === index ? { ...c, ...patch } : c,
      ),
    });
  };
  async function search() {
    setSearching(true);
    setError("");
    try {
      const r = await api<{ items: typeof items }>(
        "/symbols?q=" + encodeURIComponent(query),
      );
      setItems(r.items);
      if (!r.items.length) setError("未找到A股证券，请核对名称或代码");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  }
  async function check() {
    const sequence = ++previewSequence.current;
    const fingerprint = JSON.stringify(rule);
    setChecking(true);
    setPreview(null);
    setPreviewNotice("");
    setError("");
    try {
      const next = await api<Preview>("/rules/preview", "POST", { rule });
      if (
        sequence === previewSequence.current &&
        fingerprint === JSON.stringify(ruleRef.current)
      )
        setPreview(next);
    } catch (e) {
      if (sequence === previewSequence.current) setError((e as Error).message);
    } finally {
      if (sequence === previewSequence.current) setChecking(false);
    }
  }
  async function submit() {
    setError("");
    try {
      await onSave(rule);
    } catch (e) {
      setError((e as Error).message);
      requestAnimationFrame(() => errorRef.current?.focus());
    }
  }
  return (
    <section className="panel editor">
      <div className="panel-title">
        <div>
          <h2>{editing ? "编辑监控规则" : "检查规则，然后启用"}</h2>
        </div>
        <button
          className="icon-button"
          onClick={onClose}
          disabled={busy}
          aria-label="关闭规则编辑器"
        >
          <X aria-hidden="true" size={19} />
        </button>
      </div>
      <p className="subtle">
        核对监控对象、条件和检查时间后启用。修改会保存为新版本，已有冷却期继续保留。
      </p>
      <div className="editor-grid">
        <label>
          任务名称
          <input
            aria-label="任务名称"
            value={rule.title}
            maxLength={80}
            onChange={(e) => setRule({ ...rule, title: e.target.value })}
          />
        </label>
        <div>
          <label>
            监控证券
            <div className="search-field">
              <input
                aria-label="证券检索"
                value={query}
                placeholder="名称或6位代码"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setRule({ ...rule, symbol: "", symbolName: "" });
                  setPreview(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void search();
                  }
                }}
              />
              <button
                onClick={() => void search()}
                disabled={searching || query.length < 2}
                aria-label="检索证券"
              >
                {searching ? (
                  <LoaderCircle aria-hidden="true" className="spin" size={16} />
                ) : (
                  <Search aria-hidden="true" size={16} />
                )}
              </button>
            </div>
          </label>
          {items.length > 0 && (
            <div className="symbol-options">
              {items.map((s) => (
                <button
                  key={s.symbol}
                  className={rule.symbol === s.symbol ? "selected" : ""}
                  onClick={() => {
                    setRule({ ...rule, symbol: s.symbol, symbolName: s.name });
                    setQuery(s.name);
                    setItems([]);
                    setPreview(null);
                  }}
                >
                  {s.name}
                  <span className="mono">{s.symbol}</span>
                </button>
              ))}
            </div>
          )}
          {rule.symbol && (
            <small className="symbol-verified">
              <ShieldCheck aria-hidden="true" size={12} />
              已选 {rule.symbolName} · {rule.symbol}
            </small>
          )}
        </div>
      </div>
      <div className="condition-title">
        <b>触发条件</b>
        <div className="segmented">
          <button
            className={rule.logic === "and" ? "active" : ""}
            onClick={() => {
              setRule({ ...rule, logic: "and" });
              setPreview(null);
            }}
          >
            全部满足 AND
          </button>
          <button
            className={rule.logic === "or" ? "active" : ""}
            onClick={() => {
              setRule({ ...rule, logic: "or" });
              setPreview(null);
            }}
          >
            任一满足 OR
          </button>
        </div>
      </div>
      <div className="condition-editor">
        {rule.conditions.map((c, i) => (
          <div className="condition-row" key={i}>
            <span className="condition-number">
              {String(i + 1).padStart(2, "0")}
            </span>
            <select
              aria-label={"条件" + (i + 1) + "字段"}
              value={c.field}
              onChange={(e) => {
                const field = e.target.value as Condition["field"];
                change(i, {
                  field,
                  operator: ["date", "trading_day"].includes(field)
                    ? "eq"
                    : "lte",
                  value:
                    field === "date"
                      ? "2026-10-09"
                      : field === "trading_day"
                        ? true
                        : field === "hot_rank"
                          ? 10
                          : field === "price"
                            ? 1300
                            : -3,
                });
              }}
            >
              {Object.entries(fieldLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            <select
              aria-label={"条件" + (i + 1) + "比较"}
              value={c.operator}
              onChange={(e) =>
                change(i, { operator: e.target.value as Condition["operator"] })
              }
            >
              {Object.entries(operators)
                .filter(
                  ([key]) =>
                    !["date", "trading_day"].includes(c.field) || key === "eq",
                )
                .map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
            </select>
            {c.field === "trading_day" ? (
              <select
                aria-label={"条件" + (i + 1) + "值"}
                value={String(c.value)}
                onChange={(e) =>
                  change(i, { value: e.target.value === "true" })
                }
              >
                <option value="true">是交易日</option>
                <option value="false">非交易日</option>
              </select>
            ) : (
              <div className="unit-input">
                <input
                  aria-label={"条件" + (i + 1) + "值"}
                  type={c.field === "date" ? "date" : "number"}
                  step={c.field === "hot_rank" ? 1 : "any"}
                  value={String(c.value)}
                  onChange={(e) =>
                    change(i, {
                      value:
                        c.field === "date"
                          ? e.target.value
                          : e.target.value === ""
                            ? ""
                            : Number(e.target.value),
                    })
                  }
                />
                <span>{unitOf(c.field)}</span>
              </div>
            )}
            <button
              className="icon-button"
              disabled={rule.conditions.length === 1}
              onClick={() => {
                setRule({
                  ...rule,
                  conditions: rule.conditions.filter((_, j) => j !== i),
                });
                setPreview(null);
              }}
              aria-label={"删除条件" + (i + 1)}
            >
              <X aria-hidden="true" size={15} />
            </button>
          </div>
        ))}
      </div>
      <button
        className="text-button"
        disabled={rule.conditions.length >= 6}
        onClick={() => {
          setRule({
            ...rule,
            conditions: [
              ...rule.conditions,
              { field: "trading_day", operator: "eq", value: true },
            ],
          });
          setPreview(null);
        }}
      >
        <Plus aria-hidden="true" size={14} />
        添加条件 <span>最多6个</span>
      </button>
      <div className="editor-grid schedule-grid">
        <label>
          检查时段
          <select
            aria-label="检查时段"
            value={rule.schedule.mode}
            onChange={(e) => {
              setRule({
                ...rule,
                schedule: {
                  ...rule.schedule,
                  mode: e.target.value as Rule["schedule"]["mode"],
                },
              });
              setPreview(null);
            }}
          >
            <option value="intraday">交易日盘中</option>
            <option value="close">交易日收盘后 · 15:10</option>
            <option value="daily">每天指定时间</option>
          </select>
        </label>
        <label>
          {rule.schedule.mode === "daily" ? "指定时间（上海）" : "检查频率"}
          {rule.schedule.mode === "daily" ? (
            <input
              type="time"
              aria-label="指定时间"
              value={rule.schedule.at}
              onChange={(e) => {
                setRule({
                  ...rule,
                  schedule: { ...rule.schedule, at: e.target.value },
                });
                setPreview(null);
              }}
            />
          ) : (
            <select
              aria-label="检查频率"
              value={rule.schedule.intervalMinutes}
              disabled={rule.schedule.mode === "close"}
              onChange={(e) => {
                setRule({
                  ...rule,
                  schedule: {
                    ...rule.schedule,
                    intervalMinutes: Number(e.target.value) as 5 | 15 | 60,
                  },
                });
                setPreview(null);
              }}
            >
              {[5, 15, 60].map((n) => (
                <option key={n} value={n}>
                  每{n}分钟
                </option>
              ))}
            </select>
          )}
        </label>
        <label>
          提醒冷却
          <div className="unit-input">
            <input
              type="number"
              aria-label="提醒冷却"
              min={0}
              max={168}
              step={1 / 60}
              value={rule.cooldownMinutes / 60}
              onChange={(e) => {
                setRule({
                  ...rule,
                  cooldownMinutes: Math.round(Number(e.target.value) * 60),
                });
                setPreview(null);
              }}
            />
            <span>小时</span>
          </div>
        </label>
      </div>
      <div className="rule-readable">
        <Layers aria-hidden="true" size={16} />
        <div>
          <b>{rule.symbolName || "请先选择证券"}</b>
          <p>{ruleSummary(rule)}</p>
        </div>
      </div>
      {error && (
        <p className="inline-error" role="alert" ref={errorRef} tabIndex={-1}>
          {error}
        </p>
      )}
      {previewNotice && (
        <p className="inline-error" role="status">
          {previewNotice}
        </p>
      )}
      {preview && (
        <div className="preview-box">
          <span className="eyebrow">当前数据预检 · 不发送提醒</span>
          <Result result={preview.result} evidence={preview.evidence} />
        </div>
      )}
      <div className="editor-footer">
        <span>只发送应用内提醒，不自动交易</span>
        <button
          className="button secondary"
          disabled={checking || busy || !rule.symbol}
          onClick={() => void check()}
        >
          {checking ? (
            <LoaderCircle aria-hidden="true" size={15} className="spin" />
          ) : (
            <Activity aria-hidden="true" size={15} />
          )}
          预检当前数据
        </button>
        <button
          className="button primary"
          disabled={busy || checking || !rule.symbol}
          onClick={() => void submit()}
        >
          {busy ? (
            <LoaderCircle aria-hidden="true" className="spin" size={16} />
          ) : (
            <Check aria-hidden="true" size={16} />
          )}
          确认{editing ? "保存新版本" : "并启用"}
        </button>
      </div>
    </section>
  );
}

function DiscardDialog({
  onCancel,
  onDiscard,
}: {
  onCancel: () => void;
  onDiscard: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const cancel = () => {
    ref.current?.close();
    onCancel();
  };
  const discard = () => {
    ref.current?.close();
    onDiscard();
  };
  return (
    <dialog
      ref={ref}
      className="discard-dialog"
      aria-labelledby="discard-title"
      aria-describedby="discard-description"
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      <h2 id="discard-title">放弃未保存的修改？</h2>
      <p id="discard-description">
        修改尚未保存。继续离开会放弃当前编辑内容，已保存的任务规则不会改变。
      </p>
      <div className="discard-actions">
        <button className="button secondary" autoFocus onClick={cancel}>
          继续编辑
        </button>
        <button className="button danger-confirm" onClick={discard}>
          放弃修改并继续
        </button>
      </div>
    </dialog>
  );
}

function App() {
  const [view, setView] = useState<"tasks" | "alerts" | "about">("tasks");
  const [text, setText] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const refreshSequence = useRef(0);
  const [targetRun, setTargetRun] = useState<string | null>(null);
  const [linkedRun, setLinkedRun] = useState<Run | null>(null);
  const [editor, setEditor] = useState<{
    rule: Rule;
    taskId?: string;
    version?: number;
  } | null>(null);
  const [parsing, setParsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [parseInfo, setParseInfo] = useState<ParseResult | null>(null);
  const [detailTab, setDetailTab] = useState<"latest" | "history" | "versions">(
    "latest",
  );
  const [loaded, setLoaded] = useState(false);
  const [compose, setCompose] = useState(false);
  const parseSequence = useRef(0);
  const dirtyRef = useRef(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [discard, setDiscard] = useState<{ proceed: () => void } | null>(null);
  const onEditorDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
    setEditorDirty(dirty);
  }, []);
  useEffect(() => {
    if (!editorDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editorDirty]);
  function leaveDraft(work: () => void) {
    if (busy) return;
    const proceed = () => {
      ++parseSequence.current;
      setParsing(false);
      onEditorDirty(false);
      setEditor(null);
      setCompose(false);
      setParseInfo(null);
      setDiscard(null);
      work();
    };
    if (dirtyRef.current) setDiscard({ proceed });
    else proceed();
  }
  const [filter, setFilter] = useState<"all" | "live" | "demo" | "paused">(
    "all",
  );
  const refresh = useCallback(
    async (id?: string | null) => {
      const sequence = ++refreshSequence.current;
      const r = await api<{ tasks: Task[]; alerts: Alert[] }>("/tasks");
      if (sequence !== refreshSequence.current) return;
      setTasks(r.tasks);
      setAlerts(r.alerts);
      setLoaded(true);
      const chosen = id === undefined ? selected : id;
      if (chosen) {
        try {
          const next = await api<Detail>("/tasks/" + chosen);
          if (
            sequence === refreshSequence.current &&
            chosen === selectedRef.current
          )
            setDetail(next);
        } catch (error) {
          if (
            sequence === refreshSequence.current &&
            chosen === selectedRef.current
          )
            throw error;
        }
      }
      const nextHealth = await api<Health>("/health");
      if (sequence === refreshSequence.current) setHealth(nextHealth);
    },
    [selected],
  );
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 20000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    let cancelled = false;
    setDeleteConfirm(null);
    if (selected) {
      setDetail(null);
      void api<Detail>("/tasks/" + selected)
        .then((next) => {
          if (!cancelled) setDetail(next);
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        });
    } else setDetail(null);
    return () => {
      cancelled = true;
    };
  }, [selected]);
  useEffect(() => {
    if (detail?.task.id === selected)
      document
        .querySelector(".detail-panel")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [detail?.task.id]);
  useEffect(() => {
    setLinkedRun(null);
    if (!targetRun || !selected) return;
    let cancelled = false;
    void api<Run>("/tasks/" + selected + "/runs/" + targetRun)
      .then((run) => {
        if (!cancelled) setLinkedRun(run);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [targetRun, selected]);
  useEffect(() => {
    if (detailTab !== "history" || !linkedRun || detail?.task.id !== selected)
      return;
    const frame = requestAnimationFrame(() =>
      document
        .getElementById("run-" + linkedRun.id)
        ?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [linkedRun?.id, detail?.task.id, detailTab, selected]);
  async function runWork(work: () => Promise<void>, inlineError = false) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      if (inlineError) throw e;
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function parse() {
    const sequence = ++parseSequence.current;
    setParsing(true);
    setError("");
    setParseInfo(null);
    try {
      const r = await api<ParseResult>("/rules/parse", "POST", { text });
      if (sequence !== parseSequence.current) return;
      setParseInfo(r);
      if (r.rule) setEditor({ rule: r.rule });
    } catch (e) {
      if (sequence === parseSequence.current) setError((e as Error).message);
    } finally {
      if (sequence === parseSequence.current) setParsing(false);
    }
  }
  function updateIntent(next: string) {
    ++parseSequence.current;
    setParsing(false);
    setParseInfo(null);
    setText(next);
  }
  async function save(rule: Rule) {
    await runWork(async () => {
      const r = editor?.taskId
        ? await api<{ task: Task }>("/tasks/" + editor.taskId, "PATCH", {
            rule,
            previousVersion: editor.version,
          })
        : await api<{ task: Task }>("/tasks", "POST", { rule });
      setEditor(null);
      setCompose(false);
      setParseInfo(null);
      setFilter("all");
      setDetailTab("latest");
      setTargetRun(null);
      setSelected(r.task.id);
      await refresh(r.task.id);
      setNotice(
        editor?.taskId
          ? "新版本已保存。冷却截止时间保留，下一次检查采用新规则。"
          : "监控已启用，后台会按配置调度。",
      );
    }, true);
  }
  async function action(task: Task, act: string) {
    await runWork(async () => {
      await api("/tasks/" + task.id + "/actions", "POST", { action: act });
      await refresh(task.id);
    });
  }
  async function demo() {
    await runWork(async () => {
      setCompose(false);
      setEditor(null);
      const r = await api<{ task: Task }>("/demo", "POST", {});
      setTargetRun(null);
      setFilter("all");
      setDetailTab("latest");
      setSelected(r.task.id);
      setView("tasks");
      await api("/tasks/" + r.task.id + "/demo", "POST", {
        scenario: "unmatched",
      });
      await refresh(r.task.id);
      setNotice("隔离演示已创建。可在详情中切换场景，所有数字均为构造数据。");
    });
  }
  async function removeTask(task: Task) {
    await runWork(async () => {
      await api("/tasks/" + task.id, "DELETE", {});
      ++refreshSequence.current;
      selectedRef.current = null;
      setSelected(null);
      setDetail(null);
      setTargetRun(null);
      setLinkedRun(null);
      setDeleteConfirm(null);
      if (editor?.taskId === task.id) setEditor(null);
      await refresh(null);
      setNotice(
        "任务已删除，后台检查已停止，关联的历史、版本和提醒已清理。任务额度已释放。",
      );
    });
  }
  async function scenario(s: Scenario) {
    if (!detail) return;
    await runWork(async () => {
      await api("/tasks/" + detail.task.id + "/demo", "POST", { scenario: s });
      await refresh(detail.task.id);
    });
  }
  const active = tasks.filter((t) => t.enabled && t.mode === "live").length,
    degraded = tasks.filter((t) => t.enabled && t.health === "degraded").length;
  const latest = detail?.runs[0];
  const historyRuns = detail
    ? linkedRun?.taskId === detail.task.id &&
      !detail.runs.some((r) => r.id === linkedRun.id)
      ? [linkedRun, ...detail.runs]
      : detail.runs
    : [];
  const heartbeatFresh =
    health?.heartbeat && Date.now() - health.heartbeat.receivedAt < 180000;
  const visibleTasks = tasks.filter(
    (t) =>
      filter === "all" ||
      (filter === "paused" && !t.enabled) ||
      filter === t.mode,
  );
  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        跳转到主要内容
      </a>
      <aside className="sidebar">
        <a
          className="brand"
          href="/"
          aria-label="知因雷达首页"
          onClick={(event) => {
            event.preventDefault();
            leaveDraft(() => {
              setView("tasks");
              setSelected(null);
            });
          }}
        >
          <Radar aria-hidden="true" size={23} />
          <span>知因雷达</span>
        </a>
        <div className="sidebar-label">个人工作台</div>
        <nav>
          <button
            className={view === "tasks" ? "nav-active" : ""}
            aria-current={view === "tasks" ? "page" : undefined}
            disabled={busy}
            onClick={() => {
              if (view !== "tasks") leaveDraft(() => setView("tasks"));
            }}
          >
            <Layers aria-hidden="true" size={17} />
            监控任务{tasks.length > 0 && <span>{tasks.length}</span>}
          </button>
          <button
            className={view === "alerts" ? "nav-active" : ""}
            aria-current={view === "alerts" ? "page" : undefined}
            disabled={busy}
            onClick={() => {
              if (view !== "alerts") leaveDraft(() => setView("alerts"));
            }}
          >
            <Bell aria-hidden="true" size={17} />
            提醒中心{alerts.length > 0 && <span>{alerts.length}</span>}
          </button>
          <button
            className={view === "about" ? "nav-active" : ""}
            aria-current={view === "about" ? "page" : undefined}
            disabled={busy}
            onClick={() => {
              if (view !== "about") leaveDraft(() => setView("about"));
            }}
          >
            <FileText aria-hidden="true" size={17} />
            使用说明
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div>
            <span className="live-dot" />
            公开体验版
          </div>
          <p>
            当前浏览器独立保存任务。
            <br />
            清除 Cookie 后将进入新空间。
          </p>
          <span className="workspace-cap">真实任务 {active} / 3</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            投资研究 <ChevronRight aria-hidden="true" size={13} />{" "}
            {view === "tasks"
              ? "监控任务"
              : view === "alerts"
                ? "提醒中心"
                : "使用说明"}
          </span>
          <div>
            <span
              className={"status-dot " + (heartbeatFresh ? "on" : "pending")}
            />
            {heartbeatFresh ? "自动调度正常" : "调度心跳待确认"}
            <span className="topbar-date">
              上海时间 · {fmt(health?.serverTime, true)}
            </span>
          </div>
        </header>
        <main id="main-content">
          <div className="page-heading">
            <div>
              <h1>
                {view === "tasks"
                  ? "监控任务"
                  : view === "alerts"
                    ? "提醒中心"
                    : "使用说明"}
              </h1>
              <p>
                {view === "tasks"
                  ? "查看运行状态，核对每次检查的依据。"
                  : view === "alerts"
                    ? "提醒保留规则版本、触发原因和检查记录。"
                    : "支持范围、数据口径与提醒机制。"}
              </p>
            </div>
            <div className="heading-actions">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => leaveDraft(() => void demo())}
              >
                <Play aria-hidden="true" size={14} />
                新建演示
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  leaveDraft(() => {
                    setView("tasks");
                    setCompose(true);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  })
                }
              >
                <Plus aria-hidden="true" size={16} />
                新建任务
              </button>
            </div>
          </div>
          {error && (
            <div className="toast error" role="alert">
              <AlertTriangle aria-hidden="true" size={17} />
              <span>{error}</span>
              <button onClick={() => setError("")} aria-label="关闭错误">
                <X aria-hidden="true" size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="toast" role="status">
              <Check aria-hidden="true" size={17} />
              <span>{notice}</span>
              <button onClick={() => setNotice("")} aria-label="关闭提示">
                <X aria-hidden="true" size={16} />
              </button>
            </div>
          )}
          {view === "tasks" && (
            <>
              {compose && (
                <section className="compose-panel">
                  <div className="compose-heading">
                    <h2>新建监控</h2>
                    <button
                      className="icon-button"
                      aria-label="关闭新建任务"
                      disabled={busy}
                      onClick={() => leaveDraft(() => {})}
                    >
                      <X aria-hidden="true" size={18} />
                    </button>
                  </div>
                  <label htmlFor="intent">描述你要关注的条件</label>
                  <textarea
                    id="intent"
                    aria-label="自然语言监控意图"
                    value={text}
                    maxLength={1200}
                    onChange={(e) => updateIntent(e.target.value)}
                    placeholder="例如：贵州茅台跌幅达到3%，并进入热榜前10时提醒我"
                  />
                  <div className="compose-footer">
                    <div className="examples">
                      <span>示例</span>
                      <button onClick={() => updateIntent(sampleTexts[0])}>
                        波动 + 热度组合
                      </button>
                      <button onClick={() => updateIntent(sampleTexts[1])}>
                        指定价格条件
                      </button>
                    </div>
                    <div>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          leaveDraft(() => {
                            setCompose(true);
                            setEditor({ rule: blank });
                          })
                        }
                      >
                        手动配置
                      </button>
                      <button
                        className="button primary"
                        disabled={busy || parsing || text.trim().length < 4}
                        onClick={() =>
                          leaveDraft(() => {
                            setCompose(true);
                            void parse();
                          })
                        }
                      >
                        {parsing ? (
                          <LoaderCircle
                            aria-hidden="true"
                            size={15}
                            className="spin"
                          />
                        ) : (
                          <ArrowRight aria-hidden="true" size={15} />
                        )}
                        生成规则草稿
                      </button>
                    </div>
                  </div>
                  <p className="compose-note">
                    支持A股单证券的价格、涨跌幅、热榜、日期与交易日条件。生成后需由你核对并确认。
                  </p>
                </section>
              )}
              {parseInfo && (
                <div
                  className={"parse-info " + (!parseInfo.rule ? "warn" : "")}
                >
                  <ShieldCheck aria-hidden="true" size={16} />
                  <div>
                    <b>
                      {parseInfo.rule
                        ? "草稿已通过校验，请核对下方规则。"
                        : "请先明确以下信息"}
                    </b>
                    {parseInfo.clarifications.map((s, i) => (
                      <p key={i}>{s}</p>
                    ))}
                    {parseInfo.unsupported.map((s, i) => (
                      <p key={i}>暂未支持：{s}</p>
                    ))}
                    <small>
                      {parseInfo.model} · 解析记录{" "}
                      {parseInfo.auditId.slice(0, 8)} · {parseInfo.defaults}
                    </small>
                  </div>
                </div>
              )}
              {editor && (
                <Editor
                  key={editor.taskId ?? JSON.stringify(editor.rule)}
                  initial={editor.rule}
                  busy={busy}
                  editing={!!editor.taskId}
                  onSave={save}
                  onDirtyChange={onEditorDirty}
                  onClose={() => leaveDraft(() => setCompose(compose))}
                />
              )}
              <div className="status-summary">
                <div>
                  <span>运行中的真实任务</span>
                  <b>
                    {active}
                    <small>/ 3</small>
                  </b>
                </div>
                <div>
                  <span>已生成提醒</span>
                  <b>{alerts.length}</b>
                </div>
                <div>
                  <span>数据异常</span>
                  <b className={degraded ? "amber" : ""}>{degraded}</b>
                </div>
                <div className="summary-note">
                  <Clock aria-hidden="true" size={13} />
                  <span>关闭网页后继续运行</span>
                </div>
              </div>
              <div className={"monitor-grid " + (!detail ? "no-detail" : "")}>
                <section className="task-panel">
                  <div className="list-toolbar">
                    <div className="list-filters">
                      {(
                        [
                          ["all", "全部"],
                          ["live", "真实任务"],
                          ["demo", "演示任务"],
                          ["paused", "已暂停"],
                        ] as const
                      ).map(([key, label]) => (
                        <button
                          key={key}
                          className={filter === key ? "active" : ""}
                          aria-pressed={filter === key}
                          onClick={() => setFilter(key)}
                        >
                          {label}
                          {key === "all" && <span>{tasks.length}</span>}
                        </button>
                      ))}
                    </div>
                    <button
                      className="icon-button"
                      aria-label="刷新任务"
                      disabled={busy}
                      onClick={() =>
                        void refresh().catch((e) => setError(e.message))
                      }
                    >
                      <RefreshCw aria-hidden="true" size={15} />
                    </button>
                  </div>
                  <div className="table-head">
                    <span>任务 / 监控对象</span>
                    <span>触发条件</span>
                    <span>状态</span>
                    <span>检查计划</span>
                    <span>最近检查</span>
                  </div>
                  {!loaded ? (
                    <div className="empty">
                      <LoaderCircle
                        aria-hidden="true"
                        className="spin"
                        size={24}
                      />
                      <p>正在读取任务</p>
                    </div>
                  ) : !visibleTasks.length ? (
                    <div className="empty">
                      <Layers aria-hidden="true" size={27} />
                      <h3>
                        {tasks.length ? "这个筛选下暂无任务" : "还没有监控任务"}
                      </h3>
                      <p>
                        {tasks.length ? (
                          "切换筛选可以查看已有任务。"
                        ) : (
                          <>
                            将关注的价格、热度或日期设成条件，
                            <br />
                            系统会持续检查并保留判断依据。
                          </>
                        )}
                      </p>
                      <div>
                        <button
                          className="button primary"
                          disabled={busy}
                          onClick={() => {
                            if (tasks.length) setFilter("all");
                            else
                              leaveDraft(() => {
                                setCompose(true);
                                window.scrollTo({ top: 0, behavior: "smooth" });
                              });
                          }}
                        >
                          <Plus aria-hidden="true" size={15} />
                          {tasks.length ? "查看全部任务" : "创建首个监控"}
                        </button>
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() => leaveDraft(() => void demo())}
                        >
                          先看演示
                          <ArrowRight aria-hidden="true" size={13} />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="task-list">
                      {visibleTasks.map((t) => (
                        <button
                          className={
                            "task-row " +
                            (selected === t.id ? "task-selected" : "")
                          }
                          key={t.id}
                          disabled={busy}
                          onClick={() =>
                            leaveDraft(() => {
                              setDetailTab("latest");
                              setTargetRun(null);
                              setSelected(t.id);
                            })
                          }
                        >
                          <div className="task-identity">
                            <div>
                              <b>{t.title}</b>
                              <span
                                className={
                                  "badge " +
                                  (t.mode === "demo" ? "demo" : "live")
                                }
                              >
                                {t.mode === "demo" ? "演示" : "真实"}
                              </span>
                            </div>
                            <small>
                              {t.rule.symbolName}
                              <span className="mono">{t.rule.symbol}</span>
                              <span className="version">v{t.version}</span>
                            </small>
                          </div>
                          <p className="task-rule">{ruleSummary(t.rule)}</p>
                          <div
                            className={
                              "health " + (!t.enabled ? "paused" : t.health)
                            }
                          >
                            <i />
                            {!t.enabled ? "已暂停" : healthLabel[t.health]}
                          </div>
                          <div className="task-schedule">
                            <span>
                              {t.mode === "demo"
                                ? "手动切换场景"
                                : t.rule.schedule.mode === "intraday"
                                  ? "盘中每" +
                                    t.rule.schedule.intervalMinutes +
                                    "分钟"
                                  : t.rule.schedule.mode === "close"
                                    ? "收盘后15:10"
                                    : "每天" + t.rule.schedule.at}
                            </span>
                            <small>
                              冷却 {t.rule.cooldownMinutes / 60} 小时
                            </small>
                          </div>
                          <div className="task-last">
                            <span>
                              {t.lastRunAt
                                ? fmt(t.lastRunAt, true)
                                : "尚未检查"}
                            </span>
                            <small title={t.lastReason}>{t.lastReason}</small>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="list-bottom">
                    <span>{visibleTasks.length} 个任务</span>
                    <span>点击任务查看检查详情</span>
                  </div>
                </section>
                {detail && (
                  <section className="detail-panel">
                    <div className="detail-heading">
                      <div>
                        <p>
                          任务详情{" "}
                          <span className="version">
                            v{detail.task.version}
                          </span>
                        </p>
                        <h2>{detail.task.title}</h2>
                      </div>
                      <button
                        className="icon-button"
                        aria-label="关闭监控详情"
                        onClick={() => setSelected(null)}
                      >
                        <X aria-hidden="true" size={18} />
                      </button>
                    </div>
                    <div className="detail-sub">
                      <b>{detail.task.rule.symbolName}</b>
                      <span className="mono">{detail.task.rule.symbol}</span>
                      <span
                        className={
                          "badge " +
                          (detail.task.mode === "demo" ? "demo" : "live")
                        }
                      >
                        {detail.task.mode === "demo"
                          ? "演示 · 构造数据"
                          : "真实数据"}
                      </span>
                    </div>
                    <div className="task-actions">
                      <button
                        className="button secondary small"
                        disabled={busy}
                        onClick={() =>
                          void action(
                            detail.task,
                            detail.task.enabled ? "pause" : "resume",
                          )
                        }
                      >
                        {detail.task.enabled ? (
                          <Pause aria-hidden="true" size={13} />
                        ) : (
                          <Play aria-hidden="true" size={13} />
                        )}{" "}
                        {detail.task.enabled ? "暂停" : "恢复"}
                      </button>
                      <button
                        className="button secondary small"
                        disabled={busy}
                        onClick={() =>
                          leaveDraft(() => {
                            setEditor({
                              rule: detail.task.rule,
                              taskId: detail.task.id,
                              version: detail.task.version,
                            });
                            window.scrollTo({ top: 100, behavior: "smooth" });
                          })
                        }
                      >
                        <Pencil aria-hidden="true" size={13} />
                        编辑规则
                      </button>
                      {detail.task.mode === "live" && (
                        <button
                          className="button secondary small"
                          disabled={busy || !detail.task.enabled}
                          onClick={() => void action(detail.task, "run")}
                        >
                          {busy ? (
                            <LoaderCircle
                              aria-hidden="true"
                              className="spin"
                              size={13}
                            />
                          ) : (
                            <RefreshCw aria-hidden="true" size={13} />
                          )}
                          立即检查
                        </button>
                      )}
                      <button
                        className="button secondary small danger"
                        disabled={busy}
                        aria-expanded={deleteConfirm === detail.task.id}
                        onClick={() => setDeleteConfirm(detail.task.id)}
                      >
                        <Trash2 aria-hidden="true" size={13} />
                        删除任务
                      </button>
                    </div>
                    {deleteConfirm === detail.task.id && (
                      <div
                        className="delete-confirm"
                        role="group"
                        aria-label="确认删除任务"
                      >
                        <b>删除“{detail.task.title}”？</b>
                        <p>
                          将停止后台检查，并永久删除该任务的运行历史、规则版本和提醒。此操作无法撤销；仅需停止检查时请使用暂停。
                        </p>
                        <div>
                          <button
                            className="button secondary small"
                            disabled={busy}
                            onClick={() => setDeleteConfirm(null)}
                          >
                            取消删除
                          </button>
                          <button
                            className="button small danger-confirm"
                            disabled={busy}
                            onClick={() => void removeTask(detail.task)}
                          >
                            确认删除
                          </button>
                        </div>
                      </div>
                    )}
                    {detail.task.mode === "demo" && (
                      <details className="scenario-box" open>
                        <summary>
                          验证场景 <span>构造数据，不代表行情</span>
                        </summary>
                        <div className="scenario-buttons">
                          {Object.entries(scenarios).map(([key, label]) => (
                            <button
                              key={key}
                              disabled={busy || !detail.task.enabled}
                              onClick={() => void scenario(key as Scenario)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <p>
                          场景使用固定构造值，满足示例针对初始规则；修改后以实际比较结果为准。使用同一引擎，冷却到期会推进演示时钟。
                        </p>
                      </details>
                    )}
                    <div className="detail-tabs">
                      {(
                        [
                          ["latest", "最新检查"],
                          ["history", "运行历史"],
                          ["versions", "规则版本"],
                        ] as const
                      ).map(([key, label]) => (
                        <button
                          className={detailTab === key ? "active" : ""}
                          key={key}
                          aria-pressed={detailTab === key}
                          onClick={() => setDetailTab(key)}
                        >
                          {label}
                          {key === "history" && (
                            <small>{detail.runs.length}</small>
                          )}
                        </button>
                      ))}
                    </div>
                    <div className="detail-content">
                      {detailTab === "latest" &&
                        (latest?.result ? (
                          <>
                            {latest.version !== detail.task.version && (
                              <p className="version-warning" role="status">
                                当前 v{detail.task.version} 尚未检查；下方为历史
                                v{latest.version} 的检查结果。
                              </p>
                            )}
                            <div className="check-meta">
                              <span>
                                {fmt(latest.startedAt)}
                                {detail.task.mode === "demo"
                                  ? " · 演示时钟"
                                  : ""}
                              </span>
                              <span>
                                v{latest.version} ·{" "}
                                {latest.kind === "cron"
                                  ? "自动检查"
                                  : latest.kind === "demo"
                                    ? "演示场景"
                                    : "手动检查"}
                              </span>
                            </div>
                            <Result
                              result={latest.result}
                              evidence={latest.evidence}
                            />
                            <div className="next-check">
                              <div>
                                <span>下次自动检查</span>
                                <b>
                                  {!detail.task.enabled
                                    ? "已暂停"
                                    : detail.task.mode === "demo"
                                      ? "手动切换场景"
                                      : fmt(detail.task.nextRunAt)}
                                </b>
                              </div>
                              <div>
                                <span>冷却截止</span>
                                <b>
                                  {detail.task.cooldownUntil
                                    ? fmt(detail.task.cooldownUntil)
                                    : "尚未触发"}
                                </b>
                              </div>
                            </div>
                            <p className="detail-footnote">
                              {detail.task.mode === "demo"
                                ? "演示数值与故障由固定场景构造，可展开证据核对。"
                                : "展示值保留两位小数，判断采用源精度。源时间是快照就绪时间，不等于该证券最后成交时间。"}
                            </p>
                          </>
                        ) : (
                          <div className="empty compact">
                            <Clock aria-hidden="true" size={24} />
                            <h3>等待首次检查</h3>
                            <p>
                              {!detail.task.enabled
                                ? "任务已暂停，恢复后再检查。"
                                : detail.task.mode === "demo"
                                  ? "演示不参与自动调度，请点击上方场景检查。"
                                  : "下次自动检查：" +
                                    fmt(detail.task.nextRunAt)}
                            </p>
                            {detail.task.mode === "live" &&
                              detail.task.enabled && (
                                <p>也可以使用“立即检查”读取当前数据。</p>
                              )}
                          </div>
                        ))}
                      {detailTab === "history" && (
                        <div className="timeline">
                          {historyRuns.map((r) => (
                            <details
                              key={r.id}
                              id={"run-" + r.id}
                              className="timeline-entry"
                              open={targetRun === r.id}
                            >
                              <summary>
                                <span
                                  className={
                                    "timeline-dot " + r.result?.decision
                                  }
                                />
                                <div>
                                  <b>
                                    {r.result
                                      ? decisions[r.result.decision]
                                      : "检查中"}
                                  </b>
                                  <small>
                                    {fmt(r.startedAt)} · v{r.version} ·{" "}
                                    {r.kind === "cron"
                                      ? "自动"
                                      : r.kind === "demo"
                                        ? "演示"
                                        : "手动"}
                                  </small>
                                  <p>{r.result?.reason}</p>
                                </div>
                                <ChevronRight aria-hidden="true" size={14} />
                              </summary>
                              {r.result && (
                                <div className="timeline-result">
                                  {targetRun === r.id && (
                                    <p className="subtle">
                                      该提醒对应的检查 · v{r.version}
                                    </p>
                                  )}
                                  <Result
                                    result={r.result}
                                    evidence={r.evidence}
                                  />
                                  <small className="mono break">
                                    检查 ID：{r.id}
                                  </small>
                                </div>
                              )}
                            </details>
                          ))}
                          {!detail.runs.length && (
                            <p className="subtle">尚无运行记录</p>
                          )}
                        </div>
                      )}
                      {detailTab === "versions" && (
                        <div className="versions">
                          {detail.versions.map((v, i) => (
                            <div key={v.version} className="version-entry">
                              <div>
                                <b>v{v.version}</b>
                                <span>{i === 0 ? "当前版本" : "历史版本"}</span>
                                <small>{fmt(v.createdAt)}</small>
                              </div>
                              <p>
                                {v.rule.symbolName} · {ruleSummary(v.rule)}
                              </p>
                              <small>
                                {v.rule.schedule.mode === "intraday"
                                  ? "盘中每" +
                                    v.rule.schedule.intervalMinutes +
                                    "分钟"
                                  : v.rule.schedule.mode === "close"
                                    ? "收盘后15:10"
                                    : "每天" + v.rule.schedule.at}{" "}
                                · 冷却{v.rule.cooldownMinutes / 60}小时
                              </small>
                              {detail.versions[i + 1] && (
                                <p className="version-diff">
                                  相较 v{detail.versions[i + 1].version}：
                                  {(
                                    [
                                      "title",
                                      "symbol",
                                      "logic",
                                      "conditions",
                                      "schedule",
                                      "cooldownMinutes",
                                    ] as const
                                  )
                                    .filter(
                                      (k) =>
                                        JSON.stringify(v.rule[k]) !==
                                        JSON.stringify(
                                          detail.versions[i + 1].rule[k],
                                        ),
                                    )
                                    .map(
                                      (k) =>
                                        ({
                                          title: "名称",
                                          symbol: "证券",
                                          logic: "组合关系",
                                          conditions: "条件",
                                          schedule: "调度",
                                          cooldownMinutes: "冷却配置",
                                        })[k],
                                    )
                                    .join("、") || "规则文字记录"}
                                  发生变化。原冷却期保留。
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </section>
                )}
              </div>
            </>
          )}
          {view === "alerts" && (
            <section className="alerts-panel">
              <div className="list-toolbar">
                <h2>
                  应用内提醒 <span className="count">{alerts.length}</span>
                </h2>
                <span className="subtle">同一轮持续满足只提醒一次</span>
              </div>
              {alerts.length ? (
                <div className="alert-list">
                  {alerts.map((a) => {
                    const t = tasks.find((t) => t.id === a.taskId);
                    return (
                      <button
                        className="alert-item"
                        key={a.id}
                        disabled={busy}
                        onClick={() =>
                          leaveDraft(() => {
                            setView("tasks");
                            setSelected(a.taskId);
                            setDetailTab("history");
                            setTargetRun(a.runId);
                          })
                        }
                      >
                        <Bell aria-hidden="true" size={18} />
                        <div>
                          <div>
                            <b>{a.title}</b>
                            <span
                              className={
                                "badge " +
                                (t?.mode === "demo" ? "demo" : "live")
                              }
                            >
                              {t?.mode === "demo" ? "演示" : "真实"}
                            </span>
                            <span className="version">v{a.version}</span>
                          </div>
                          <p>{a.reason}</p>
                          <small>
                            检查 {a.runId.slice(0, 8)} · 提醒 {a.id.slice(0, 8)}
                          </small>
                        </div>
                        <time>{fmt(a.createdAt)}</time>
                        <ArrowUpRight aria-hidden="true" size={16} />
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="empty">
                  <Bell aria-hidden="true" size={25} />
                  <h3>暂无提醒</h3>
                  <p>
                    条件满足后的提醒会保留在这里。
                    <br />
                    在任务详情中可以查看未触发的原因。
                  </p>
                </div>
              )}
            </section>
          )}
          {view === "about" && (
            <div className="help-layout">
              <aside>
                <span>使用指南</span>
                <a href="#supported">支持的条件</a>
                <a href="#sources">数据与口径</a>
                <a href="#notifications">运行与提醒</a>
                <a href="#boundaries">体验版边界</a>
              </aside>
              <article>
                <section id="supported">
                  <h2>支持的条件</h2>
                  <p>
                    支持A股单证券的价格、当日涨跌幅、过去24小时热榜前30、指定日期、是否交易日，以及最多6个
                    AND / OR 组合条件。
                  </p>
                  <p>
                    DeepSeek Flash
                    只生成规则草稿，模糊阈值需要澄清。你确认证券、条件和频率后才启用；任务由确定性规则引擎判断。条件有“满足
                    / 不满足 / 无法判断”三种结果，局部数据异常会单独标识。
                  </p>
                </section>
                <section id="sources">
                  <h2>数据与口径</h2>
                  <dl className="help-definitions">
                    <div>
                      <dt>行情</dt>
                      <dd>
                        扶摇快照。盘中新鲜度10分钟；收盘阶段要求当日15:00后的有效快照。源时间为快照就绪时间，不等于单证券最后成交时间。
                      </dd>
                    </div>
                    <div>
                      <dt>涨跌幅</dt>
                      <dd>
                        单位为百分数，3表示3%。与价格和前收盘价推算差超过0.05个百分点时标为冲突，暂停相关条件判断。
                      </dd>
                    </div>
                    <div>
                      <dt>热榜</dt>
                      <dd>
                        过去24小时榜单，新鲜度60分钟。完整榜单未出现时仅标识“未进入前30”，不虚构具体名次；不完整榜单无法推断榜外状态。
                      </dd>
                    </div>
                    <div>
                      <dt>交易日历</dt>
                      <dd>
                        接口范围为过去一年至当日；未来交易日尚不能确认。所有调度采用上海时区。
                      </dd>
                    </div>
                  </dl>
                  <a
                    className="help-link"
                    href="https://fuyao.aicubes.cn/llms.txt"
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看数据源接口说明
                    <ExternalLink aria-hidden="true" size={13} />
                  </a>
                </section>
                <section id="notifications">
                  <h2>运行与提醒</h2>
                  <p>
                    后台每分钟检查到期任务，关闭网页后仍继续运行。盘中时段为9:30–11:30和13:00–15:00；收盘检查为15:10；也可以每天指定时间检查。
                  </p>
                  <p>
                    连续满足只提醒一次。有效“不满足”才会结束当前触发周期，异常数据不会重置。新一轮在冷却中等待，到期仍满足才提醒。失败按1
                    / 5 / 15分钟退避，恢复后留下记录。
                  </p>
                  <p>
                    编辑生成新版本并保留原冷却期；暂停恢复检查当前数据，暂停期间不补造历史触发。每次检查保留规则版本、原字段、单位、来源和时点。
                  </p>
                  <p>
                    删除任务会停止检查并永久清理关联的历史、规则版本和提醒，需再次确认且无法撤销。需要保留记录时请使用暂停。
                  </p>
                </section>
                <section id="boundaries">
                  <h2>体验版边界</h2>
                  <p>
                    本作品只提供条件监控与投资研究信息，不提供买卖、仓位建议、涨跌预测、收益保证或自动交易。演示数据均为构造值，真实任务禁止注入演示场景。
                  </p>
                  <p>
                    每个浏览器最多30个总任务（含演示和暂停），其中最多3个运行中的真实任务，全站12个。删除可释放总任务额度，暂停只释放运行额度。AI解析全站每天200次，每个浏览器每天20次。当前没有正式账号、跨设备同步、公告事件、指数、财务估值、邮件或推送。
                  </p>
                  <p>
                    服务使用 Cloudflare
                    Workers、D1与Cron保存并调度任务。体验空间由签名Cookie隔离，清除Cookie后进入新空间，不适合作为生产级身份认证。
                  </p>
                </section>
                <div className="help-service">
                  <b>当前服务</b>
                  <span>模型 {health?.model ?? "读取中"}</span>
                  <span>
                    扶摇数据 {health?.dataConfigured ? "已配置" : "未配置"}
                  </span>
                  <span>后台心跳 {fmt(health?.heartbeat?.receivedAt)}</span>
                </div>
              </article>
            </div>
          )}
          <footer className="page-footer">
            <span>条件监控与研究信息，不构成交易建议。</span>
            <span>知因雷达 · 公开体验版</span>
          </footer>
        </main>
      </div>
      {discard && (
        <DiscardDialog
          onCancel={() => setDiscard(null)}
          onDiscard={discard.proceed}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
