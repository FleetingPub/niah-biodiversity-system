/*
  Sensor node (tier 1)
  Board    : ESP32 Dev Module
  Core     : esp32 by Espressif Systems 3.3.12
  Libraries: DHT sensor library, Adafruit Unified Sensor, PubSubClient, ArduinoJson
  Serial   : 115200 baud
  Message  : WiFi / MQTT / binary frame

  Reads its sensors and sends a reading to the region's edge device (Mosquitto on the edge VM)
  once a minute, and straight away when something changes. The edge passes it on to Supabase.
  The node only decides when to send. What counts as a threat is decided on the server.
  Readings taken while the edge can't be reached are kept in RAM (the last 30) and sent in
  order once it is back. It has no GPS; its position is set by hand in secrets.h.
  Nothing is kept across a restart: the beep starts on and the ultrasonic baseline is
  measured again at every power-up.

  Settings (router WiFi, node ID, edge address, node secret and position) are in secrets.h,
  next to this file.

  Sends straight away (at most once every 5 s) when one of these starts:
    PIR motion                      animal / person near the node
    ultrasonic shift > 10 cm        node moved, fell or is obstructed  (holds for 3 checks, 1 s apart)
    ultrasonic echo lost            sensor blocked, tilted or out of range  (holds for 3 checks)
    soil >= 85 %                    saturated soil, flash-flood risk  (checked every 10 s)
    rain >= 60 %                    heavy rain  (checked every 10 s)
  Each fires once when the condition starts, not again until it has cleared.

  Topics (field/<node_id>/...)
    telemetry  node -> edge   binary frame below, QoS 0
    status     node -> edge   {"online":true|false,"boot_id":n}, retained; false is the last will
    info       node -> edge   {"boot_id":n,"lat":..,"lon":..}, retained, once per power-up
    cmd        edge -> node   {"id":"..","cmd":"beep_on" | "beep_off" | "reset_baseline"}
    ack        node -> edge   {"id","cmd","ok","detail","beep_on","baseline_cm"}

  Binary frame (little-endian, must match FRAME in iot/edge-device/edge_db.py):
    offset size field     encoding
      0     4   seq       uint32 counter since power-up
      4     4   ts        uint32 Unix seconds UTC, 0 = clock not set yet
      8     2   temp      int16  0.1 C,   -32768 = DHT11 read failed
     10     1   hum       uint8  %RH,     255 = DHT11 read failed
     11     2   soil_raw  uint16 ADC 0-4095
     13     2   rain_raw  uint16 ADC 0-4095
     15     2   dist      uint16 mm,      65535 = no echo
     17     2   baseline  uint16 mm,      65535 = not set
     19     1   rssi      int8   dBm,     0 = WiFi not connected
     20     1   flags     bit 0 = beep on, bit 1 = PIR motion since the previous
                          reading, other bits 0

  Applications
    DHT11      -> air temperature and humidity
    Soil probe -> flash flooding (saturated soil) / soil drying (erosion risk)
    Rain pad   -> rain detection
    HC-SR04    -> node status (if the node dropped or moved)
    PIR        -> movement near the node (animal / person)
    Buzzer     -> asset tracking (beeps every 5 s so the node can be found)

  Wiring (expansion board header: G = GND, V = supply, S = signal)
    Device        Pin        Board header
    DHT11         +          D21 (V)       voltage jumper on 3.3 V
                  OUT        D21 (S)
                  -          D21 (G)
    Soil probe    AO         VP/36 (S)
                  VCC        D17 (S)       switched: powered only while sampling
                  GND        VP/36 (G)
    Rain pad      AO         VN/39 (S)
                  VCC        D19 (S)       switched: powered only while sampling
                  GND        VN/39 (G)
    HC-SR04       VCC        5V pin
                  Trig       D5 (S)
                  Echo       D16 (S)       (recommended: via 1k/2k divider)
                  GND        D16 (G)
    Buzzer        +          D23 (S)
                  -          D23 (G)
    PIR HC-SR501  VCC        5V pin        (needs 4.5-20 V; output is 3.3 V, safe for the ESP32)
                  OUT        D27 (S)       jumper on H (repeat trigger), time pot fully left (~3 s)
                  GND        D27 (G)
*/

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <math.h>
#include <time.h>

