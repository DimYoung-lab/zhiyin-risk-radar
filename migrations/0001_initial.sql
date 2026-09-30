CREATE TABLE tasks (
 id TEXT PRIMARY KEY, workspace TEXT NOT NULL, title TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('live','demo')), rule_json TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1,
 health TEXT NOT NULL DEFAULT 'pending', last_reason TEXT NOT NULL DEFAULT '等待首次检查',
 last_run_at INTEGER, next_run_at INTEGER NOT NULL, cooldown_until INTEGER NOT NULL DEFAULT 0,
 episode INTEGER NOT NULL DEFAULT 0, last_truth TEXT NOT NULL DEFAULT 'unknown', notified_episode INTEGER NOT NULL DEFAULT -1,
 fail_count INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, lease_token TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX tasks_workspace ON tasks(workspace,created_at);
CREATE INDEX tasks_due ON tasks(mode,enabled,next_run_at);
CREATE TABLE versions (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, version INTEGER NOT NULL, rule_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(task_id,version));
CREATE TABLE runs (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 version INTEGER NOT NULL, slot TEXT NOT NULL, kind TEXT NOT NULL,
 started_at INTEGER NOT NULL, finished_at INTEGER,
 status TEXT NOT NULL, result_json TEXT, evidence_json TEXT,
 UNIQUE(task_id,version,slot)
);
CREATE INDEX runs_task ON runs(task_id,started_at DESC);
CREATE TABLE alerts (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 workspace TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id),
 version INTEGER NOT NULL, episode INTEGER NOT NULL, title TEXT NOT NULL,
 reason TEXT NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(task_id,version,episode)
);
CREATE INDEX alerts_workspace ON alerts(workspace,created_at DESC);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE quota (key TEXT PRIMARY KEY, count INTEGER NOT NULL, day TEXT NOT NULL);
