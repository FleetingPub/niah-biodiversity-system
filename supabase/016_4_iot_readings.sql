-- Sensor readings (items 28 and 29). Only edge-com adds them, for nodes an admin has linked to the
-- device that sent them, and nobody changes or removes one through the API. A device can't be
-- removed while it has readings, and neither can a node, so the history stays whole. Turn a device
-- off instead. Officers and admins read them.
-- The values are raw, as the node measured them. Soil % and rain % are worked out when they're
-- read, with the node's calibration in iot_nodes (iot_raw_pct below), so a recalibration also
-- fixes the old readings. Old readings from an edge's buffer are stored like any other, for
-- analysis; only a reading measured more than 5 minutes in the future is turned down (edge-com).
-- Run it after 016_3. 017 adds the alerts.
-- The SQL editor runs a whole file as one transaction, so if anything in here fails, nothing from
-- it is kept. It's safe to run again.

DO $$
BEGIN
  IF to_regclass('public.iot_device_tokens') IS NULL THEN
    RAISE EXCEPTION '016_4 needs 016_3_iot_device_tokens.sql to be run first';
  END IF;
END
$$;

-- The ranges are what the parts can really measure, not what's normal for the forest. They match
-- the edge's own checks, which leave a value out before it gets here, so a value outside them means
-- a broken sensor or a bad message. Each check has a name, so an error says which value it was.
-- (node_id, boot_id, seq) is unique: the node numbers its readings from 1 at every power-up, with a
-- new random boot_id, so a reading the edge sends twice is only stored once.
CREATE TABLE IF NOT EXISTS public.iot_readings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id text NOT NULL REFERENCES public.iot_devices (device_id),
  node_id text NOT NULL REFERENCES public.iot_nodes (node_id),
  boot_id bigint NOT NULL CONSTRAINT boot_id_in_range CHECK (boot_id BETWEEN 0 AND 4294967295),
  seq bigint NOT NULL CONSTRAINT seq_in_range CHECK (seq >= 0),
  -- When the node measured it (its NTP clock), or when the edge got it if the node had no time yet
  recorded_at timestamptz NOT NULL,
  ts_source text NOT NULL CONSTRAINT ts_source_kind CHECK (ts_source IN ('device', 'edge')),
  received_at timestamptz NOT NULL,          -- when the edge got it
  inserted_at timestamptz NOT NULL DEFAULT now(),
  -- The DHT11 is rated for 0 to 50 C; empty when its read failed
  temp_c real CONSTRAINT temp_c_in_range CHECK (temp_c BETWEEN 0 AND 50),
  hum_pct real CONSTRAINT hum_pct_in_range CHECK (hum_pct BETWEEN 0 AND 100),
  -- The soil probe and the rain pad, as the ESP32's 12-bit ADC read them
  soil_raw integer CONSTRAINT soil_raw_in_range CHECK (soil_raw BETWEEN 0 AND 4095),
  rain_raw integer CONSTRAINT rain_raw_in_range CHECK (rain_raw BETWEEN 0 AND 4095),
  -- The HC-SR04 and the distance it took as normal; dist_cm is empty when there was no echo
  dist_cm real CONSTRAINT dist_cm_in_range CHECK (dist_cm BETWEEN 0 AND 1000),
  baseline_cm real CONSTRAINT baseline_cm_in_range CHECK (baseline_cm BETWEEN 0 AND 1000),
  beep_on boolean,                           -- the locate beep was on
  rssi smallint CONSTRAINT rssi_in_range CHECK (rssi BETWEEN -127 AND 0),
  motion boolean,                            -- the PIR saw movement since the previous reading
  CONSTRAINT iot_readings_one_per_reading UNIQUE (node_id, boot_id, seq)
);

CREATE INDEX IF NOT EXISTS iot_readings_node_id_recorded_at
  ON public.iot_readings (node_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS iot_readings_recorded_at
  ON public.iot_readings (recorded_at DESC);

ALTER TABLE public.iot_readings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.iot_readings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.iot_readings TO authenticated;

-- In a sub-select so Postgres checks the role once, not again for every reading
DROP POLICY IF EXISTS "Officers and admins read sensor readings" ON public.iot_readings;
CREATE POLICY "Officers and admins read sensor readings"
  ON public.iot_readings FOR SELECT
  TO authenticated
  USING ((SELECT public.has_any_role(ARRAY['conservation_officer', 'admin'])));

-- Raw ADC value to percent with a node's dry and wet values: Arduino's map(raw, dry, wet, 0, 100)
-- kept within 0 to 100, with the same whole-number division as the ESP32 and the edge, so all
-- three agree on a reading's state. Empty when there's no value.
CREATE OR REPLACE FUNCTION public.iot_raw_pct(raw integer, dry integer, wet integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN raw IS NULL OR wet = dry THEN NULL
    ELSE greatest(0, least(100, ((raw - dry) * 100) / (wet - dry)))
  END
$$;

REVOKE EXECUTE ON FUNCTION public.iot_raw_pct(integer, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.iot_raw_pct(integer, integer, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';
