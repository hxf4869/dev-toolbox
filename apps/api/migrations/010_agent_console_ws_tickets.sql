-- Agent Console WebSocket 一次性连接 ticket。
-- 只保存高熵 ticket 的 SHA-256 摘要，明文只在创建响应中出现一次；
-- 单次消费由 consumed_at 判定，原子消费见 POST /internal/agent-console/ws-tickets/consume。
CREATE TABLE agent_console_ws_tickets (
    id uuid PRIMARY KEY,
    ticket_digest bytea NOT NULL UNIQUE CHECK (octet_length(ticket_digest) = 32),
    auth_session_id uuid NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
    owner_id uuid NOT NULL REFERENCES owner_account(id) ON DELETE CASCADE,
    audience text NOT NULL CHECK (char_length(audience) BETWEEN 1 AND 64),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    consumed_at timestamptz
);

CREATE INDEX agent_console_ws_tickets_expires_idx ON agent_console_ws_tickets (expires_at);

---- create above / drop below ----

DROP TABLE IF EXISTS agent_console_ws_tickets;
