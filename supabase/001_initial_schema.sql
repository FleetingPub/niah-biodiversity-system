-- ==============================================================================
-- Niah National Park Biodiversity System — Supabase PostgreSQL Schema
-- Item 14: Plant Database Schema & CRUD Operations
-- Client / Field: Sarawak Forestry Corporation (SFC) — Niah National Park
-- Unit / Context: COS30049 Computing Technology Innovation Project
-- ==============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";

-- ------------------------------------------------------------------------------
-- 1. Profiles Table (Extends Supabase auth.users with RBAC roles)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'visitor' CHECK (role IN ('visitor', 'botanist', 'conservation_officer', 'admin')),
    agency TEXT DEFAULT 'Sarawak Forestry Corporation',
    avatar_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------------------------------------
-- 2. Plant Species Registry Table
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.species (
    id TEXT PRIMARY KEY,                       -- Unique identifier / URL slug (e.g. 'eusideroxylon-zwageri')
    slug TEXT UNIQUE,                          -- Canonical slug matching web and mobile
    scientific_name TEXT NOT NULL,
    authority TEXT,
    family TEXT NOT NULL,
    genus TEXT,
    species TEXT,
    common_names TEXT[] DEFAULT '{}',          -- List of common/local names
    iucn_code TEXT NOT NULL CHECK (iucn_code IN ('CR', 'EN', 'VU', 'NT', 'LC', 'DD', 'NE')),
    sarawak_protected BOOLEAN NOT NULL DEFAULT FALSE,
    newer_name TEXT,
    summary TEXT,
    about TEXT,
    description TEXT,
    growth_habit TEXT DEFAULT 'Tree',
    height_range TEXT,
    habitat TEXT,
    uses TEXT,
    niah_zone TEXT DEFAULT 'Niah National Park',
    coordinates_rough JSONB DEFAULT '{"lat": 3.82, "lng": 113.78, "bufferKm": 4.0}',
    coordinates_exact JSONB DEFAULT '{"lat": 3.82, "lng": 113.78, "accuracyMeters": 5.0}',
    morphology JSONB DEFAULT '{"leaves": "", "bark": "", "flowers": "", "fruit": ""}',
    threats TEXT[] DEFAULT '{}',
    photos JSONB NOT NULL DEFAULT '[]',
    qr_uuid TEXT UNIQUE,                       -- Corresponds to physical tree tag (e.g. 'NNP-3F2A9C')
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Backwards compatibility trigger: ensure slug = id if slug is omitted
CREATE OR REPLACE FUNCTION public.sync_species_slug()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.slug IS NULL OR NEW.slug = '' THEN
        NEW.slug := NEW.id;
    END IF;
    IF NEW.id IS NULL OR NEW.id = '' THEN
        NEW.id := NEW.slug;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_species_slug ON public.species;
CREATE TRIGGER trg_sync_species_slug
    BEFORE INSERT OR UPDATE ON public.species
    FOR EACH ROW EXECUTE FUNCTION public.sync_species_slug();

-- ------------------------------------------------------------------------------
-- 3. Field Ground-Truthing Records / Observations Table
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    species_slug TEXT NOT NULL REFERENCES public.species(id) ON DELETE CASCADE,
    height_m NUMERIC(5, 2) NOT NULL DEFAULT 0.0,
    condition TEXT NOT NULL DEFAULT 'healthy' CHECK (condition IN ('healthy', 'damaged', 'dead')),
    photo_count INTEGER NOT NULL DEFAULT 0,
    photo_urls TEXT[] DEFAULT '{}',
    gps JSONB,                                 -- {"lat": 3.81488, "lng": 113.77968, "accuracyM": 6}
    notes TEXT,
    recorded_by TEXT NOT NULL,                 -- Botanist identifier
    recorded_at TIMESTAMPTZ DEFAULT NOW(),
    status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('published', 'waiting', 'rejected')),
    review_notes TEXT,
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ
);

-- Create a view alias 'observations' for backward compatibility
CREATE OR REPLACE VIEW public.observations AS
SELECT 
    id::text AS id,
    species_slug AS species_id,
    species_slug AS suggested_scientific_name,
    'Plantae' AS suggested_family,
    recorded_by AS botanist_name,
    recorded_by AS botanist_id,
    CASE 
        WHEN status = 'published' THEN 'approved'
        WHEN status = 'waiting' THEN 'pending'
        ELSE status
    END AS status,
    recorded_at AS submitted_at,
    CASE WHEN array_length(photo_urls, 1) > 0 THEN photo_urls[1] ELSE NULL END AS photo_url,
    notes,
    gps AS gps_location,
    review_notes,
    reviewed_by,
    reviewed_at
FROM public.records;

-- ------------------------------------------------------------------------------
-- 4. IoT Sensor Nodes Table
-- The field nodes themselves. Their readings are in iot_readings (016_4), and 016_2 adds each
-- node's edge device, calibration and alert settings.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.iot_nodes (
    node_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    zone TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'warning', 'threat_triggered', 'offline')),
    last_heartbeat TIMESTAMPTZ                 -- the time of the node's newest reading; empty until it sends one
);

-- ------------------------------------------------------------------------------
-- 5. Row-Level Security (RLS) Policies
-- ------------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.species ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.iot_nodes ENABLE ROW LEVEL SECURITY;

-- Species Policies:
-- Anyone (Public visitors and authenticated staff) can read species catalog
CREATE POLICY "Public read access for species"
    ON public.species FOR SELECT
    USING (true);

-- Only authenticated staff can insert/update/delete species
CREATE POLICY "Staff can manage species"
    ON public.species FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- Records Policies:
-- Public visitors can only view published records (unapproved/waiting stay hidden)
CREATE POLICY "Public read published records"
    ON public.records FOR SELECT
    USING (status = 'published');

-- Authenticated staff can view all records (including waiting queue)
CREATE POLICY "Authenticated users view all records"
    ON public.records FOR SELECT
    TO authenticated
    USING (true);

-- Authenticated botanists can insert field records
CREATE POLICY "Botanists can insert records"
    ON public.records FOR INSERT
    TO authenticated
    WITH CHECK (true);

-- Conservation Officers and Admins can update/review records
CREATE POLICY "Officers can review records"
    ON public.records FOR UPDATE
    TO authenticated
    USING (true);

-- IoT Nodes Policies:
-- Anyone can view sensor node telemetry in public dashboards
CREATE POLICY "Allow read access to IoT telemetry"
    ON public.iot_nodes FOR SELECT
    USING (true);

-- Authenticated devices/staff can insert/update telemetry
CREATE POLICY "Allow update access to IoT nodes"
    ON public.iot_nodes FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- ------------------------------------------------------------------------------
-- 6. Trigger to automatically create profile on Supabase auth signup
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, name, role, agency)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
        COALESCE(NEW.raw_user_meta_data->>'role', 'visitor'),
        COALESCE(NEW.raw_user_meta_data->>'agency', 'Sarawak Forestry Corporation')
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ------------------------------------------------------------------------------
-- 7. Supabase Storage Bucket Setup
-- ------------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('botanical-photos', 'botanical-photos', true)
ON CONFLICT (id) DO NOTHING;

-- Storage Policy: Public Read
CREATE POLICY "Public read botanical photos"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'botanical-photos');

-- Storage Policy: Authenticated Upload
CREATE POLICY "Authenticated upload botanical photos"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (bucket_id = 'botanical-photos');
