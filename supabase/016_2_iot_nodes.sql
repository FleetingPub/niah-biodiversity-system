-- Sensor nodes (items 28 and 29): the iot_nodes table from 001 made ready for the field nodes.
-- Each node is linked to the edge device it sends through, and gets its own calibration and alert
-- settings. The policies from 006 stay: officers and admins
-- read, admins add, change and remove a node.
-- Run it after 016_1.
-- The SQL editor runs a whole file as one transaction, so if anything in here fails, nothing from
-- it is kept. It's safe to run again.

DO $$
BEGIN
  IF to_regclass('public.iot_devices') IS NULL THEN
    RAISE EXCEPTION '016_2 needs 016_1_iot_devices.sql to be run first';
  END IF;
END
$$;

-- 1. The edge device a node sends through (a node with no device can't get readings from anyone),
-- and what it last reported about itself. status and last_heartbeat are 001's, and edge-com keeps
-- them up to date from the readings.
ALTER TABLE public.iot_nodes
  ADD COLUMN IF NOT EXISTS edge_device_id text REFERENCES public.iot_devices (device_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_rssi smallint,
  ADD COLUMN IF NOT EXISTS beep_on boolean,
  ADD COLUMN IF NOT EXISTS baseline_cm real;

CREATE INDEX IF NOT EXISTS iot_nodes_edge_device_id ON public.iot_nodes (edge_device_id);

-- The IDs the sketch and the edge accept
ALTER TABLE public.iot_nodes DROP CONSTRAINT IF EXISTS iot_nodes_node_id_format;
ALTER TABLE public.iot_nodes
  ADD CONSTRAINT iot_nodes_node_id_format CHECK (node_id ~ '^[A-Za-z0-9_-]{1,32}$');

-- 2. Calibration and alert settings, per node. Change a value (Table Editor -> iot_nodes) and
-- the Sensors page uses it straight away for all readings, old and new; the edge gets it with its
-- next upload (cal_version goes up) and spots quick alerts with it.
CREATE SEQUENCE IF NOT EXISTS public.iot_calibration_version_seq;

ALTER TABLE public.iot_nodes
  -- Raw ADC -> percent, and where the states start
  ADD COLUMN IF NOT EXISTS soil_dry_raw   integer  NOT NULL DEFAULT 4095 CHECK (soil_dry_raw BETWEEN 0 AND 4095),
  ADD COLUMN IF NOT EXISTS soil_wet_raw   integer  NOT NULL DEFAULT 1400 CHECK (soil_wet_raw BETWEEN 0 AND 4095),
  ADD COLUMN IF NOT EXISTS soil_flood_pct smallint NOT NULL DEFAULT 85   CHECK (soil_flood_pct BETWEEN 0 AND 100),  -- SATURATED from
  ADD COLUMN IF NOT EXISTS soil_dry_pct   smallint NOT NULL DEFAULT 20   CHECK (soil_dry_pct BETWEEN 0 AND 100),    -- DRY up to
  ADD COLUMN IF NOT EXISTS rain_dry_raw   integer  NOT NULL DEFAULT 4095 CHECK (rain_dry_raw BETWEEN 0 AND 4095),
  ADD COLUMN IF NOT EXISTS rain_wet_raw   integer  NOT NULL DEFAULT 1500 CHECK (rain_wet_raw BETWEEN 0 AND 4095),
  ADD COLUMN IF NOT EXISTS rain_light_pct smallint NOT NULL DEFAULT 20   CHECK (rain_light_pct BETWEEN 0 AND 100),  -- RAIN from
  ADD COLUMN IF NOT EXISTS rain_heavy_pct smallint NOT NULL DEFAULT 60   CHECK (rain_heavy_pct BETWEEN 0 AND 100),  -- HEAVY from
  ADD COLUMN IF NOT EXISTS move_cm        real     NOT NULL DEFAULT 10   CHECK (move_cm > 0),                       -- MOVED beyond
  -- The DHT11 reads up to 50 C, so a fire has to show below that
  ADD COLUMN IF NOT EXISTS too_hot_c      real     NOT NULL DEFAULT 45   CHECK (too_hot_c BETWEEN 0 AND 50),        -- TOO_HOT from
  -- Where an alert ends
  ADD COLUMN IF NOT EXISTS soil_flood_clear_pct smallint NOT NULL DEFAULT 80,   -- SATURATED ends below
  ADD COLUMN IF NOT EXISTS soil_dry_clear_pct   smallint NOT NULL DEFAULT 25,   -- DRY ends above
  ADD COLUMN IF NOT EXISTS rain_light_clear_pct smallint NOT NULL DEFAULT 15,   -- RAIN ends below
  ADD COLUMN IF NOT EXISTS rain_heavy_clear_pct smallint NOT NULL DEFAULT 50,   -- HEAVY ends below
  ADD COLUMN IF NOT EXISTS move_clear_cm        real     NOT NULL DEFAULT 7,    -- MOVED ends within
  ADD COLUMN IF NOT EXISTS too_hot_clear_c      real     NOT NULL DEFAULT 40,   -- TOO_HOT ends below
  -- Which conditions raise alerts, how many readings in a row open and end one (the node sends at
  -- once when a condition starts and debounces it itself, so 1 is enough), how long after an end
  -- the same condition stays quiet, and how long without a reading makes a node QUIET.
  -- MOTION ends after motion_clear_readings readings in a row without movement (about a minute each).
  ADD COLUMN IF NOT EXISTS alert_types text[] NOT NULL
    DEFAULT ARRAY['SATURATED', 'HEAVY', 'MOVED', 'NO_ECHO', 'MOTION', 'TOO_HOT', 'QUIET']
    CHECK (alert_types <@ ARRAY['SATURATED', 'DRY', 'HEAVY', 'RAIN', 'MOVED', 'NO_ECHO', 'MOTION', 'TOO_HOT', 'QUIET']),
  ADD COLUMN IF NOT EXISTS alert_confirm_readings  smallint NOT NULL DEFAULT 1   CHECK (alert_confirm_readings BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS motion_confirm_readings smallint NOT NULL DEFAULT 1   CHECK (motion_confirm_readings BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS motion_clear_readings   smallint NOT NULL DEFAULT 2   CHECK (motion_clear_readings BETWEEN 1 AND 1000),
  ADD COLUMN IF NOT EXISTS alert_rearm_s           integer  NOT NULL DEFAULT 300 CHECK (alert_rearm_s >= 0),
  ADD COLUMN IF NOT EXISTS quiet_minutes           integer  NOT NULL DEFAULT 15  CHECK (quiet_minutes > 0),
  ADD COLUMN IF NOT EXISTS cal_version bigint NOT NULL DEFAULT nextval('public.iot_calibration_version_seq');

ALTER TABLE public.iot_nodes DROP CONSTRAINT IF EXISTS iot_nodes_cal_ranges;
ALTER TABLE public.iot_nodes ADD CONSTRAINT iot_nodes_cal_ranges CHECK (
  soil_wet_raw <> soil_dry_raw AND rain_wet_raw <> rain_dry_raw
  AND soil_flood_clear_pct BETWEEN 0 AND soil_flood_pct
  AND soil_dry_clear_pct BETWEEN soil_dry_pct AND 100
  AND rain_light_clear_pct BETWEEN 0 AND rain_light_pct
  AND rain_heavy_clear_pct BETWEEN 0 AND rain_heavy_pct
  AND move_clear_cm BETWEEN 0 AND move_cm
  AND too_hot_clear_c BETWEEN 0 AND too_hot_c);

-- A new cal_version tells the edge to fetch the node's calibration again. Only this trigger moves
-- it: a change that sets cal_version itself keeps the old one, even if 006 granted the whole table.
-- It runs as its owner, so an admin changing a setting through the API doesn't need a grant on the
-- sequence.
CREATE OR REPLACE FUNCTION public.iot_nodes_bump_cal_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF (NEW.soil_dry_raw, NEW.soil_wet_raw, NEW.soil_flood_pct, NEW.soil_dry_pct,
      NEW.rain_dry_raw, NEW.rain_wet_raw, NEW.rain_light_pct, NEW.rain_heavy_pct, NEW.move_cm,
      NEW.alert_types, NEW.alert_confirm_readings, NEW.motion_confirm_readings)
     IS DISTINCT FROM
     (OLD.soil_dry_raw, OLD.soil_wet_raw, OLD.soil_flood_pct, OLD.soil_dry_pct,
      OLD.rain_dry_raw, OLD.rain_wet_raw, OLD.rain_light_pct, OLD.rain_heavy_pct, OLD.move_cm,
      OLD.alert_types, OLD.alert_confirm_readings, OLD.motion_confirm_readings) THEN
    NEW.cal_version := nextval('public.iot_calibration_version_seq');
  ELSE
    NEW.cal_version := OLD.cal_version;
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.iot_nodes_bump_cal_version() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS iot_nodes_cal_version ON public.iot_nodes;
CREATE TRIGGER iot_nodes_cal_version
  BEFORE UPDATE ON public.iot_nodes
  FOR EACH ROW EXECUTE FUNCTION public.iot_nodes_bump_cal_version();

-- 3. What the website may read and change. 006 decides which rows, with its policies: officers and
-- admins read, admins change. These grants only add the new columns, in case 006 granted iot_nodes
-- by column. cal_version isn't in the UPDATE list: the trigger above sets it.
GRANT SELECT (
  edge_device_id, last_rssi, beep_on, baseline_cm,
  soil_dry_raw, soil_wet_raw, soil_flood_pct, soil_dry_pct, rain_dry_raw, rain_wet_raw,
  rain_light_pct, rain_heavy_pct, move_cm, too_hot_c, soil_flood_clear_pct, soil_dry_clear_pct,
  rain_light_clear_pct, rain_heavy_clear_pct, move_clear_cm, too_hot_clear_c, alert_types,
  alert_confirm_readings, motion_confirm_readings, motion_clear_readings, alert_rearm_s,
  quiet_minutes, cal_version
) ON TABLE public.iot_nodes TO authenticated;
GRANT INSERT (edge_device_id) ON TABLE public.iot_nodes TO authenticated;
GRANT UPDATE (
  edge_device_id,
  soil_dry_raw, soil_wet_raw, soil_flood_pct, soil_dry_pct, rain_dry_raw, rain_wet_raw,
  rain_light_pct, rain_heavy_pct, move_cm, too_hot_c, soil_flood_clear_pct, soil_dry_clear_pct,
  rain_light_clear_pct, rain_heavy_clear_pct, move_clear_cm, too_hot_clear_c, alert_types,
  alert_confirm_readings, motion_confirm_readings, motion_clear_readings, alert_rearm_s,
  quiet_minutes
) ON TABLE public.iot_nodes TO authenticated;

NOTIFY pgrst, 'reload schema';
