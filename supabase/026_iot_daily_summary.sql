-- Each node's day in figures (item 30): for today and the 6 days before it, by park time (Sarawak,
-- UTC+8), how many readings came in and the lowest, average and highest temperature, humidity and
-- soil moisture. The Sensors page shows them on each node's card.
-- Soil % is worked out from the raw values with the node's calibration in iot_nodes, the same way
-- as everywhere else, so a recalibration changes past days too. A value a node didn't send is left
-- out of that value's figures, and a day with no readings has no row.
-- It reads as whoever is asking, so the Row Level Security on iot_readings and iot_nodes decides
-- who gets rows: officers and admins. Nobody else, and nothing public, can read it.
-- It only reads the last 7 days of readings, so it stays quick however long the history gets.
-- Run it after 025.
-- The SQL editor runs a whole file as one transaction, so if anything in here fails, nothing from
-- it is kept. It's safe to run again.

DO $$
BEGIN
  IF to_regclass('public.iot_commands') IS NULL THEN
    RAISE EXCEPTION '026 needs 025_iot_commands.sql to be run first';
  END IF;
END
$$;

DROP VIEW IF EXISTS public.iot_daily_summary;
CREATE VIEW public.iot_daily_summary
WITH (security_invoker = true)
AS
SELECT
  r.node_id,
  (r.recorded_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS day,
  count(*)::integer AS readings,
  min(r.temp_c) AS temp_min,
  round(avg(r.temp_c)::numeric, 1)::real AS temp_avg,
  max(r.temp_c) AS temp_max,
  min(r.hum_pct) AS hum_min,
  round(avg(r.hum_pct)::numeric, 1)::real AS hum_avg,
  max(r.hum_pct) AS hum_max,
  min(p.soil_pct) AS soil_min,
  round(avg(p.soil_pct), 1)::real AS soil_avg,
  max(p.soil_pct) AS soil_max
FROM public.iot_readings AS r
JOIN public.iot_nodes AS n ON n.node_id = r.node_id
CROSS JOIN LATERAL (
  SELECT public.iot_raw_pct(r.soil_raw, n.soil_dry_raw, n.soil_wet_raw) AS soil_pct
) AS p
-- From midnight 6 days ago, park time. Written on recorded_at itself so the index on it is used.
WHERE r.recorded_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kuala_Lumpur') - interval '6 days')
                       AT TIME ZONE 'Asia/Kuala_Lumpur'
GROUP BY r.node_id, (r.recorded_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date;

REVOKE ALL ON TABLE public.iot_daily_summary FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.iot_daily_summary TO authenticated;

NOTIFY pgrst, 'reload schema';