#include "secrets.h"

const char*    TOPIC_PREFIX = "field";
const uint16_t MQTT_PORT    = 1883;
const char*    MQTT_USER    = "thing";   // same user for every node; NODE_SECRET is its password

// pin map
#define DHT_PIN        21
#define SOIL_AO_PIN    36   // VP, ADC1
#define SOIL_PWR_PIN   17
#define RAIN_AO_PIN    39   // VN, ADC1
#define RAIN_PWR_PIN   19
#define US_TRIG_PIN     5
#define US_ECHO_PIN    16
#define BUZZER_PIN     23
#define PIR_PIN        27

// timing
const uint32_t REPORT_MS         = 60000;  // a routine reading every minute
const uint32_t ALERT_GAP_MS      = 5000;   // the soonest an event can send another reading
const uint32_t DISTANCE_CHECK_MS = 1000;   // pulseIn can block ~30 ms, so not every loop
const uint32_t PROBE_CHECK_MS    = 10000;  // soil and rain probes, powered only while read
const uint32_t MQTT_RETRY_MS     = 5000;
const uint32_t BEEP_MS           = 5000;   // asset-tracking beep every 5 s (when enabled)
const uint16_t BEEP_HZ           = 2000;
const uint16_t BEEP_LEN_MS       = 150;
const uint32_t PIR_WARMUP_MS     = 60000;  // ignore the PIR while it settles after power-up

// Calibration (tune)
const int SOIL_DRY_RAW = 4095;
const int SOIL_WET_RAW = 1400;
const int RAIN_DRY_RAW = 4095;
const int RAIN_WET_RAW = 1500;

// Thresholds. The node uses these to decide when to send and for the printout. They match the
// starting values on the server, but the server's numbers are the ones that raise alerts.
const int SOIL_FLOOD_PCT = 85;  // at or above: saturated -> flash-flood risk   (sends now)
const int SOIL_DRY_PCT   = 20;  // at or below: drying -> erosion risk         (printout only)
const int RAIN_LIGHT_PCT = 20;  //                                             (printout only)
const int RAIN_HEAVY_PCT = 60;  //                                             (sends now)
const int PROBE_HYST_PCT = 5;   // must drop this far below a threshold before it can fire again

// Ultrasonic
const float    US_MOVE_CM = 10.0;          // change from the baseline that counts as moved
const uint8_t  US_CONFIRM = 3;             // checks in a row before a change counts
const unsigned long US_TIMEOUT = 30000;    // ~5 m round trip max

// Binary frame
const size_t   FRAME_LEN = 21;
const int16_t  TEMP_NONE = INT16_MIN;
const uint8_t  HUM_NONE  = 0xFF;
const uint16_t DIST_NONE = 0xFFFF;

// Readings held while the edge can't be reached
const uint8_t HELD_MAX       = 30;         // 30 x 1 min = ~30 min of readings, ~1 kB of RAM
const uint8_t FLUSH_PER_LOOP = 10;

enum UsState : uint8_t { US_OK, US_MOVED, US_LOST };

// globals
DHT dht(DHT_PIN, DHT11);
WiFiClient net;
PubSubClient mqtt(net);

uint32_t bootId = 0, seq = 0;
uint32_t lastReport = 0, lastAlertSend = 0, lastDistanceCheck = 0, lastProbeCheck = 0;
uint32_t lastBeep = 0, lastMqttTry = 0;
float usBaseline = -1;                // cm, -1 = not set
bool beepOn = true;
bool wifiWasUp = false;
bool statusSent = false;              // the edge knows our boot_id on this connection
bool infoSent = false;                // position sent for this power-up
IPAddress edgeIp;
bool edgeIpKnown = false;
char topicTelemetry[64], topicStatus[64], topicCmd[64], topicAck[64], topicInfo[64];
char recentCmds[8][40];               // ids of the last commands, to ignore repeats
uint8_t recentIdx = 0;

// events
volatile bool pirEdge = false;        // set by the PIR interrupt on each rising edge
bool pirReady = false;                // warm-up over
bool sawMotion = false;               // motion since the previous reading
UsState usState = US_OK, usCandidate = US_OK;
uint8_t usCount = 0;
bool soilWasWet = false, rainWasHeavy = false;
bool sendWanted = false;
char sendReason[64] = "";

