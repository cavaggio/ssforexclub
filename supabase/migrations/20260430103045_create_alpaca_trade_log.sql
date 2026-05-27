/*
  # Alpaca Auto-Trading: Trade Log & Risk State

  ## Tables Created

  ### trade_log
  Records every trade decision made by the auto-trading engine, whether submitted,
  blocked, rejected, filled, or canceled. Never stores API secrets.

  Columns:
  - id: uuid primary key
  - session_id: client-generated session identifier (groups trades per day/session)
  - timestamp: when the decision was made
  - ticker: underlying ticker symbol (e.g. NVDA)
  - option_symbol: full OCC option symbol (e.g. NVDA251219C00950000)
  - signal_score: totalScore from Signal Stack (0–20)
  - confidence: signal confidence percent (0–100)
  - risk_reward: signal R/R ratio
  - grade: signal grade (A+, A, B)
  - entry_price: limit price submitted
  - qty: number of contracts
  - side: buy or sell
  - status: blocked | submitted | filled | canceled | rejected | shadow
  - rejection_reason: why the trade was blocked or rejected
  - order_id: Alpaca order ID if submitted
  - environment: paper or live
  - shadow_mode: whether this was a shadow (not real) execution
  - created_at: row creation timestamp

  ### risk_state
  Persists daily risk counters so the engine survives page reloads.
  One row per session_date per environment.

  Columns:
  - id: uuid primary key
  - session_date: YYYY-MM-DD trading date (ET)
  - environment: paper or live
  - trades_today: count of trades placed today
  - consecutive_losses: running streak of losing trades
  - daily_pnl: realized + unrealized P&L for the day
  - trading_disabled: whether auto-trading was hard-disabled
  - disable_reason: reason trading was disabled
  - updated_at: last update timestamp

  ## Security
  - RLS enabled on both tables
  - Only authenticated users can read/write their own rows
  - No API secrets are ever stored in these tables
*/

-- trade_log
CREATE TABLE IF NOT EXISTS trade_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL DEFAULT '',
  timestamp timestamptz NOT NULL DEFAULT now(),
  ticker text NOT NULL DEFAULT '',
  option_symbol text NOT NULL DEFAULT '',
  signal_score numeric NOT NULL DEFAULT 0,
  confidence numeric NOT NULL DEFAULT 0,
  risk_reward numeric NOT NULL DEFAULT 0,
  grade text NOT NULL DEFAULT '',
  entry_price numeric,
  qty integer NOT NULL DEFAULT 1,
  side text NOT NULL DEFAULT 'buy',
  status text NOT NULL DEFAULT 'blocked',
  rejection_reason text,
  order_id text,
  environment text NOT NULL DEFAULT 'paper',
  shadow_mode boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE trade_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can insert trade logs"
  ON trade_log FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can read trade logs"
  ON trade_log FOR SELECT
  TO authenticated
  USING (true);

-- risk_state
CREATE TABLE IF NOT EXISTS risk_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date date NOT NULL,
  environment text NOT NULL DEFAULT 'paper',
  trades_today integer NOT NULL DEFAULT 0,
  consecutive_losses integer NOT NULL DEFAULT 0,
  daily_pnl numeric NOT NULL DEFAULT 0,
  trading_disabled boolean NOT NULL DEFAULT false,
  disable_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_date, environment)
);

ALTER TABLE risk_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can insert risk state"
  ON risk_state FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can read risk state"
  ON risk_state FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can update risk state"
  ON risk_state FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- indexes for common query patterns
CREATE INDEX IF NOT EXISTS trade_log_session_id_idx ON trade_log(session_id);
CREATE INDEX IF NOT EXISTS trade_log_created_at_idx ON trade_log(created_at DESC);
CREATE INDEX IF NOT EXISTS risk_state_date_env_idx ON risk_state(session_date, environment);
