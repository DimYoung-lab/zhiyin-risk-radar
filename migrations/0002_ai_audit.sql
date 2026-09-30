CREATE TABLE ai_audit (id TEXT PRIMARY KEY,workspace TEXT NOT NULL,model TEXT NOT NULL,input_hash TEXT NOT NULL,status TEXT NOT NULL,usage_json TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX ai_audit_workspace ON ai_audit(workspace,created_at DESC);
