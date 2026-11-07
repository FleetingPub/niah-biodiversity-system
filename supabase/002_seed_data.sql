-- ==============================================================================
-- Niah National Park Biodiversity System — Supabase Seed Data
-- Item 14: Plant Database Schema & Seed Data
-- Client / Field: Sarawak Forestry Corporation (SFC) — Niah National Park
-- Unit / Context: COS30049 Computing Technology Innovation Project
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Seed Plant Species
-- ------------------------------------------------------------------------------
INSERT INTO public.species (
    id, slug, scientific_name, authority, family, genus, species, common_names,
    iucn_code, sarawak_protected, summary, about, habitat, uses, description,
    growth_habit, height_range, niah_zone, coordinates_rough, coordinates_exact,
    morphology, threats, photos, qr_uuid
) VALUES
(
    'eusideroxylon-zwageri',
    'eusideroxylon-zwageri',
    'Eusideroxylon zwageri',
    'Teijsm. & Binn.',
    'Lauraceae',
    'Eusideroxylon',
    'zwageri',
    ARRAY['Belian', 'Borneo ironwood', 'Tebelian', 'Kayu Besi'],
    'VU',
    FALSE,
    'A slow growing hardwood with timber so dense it sinks in water.',
    'Belian is a big, slow growing tree of lowland forest. Its wood is one of the heaviest and hardest in Borneo and it hardly rots, so posts and roof shingles made from it can last for generations.',
    'Lowland rainforest in Borneo and nearby islands, mostly on well drained soil.',
    'Posts, piles, bridges and roof shingles. Many older longhouses stand on belian posts.',
    'An iconic ironwood of Borneo, capable of reaching 50 meters in height with a dense, fine-textured grain that is naturally impervious to termite attack.',
    'Canopy / Emergent Tree',
    '30m - 50m',
    'Pangkalan Lubang & Lowland Alluvial Trail',
    '{"lat": 3.815, "lng": 113.780, "bufferKm": 4.5}',
    '{"lat": 3.81488, "lng": 113.77968, "accuracyMeters": 4.2}',
    '{"leaves": "Alternate, elliptic to oblong-elliptic, 15-30 cm long, coriaceous with prominent veins.", "bark": "Dark reddish-brown to almost black, shallowly fissured and peeling in thin strips.", "flowers": "Small yellowish-green blossoms in axillary panicles.", "fruit": "Large solitary drupe, 8-15 cm long, enclosed in a hard woody endocarp."}',
    ARRAY['Over-harvesting for high-durability construction', 'Extremely slow natural regeneration rate', 'Habitat clearing'],
    '[{"url": "https://images.unsplash.com/photo-1542273917363-3b1817f69a2d?auto=format&fit=crop&w=1200&q=80", "caption": "Trunk buttress and dense canopy of mature Belian specimen", "credit": "Sarawak Forestry Corporation Archive", "isPrimary": true}]'::jsonb,
    'NNP-3F2A9C'
),
(
    'nepenthes-ampullaria',
    'nepenthes-ampullaria',
    'Nepenthes ampullaria',
    'Jack',
    'Nepenthaceae',
    'Nepenthes',
    'ampullaria',
    ARRAY['Pitcher plant', 'Periuk kera', 'Periuk Kera Bergigi'],
    'LC',
    TRUE,
    'A pitcher plant whose round pitchers sit in clusters on the forest floor.',
    'Most pitcher plants hang their pitchers from vines, but this one makes most of them at ground level, in tight clusters that can carpet the forest floor. The small lid stays folded back, so the pitchers catch falling leaves as well as insects.',
    'Shady, wet places such as peat swamp forest and heath forest (kerangas).',
    'In parts of Borneo the pitchers of this and other Nepenthes are used as small pots for cooking rice.',
    'A unique detritivorous carnivorous plant forming dense rosettes of urceolate pitchers on the forest floor, relying partly on digesting falling leaf litter.',
    'Carnivorous Climber / Terrestrial Rosette',
    'Climber up to 15m; ground rosettes 20cm',
    'Madai / Great Cave Approach Trail Gullies',
    '{"lat": 3.817, "lng": 113.775, "bufferKm": 4.0}',
    '{"lat": 3.81655, "lng": 113.77514, "accuracyMeters": 5.8}',
    '{"leaves": "Spatulate to lanceolate, 15-25 cm long, sessile with winged petiole.", "bark": "Herbaceous vine maturing into a wiry, flexible stem.", "flowers": "Small reddish-brown flowers arranged in dense racemes up to 40 cm long.", "fruit": "Capsule containing numerous light, wind-dispersed filiform seeds."}',
    ARRAY['Wild collection by horticultural poachers', 'Peat swamp drainage', 'Understory microclimate alteration'],
    '[{"url": "https://images.unsplash.com/photo-1518531933037-91b2f5f229cc?auto=format&fit=crop&w=1200&q=80", "caption": "Ground rosette cluster of Nepenthes ampullaria pitchers in Niah understory", "credit": "SFC Field Research Unit", "isPrimary": true}]'::jsonb,
    'NNP-8C41E7'
),
(
    'koompassia-excelsa',
    'koompassia-excelsa',
    'Koompassia excelsa',
    '(Becc.) Taub.',
    'Fabaceae',
    'Koompassia',
    'excelsa',
    ARRAY['Tapang', 'Menggris', 'Tualang'],
    'LC',
    TRUE,
    'One of the tallest trees in the world, famous for the wild honey bees in its crown.',
    'Tapang is the tallest rainforest tree in tropical Asia, sometimes growing past 80 metres. Giant honey bees hang their combs from its high branches because the smooth, pale bark keeps sun bears from climbing it. It is protected by law in Sarawak.',
    'Lowland and hill rainforest, especially river valleys and lower slopes.',
    'Protected from logging by Sarawak law. Traditional honey gathering from wild bee colonies.',
    'A majestic emergent legume reaching staggering heights over 80m. Its smooth cylindrical trunk features massive buttresses and supports colonial nesting sites of Apis dorsata.',
    'Giant Emergent Tree',
    '60m - 88m',
    'Kuala Gading River Valley & Limestone Base',
    '{"lat": 3.812, "lng": 113.782, "bufferKm": 5.0}',
    '{"lat": 3.81188, "lng": 113.78203, "accuracyMeters": 3.5}',
    '{"leaves": "Pinnately compound with 7-12 small alternate leaflets, 3-4 cm long.", "bark": "Silvery-grey to pale greenish-white, remarkably smooth without fissures.", "flowers": "Small, cream-colored, fragrant flowers in large terminal panicles.", "fruit": "Oblong, flat, winged pod containing a single seed."}',
    ARRAY['Lightning strikes on exposed emergents', 'Loss of pollination corridors', 'Illegal forest encroachment'],
    '[{"url": "https://images.unsplash.com/photo-1448375240586-882707db888b?auto=format&fit=crop&w=1200&q=80", "caption": "Gigantic buttressed trunk of Koompassia excelsa towering over the Niah canopy", "credit": "Sarawak Forestry Corporation Archive", "isPrimary": true}]'::jsonb,
    'NNP-B17D03'
),
(
    'shorea-macrophylla',
    'shorea-macrophylla',
    'Shorea macrophylla',
    '(de Vriese) P.S.Ashton',
    'Dipterocarpaceae',
    'Shorea',
    'macrophylla',
    ARRAY['Kawang jantong', 'Red meranti', 'Engkabang jantong'],
    'VU',
    FALSE,
    'An engkabang tree whose oil-rich seeds are known as the illipe nut.',
    'Engkabang jantong grows along river banks and blooms during mast fruiting years. Its large, winged seeds produce illipe butter (minyak engkabang), used locally for food and prized in cosmetics. The seeds drop into streams and are carried by water.',
    'River banks and floodplains in lowland rainforest, usually on fertile alluvial silt.',
    'Illipe nut oil (cooking, cosmetics and chocolate), timber (light red meranti).',
    'An ecologically critical riverine dipterocarp that stabilizes riparian banks and yields valuable illipe nuts during irregular mast fruiting cycles.',
    'Riparian Canopy Tree',
    '30m - 45m',
    'Sungai Niah Riparian Corridor',
    '{"lat": 3.818, "lng": 113.778, "bufferKm": 4.0}',
    '{"lat": 3.81820, "lng": 113.77810, "accuracyMeters": 4.0}',
    '{"leaves": "Large, oblong to broadly elliptic, up to 30-50 cm long, coriaceous.", "bark": "Greyish-brown, becoming shallowly fissured with age.", "flowers": "Sweet-scented, creamy petals in axillary panicles.", "fruit": "Large nut surrounded by five elongated wings (three larger wings up to 15 cm long)." }',
    ARRAY['Riverbank clearing and siltation', 'Irregular mast flowering intervals', 'Commercial seed over-harvesting'],
    '[{"url": "https://images.unsplash.com/photo-1473448912268-2022ce9509d8?auto=format&fit=crop&w=1200&q=80", "caption": "Riparian canopy of Shorea macrophylla along the Niah River bank", "credit": "SFC Botany Team", "isPrimary": true}]'::jsonb,
    'NNP-5E9A2C'
),
(
    'dipterocarpus-sarawakensis',
    'dipterocarpus-sarawakensis',
    'Dipterocarpus sarawakensis',
    'Slooten',
    'Dipterocarpaceae',
    'Dipterocarpus',
    'sarawakensis',
    ARRAY['Keruing sarawak', 'Keruing'],
    'EN',
    FALSE,
    'An endangered dipterocarp endemic to Borneo with aromatic wood oil.',
    'A majestic canopy tree producing rich oleoresin (minyak keruing). Native to the mixed dipterocarp forests of northern Borneo, this species has experienced marked population reductions due to historical selective logging.',
    'Lowland and hill mixed dipterocarp forest on sandy clay ridges and limestone transitions.',
    'Aromatic wood resin, heavy timber for construction.',
    'An endangered endemic Bornean timber tree characterized by thick leathery leaves and winged calyx fruits.',
    'Canopy / Emergent Tree',
    '35m - 50m',
    'Bukit Kasut Trail & Limestone Ridge Flank',
    '{"lat": 3.822, "lng": 113.785, "bufferKm": 4.5}',
    '{"lat": 3.82210, "lng": 113.78540, "accuracyMeters": 5.2}',
    '{"leaves": "Broadly ovate to elliptic, 12-22 cm long, with prominent plicate secondary veins.", "bark": "Grey to brown, flaky with distinct lenticels.", "flowers": "Large showy petals in short few-flowered racemes.", "fruit": "Globose nut with two long erect wings up to 12 cm long."}',
    ARRAY['Severe habitat fragmentation', 'Selective logging pressure', 'Slow sapling recruitment'],
    '[{"url": "https://images.unsplash.com/photo-1542273917363-3b1817f69a2d?auto=format&fit=crop&w=1200&q=80", "caption": "Emergent Keruing stand on limestone fringe hill", "credit": "SFC Herbarium Archive", "isPrimary": true}]'::jsonb,
    'NNP-9F8E7D'
),
(
    'paphiopedilum-barbatum',
    'paphiopedilum-barbatum',
    'Paphiopedilum barbatum',
    '(Lindl.) Pfitzer',
    'Orchidaceae',
    'Paphiopedilum',
    'barbatum',
    ARRAY['Slipper orchid', 'Bunga kasut', 'Anggerik kasut'],
    'VU',
    TRUE,
    'A terrestrial orchid with a distinctive slipper-shaped pouch growing in damp limestone moss.',
    'This terrestrial orchid grows in leaf litter and mossy crevices on shaded limestone boulders around Niah. Its distinctive pouch acts as a temporary trap for insect pollinators.',
    'Humid limestone crevices, shaded mossy boulders and alluvial leaf litter.',
    'Ornamental orchid strictly protected from commercial extraction by Sarawak Ordinance.',
    'A high-value endangered lady slipper orchid endemic to shaded karst understories, protected under CITES Appendix I and Sarawak wildlife laws.',
    'Terrestrial Karst Herb',
    '15cm - 30cm',
    'Great Cave Entrance Crevices & Mossy Limestone',
    '{"lat": 3.816, "lng": 113.784, "bufferKm": 3.5}',
    '{"lat": 3.81620, "lng": 113.78410, "accuracyMeters": 4.8}',
    '{"leaves": "Tessellated light and dark green, oblong-elliptic, 10-18 cm long.", "bark": "Herbaceous perennial without woody stem.", "flowers": "Solitary flower on dark purple pubescent scape; dorsal sepal white with purple veins, pouch deep maroon.", "fruit": "Cylindrical capsule bearing millions of microscopic seeds."}',
    ARRAY['Illegal extraction by commercial orchid poachers', 'Microclimate changes from trail opening', 'Karst disturbance'],
    '[{"url": "https://images.unsplash.com/photo-1525310072745-f49212b5ac6d?auto=format&fit=crop&w=1200&q=80", "caption": "Paphiopedilum barbatum flowering in karst limestone moss crevice", "credit": "Sarawak Forestry Corporation", "isPrimary": true}]'::jsonb,
    'NNP-2A1B0C'
)
ON CONFLICT (id) DO UPDATE SET
    scientific_name = EXCLUDED.scientific_name,
    common_names = EXCLUDED.common_names,
    iucn_code = EXCLUDED.iucn_code,
    sarawak_protected = EXCLUDED.sarawak_protected,
    summary = EXCLUDED.summary,
    about = EXCLUDED.about,
    photos = EXCLUDED.photos;

