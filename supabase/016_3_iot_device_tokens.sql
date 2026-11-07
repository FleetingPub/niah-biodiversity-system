-- Edge device tokens (item 28). Each edge device has its own token, and the only thing that token
-- does is let edge-com take uploads for the nodes linked to that device. Only a hash of it is kept.
-- Run it after 016_2.
-- The SQL editor runs a whole file as one transaction, so if anything in here fails, nothing from
-- it is kept. It's safe to run again.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'iot_nodes' AND column_name = 'cal_version'
  ) THEN
    RAISE EXCEPTION '016_3 needs 016_2_iot_nodes.sql to be run first';
  END IF;
END
$$;

-- The token hashes, on their own so nobody can read them through the API, admins included. It has
-- Row Level Security on and no policies, and no role the API uses has any grant on it. Only
-- iot_make_device_token below and edge-com (which connects to the database directly) use it. A
-- plain SHA-256 is enough here because a token is long and random, so there's nothing to guess from
-- a list of common passwords.
CREATE TABLE IF NOT EXISTS public.iot_device_tokens (
  device_id text PRIMARY KEY REFERENCES public.iot_devices (device_id) ON DELETE CASCADE,
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32)
);

ALTER TABLE public.iot_device_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.iot_device_tokens FROM PUBLIC, anon, authenticated, service_role;

-- Makes a device's token, or replaces it. The old token stops working straight away. This is the
-- only time the plain token exists: it goes back to the admin who asked, who pastes it into the
-- edge's secrets.toml as edge_key. Only its hash is saved, so a lost token can't be looked up, only
-- replaced. The random part comes from two gen_random_uuid() calls, which use the server's secure
-- random source and need no extension.
CREATE OR REPLACE FUNCTION public.iot_make_device_token(device text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  plain text;
  made_at timestamptz := now();
BEGIN
  IF NOT public.has_any_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only administrators can make device tokens' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.iot_devices AS d WHERE d.device_id = device) THEN
    RAISE EXCEPTION 'There''s no device called %', device;
  END IF;

  plain := 'niah_device_'
    || replace(gen_random_uuid()::text, '-', '')
    || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.iot_device_tokens (device_id, token_hash)
  VALUES (device, sha256(convert_to(plain, 'UTF8')))
  ON CONFLICT (device_id) DO UPDATE SET token_hash = EXCLUDED.token_hash;

  UPDATE public.iot_devices
  SET token_made_at = made_at,
      token_made_by_name = (
        SELECT COALESCE(NULLIF(p.name, ''), p.email)
        FROM public.profiles AS p
        WHERE p.id = auth.uid()
      )
  WHERE device_id = device;

  RETURN jsonb_build_object('device_id', device, 'token', plain, 'token_made_at', made_at);
END
$$;

REVOKE EXECUTE ON FUNCTION public.iot_make_device_token(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.iot_make_device_token(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
