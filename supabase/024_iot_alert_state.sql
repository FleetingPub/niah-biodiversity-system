-- edge-com's working state for alerts, one row per node and condition: how many readings in a row
-- show it (or are back to normal), which alert is open, and when the last one ended. It's only for
-- edge-com, which connects to the database directly, so it has Row Level Security on, no policies,
-- and no grants. Staff read the alerts themselves in iot_alerts.
-- Run it after 023.
-- The SQL editor runs a whole file as one transaction, so if anything in here fails, nothing from
-- it is kept. It's safe to run again.

DO $$
BEGIN
  IF to_regclass('public.iot_boots') IS NULL THEN
    RAISE EXCEPTION '024 needs 023_iot_boots.sql to be run first';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.iot_alert_state (
  node_id text NOT NULL REFERENCES public.iot_nodes (node_id),
  type text NOT NULL,
  last_reading_at timestamptz,               -- the newest reading looked at; older ones aren't judged again
  run_count integer NOT NULL DEFAULT 0,      -- readings in a row showing the condition
  run_boot_id bigint,                        -- the first reading of that run
  run_seq bigint,
  run_started_at timestamptz,
  clear_count integer NOT NULL DEFAULT 0,    -- readings in a row back past the clear threshold
  clear_started_at timestamptz,
  open_alert_id bigint REFERENCES public.iot_alerts (id),
  last_cleared_at timestamptz,               -- measurement time the last alert ended (for alert_rearm_s)
  PRIMARY KEY (node_id, type)
);

ALTER TABLE public.iot_alert_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.iot_alert_state FROM PUBLIC, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
