-- Gives the public less about a plant whose spot is hidden. records_public (007) already rounds the
-- spot, and this makes the rest of the row match: a hidden plant's time goes down to the day, and
-- a plant whose name doesn't match the species it's linked to counts as hidden. Rows also stop
-- coming back in the order they were saved. Staff still see everything through records_staff.
-- The phone doesn't read this view, so nothing changes for it.
-- Run it after 001 to 017. There's no 018 file.
-- The SQL editor runs a whole file as one transaction, so if anything in here fails, nothing from
-- it is kept. It's safe to run again.
-- supabase/tests/public-details.test.js checks it.

-- 017 has to be there first, and 001 to 016_4 before that.
DO $$
BEGIN
  IF to_regprocedure('public.iot_check_alerts()') IS NULL THEN
    RAISE EXCEPTION '019 needs 017_iot_alerts.sql to be run first';
  END IF;
END
$$;

-- 1. The public view. The columns stay the same, in the same order. exact is on only when the
-- species shows its spot and the record's name is that species' name. Capitals and extra spaces
-- don't count, the same as sameName in web/src/lib/review.ts. A species renamed in the SQL editor
-- hides its records until they're corrected, since it's safer to hide too much than too little.
-- A hidden plant's time is midnight at the start of its day in park time (UTC+8 all year, the
-- same as 012). The ID is random, so sorting on it gives nothing away.
CREATE OR REPLACE VIEW public.records_public
WITH (security_invoker = false, security_barrier = true)
AS
SELECT
  r.id,
  r.tag_code,
  r.species_slug,
  r.species_name,
  r.common_name,
  r.height_m,
  r.condition,
  r.photo_count,
  CASE
    WHEN shown.exact THEN r.recorded_at
    ELSE (
      date_trunc('day', (r.recorded_at AT TIME ZONE 'UTC') + INTERVAL '8 hours') - INTERVAL '8 hours'
    ) AT TIME ZONE 'UTC'
  END AS recorded_at,
  r.status,
  CASE
    WHEN r.gps IS NULL THEN NULL
    WHEN shown.exact THEN
      jsonb_build_object('lat', r.gps -> 'lat', 'lng', r.gps -> 'lng', 'accuracyM', r.gps -> 'accuracyM')
    ELSE jsonb_build_object(
      'lat', round((floor((r.gps ->> 'lat')::numeric / 0.004) + 0.5) * 0.004, 3),
      'lng', round((floor((r.gps ->> 'lng')::numeric / 0.004) + 0.5) * 0.004, 3),
      'accuracyM', 440
    )
  END AS gps
FROM public.records AS r
LEFT JOIN public.species AS s ON s.id = r.species_slug
CROSS JOIN LATERAL (
  SELECT COALESCE(
    NOT s.sarawak_protected
      AND NOT s.rough_area_only
      AND s.iucn_code IN ('LC', 'NT')
      AND lower(regexp_replace(btrim(r.species_name), '\s+', ' ', 'g'))
        = lower(regexp_replace(btrim(s.scientific_name), '\s+', ' ', 'g')),
    false
  ) AS exact
) AS shown
WHERE r.status = 'published'
ORDER BY r.id;

