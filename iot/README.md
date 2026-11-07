# IoT plant protection

ESP32 field nodes send their readings over the region's Wi-Fi to an edge device (an Ubuntu VM) in each forest region, which keeps them in SQLite and uploads them to Supabase through the `edge-com` function. Supabase stores them and decides the alerts, and officers see the result on the dashboard's Sensors page.

[`Field_Node_Edge-to-Cloud_Setup_Guide.md`](Field_Node_Edge-to-Cloud_Setup_Guide.md) has the wiring, the setup, the message formats, testing and troubleshooting.

| Folder | What it is |
| --- | --- |
| `sensor-node/` | Tier 1, the field node. `sensor-node.ino` reads the sensors and sends to the edge over MQTT. Copy `secrets.example.h` to `secrets.h` and fill it in. |
| `edge-device/` | Tier 2, one for each forest region. `thing-com.py` takes the nodes' readings into SQLite, `cloud-com.py` uploads them to Supabase, `install-edge.sh` sets it all up, and `tools/fake-thing.py` plays a node. |
| `testing/` | Sketches for trying one part at a time, and `testing/notes.md` on each part. |

The Supabase side is in `supabase/`: the sensor files `016_1` to `017` and `022` to `025`, and the function in `supabase/functions/edge-com/index.ts`. `supabase/README.md` says how to run them.

Tokens and passwords only go in `sensor-node/secrets.h` and the edge's `secrets.toml`. Never in a commit, a chat, a screenshot or a doc.
