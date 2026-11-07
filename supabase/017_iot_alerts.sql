-- Threat alerts (item 31). edge-com decides them from the readings when an upload arrives, with
-- each node's own settings in iot_nodes: an alert opens after alert_confirm_readings readings in a
-- row show the condition, ends by itself after as many readings in a row are back past the clear
-- threshold (MOTION: motion_clear_readings), and the same condition stays quiet for alert_rearm_s
-- after an end. QUIET (a node that stopped sending) is raised here, by iot_raise_quiet_alerts, so it
-- also works when a whole edge is down. One ongoing problem is one alert, not a new one for every
-- reading. Officers and admins can acknowledge and resolve an alert, and the database writes down
-- who and when.
-- Run it after 016_4.
-- The SQL editor runs a whole file as one transaction, so if anything in here fails, nothing from
-- it is kept. It's safe to run again.

DO $$
BEGIN
  IF to_regclass('public.iot_readings') IS NULL THEN
    RAISE EXCEPTION '017 needs 016_4_iot_readings.sql to be run first';
  END IF;
END
$$;

-- 1. The alerts. Nobody adds or changes one directly through the API. edge-com and the functions
-- below do, so a row can't say someone else acknowledged or resolved it. The node's name is kept as
-- well as its ID, and the staff's names as well as their IDs, so an alert still says who it was
-- after an account is deleted.
-- Two kinds of "over": cleared_at is when the readings showed the condition had passed, resolved_at
-- when someone said it's dealt with. Either can come first.
-- urgent could mean someone is at the plant, or a fire or a flash flood. routine (DRY, RAIN) can
-- wait for the next patrol.
-- from_backlog: the alert started more than an hour before it was opened, because its readings
-- came from an edge's buffer after an outage. It's kept for the record but doesn't count as one
-- needing someone.
CREATE TABLE IF NOT EXISTS public.iot_alerts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  node_id text NOT NULL REFERENCES public.iot_nodes (node_id),
  node_name text NOT NULL,
  device_id text NOT NULL REFERENCES public.iot_devices (device_id),
  type text NOT NULL CHECK (type IN (
    'SATURATED', 'DRY', 'HEAVY', 'RAIN', 'MOVED', 'NO_ECHO', 'MOTION', 'TOO_HOT', 'QUIET'
  )),
  severity text NOT NULL CHECK (severity IN ('urgent', 'routine')),
  -- The first reading that showed the condition. QUIET has none.
  boot_id bigint,
  seq bigint,
  -- When it started: that reading's measurement time (QUIET: the last reading before the silence)
  recorded_at timestamptz NOT NULL,
  confirmed_recorded_at timestamptz NOT NULL,   -- measurement time of the reading that confirmed it
  confirmed_at timestamptz NOT NULL DEFAULT now(),  -- when it was opened here
  from_backlog boolean NOT NULL DEFAULT false,
  cleared_recorded_at timestamptz,              -- the first reading back to normal; empty = still going on
  cleared_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  acknowledged_by_name text,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  resolved_by_name text,
  CONSTRAINT iot_alerts_one_per_start UNIQUE (node_id, type, boot_id, seq),
  CONSTRAINT iot_alerts_reading_unless_quiet CHECK ((type = 'QUIET') = (boot_id IS NULL AND seq IS NULL)),
  CONSTRAINT iot_alerts_ends_after_start CHECK (cleared_recorded_at IS NULL OR cleared_recorded_at >= recorded_at),
  CONSTRAINT resolved_has_a_time CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CONSTRAINT acknowledged_has_a_time CHECK (status <> 'acknowledged' OR acknowledged_at IS NOT NULL)
);

-- One QUIET alert for each silence, even if two uploads look at the same moment
CREATE UNIQUE INDEX IF NOT EXISTS iot_alerts_one_quiet_per_silence
  ON public.iot_alerts (node_id, recorded_at)
  WHERE type = 'QUIET';

CREATE INDEX IF NOT EXISTS iot_alerts_recorded_at ON public.iot_alerts (recorded_at DESC);
CREATE INDEX IF NOT EXISTS iot_alerts_going_on ON public.iot_alerts (node_id) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS iot_alerts_status_severity ON public.iot_alerts (status, severity);

ALTER TABLE public.iot_alerts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.iot_alerts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.iot_alerts TO authenticated;

DROP POLICY IF EXISTS "Officers and admins read alerts" ON public.iot_alerts;
CREATE POLICY "Officers and admins read alerts"
  ON public.iot_alerts FOR SELECT
  TO authenticated
  USING ((SELECT public.has_any_role(ARRAY['conservation_officer', 'admin'])));

