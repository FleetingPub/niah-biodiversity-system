-- Limits how many readings one edge device can add in an hour, so a device token can't be used to
-- fill the database. A device with three field nodes sends about 180 readings an hour, one a
-- minute from each, plus one at once whenever something starts. 3,600 leaves room for that and
-- for an edge catching up after an outage, which then takes longer: a day's backlog from three
-- nodes is about 4,300 readings, so it's all in about two hours after the edge is back.
-- An upload that would go over is refused with HTTP 429 and none of it is kept. cloud-com on the
-- edge keeps the batch and tries again later, waiting longer each time. Readings it has already
-- sent don't count again. The count is by when Supabase stored a reading (inserted_at), not when
-- it was measured, so old readings from a backlog count when they arrive.
-- Run it after 001 to 017 and 019 to 021.
-- The SQL editor runs a whole file as one transaction, so if anything in here fails, nothing from
-- it is kept. It's safe to run again. To change the limit, change the number in part 2 and run it
-- again.
-- supabase/tests/iot-limit.test.js checks it.

-- 021 has to be there first, and the readings table from 016_4.
DO $$
BEGIN
  IF to_regclass('public.role_changes') IS NULL THEN
    RAISE EXCEPTION '022 needs 021_role_changes.sql to be run first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'iot_readings' AND column_name = 'inserted_at'
  ) THEN
    RAISE EXCEPTION '022 needs 016_4_iot_readings.sql to be run first';
  END IF;
END
$$;

-- 1. Lets the count in part 2 find one device's readings from the last hour without reading the
-- rest of the table.
CREATE INDEX IF NOT EXISTS iot_readings_device_id_inserted_at
  ON public.iot_readings (device_id, inserted_at);

-- 2. Runs once after each upload's readings are added, and counts each device's readings from the
-- last hour, the new ones too. Only one upload from a device counts at a time, because of the
-- lock, so two sent together can't both get under the limit. edge-com stores an upload in one
-- transaction, so raising this undoes all of it, and edge-com turns the PT429 code into HTTP 429.
-- Readings skipped as already sent never get here, since nothing new was added for them.
CREATE OR REPLACE FUNCTION public.iot_limit_readings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  most_an_hour constant integer := 3600;
  device text;
  lately integer;
BEGIN
  FOR device IN SELECT DISTINCT a.device_id FROM added AS a ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtext('public.iot_limit_readings ' || device));
    SELECT count(*) INTO lately
    FROM (
      SELECT 1
      FROM public.iot_readings AS r
      WHERE r.device_id = device
        AND r.inserted_at > now() - interval '1 hour'
      LIMIT most_an_hour + 1
    ) AS recent;
    IF lately > most_an_hour THEN
      RAISE EXCEPTION 'This device has sent too many readings in the last hour'
        USING ERRCODE = 'PT429',
          DETAIL = format('One device can send %s readings an hour.', most_an_hour),
          HINT = 'Send them again later.';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

REVOKE EXECUTE ON FUNCTION public.iot_limit_readings()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS iot_limit_readings ON public.iot_readings;
CREATE TRIGGER iot_limit_readings
  AFTER INSERT ON public.iot_readings
  REFERENCING NEW TABLE AS added
  FOR EACH STATEMENT EXECUTE FUNCTION public.iot_limit_readings();

NOTIFY pgrst, 'reload schema';