// held readings: packed frames in a ring buffer, oldest at heldHead
uint8_t  heldFrame[HELD_MAX][FRAME_LEN];
uint32_t heldTakenMs[HELD_MAX];       // millis() when taken, to work out ts if the clock was set later
uint8_t  heldHead = 0, heldCount = 0;
uint32_t droppedTotal = 0;            // oldest readings pushed out while the buffer was full
bool backlog = false;                 // readings had to wait; report when they are all out

void IRAM_ATTR onPir() { pirEdge = true; }

// Asks for a reading straight away, with the reason shown in the printout
void requestSend(const char* why) {
  Serial.printf("Event    : %s\n", why);
  sendWanted = true;
  if (strstr(sendReason, why)) return;
  if (sendReason[0]) strlcat(sendReason, ", ", sizeof(sendReason));
  strlcat(sendReason, why, sizeof(sendReason));
}

// ---------------------------------------------------------------- sensors
// Power a probe, wait for it to settle, average 16 ADC readings, power it off.
int readSwitchedSensor(uint8_t pwrPin, uint8_t aoPin) {
  digitalWrite(pwrPin, HIGH);
  delay(50);
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) sum += analogRead(aoPin);
  digitalWrite(pwrPin, LOW);
  return sum / 16;
}

int rawToPercent(int raw, int dryRaw, int wetRaw) {
  return constrain(map(raw, dryRaw, wetRaw, 0, 100), 0, 100);
}