-- ------------------------------------------------------------------------------
-- 2. Seed Initial Field Records (Matches mobile mock-records.ts & web records.ts)
-- ------------------------------------------------------------------------------
INSERT INTO public.records (
    id, species_slug, height_m, condition, photo_count, photo_urls, gps, notes, recorded_by, recorded_at, status
) VALUES
(
    '3f2a9c4e-8b1d-4c6a-9e2f-7a1b5c3d9e01'::uuid,
    'eusideroxylon-zwageri',
    18.5,
    'healthy',
    2,
    ARRAY['https://images.unsplash.com/photo-1542273917363-3b1817f69a2d?auto=format&fit=crop&w=800&q=80'],
    '{"lat": 3.81488, "lng": 113.77968, "accuracyM": 6}'::jsonb,
    'Mature healthy tree beside main boardwalk, trunk buttress fully intact.',
    'daniel',
    '2026-10-02T10:24:00Z',
    'published'
),
(
    '8c41e7b2-5d3f-4a9e-b6c1-2e8f4a7d1c02'::uuid,
    'nepenthes-ampullaria',
    0.4,
    'healthy',
    3,
    ARRAY['https://images.unsplash.com/photo-1518531933037-91b2f5f229cc?auto=format&fit=crop&w=800&q=80'],
    '{"lat": 3.81655, "lng": 113.77514, "accuracyM": 12}'::jsonb,
    'Ground rosette cluster in peat hollow, ~14 active pitchers holding fluid.',
    'mira',
    '2026-10-01T14:05:00Z',
    'published'
),
(
    'b17d03f9-2c6e-4f8a-a3d5-9e1c7b4f2a03'::uuid,
    'koompassia-excelsa',
    52.0,
    'healthy',
    1,
    ARRAY['https://images.unsplash.com/photo-1448375240586-882707db888b?auto=format&fit=crop&w=800&q=80'],
    '{"lat": 3.81188, "lng": 113.78203, "accuracyM": 9}'::jsonb,
    'Colossal emergent specimen, multiple wild bee combs visible in upper branches.',
    'daniel',
    '2026-10-01T09:40:00Z',
    'published'
),
(
    '5e9a2c71-7f4b-4d2e-8c9a-3b6d1e5f7a04'::uuid,
    'shorea-macrophylla',
    24.0,
    'healthy',
    2,
    ARRAY['https://images.unsplash.com/photo-1473448912268-2022ce9509d8?auto=format&fit=crop&w=800&q=80'],
    '{"lat": 3.81820, "lng": 113.77810, "accuracyM": 7}'::jsonb,
    'Riverbank stabilizer specimen, healthy foliage canopy.',
    'daniel',
    '2026-09-28T11:15:00Z',
    'published'
),
(
    '9f8e7d6c-5b4a-3a2b-1c0d-9e8f7a6b5c05'::uuid,
    'dipterocarpus-sarawakensis',
    38.0,
    'healthy',
    1,
    ARRAY['https://images.unsplash.com/photo-1542273917363-3b1817f69a2d?auto=format&fit=crop&w=800&q=80'],
    '{"lat": 3.82210, "lng": 113.78540, "accuracyM": 8}'::jsonb,
    'Limestone slope ridge specimen, resin exudate noted at base.',
    'mira',
    '2026-09-27T16:30:00Z',
    'published'
),
(
    '2a1b0c9d-8e7f-6a5b-4c3d-2e1f0a9b8c06'::uuid,
    'paphiopedilum-barbatum',
    0.25,
    'healthy',
    4,
    ARRAY['https://images.unsplash.com/photo-1525310072745-f49212b5ac6d?auto=format&fit=crop&w=800&q=80'],
    '{"lat": 3.81620, "lng": 113.78410, "accuracyM": 5}'::jsonb,
    'High conservation priority karst orchid, single flower open in shaded niche.',
    'mira',
    '2026-09-26T15:20:00Z',
    'published'
)
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 3. Seed IoT Sensor Nodes
-- Three sample field nodes, named and placed by zone only. They have no readings: those come from
-- an edge device through edge-com (016_1 to 025), which also sets status and last_heartbeat from
-- them. An admin links each node to its edge device on the Devices page. Running this again leaves
-- nodes that are already there as they are.
-- ------------------------------------------------------------------------------
INSERT INTO public.iot_nodes (node_id, name, zone, status, last_heartbeat) VALUES
('NNP-IOT-01', 'Boardwalk West Sensor Node', 'Pangkalan Lubang Boardwalk', 'online', NULL),
('NNP-IOT-02', 'Great Cave Trail Sensor Node', 'Great Cave Path (Gully 3)', 'online', NULL),
('NNP-IOT-03', 'Bukit Kasut Ridge Node', 'Bukit Kasut Limestone Ridge', 'online', NULL)
ON CONFLICT (node_id) DO NOTHING;
