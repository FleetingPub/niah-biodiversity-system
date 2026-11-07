-- Commands for the nodes: beep_on and beep_off (the locate beep, so a node can be found in the
-- forest) and reset_baseline (after a node was put back, take its distance now as normal).
-- Officers and admins send one from the website by adding a row with node_id and command; the
-- database fills in who and when. edge-com hands it to the node's edge with the next upload, the
-- edge sends it to the node and resends it until the node answers, and the row follows along:
-- pending -> at_edge -> sent -> done / failed, or expired after an hour. Only edge-com changes a
-- command after that, so nobody can mark one done through the API.
-- Run it after 024.
-- The SQL editor runs a whole file as one transaction, so if anything in here fails, nothing from
-- it is kept. It's safe to run again.

DO $$
BEGIN
  IF to_regclass('public.iot_alert_state') IS NULL THEN
    RAISE EXCEPTION '025 needs 024_iot_alert_state.sql to be run first';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.iot_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id text NOT NULL REFERENCES public.iot_nodes (node_id),
  command text NOT NULL CHECK (command IN ('beep_on', 'beep_off', 'reset_baseline')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'at_edge', 'sent', 'done', 'failed', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES public.profiles (id) ON DELETE SET NULL,
  created_by_name text,
  expires_at timestamptz NOT NULL DEFAULT now() + INTERVAL '1 hour',
  at_edge_at timestamptz,   -- the edge stored it
  sent_at timestamptz,      -- the edge sent it to the node over MQTT
  done_at timestamptz,      -- the node answered (or it failed or expired)
  result text               -- the node's answer, or why it failed
);

CREATE INDEX IF NOT EXISTS iot_commands_open
  ON public.iot_commands (node_id, created_at)
  WHERE status IN ('pending', 'at_edge', 'sent');

-- Who sent it, filled in by the server. A command added with nobody signed in (the SQL editor)
-- has no name.
CREATE OR REPLACE FUNCTION public.iot_fill_in_command_sender()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.created_by := auth.uid();
  NEW.created_by_name := (
    SELECT COALESCE(NULLIF(p.name, ''), p.email)
    FROM public.profiles AS p
    WHERE p.id = auth.uid()
  );
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.iot_fill_in_command_sender()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS iot_fill_in_command_sender ON public.iot_commands;
CREATE TRIGGER iot_fill_in_command_sender
  BEFORE INSERT ON public.iot_commands
  FOR EACH ROW EXECUTE FUNCTION public.iot_fill_in_command_sender();

ALTER TABLE public.iot_commands ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.iot_commands FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.iot_commands TO authenticated;
GRANT INSERT (node_id, command) ON TABLE public.iot_commands TO authenticated;

DROP POLICY IF EXISTS "Officers and admins read commands" ON public.iot_commands;
CREATE POLICY "Officers and admins read commands"
  ON public.iot_commands FOR SELECT
  TO authenticated
  USING ((SELECT public.has_any_role(ARRAY['conservation_officer', 'admin'])));

DROP POLICY IF EXISTS "Officers and admins send commands" ON public.iot_commands;
CREATE POLICY "Officers and admins send commands"
  ON public.iot_commands FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.has_any_role(ARRAY['conservation_officer', 'admin'])));

NOTIFY pgrst, 'reload schema';
