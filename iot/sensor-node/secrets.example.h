// Copy this to secrets.h, which git ignores, and fill it in. Never commit secrets.h.

// The AP router for this forest region
#define WIFI_SSID     "your-router-name"
#define WIFI_PASSWORD "your-router-password"

// This node's ID. It has to be on the Devices page, linked to this region's edge device.
#define NODE_ID "NNP-IOT-01"

// Where the edge device's MQTT broker listens: its IP, or its name + ".local". Give it a fixed
// address on the router, so this doesn't change.
#define EDGE_HOST "192.168.1.50"

// Has to match the password of the "thing" MQTT user on this region's edge device. Make up a long
// random string for each region. This isn't the device token. Nodes never get that.
#define NODE_SECRET "make-up-a-long-random-string"

// Where this node is installed, decimal degrees WGS84 (e.g. from a phone's map app). Sent once
// after every power-up. Leave NAN if unknown: it is recorded as empty.
#define NODE_LAT NAN   // e.g.   1.553300  (north +, south -)
#define NODE_LON NAN   // e.g. 110.359200  (east +, west -)
