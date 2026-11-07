-- Node power-ups. One row each time a node starts: where it's installed (set by hand in its
-- secrets.h and sent once per power-up, as it has no GPS), and the first and last reading that
-- arrived, so you can see whether readings went missing. edge-com fills it in. Nodes sit beside
-- protected plants, so only officers and admins read it, and no public view does.
-- Run it after 022.
-- The SQL editor runs a whole file as one transaction, so if anything in here fails, nothing from
-- it is kept. It's safe to run again.

DO $$
BEGIN
  IF to_regprocedure('public.iot_limit_readings()') IS NULL THEN
    RAISE EXCEPTION '023 needs 022_iot_reading_limit.sql to be run first';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.iot_boots (
  node_id text NOT NULL REFERENCES public.iot_nodes (node_id),
  boot_id bigint NOT NULL CONSTRAINT boot_id_in_range CHECK (boot_id BETWEEN 0 AND 4294967295),
  device_id text REFERENCES public.iot_devices (device_id),   -- the edge that last forwarded it
  -- Empty when the position isn't set in the node's secrets.h
  latitude double precision CONSTRAINT latitude_in_range CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision CONSTRAINT longitude_in_range CHECK (longitude BETWEEN -180 AND 180),
  position_at timestamptz,                   -- when the edge got the position
  first_seq bigint,                          -- the lowest seq that arrived (1 = nothing lost at the start)
  first_recorded_at timestamptz,             -- its measurement time, a few seconds after power-up
  last_seq bigint,
  last_recorded_at timestamptz,
  PRIMARY KEY (node_id, boot_id),
  CONSTRAINT latitude_and_longitude_together CHECK ((latitude IS NULL) = (longitude IS NULL))
);

ALTER TABLE public.iot_boots ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.iot_boots FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.iot_boots TO authenticated;

DROP POLICY IF EXISTS "Officers and admins read node power-ups" ON public.iot_boots;
CREATE POLICY "Officers and admins read node power-ups"
  ON public.iot_boots FOR SELECT
  TO authenticated
  USING ((SELECT public.has_any_role(ARRAY['conservation_officer', 'admin'])));

NOTIFY pgrst, 'reload schema';