float readDistanceCm() {
  digitalWrite(US_TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(US_TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(US_TRIG_PIN, LOW);
  unsigned long us = pulseIn(US_ECHO_PIN, HIGH, US_TIMEOUT);
  if (us == 0) return -1;            // no echo
  return us * 0.0343f / 2.0f;
}

uint16_t cmToMm(float cm) {
  if (cm < 0) return DIST_NONE;
  long mm = lroundf(cm * 10.0f);
  return (uint16_t)constrain(mm, 0L, 65534L);
}

bool clockSet() { return time(nullptr) > 1704067200; }   // after 2024-01-01

// The first good reading after power-up, or after reset_baseline, becomes the reference.
void takeBaselineIfUnset(float cm) {
  if (cm < 0 || usBaseline >= 0) return;
  usBaseline = cmToMm(cm) / 10.0f;
  Serial.printf("Distance : new baseline %.1f cm\n", usBaseline);
}

// ---------------------------------------------------------------- event checks
void checkPir() {
  if (!pirReady) {
    if (millis() < PIR_WARMUP_MS) { pirEdge = false; return; }
    pirReady = true;
    pirEdge = false;
    Serial.println("PIR      : warmed up");
  }
  if (pirEdge) {
    pirEdge = false;
    sawMotion = true;
    requestSend("motion");
  }
}

void checkDistance() {
  float cm = readDistanceCm();
  UsState seen = US_LOST;
  if (cm >= 0) {
    takeBaselineIfUnset(cm);
    seen = fabsf(cm - usBaseline) > US_MOVE_CM ? US_MOVED : US_OK;
  }
  // A change only counts once it has held for US_CONFIRM checks in a row
  if (seen == usCandidate) { if (usCount < US_CONFIRM) usCount++; }
  else { usCandidate = seen; usCount = 1; }

  if (usCount >= US_CONFIRM && usCandidate != usState) {
    usState = usCandidate;
    if (usState == US_MOVED)     requestSend("node moved");
    else if (usState == US_LOST) requestSend("echo lost");
    else Serial.println("Event    : distance back to normal");
  }
}

void checkProbes() {
  int soilPct = rawToPercent(readSwitchedSensor(SOIL_PWR_PIN, SOIL_AO_PIN), SOIL_DRY_RAW, SOIL_WET_RAW);
  int rainPct = rawToPercent(readSwitchedSensor(RAIN_PWR_PIN, RAIN_AO_PIN), RAIN_DRY_RAW, RAIN_WET_RAW);
  bool soilWet   = soilPct >= SOIL_FLOOD_PCT - (soilWasWet   ? PROBE_HYST_PCT : 0);
  bool rainHeavy = rainPct >= RAIN_HEAVY_PCT - (rainWasHeavy ? PROBE_HYST_PCT : 0);
  if (soilWet && !soilWasWet)     requestSend("soil saturated");
  if (rainHeavy && !rainWasHeavy) requestSend("heavy rain");
  soilWasWet = soilWet;
  rainWasHeavy = rainHeavy;
}

// ---------------------------------------------------------------- binary out
void put16(uint8_t* p, uint16_t v) { p[0] = v & 0xFF; p[1] = v >> 8; }
void put32(uint8_t* p, uint32_t v) { p[0] = v & 0xFF; p[1] = (v >> 8) & 0xFF; p[2] = (v >> 16) & 0xFF; p[3] = v >> 24; }

uint32_t get32(const uint8_t* p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

// Every reading goes into the buffer first, so readings always leave in order.
void holdFrame(const uint8_t* frame) {
  if (heldCount == HELD_MAX) {         // full: the oldest makes room
    heldHead = (heldHead + 1) % HELD_MAX;
    heldCount--;
    droppedTotal++;
  }
  uint8_t slot = (heldHead + heldCount) % HELD_MAX;
  memcpy(heldFrame[slot], frame, FRAME_LEN);
  heldTakenMs[slot] = millis();
  heldCount++;
}

// Sends held readings, oldest first, while the edge is reachable.
void flushHeld() {
  if (!statusSent || !mqtt.connected()) return;
  for (uint8_t sent = 0; heldCount && sent < FLUSH_PER_LOOP; sent++) {
    uint8_t* frame = heldFrame[heldHead];
    if (get32(frame + 4) == 0 && clockSet())   // taken before NTP answered: work out when it was taken
      put32(frame + 4, (uint32_t)time(nullptr) - (millis() - heldTakenMs[heldHead]) / 1000);
    if (!mqtt.publish(topicTelemetry, frame, FRAME_LEN, false)) return;
    heldHead = (heldHead + 1) % HELD_MAX;
    heldCount--;
  }
}

// ---------------------------------------------------------------- one reading
void sampleAll(const char* why) {
  seq++;
  uint32_t ts   = clockSet() ? (uint32_t)time(nullptr) : 0;   // 0 = unknown, the edge then uses its own clock
  int8_t   rssi = (WiFi.status() == WL_CONNECTED) ? (int8_t)WiFi.RSSI() : 0;
  uint8_t  flags = beepOn ? 1 : 0;

  // PIR: movement at any moment since the previous reading (the interrupt catches short
  // pulses between readings; the pin level covers a pulse still going on)
  bool motion = pirReady && (sawMotion || digitalRead(PIR_PIN) == HIGH);
  sawMotion = false;
  if (motion) flags |= 2;

  Serial.printf("\n---- #%lu (t = %lu s, %s) ----\n", (unsigned long)seq, (unsigned long)(millis() / 1000), why);

  // DHT11: temperature and humidity
  int16_t temp10 = TEMP_NONE;
  uint8_t humPct = HUM_NONE;
  float hum = dht.readHumidity();
  float temp = dht.readTemperature();
  if (isnan(hum) || isnan(temp)) {
    Serial.println("Temp/Hum : read FAILED (check DHT11 wiring)");
  } else {
    temp10 = (int16_t)constrain(lroundf(temp * 10.0f), -400L, 850L);
    humPct = (uint8_t)constrain(lroundf(hum), 0L, 100L);
    Serial.printf("Temp/Hum : %.1f C   %u %%RH\n", temp10 / 10.0f, humPct);
  }

  // Soil moisture: flooding / drying
  uint16_t soilRaw = readSwitchedSensor(SOIL_PWR_PIN, SOIL_AO_PIN);
  int soilPct = rawToPercent(soilRaw, SOIL_DRY_RAW, SOIL_WET_RAW);
  Serial.printf("Soil     : raw %4u -> %3d %%   [%s]\n", soilRaw, soilPct,
                soilPct >= SOIL_FLOOD_PCT ? "SATURATED" : soilPct <= SOIL_DRY_PCT ? "DRY" : "NORMAL");

  // Rain
  uint16_t rainRaw = readSwitchedSensor(RAIN_PWR_PIN, RAIN_AO_PIN);
  int rainPct = rawToPercent(rainRaw, RAIN_DRY_RAW, RAIN_WET_RAW);
  Serial.printf("Rain     : raw %4u -> %3d %%   [%s]\n", rainRaw, rainPct,
                rainPct >= RAIN_HEAVY_PCT ? "HEAVY" : rainPct >= RAIN_LIGHT_PCT ? "RAIN" : "NONE");

  // Ultrasonic: node status (to 1 mm, the resolution of the frame)
  float cm = readDistanceCm();
  takeBaselineIfUnset(cm);
  uint16_t distMm = cmToMm(cm);
  if (distMm == DIST_NONE) {
    Serial.println("Distance : no echo   [CHECK NODE - sensor blocked, tilted or out of range]");
  } else {
    long deltaMm = (long)distMm - (long)cmToMm(usBaseline);
    bool moved = labs(deltaMm) > lroundf(US_MOVE_CM * 10.0f);
    Serial.printf("Distance : %.1f cm  (baseline %.1f, change %+.1f)   [%s]\n",
                  distMm / 10.0f, usBaseline, deltaMm / 10.0f, moved ? "NODE MOVED / OBSTRUCTED" : "NODE OK");
  }
  uint16_t baseMm = cmToMm(usBaseline);

  Serial.printf("Motion   : %s\n", !pirReady ? "PIR warming up" : motion ? "MOVEMENT DETECTED" : "none");

  // Pack the frame (layout in the header above)
  uint8_t frame[FRAME_LEN];
  put32(frame + 0, seq);
  put32(frame + 4, ts);
  put16(frame + 8, (uint16_t)temp10);
  frame[10] = humPct;
  put16(frame + 11, soilRaw);
  put16(frame + 13, rainRaw);
  put16(frame + 15, distMm);
  put16(frame + 17, baseMm);
  frame[19] = (uint8_t)rssi;
  frame[20] = flags;

  holdFrame(frame);
  flushHeld();
  if (heldCount == 0) {
    Serial.println("MQTT     : sent");
  } else {
    backlog = true;
    if (statusSent && mqtt.connected())
      Serial.printf("MQTT     : sending held readings, %u left\n", heldCount);
    else
      Serial.printf("MQTT     : edge not reachable, reading held (%u waiting%s)\n", heldCount,
                    heldCount == HELD_MAX ? ", full: the oldest are being dropped" : "");
  }
}

// ---------------------------------------------------------------- commands in
bool seenBefore(const char* id) {
  for (auto& r : recentCmds) if (strcmp(r, id) == 0) return true;
  strlcpy(recentCmds[recentIdx], id, sizeof(recentCmds[0]));
  recentIdx = (recentIdx + 1) % 8;
  return false;
}

void sendAck(const char* id, const char* cmd, bool ok, const char* detail) {
  JsonDocument doc;
  doc["id"] = id;
  doc["cmd"] = cmd;
  doc["ok"] = ok;
  doc["detail"] = detail;
  doc["beep_on"] = beepOn;
  if (usBaseline < 0) doc["baseline_cm"] = nullptr; else doc["baseline_cm"] = serialized(String(usBaseline, 1));
  char out[256];
  size_t n = serializeJson(doc, out, sizeof(out));
  mqtt.publish(topicAck, (const uint8_t*)out, n, false);
}

void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) {
    Serial.println("Command  : not valid JSON, ignored");
    return;
  }
  char id[40], cmd[24];                // copy out before publishing (shared buffer)
  strlcpy(id, doc["id"] | "", sizeof(id));
  strlcpy(cmd, doc["cmd"] | "", sizeof(cmd));
  if (id[0] == 0) return;

  if (seenBefore(id)) {                // the edge resent it: just confirm again
    sendAck(id, cmd, true, "repeat, already done");
    return;
  }
  Serial.printf("Command  : %s (%.8s)\n", cmd, id);
  if (strcmp(cmd, "beep_on") == 0) {
    beepOn = true;
    lastBeep = millis() - BEEP_MS;     // beep straight away
    sendAck(id, cmd, true, "beep enabled");
  } else if (strcmp(cmd, "beep_off") == 0) {
    beepOn = false;
    noTone(BUZZER_PIN);
    sendAck(id, cmd, true, "beep disabled");
  } else if (strcmp(cmd, "reset_baseline") == 0) {
    usBaseline = -1;
    usState = usCandidate = US_OK;     // start the moved / lost checks fresh
    usCount = 0;
    sendAck(id, cmd, true, "baseline cleared, next good reading becomes the reference");
  } else {
    sendAck(id, cmd, false, "unknown command");
  }
}

// ---------------------------------------------------------------- network
void handleWifi() {
  bool up = WiFi.status() == WL_CONNECTED;
  if (up && !wifiWasUp) {
    Serial.printf("WiFi     : connected to %s, IP %s, RSSI %d dBm\n", WIFI_SSID, WiFi.localIP().toString().c_str(), WiFi.RSSI());
    edgeIpKnown = false;
  } else if (!up && wifiWasUp) {
    Serial.println("WiFi     : disconnected, reconnecting...");
  }
  wifiWasUp = up;
}

bool resolveEdge() {
  if (edgeIpKnown) return true;
  IPAddress ip;
  String host = EDGE_HOST;
  if (ip.fromString(host)) {
    edgeIp = ip;
  } else if (!WiFi.hostByName(EDGE_HOST, edgeIp)) {
    Serial.printf("MQTT     : cannot resolve %s\n", EDGE_HOST);
    return false;
  }
  edgeIpKnown = true;
  Serial.printf("MQTT     : edge %s is %s\n", EDGE_HOST, edgeIp.toString().c_str());
  return true;
}

void ensureMqtt() {
  if (!mqtt.connected()) statusSent = false;
  if (mqtt.connected() || WiFi.status() != WL_CONNECTED) return;
  if (millis() - lastMqttTry < MQTT_RETRY_MS) return;   // readings continue meanwhile
  lastMqttTry = millis();
  if (!resolveEdge()) return;

  mqtt.setServer(edgeIp, MQTT_PORT);
  char clientId[48], will[64], online[64];
  snprintf(clientId, sizeof(clientId), "thing-%s", NODE_ID);
  snprintf(will, sizeof(will), "{\"online\":false,\"boot_id\":%lu}", (unsigned long)bootId);
  if (mqtt.connect(clientId, MQTT_USER, NODE_SECRET, topicStatus, 1, true, will)) {
    // The edge takes the boot_id for every following frame from this message, so
    // telemetry waits until it is out (sent in order on the same connection).
    snprintf(online, sizeof(online), "{\"online\":true,\"boot_id\":%lu}", (unsigned long)bootId);
    if (!mqtt.publish(topicStatus, online, true)) {
      Serial.println("MQTT     : could not send the status message, reconnecting");
      mqtt.disconnect();
      return;
    }
    statusSent = true;
    if (!infoSent) {                   // once per power-up: where this node is
      char info[128], lat[16] = "null", lon[16] = "null";
      if (!isnan(NODE_LAT)) snprintf(lat, sizeof(lat), "%.6f", NODE_LAT);
      if (!isnan(NODE_LON)) snprintf(lon, sizeof(lon), "%.6f", NODE_LON);
      snprintf(info, sizeof(info), "{\"boot_id\":%lu,\"lat\":%s,\"lon\":%s}", (unsigned long)bootId, lat, lon);
      infoSent = mqtt.publish(topicInfo, info, true);
    }
    mqtt.subscribe(topicCmd, 1);
    Serial.printf("MQTT     : connected to %s:%u as %s\n", edgeIp.toString().c_str(), MQTT_PORT, MQTT_USER);
  } else {
    // -2 = edge not reachable (VM off / wrong IP / port 1883 blocked), 4 = wrong user or password, 5 = not authorised
    Serial.printf("MQTT     : connect failed (state %d), retrying in 5 s\n", mqtt.state());
    edgeIpKnown = false;               // look the address up again next time
  }
}

// ---------------------------------------------------------------- setup / loop
void setup() {
  Serial.begin(115200);

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);      // 0 - ~3.1 V input range

  pinMode(SOIL_PWR_PIN, OUTPUT);  digitalWrite(SOIL_PWR_PIN, LOW);
  pinMode(RAIN_PWR_PIN, OUTPUT);  digitalWrite(RAIN_PWR_PIN, LOW);
  pinMode(US_TRIG_PIN, OUTPUT);   digitalWrite(US_TRIG_PIN, LOW);
  pinMode(US_ECHO_PIN, INPUT);
  pinMode(PIR_PIN, INPUT_PULLDOWN);    // pull-down: an unplugged PIR reads "no motion"
  attachInterrupt(digitalPinToInterrupt(PIR_PIN), onPir, RISING);

  snprintf(topicTelemetry, sizeof(topicTelemetry), "%s/%s/telemetry", TOPIC_PREFIX, NODE_ID);
  snprintf(topicStatus, sizeof(topicStatus), "%s/%s/status", TOPIC_PREFIX, NODE_ID);
  snprintf(topicCmd, sizeof(topicCmd), "%s/%s/cmd", TOPIC_PREFIX, NODE_ID);
  snprintf(topicAck, sizeof(topicAck), "%s/%s/ack", TOPIC_PREFIX, NODE_ID);
  snprintf(topicInfo, sizeof(topicInfo), "%s/%s/info", TOPIC_PREFIX, NODE_ID);
  memset(recentCmds, 0, sizeof(recentCmds));

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  bootId = esp_random();               // new random id every power-up (radio on = true random)
  configTime(0, 0, "pool.ntp.org", "time.google.com");   // UTC; the edge converts for display

  mqtt.setBufferSize(256);             // a frame, a command or the info message
  mqtt.setKeepAlive(30);
  mqtt.setSocketTimeout(5);
  mqtt.setCallback(onMqttMessage);

  dht.begin();
  delay(2000);  // DHT11 needs ~1-2 s after power-up

  Serial.printf("\nESP32 field node %s started (boot_id %lu, beep on, baseline taken from the first good reading)\n",
                NODE_ID, (unsigned long)bootId);
  if (isnan(NODE_LAT) || isnan(NODE_LON)) Serial.println("Position : NODE_LAT / NODE_LON not set, recorded as empty");
  else Serial.printf("Position : %.6f, %.6f\n", NODE_LAT, NODE_LON);
  Serial.printf("PIR      : warming up for %lu s\n", (unsigned long)(PIR_WARMUP_MS / 1000));

  uint32_t now = millis();
  lastReport        = now - REPORT_MS;          // first reading straight away (held until MQTT is up)
  lastAlertSend     = now - ALERT_GAP_MS;
  lastDistanceCheck = now - DISTANCE_CHECK_MS;
  lastProbeCheck    = now - PROBE_CHECK_MS;
  lastBeep          = now - BEEP_MS;
}

