-- Edge devices (item 28), one for each forest region: the Ubuntu VM that collects its sensor
-- nodes' readings over MQTT and sends them on through the edge-com function. Admins add them on
-- the Devices page and can turn one off; a device that's off can't send anything. Its token is in
-- 016_3, on its own, so nobody can read it through the API.
-- Run it after 001 to 015.
-- The SQL editor runs a whole file as one transaction, so if anything in here fails, nothing from
-- it is kept. It's safe to run again.

-- 015 has to be there first, and 001 to 014 before that.
DO $$
BEGIN
  IF to_regprocedure('public.keep_species_rough()') IS NULL THEN
    RAISE EXCEPTION '016_1 needs 015_species_rough_area.sql to be run first';
  END IF;
END
$$;

-- The token columns only say when a token was made and by who. The website and the API can never
-- set those, because only iot_make_device_token (016_3) does. device_id is what the edge has as
-- edge_id in its secrets.toml.
CREATE TABLE IF NOT EXISTS public.iot_devices (
  device_id text PRIMARY KEY CHECK (device_id ~ '^[A-Za-z0-9-]{3,40}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  zone text CHECK (char_length(zone) <= 80),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  token_made_at timestamptz,
  token_made_by_name text,
  -- When edge-com last took an upload from it
  last_heard_at timestamptz,
  -- Where the edge is ([edge] lat / lon in its config.toml; `iot-edge register-sql` prints the SQL)
  latitude double precision CONSTRAINT latitude_in_range CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision CONSTRAINT longitude_in_range CHECK (longitude BETWEEN -180 AND 180),
  CONSTRAINT latitude_and_longitude_together CHECK ((latitude IS NULL) = (longitude IS NULL))
);

ALTER TABLE public.iot_devices ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.iot_devices FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON TABLE public.iot_devices TO authenticated;
GRANT INSERT (device_id, name, zone, latitude, longitude) ON TABLE public.iot_devices TO authenticated;
GRANT UPDATE (name, zone, enabled, latitude, longitude) ON TABLE public.iot_devices TO authenticated;

DROP POLICY IF EXISTS "Admins manage edge devices" ON public.iot_devices;
CREATE POLICY "Admins manage edge devices"
  ON public.iot_devices FOR ALL
  TO authenticated
  USING (public.has_any_role(ARRAY['admin']))
  WITH CHECK (public.has_any_role(ARRAY['admin']));

-- Officers see the devices too, for the map and the list on the Sensors page. Only admins add,
-- change or remove one, and nobody reads a token (016_3 keeps the hashes on their own).
DROP POLICY IF EXISTS "Officers and admins read edge devices" ON public.iot_devices;
CREATE POLICY "Officers and admins read edge devices"
  ON public.iot_devices FOR SELECT
  TO authenticated
  USING ((SELECT public.has_any_role(ARRAY['conservation_officer', 'admin'])));

NOTIFY pgrst, 'reload schema';