-- 2. A node's status in iot_nodes, from its alerts that are still going on and not resolved:
-- offline (QUIET), threat_triggered (an urgent one), warning (a routine one) or online. edge-com
-- runs it after each upload, and the functions below when they change an alert.
CREATE OR REPLACE FUNCTION public.iot_refresh_node_status(nodes text[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.iot_nodes AS n
  SET status = s.status
  FROM (
    SELECT x.node_id,
      CASE
        WHEN bool_or(a.type = 'QUIET') THEN 'offline'
        WHEN bool_or(a.severity = 'urgent') THEN 'threat_triggered'
        WHEN count(a.id) > 0 THEN 'warning'
        ELSE 'online'
      END AS status
    FROM unnest(nodes) AS x (node_id)
    LEFT JOIN public.iot_alerts AS a
      ON a.node_id = x.node_id AND a.cleared_at IS NULL AND a.status <> 'resolved'
    GROUP BY x.node_id
  ) AS s
  WHERE n.node_id = s.node_id
    AND n.status IS DISTINCT FROM s.status;
$$;

REVOKE EXECUTE ON FUNCTION public.iot_refresh_node_status(text[])
  FROM PUBLIC, anon, authenticated, service_role;

-- 3. Nodes that have gone quiet. No reading arrives to set this off, so something has to ask:
-- edge-com after every upload from any edge, and iot_check_alerts each time a staff page loads, so
-- it also works when a region's edge is down. A scheduler such as pg_cron could also run it. A
-- node is quiet when its newest reading is older than its quiet_minutes and QUIET is one of its
-- alert_types. It makes one alert for each silence, even if someone has resolved it since; edge-com
-- ends it when a new reading arrives. A node that has never sent anything isn't quiet, it just
-- hasn't started.
CREATE OR REPLACE FUNCTION public.iot_raise_quiet_alerts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  raised text[];
BEGIN
  WITH added AS (
    INSERT INTO public.iot_alerts (
      node_id, node_name, device_id, type, severity, recorded_at, confirmed_recorded_at
    )
    SELECT n.node_id, n.name, last.device_id, 'QUIET', 'urgent', last.recorded_at, last.recorded_at
    FROM public.iot_nodes AS n
    CROSS JOIN LATERAL (
      SELECT r.recorded_at, r.device_id
      FROM public.iot_readings AS r
      WHERE r.node_id = n.node_id
      ORDER BY r.recorded_at DESC
      LIMIT 1
    ) AS last
    WHERE 'QUIET' = ANY (n.alert_types)
      AND last.recorded_at < now() - make_interval(mins => n.quiet_minutes)
    ON CONFLICT (node_id, recorded_at) WHERE type = 'QUIET' DO NOTHING
    RETURNING node_id
  )
  SELECT array_agg(node_id) INTO raised FROM added;

  IF raised IS NOT NULL THEN
    PERFORM public.iot_refresh_node_status(raised);
  END IF;
  RETURN coalesce(array_length(raised, 1), 0);
END
$$;

-- No grants. edge-com and iot_check_alerts run it, and a scheduler runs as the owner.
REVOKE EXECUTE ON FUNCTION public.iot_raise_quiet_alerts()
  FROM PUBLIC, anon, authenticated, service_role;

-- 4. What the staff pages call. It looks for quiet nodes, then says how many alerts need someone,
-- which is what the red number in the staff menu shows: still going on, nobody has acknowledged
-- them yet, and not from an edge's backlog. It only answers officers and admins.
CREATE OR REPLACE FUNCTION public.iot_check_alerts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.has_any_role(ARRAY['conservation_officer', 'admin']) THEN
    RAISE EXCEPTION 'Only officers and administrators can check alerts' USING ERRCODE = '42501';
  END IF;

  PERFORM public.iot_raise_quiet_alerts();

  RETURN (
    SELECT jsonb_build_object(
      'urgent', count(*) FILTER (WHERE a.severity = 'urgent'),
      'open', count(*)
    )
    FROM public.iot_alerts AS a
    WHERE a.status = 'open'
      AND a.cleared_at IS NULL
      AND NOT a.from_backlog
  );
END
$$;

REVOKE EXECUTE ON FUNCTION public.iot_check_alerts()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.iot_check_alerts() TO authenticated;

-- 5. Acknowledge means "I've seen this and someone is on it". Resolve means "it's dealt with",
-- whether or not the readings say it has passed yet. Both give back the alert's status. Doing
-- either one again changes nothing, so the first person stays on it if two officers press the
-- button at once. Anyone else gets turned down.
CREATE OR REPLACE FUNCTION public.iot_acknowledge_alert(alert bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  now_status text;
BEGIN
  IF NOT public.has_any_role(ARRAY['conservation_officer', 'admin']) THEN
    RAISE EXCEPTION 'Only officers and administrators can acknowledge alerts' USING ERRCODE = '42501';
  END IF;

  UPDATE public.iot_alerts AS a
  SET status = 'acknowledged',
      acknowledged_at = now(),
      acknowledged_by = auth.uid(),
      acknowledged_by_name = (
        SELECT COALESCE(NULLIF(p.name, ''), p.email)
        FROM public.profiles AS p
        WHERE p.id = auth.uid()
      )
  WHERE a.id = alert
    AND a.status = 'open';

  SELECT a.status INTO now_status FROM public.iot_alerts AS a WHERE a.id = alert;
  IF now_status IS NULL THEN
    RAISE EXCEPTION 'There''s no alert %', alert;
  END IF;
  RETURN jsonb_build_object('id', alert, 'status', now_status);
END
$$;

REVOKE EXECUTE ON FUNCTION public.iot_acknowledge_alert(bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.iot_acknowledge_alert(bigint) TO authenticated;

CREATE OR REPLACE FUNCTION public.iot_resolve_alert(alert bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  now_status text;
  its_node text;
BEGIN
  IF NOT public.has_any_role(ARRAY['conservation_officer', 'admin']) THEN
    RAISE EXCEPTION 'Only officers and administrators can resolve alerts' USING ERRCODE = '42501';
  END IF;

  UPDATE public.iot_alerts AS a
  SET status = 'resolved',
      resolved_at = now(),
      resolved_by = auth.uid(),
      resolved_by_name = (
        SELECT COALESCE(NULLIF(p.name, ''), p.email)
        FROM public.profiles AS p
        WHERE p.id = auth.uid()
      )
  WHERE a.id = alert
    AND a.status <> 'resolved';

  SELECT a.status, a.node_id INTO now_status, its_node FROM public.iot_alerts AS a WHERE a.id = alert;
  IF now_status IS NULL THEN
    RAISE EXCEPTION 'There''s no alert %', alert;
  END IF;
  PERFORM public.iot_refresh_node_status(ARRAY[its_node]);
  RETURN jsonb_build_object('id', alert, 'status', now_status);
END
$$;

REVOKE EXECUTE ON FUNCTION public.iot_resolve_alert(bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.iot_resolve_alert(bigint) TO authenticated;

-- 6. Each node with its latest reading, for the Sensors page. It reads as whoever is asking, so the
-- Row Level Security on the tables decides who gets rows. Percent and states are worked out from
-- the raw values with the node's calibration, the same way edge-com and the edge do. It leaves out
-- the position. A node with no readings yet has empty columns here and isn't quiet.
DROP VIEW IF EXISTS public.iot_node_status;
CREATE VIEW public.iot_node_status
WITH (security_invoker = true)
AS
SELECT
  n.node_id,
  n.name,
  n.zone,
  n.edge_device_id,
  n.status,
  n.last_heartbeat,
  last.recorded_at AS last_reading_at,
  now() - last.recorded_at AS age,
  last.temp_c,
  CASE WHEN last.temp_c >= n.too_hot_c THEN 'TOO_HOT'
       WHEN last.temp_c IS NOT NULL THEN 'NORMAL' END AS temp_state,
  last.hum_pct,
  last.soil_raw,
  p.soil_pct,
  CASE WHEN p.soil_pct >= n.soil_flood_pct THEN 'SATURATED'
       WHEN p.soil_pct <= n.soil_dry_pct THEN 'DRY'
       WHEN p.soil_pct IS NOT NULL THEN 'NORMAL' END AS soil_state,
  last.rain_raw,
  p.rain_pct,
  CASE WHEN p.rain_pct >= n.rain_heavy_pct THEN 'HEAVY'
       WHEN p.rain_pct >= n.rain_light_pct THEN 'RAIN'
       WHEN p.rain_pct IS NOT NULL THEN 'NONE' END AS rain_state,
  last.dist_cm,
  last.baseline_cm,
  CASE WHEN last.id IS NULL THEN NULL
       WHEN last.dist_cm IS NULL THEN 'NO_ECHO'
       WHEN last.baseline_cm IS NOT NULL
        AND abs(round(last.dist_cm * 10) - round(last.baseline_cm * 10)) > round(n.move_cm * 10) THEN 'MOVED'
       ELSE 'OK' END AS dist_state,
  last.motion,
  n.beep_on,
  n.last_rssi AS rssi,
  COALESCE(last.recorded_at < now() - make_interval(mins => n.quiet_minutes), false) AS quiet,
  COALESCE(a.going_on, 0) AS open_alerts,
  COALESCE(a.urgent, 0) AS urgent_alerts
FROM public.iot_nodes AS n
LEFT JOIN LATERAL (
  SELECT r.*
  FROM public.iot_readings AS r
  WHERE r.node_id = n.node_id
  ORDER BY r.recorded_at DESC
  LIMIT 1
) AS last ON true
CROSS JOIN LATERAL (
  SELECT public.iot_raw_pct(last.soil_raw, n.soil_dry_raw, n.soil_wet_raw) AS soil_pct,
         public.iot_raw_pct(last.rain_raw, n.rain_dry_raw, n.rain_wet_raw) AS rain_pct
) AS p
LEFT JOIN LATERAL (
  SELECT count(*) AS going_on, count(*) FILTER (WHERE x.severity = 'urgent') AS urgent
  FROM public.iot_alerts AS x
  WHERE x.node_id = n.node_id AND x.cleared_at IS NULL AND x.status <> 'resolved'
) AS a ON true;

REVOKE ALL ON TABLE public.iot_node_status FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.iot_node_status TO authenticated;

NOTIFY pgrst, 'reload schema';