void loop() {
  handleWifi();
  ensureMqtt();
  mqtt.loop();

  flushHeld();
  if (backlog && heldCount == 0) {
    backlog = false;
    Serial.print("MQTT     : edge reachable again, held readings sent");
    if (droppedTotal) Serial.printf(" (%lu oldest were dropped while the buffer was full)", (unsigned long)droppedTotal);
    Serial.println();
    droppedTotal = 0;
  }

  uint32_t now = millis();
  checkPir();
  if (now - lastDistanceCheck >= DISTANCE_CHECK_MS) {
    lastDistanceCheck = now;
    checkDistance();
  }
  if (now - lastProbeCheck >= PROBE_CHECK_MS) {
    lastProbeCheck = now;
    checkProbes();
  }

  // An event sends at most every ALERT_GAP_MS; a routine reading that falls due first carries
  // any waiting event with it.
  now = millis();
  bool eventDue   = sendWanted && now - lastAlertSend >= ALERT_GAP_MS;
  bool routineDue = now - lastReport >= REPORT_MS;
  if (eventDue || routineDue) {
    char why[72];
    strlcpy(why, sendWanted ? sendReason : "routine", sizeof(why));
    if (sendWanted) lastAlertSend = now;
    sendWanted = false;
    sendReason[0] = 0;
    lastReport = now;
    sampleAll(why);
  }

  if (beepOn && now - lastBeep >= BEEP_MS) {
    lastBeep = now;
    tone(BUZZER_PIN, BEEP_HZ, BEEP_LEN_MS); // non-blocking short beep
  }
}
