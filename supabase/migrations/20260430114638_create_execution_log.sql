/*
  # Execution Lifecycle Log

  ## Purpose
  Records every step of the full trade execution lifecycle:
  SUBMITTED → FILL_POLLING → FILLED/CANCELED/REJECTED → POSITION_CONFIRMED

  This table is the authoritative record. A trade is NEVER considered executed
  unless fill_status = 'filled' AND position_confirmed = true.

  ## Tables Created

  ### execution_log
  One row per trade attempt. Updated as status progresses.

  Columns:
  - id: uuid primary key
  - session_id: client session grouping
  - ticker: underlying symbol
  - option_symbol: full OCC option symbol
  - signal_score: Signal Stack totalScore
  - confidence: signal confidence %
  - risk_reward: R/R ratio
  - grade: A+/A/B
  - quantity: contracts ordered
  - limit_price: order limit price
  - estimated_cost: limitPrice * 100 * qty (options multiplier)
  - order_id: Alpaca order ID (null until submitted)
  - order_status: submitted | partially_filled | filled | canceled | rejected | shadow | blocked
  - fill_status: pending | filled | canceled | rejected
  - position_confirmed: whether position was found in Alpaca after fill
  - pre_trade_buying_power: account buying power before order
  - post_trade_buying_power: account buying power after fill
  - pre_trade_equity: account equity before order
  - post_trade_equity: account equity after fill
  - submitted_at: when order was placed
  - filled_at: when order was filled
  - position_checked_at: when position confirmation ran
  - blocked_reason: why trade was blocked (if applicable)
  - environment: paper | live
  - shadow_mode: whether this was a shadow execution
  - created_at: row creation timestamp
  - updated_at: last update timestamp

  ## Security
  - RLS enabled
  - Only authenticated users can read/write
  - No API secrets stored
*/

CREATE TABLE IF NOT EXISTS execution_log (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id               text NOT NULL DEFAULT '',
  ticker                   text NOT NULL DEFAULT '',
  option_symbol            text NOT NULL DEFAULT '',
  signal_score             numeric NOT NULL DEFAULT 0,
  confidence               numeric NOT NULL DEFAULT 0,
  risk_reward              numeric NOT NULL DEFAULT 0,
  grade                    text NOT NULL DEFAULT '',
  quantity                 integer NOT NULL DEFAULT 1,
  limit_price              numeric,
  estimated_cost           numeric,
  order_id                 text,
  order_status             text NOT NULL DEFAULT 'blocked',
  fill_status              text NOT NULL DEFAULT 'pending',
  position_confirmed       boolean NOT NULL DEFAULT false,
  pre_trade_buying_power   numeric,
  post_trade_buying_power  numeric,
  pre_trade_equity         numeric,
  post_trade_equity        numeric,
  submitted_at             timestamptz,
  filled_at                timestamptz,
  position_checked_at      timestamptz,
  blocked_reason           text,
  environment              text NOT NULL DEFAULT 'paper',
  shadow_mode              boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE execution_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can insert execution logs"
  ON execution_log FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can read execution logs"
  ON execution_log FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can update execution logs"
  ON execution_log FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- indexes
CREATE INDEX IF NOT EXISTS execution_log_session_idx   ON execution_log(session_id);
CREATE INDEX IF NOT EXISTS execution_log_order_id_idx  ON execution_log(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS execution_log_created_idx   ON execution_log(created_at DESC);
CREATE INDEX IF NOT EXISTS execution_log_status_idx    ON execution_log(order_status);

-- account_snapshots: pre/post trade buying power history
CREATE TABLE IF NOT EXISTS account_snapshots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       text NOT NULL DEFAULT '',
  snapshot_type    text NOT NULL DEFAULT 'periodic', -- 'pre_trade' | 'post_trade' | 'periodic'
  execution_log_id uuid REFERENCES execution_log(id) ON DELETE SET NULL,
  equity           numeric NOT NULL DEFAULT 0,
  buying_power     numeric NOT NULL DEFAULT 0,
  cash             numeric NOT NULL DEFAULT 0,
  day_trade_buying_power numeric NOT NULL DEFAULT 0,
  portfolio_value  numeric NOT NULL DEFAULT 0,
  open_positions   integer NOT NULL DEFAULT 0,
  environment      text NOT NULL DEFAULT 'paper',
  recorded_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE account_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can insert account snapshots"
  ON account_snapshots FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can read account snapshots"
  ON account_snapshots FOR SELECT
  TO authenticated
  USING (true);

CREATE INDEX IF NOT EXISTS account_snapshots_session_idx    ON account_snapshots(session_id);
CREATE INDEX IF NOT EXISTS account_snapshots_recorded_idx   ON account_snapshots(recorded_at DESC);
CREATE INDEX IF NOT EXISTS account_snapshots_exec_log_idx   ON account_snapshots(execution_log_id) WHERE execution_log_id IS NOT NULL;