-- 2. The counts on the Reports page, the same as 012 except that hides_spot follows the same rule
-- as the view above.
CREATE OR REPLACE FUNCTION public.report_counts(
  scope text DEFAULT 'published',
  from_day date DEFAULT NULL,
  to_day date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH parked AS (
    SELECT
      r.status,
      r.condition,
      r.gps IS NOT NULL AS has_gps,
      -- Park time is UTC+8 all year, the same as PARK_OFFSET_MS in web/src/lib/format.ts
      (r.recorded_at AT TIME ZONE 'UTC') + INTERVAL '8 hours' AS recorded_at,
      s.id AS species_id,
      s.iucn_code,
      COALESCE(s.iucn_code IN ('CR', 'EN', 'VU') OR s.sarawak_protected, false) AS threatened,
      -- The rule from records_public above. A plant with no species stays hidden too.
      NOT COALESCE(
        s.iucn_code IN ('LC', 'NT')
          AND NOT s.sarawak_protected
          AND NOT s.rough_area_only
          AND lower(regexp_replace(btrim(r.species_name), '\s+', ' ', 'g'))
            = lower(regexp_replace(btrim(s.scientific_name), '\s+', ' ', 'g')),
        false
      ) AS hides_spot
    FROM public.records_staff AS r
    LEFT JOIN public.species_staff AS s ON s.id = r.species_slug
    WHERE r.status = 'published'
      OR (r.status = 'waiting' AND report_counts.scope = 'all')
  ),
  covered AS (
    SELECT *
    FROM parked AS p
    WHERE (report_counts.from_day IS NULL OR p.recorded_at::date >= report_counts.from_day)
      AND (report_counts.to_day IS NULL OR p.recorded_at::date <= report_counts.to_day)
  )
  SELECT jsonb_build_object(
    'total', count(*),
    'waiting', count(*) FILTER (WHERE c.status = 'waiting'),
    'species_count', count(DISTINCT c.species_id),
    'not_matched', count(*) FILTER (WHERE c.species_id IS NULL),
    'threatened', count(*) FILTER (WHERE c.threatened),
    'needs_care', count(*) FILTER (WHERE c.condition <> 'healthy'),
    -- Rows of the CSV that say Hidden unless the exact spots are included
    'hidden_spots', count(*) FILTER (WHERE c.has_gps AND c.hides_spot),
    -- In park time to the minute, like 2026-10-12T16:05, or null with no records
    'first', to_char(min(c.recorded_at), 'YYYY-MM-DD"T"HH24:MI'),
    'last', to_char(max(c.recorded_at), 'YYYY-MM-DD"T"HH24:MI'),
    -- {"VU": 2, "none": 1}, where none is plants not matched to a species yet
    'by_iucn', (
      SELECT COALESCE(jsonb_object_agg(g.iucn, g.n), '{}'::jsonb)
      FROM (
        SELECT COALESCE(x.iucn_code, 'none') AS iucn, count(*) AS n
        FROM covered AS x
        GROUP BY 1
      ) AS g
    ),
    -- {"healthy": 7, "dead": 1}. Conditions with no records are left out.
    'by_condition', (
      SELECT COALESCE(jsonb_object_agg(g.condition, g.n), '{}'::jsonb)
      FROM (
        SELECT x.condition, count(*) AS n
        FROM covered AS x
        GROUP BY 1
      ) AS g
    ),
    -- {"eusideroxylon-zwageri": 2, "none": 1}, by species ID
    'by_species', (
      SELECT COALESCE(jsonb_object_agg(g.species, g.n), '{}'::jsonb)
      FROM (
        SELECT COALESCE(x.species_id, 'none') AS species, count(*) AS n
        FROM covered AS x
        GROUP BY 1
      ) AS g
    ),
    -- {"2026-10": {"healthy": 4, "dead": 1}}, by month in park time
    'by_month', (
      SELECT COALESCE(jsonb_object_agg(m.month, m.conditions), '{}'::jsonb)
      FROM (
        SELECT g.month, jsonb_object_agg(g.condition, g.n) AS conditions
        FROM (
          SELECT to_char(x.recorded_at, 'YYYY-MM') AS month, x.condition, count(*) AS n
          FROM covered AS x
          GROUP BY 1, 2
        ) AS g
        GROUP BY g.month
      ) AS m
    )
  )
  FROM covered AS c;
$$;

-- Only people who are signed in can call it. Supabase gives anon EXECUTE on new functions by
-- default, so it's taken away here.
REVOKE EXECUTE ON FUNCTION public.report_counts(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_counts(text, date, date) TO authenticated;

-- Tells the API to pick up the changes straight away.
NOTIFY pgrst, 'reload schema';
