/* Fictional filesystem: the Varda Icefield Resurvey, autumn 2026 ("Day 41").
 * Consumed by the overhaul mock engine as window.TX_FS.expedition.
 * "Today" in the fiction is Wednesday 18 November 2026.
 * Day N = Monday 10 August 2026 + (N - 1). The laptop clock is UTC; camp time is UTC+2.
 * Everyone came home well. Nothing here is dangerous; the only secret is a good one.
 */
(function () {
  "use strict";
  var TX = (window.TX_FS = window.TX_FS || {});

  /* ---------------- helpers ---------------- */
  var ASSETS = "../peel-mock/assets/";
  function body(s) { return s.replace(/^\n/, "").replace(/\n$/, ""); }
  function D(name, date, kids) { return { name: name, kind: "dir", date: date, kids: kids }; }
  function T(name, date, text) { return { name: name, kind: "file", date: date, text: body(text) }; }
  function B(name, date, size, type) { var n = { name: name, kind: "file", date: date, size: size }; if (type) n.type = type; return n; }
  function IMG(name, date, file, px, size) { return { name: name, kind: "file", date: date, src: ASSETS + file, px: px, size: size }; }
  function JS(name, date, obj) { return { name: name, kind: "file", date: date, text: JSON.stringify(obj, null, 2) }; }
  function G(kids) { return kids; }   // a group of siblings, spliced into its parent folder
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function rng(seed) { var s = seed >>> 0; return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

  /* ---------------- calendar (single source of truth) ---------------- */
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  function dd(n) { return new Date(Date.UTC(2026, 7, 9 + n)); }          // Day 1 = Mon 10 Aug 2026
  function iso(n) { return dd(n).toISOString().slice(0, 10); }
  function at(n, hm) { return iso(n) + "T" + hm + ":00"; }                 // UTC, as the laptop sees it
  function longDay(n) { var d = dd(n); return DAYS[d.getUTCDay()] + " " + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()]; }
  function shortDay(n) { var d = dd(n); return DAYS[d.getUTCDay()].slice(0, 3) + " " + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()].slice(0, 3); }
  function dn(n) { return pad(n); }
  var FLY_OUT = 60;          // Thu 8 Oct
  var SIDE_TRIP = [39, 40];  // Thu 17 and Fri 18 Sep: nobody at camp

  /* ---------------- weather at camp, 0600Z ---------------- */
  var WX = [null];
  (function () {
    var r = rng(4117), dirs = ["W", "NW", "W", "SW", "N", "NE", "W", "NW"], skies = ["clear", "high cloud", "overcast", "fog early", "snow showers", "clear", "broken cloud"];
    for (var d = 1; d <= FLY_OUT; d++) {
      var t = Math.round(-2 - d * 0.17 + (r() * 4 - 2));
      WX.push({ t: t, dir: dirs[Math.floor(r() * dirs.length)], kmh: 5 + Math.floor(r() * 25), hpa: 998 + Math.floor(r() * 18), sky: skies[Math.floor(r() * skies.length)] });
    }
    WX[39] = { t: -6, dir: "W", kmh: 8, hpa: 1016, sky: "clear" };         // the side trip had the best two days of the season
    WX[40] = { t: -7, dir: "calm", kmh: 0, hpa: 1018, sky: "clear; mist in the east" };
    WX[44] = { t: -9, dir: "NW", kmh: 22, hpa: 1004, sky: "snow showers" };
  })();
  function weatherCsv() {
    var out = ["day,date,time_utc,temp_c,wind_dir,wind_kmh,pressure_hpa,sky,observer"];
    for (var d = 1; d <= FLY_OUT; d++) {
      var w = WX[d], obs = SIDE_TRIP.indexOf(d) >= 0 ? "(nobody at camp: AWS only)" : (d % 2 ? "TH" : "JR");
      out.push([d, iso(d), "06:00", w.t, w.dir, w.kmh, w.hpa, w.sky, obs].join(","));
    }
    return out.join("\n");
  }

  /* ---------------- stores (tenths of a person-day / litre) ---------------- */
  var FOOD0 = 2500, FUEL0 = 1250, RESUPPLY_DAY = 45, RES_FOOD = 1000, RES_FUEL = 400;
  var STOCK = [{ food: FOOD0, fuel: FUEL0 }];
  function issued(d) {
    if (d === 38) return { food: 50 + 100, fuel: 25 + 40, drawn: "side trip: 10.0 pd + 4.0 L to sledge packs (AM)" };
    if (SIDE_TRIP.indexOf(d) >= 0) return { food: 0, fuel: 0, drawn: "" };
    return { food: 50, fuel: 25, drawn: "" };
  }
  (function () {
    var f = FOOD0, u = FUEL0;
    for (var d = 1; d <= FLY_OUT; d++) {
      var x = issued(d); f -= x.food; u -= x.fuel;
      if (d === RESUPPLY_DAY) { f += RES_FOOD; u += RES_FUEL; }
      STOCK.push({ food: f, fuel: u });
    }
  })();
  function t1(x) { return (x / 10).toFixed(1); }
  function food(d) { return t1(STOCK[d].food); }
  function fuel(d) { return t1(STOCK[d].fuel); }
  var COUNT_NOTES = {
    1: "flew in; first count in the food tent", 10: "backup to SD card tonight (JR)", 12: "Ansel ate a whole cheese. Logged as 1.0 pd (generously)",
    22: "oatcakes recount: correct (Tamsin)", 30: "cocoa now rationed by Ruth: the one person nobody argues with",
    38: "two days drawn for the side trip. Not on the ration plan. Ask Ansel. (Ansel: 'side trip')",
    39: "nobody at camp", 40: "nobody at camp", 41: "back. Everyone very quiet and very cheerful",
    44: "one extra tin of peaches unaccounted for. Birthday. Do not ask (MC)", 45: "flight in 11:40 local: 100 pd + 40 L + two crates of oranges",
    60: "flight out. Leftovers to the Lund hut store"
  };
  function countCsv(upTo) {
    var out = ["day,date,pax,food_pd_end,fuel_L_end,issued_pd,issued_L,drawn_other,counted_by,note"];
    for (var d = 1; d <= upTo; d++) {
      var x = issued(d), away = SIDE_TRIP.indexOf(d) >= 0;
      var by = away ? "-" : d <= 20 ? "JR" : d % 3 === 0 ? "MC" : d % 3 === 1 ? "JR" : "TH";
      out.push([d, iso(d), 5, away ? "" : food(d), away ? "" : fuel(d), t1(x.food), t1(x.fuel), x.drawn, by, COUNT_NOTES[d] || ""].join(","));
    }
    return out.join("\n");
  }
  function rationPlanCsv(live) {
    var out = ["from_day,to_day,pd_per_day,L_per_day,source,note",
      "1,44,5.0,2.5,camp stores,1.0 ration: one bag per person per day",
      "45,45,+100.0,+40.0,flight,resupply (Sorli Air from Lund)",
      "45,60,5.0,2.5,camp stores,1.0 ration",
      "60,60,0,0,-,flight out; leftovers to the Lund hut store"];
    if (live) out.splice(2, 0, "38,38,10.0,4.0,camp stores,drawn for side trip D39-40 (AM). Destination: see route");
    return out.join("\n");
  }

  /* ---------------- the dawn caller: UNK-7 detections at Cairn 19 ---------------- */
  // Recorder deployed Day 20, recovered Day 58. Detections of the unknown call per dawn.
  var UNK = { 26: 1, 27: 0, 28: 2, 29: 3, 30: 2, 31: 4, 32: 5, 33: 3, 34: 6, 35: 7, 36: 9, 37: 8, 38: 11, 39: 12, 40: 27, 41: 14, 42: 13, 43: 12, 44: 9, 45: 10, 46: 8, 47: 7, 48: 6, 49: 6, 50: 4, 51: 3, 52: 3, 53: 2, 54: 1, 55: 1, 56: 0, 57: 0 };
  var KEY_DET = { 26: [3, 52], 31: [4, 36], 34: [4, 12], 40: [4, 2] };   // the files Jonas kept
  function unkTotal(a, b) { var s = 0; for (var d = a; d <= b; d++) s += UNK[d] || 0; return s; }
  function detectorLog() {
    var r = rng(1962), out = [];
    function L(d, h, m, s, txt) { out.push(iso(d) + "T" + pad(h) + ":" + pad(m) + ":" + pad(s) + "Z C19 " + txt); }
    out.push("# acoudet 0.9 (J. Reiter) - two-channel recorder at Cairn 19, east line. Times UTC. Camp is UTC+2.");
    out.push("# classes: WIND ICE GUY SNOW-BUNTING RAVEN UNK-n. lib_best = closest match in the reference library (score 0-1).");
    for (var d = 20; d <= 58; d++) {
      if (d === 20) L(d, 13, 40, 2, "deploy: mast 2.1 m, guy-lines x3, mics N/E, gain 32 dB. NOTE JR: icequakes and wind, that's the job.");
      for (var hs = 3; hs <= 21; hs += 3) L(d, hs, 0, 0, "status ok batt=" + (12.8 - (d - 20) * 0.02 - (hs % 6) * 0.01).toFixed(2) + "V disk=" + (31 + (d - 20) * 1.4).toFixed(1) + "GB");
      L(d, 0, 0, 1, "rollover " + iso(d) + "_0000_C19.wav batt=" + (12.9 - (d - 20) * 0.02).toFixed(2) + "V temp=" + (WX[d].t - 2) + "C");
      var n = 2 + Math.floor(r() * 3);
      for (var i = 0; i < n; i++) L(d, Math.floor(r() * 24), Math.floor(r() * 60), Math.floor(r() * 60), "det=ICE conf=0." + (60 + Math.floor(r() * 39)) + " dur=" + (0.2 + r()).toFixed(1) + "s note=crack");
      var w = 2 + Math.floor(r() * 3);
      for (i = 0; i < w; i++) L(d, Math.floor(r() * 24), Math.floor(r() * 60), Math.floor(r() * 60), "det=WIND conf=0." + (70 + Math.floor(r() * 29)) + " dur=" + (3 + Math.floor(r() * 40)) + "s");
      if (d < 30 && r() < 0.8) L(d, 2 + Math.floor(r() * 4), Math.floor(r() * 60), 7, "det=GUY conf=0.8" + Math.floor(r() * 9) + " f0=" + (180 + Math.floor(r() * 30)) + "Hz note=guy-line hum");
      if (d < 36 && r() < 0.4) L(d, 9 + Math.floor(r() * 6), Math.floor(r() * 60), 30, "det=SNOW-BUNTING conf=0.9" + Math.floor(r() * 9) + " note=passage");
      if (r() < 0.25) L(d, 11 + Math.floor(r() * 4), Math.floor(r() * 60), 12, "det=RAVEN conf=0.9" + Math.floor(r() * 9) + " note=the camp raven again");
      var k = UNK[d] || 0;
      for (i = 0; i < k; i++) {
        var mm = 50 + i * Math.max(1, Math.floor(60 / (k + 1))) + Math.floor(r() * 3);
        var hh = 3 + Math.floor(mm / 60); mm = mm % 60;
        if (i === 0 && KEY_DET[d]) { hh = KEY_DET[d][0]; mm = KEY_DET[d][1]; }
        L(d, hh, mm, Math.floor(r() * 60), "det=UNK-7 conf=0.9" + Math.floor(r() * 9) + " f0=" + (395 + Math.floor(r() * 30)) + "Hz dur=" + (2.1 + r()).toFixed(1) + "s bearing=" + (94 + Math.floor(r() * 6)) + " lib_best=Grus grus 0.4" + Math.floor(r() * 3) + " | Cygnus cygnus 0.1" + Math.floor(r() * 9));
      }
      if (d === 26) L(d, 7, 2, 0, "NOTE JR: first UNK-7. Two notes, rising. Probably the NE guy-line singing in the dawn wind. Will check.");
      if (d === 30) L(d, 14, 10, 0, "NOTE JR: removed all three guy-lines; mast now on rock bolts. If UNK-7 continues, it is not the guy-lines.");
      if (d === 31) L(d, 6, 30, 0, "NOTE JR: it continues. Four, and no guy-lines. Not GUY. Not wind (flat calm at 0400Z). Not in the library.");
      if (d === 34) L(d, 6, 12, 0, "NOTE JR: library has 2,300 northern calls. Best match every time is common crane at 0.4, which in this library means 'no'.");
      if (d === 37) L(d, 6, 40, 0, "NOTE JR: second mic gives a bearing: 094-099 every time. From the east, below the rim. There is nothing east of the rim. Officially.");
      if (d === 40) L(d, 6, 1, 0, "NOTE JR (entered D41): twenty-seven at dawn on Day 40. We were not here to hear them here. We were there.");
      if (d === 41) L(d, 21, 15, 0, "NOTE JR: as agreed tonight, UNK-7 is Item C in everything from now on. Say no more.");
      if (d === 58) L(d, 10, 5, 0, "recover: mast down, recorder to camp. NOTE JR: " + unkTotal(26, 57) + " UNK-7 detections in total. Thank you, Cairn 19.");
    }
    var head = out.slice(0, 2), rest = out.slice(2).sort();
    return head.concat(rest).join("\n");
  }
  function unkTable() {
    var out = [];
    for (var d = 26; d <= 45; d++) out.push("| D" + dn(d) + " | " + shortDay(d) + " | " + pad(UNK[d] || 0) + " |" + (d === 30 ? " guy-lines off" : d === 40 ? " we were away. it wasn't." : d === 41 ? " now Item C" : ""));
    return out.join("\n");
  }

  /* ---------------- Tamsin's thermistor string, east line ---------------- */
  // T1-T6 behave. T7 (at Cairn 19, 10 m) reads warm from the day it went in. T8 is the control at C17.
  function iceTempCsv() {
    var r = rng(77), out = ["day,date,T1_C17_5m,T2_C17_10m,T3_C18_5m,T4_C18_10m,T5_C19_5m,T6_C19_7m,T7_C19_10m,T8_control,flag"];
    for (var d = 21; d <= FLY_OUT; d++) {
      var base = -6.2 - (d - 21) * 0.01, v = [];
      for (var i = 0; i < 6; i++) v.push((base + i * 0.12 + (r() - 0.5) * 0.1).toFixed(2));
      var t7 = (0.6 + (d - 21) * 0.008 + (r() - 0.5) * 0.06).toFixed(2);
      var flag = d < 29 ? "T7 FAULT?" : d < 36 ? "T7 FAULT? (swapped T7/T3 D29: warm stays at C19)" : d < 41 ? "T7 OK (ice-bath D36)" : "ITEM_A";
      out.push([d, iso(d)].concat(v, [t7, (base - 0.3).toFixed(2), flag]).join(","));
    }
    return out.join("\n");
  }

  /* ================= /etc, /usr, /var ================= */
  var etc = D("etc", at(41, "21:02"), [
    T("motd", "2026-08-08T19:30:00", `
  VARDA ICEFIELD RESURVEY 2026  -  field laptop "varde"
  Rugged, refurbished, veteran of two expeditions and one bath.

  - The clock is UTC. The radio is UTC. Camp is UTC+2. Write Z after your times.
  - One account, one home: /home/varda. Your folder is your name. Shared work in
    expedition/. Sandvik's 1962 papers in 1962/. Everything else: ask Jonas.
  - Back up to the SD card. Every tenth day. I will remind you. (JR)
  - If the screen goes dark it is the cold, not you. Put it inside your jacket.
  - Card game ledger: expedition/team. Disputes to Ruth. Ruth's ruling is final.

  73 de JR
`),
    T("hostname", "2026-07-30T10:00:00", "varde"),
    T("timezone", "2026-07-30T10:00:00", "Etc/UTC"),
    T("hosts", "2026-07-30T10:00:00", `
127.0.0.1   localhost
127.0.1.1   varde
# no network on the ice. the radio is the network. (JR)
`),
    T("passwd", "2026-08-01T12:00:00", `
root:x:0:0:root:/root:/bin/bash
varda:x:1000:1000:Varda Icefield Resurvey 2026 (all five of us):/home/varda:/bin/bash
# one account for five people. a folder each. Jonas: "it's a field laptop, not a bank."
`),
    T("fstab", "2026-08-01T12:00:00", `
# <device>       <mount>         <type>  <options>
/dev/nvme0n1p2   /               ext4    defaults,noatime          0 1
/dev/mmcblk0p1   /media/sdcard   exfat   defaults,nofail,uid=1000  0 0
# the grey backup drive comes and goes as it pleases (JR)
`),
    T("os-release", "2026-07-30T10:00:00", `
NAME="Varde Linux"
PRETTY_NAME="Varde Linux 26.04 (Cairn)"
ID=varde
VERSION_CODENAME=cairn
HOME_URL="nowhere near a network"
`)
  ]);

  var usr = D("usr", "2026-08-02T11:00:00", [
    D("games", at(52, "21:40"), [
      B("cairn-solitaire", "2026-07-29T16:00:00", "184 KB", "app"),
      T("cairn-solitaire.scores", at(52, "21:40"), `
CAIRN SOLITAIRE - HIGH SCORES (build all 19 cairns before the light goes)

 1. TH   19/19   04:11   "two decimal places of time, please"
 2. JR   19/19   04:38
 3. AM   19/19   06:02   (claims a bug ate Cairn 7)
 4. MC   17/19   --:--   "stopped to look at the view"
 5. RO   19/19   09:55   "I was not in a hurry"
 6. ES   12/19   --:--   1962 mode. Cook complained. Game over.
`),
      B("fortune", "2026-07-29T16:00:00", "38 KB", "app"),
      T("varda.fortunes", at(48, "20:10"), `
The cairn you are looking for is behind you.
%
"It's not a fault, it's a feature." - not Tamsin
%
Menu B is not a band. (MC)
%
There is always more porridge. There is never more cocoa.
%
A theodolite is just a very patient telescope.
%
"Write Z." - JR, daily
%
Today you will find a 1962 cairn exactly where the 1962 map says. Enjoy it. It will not happen again.
%
The wind in the guy-lines is only the wind in the guy-lines. Probably.
%
Ruth's ruling is final.
%
Two decimal places or it didn't happen.
%
Somewhere east of here, someone is having a lovely morning.
%
Sandvik was right about the cook. Sandvik was wrong about almost everything else.
%
You will eat a peach in a tent and it will be the best peach of your life.
%
Do not lick the stake.
%
The raven is not your friend. The raven is everybody's friend.
%
Your snoring has been recorded and ranked.
%
If you have to ask what Item C is, you were not there.
%
Mist is just a cloud that came to visit.
%
Never trust a map with a sea monster on it. Always trust the person who drew it.
%
Day 41 is a good day to keep a secret.
%
A cook who is complained about every day is a cook who is fed every day.
%
"N.H. 096" is not a typo.
%
There are two kinds of glaciologist: those who check twice, and Tamsin, who checks three times.
%
Kari at Lund says 73. You have converted a whole radio station.
%
The best camera is the one with its lens cap in your pocket.
%
Somebody in 1962 was right. Somebody is always right in 1962. It just takes a while.
`)
    ])
  ]);

  var varDir = D("var", at(FLY_OUT, "07:00"), [
    D("log", at(FLY_OUT, "07:00"), [
      T("syslog", at(FLY_OUT, "07:00"), `
${iso(1)}T07:12:44Z varde kernel: Linux varde 6.8.0-varde (cold boot, -4 C)
${iso(1)}T07:13:02Z varde systemd[1]: Started acoustic detector (acoudet).
${iso(10)}T20:31:10Z varde kernel: mmc0: new SD card at address 0001 (/media/sdcard)
${iso(10)}T20:58:41Z varde rsync[2211]: backup-day-10 complete (JR)
${iso(18)}T03:01:09Z varde kernel: battery critical (cold). suspend.
${iso(18)}T06:44:20Z varde kernel: resume. someone put me inside their jacket. thank you.
${iso(38)}T19:40:02Z varde systemd-logind: user varda: session closed
${iso(38)}T19:41:15Z varde systemd[1]: Reached target sleep (nobody at camp until Day 40; AWS and acoudet keep running)
${iso(40)}T21:12:55Z varde kernel: resume
${iso(41)}T20:14:30Z varde kernel: mmc0: new SD card at address 0001 (/media/sdcard)
${iso(41)}T20:22:03Z varde rsync[3480]: copy to /media/sdcard/.cal complete (JR, for MC)
${iso(41)}T23:58:11Z varde systemd-logind: user varda: 5 people typing at once on one keyboard. A busy evening.
${iso(FLY_OUT)}T06:58:40Z varde systemd[1]: Powering off. (flight out)
2026-10-21T09:02:12Z varde kernel: Linux varde 6.8.0-varde (warm boot, +21 C, an office)
2026-11-16T15:40:03Z varde systemd-logind: user varda: session opened (Ansel)
2026-11-16T16:22:47Z varde systemd-logind: user varda: session closed
`),
      D("acoustic", at(58, "10:05"), [
        T("README", at(20, "13:50"), `
acoudet: the acoustic detector at Cairn 19 (J. Reiter)

The recorder at Cairn 19 listens for icequakes (Tamsin's request) and wind.
It classifies what it hears and writes one line per event to detector-C19.log.
Audio itself is in /home/varda/jonas/acoustics/recorder-C19, one file per detection
worth keeping. The laptop cannot play them. Neither, frankly, can I, out here.

Classes: WIND, ICE, GUY (a guy-line humming), SNOW-BUNTING, RAVEN, and UNK-n
for anything it cannot place. lib_best is the nearest call in my reference
library, scored 0 to 1. Below 0.6 means "not this".

grep is your friend:  grep -c UNK-7 detector-C19.log
`),
        T("detector-C19.log", at(58, "10:05"), detectorLog())
      ])
    ])
  ]);

  /* ================= /srv/expedition (shared) ================= */
  var ROUTE_BASE = `
# Route and work plan, Varda Icefield Resurvey 2026

Camp: Cairn 11 (1962), on the plateau. Flown in Day 1, flown out Day 60.

## The line
- Sandvik's 1962 survey line runs from Cairn 1 at the Lund glacier snout (west) up onto the plateau and east to Cairn 19 at the east rim.
- We re-find and re-measure Cairns 8 to 19 from camp. Cairns 1 to 7 by flight on the way out if the weather is kind.
- Cairn 19 is the end of the line. Nothing east of it is ours to survey: the rim drops away into cloud.

## Work blocks
- Days 1-19: west plateau. Cairns 8 to 13. Ablation stakes. Radar lines R1 to R6.
- Days 20-38: east line. Cairns 14 to 19. Thermistor string C17-C19 (TH). Acoustic recorder at Cairn 19 (JR).
- Days 41-58: repeat measurements, both lines. Samples to the register.
- Day 45: resupply flight. Day 60: flight out.
`;
  var ROUTE_LIVE = ROUTE_BASE.replace("- Days 41-58:", "- Days 39-40: side trip. From Cairn 19, 096 degrees, and down. All five. Back by dark on Day 40. (AM, Day 37)\n- Days 41-58:");

  var COMMS = `
# Comms plan

- Sked with Lund base twice a day: 0800Z and 1800Z. Kari Olsen at the Lund end.
- Format: callsign XV9VR, Z times, position, pax, weather, and 73. (JR)
- Radio-mail through the same link for anything longer. Slow. Be brief.
- Sponsor: the Halvorsen Polar Foundation. Progress reports go to Per Halvorsen through Ansel, weekly.
- If we are all away from camp, tell Kari the day before which skeds we will miss. She worries.
`;
  var FLIGHTS = `
FLIGHTS - Sorli Air, Lund (Twin Otter on skis)

Day 1   Mon 10 Aug   in     five of us + 1,410 kg   landed 09:20 local beside Cairn 11
Day 45  Wed 23 Sep   resupply  100 pd food, 40 L fuel, mail     (weather permitting)
Day 60  Thu 8 Oct    out    five of us + samples (cold box) + kit

Pilot: Sorli. Pilot's only request: "Flatten me a runway and don't make me wait."
`;

  function sampleRegister(live) {
    var rows = [
      "id,day,date,site,type,description,collector",
      "VAR-001,2," + iso(2) + ",Cairn 11,ice core,0-2 m firn,TH",
      "VAR-002,3," + iso(3) + ",Cairn 11,ice core,2-4 m,TH",
      "VAR-003,4," + iso(4) + ",Cairn 12,rock,cairn stone (1962 paint flake),AM",
      "VAR-004,5," + iso(5) + ",Cairn 12,snow,surface snow for isotopes,TH",
      "VAR-005,6," + iso(6) + ",Cairn 13,lichen,on cairn stone: crustose,RO",
      "VAR-006,7," + iso(7) + ",Cairn 10,rock,erratic: granite,AM",
      "VAR-007,8," + iso(8) + ",Cairn 9,ice core,0-2 m,TH",
      "VAR-008,9," + iso(9) + ",Cairn 9,insect,wind-blown aphid (a long way from home),RO",
      "VAR-009,10," + iso(10) + ",Cairn 8,water,supraglacial stream,TH"
    ];
    if (!live) return rows.join("\n");
    rows = rows.concat([
      "VAR-010,14," + iso(14) + ",Cairn 13,ice core,0-2 m,TH",
      "VAR-011,21," + iso(21) + ",Cairn 17,ice core,0-2 m,TH",
      "VAR-012,23," + iso(23) + ",Cairn 19,water,melt pond (drains east?),TH",
      "VAR-013,25," + iso(25) + ",Cairn 19,dye,fluorescein trace: east,TH",
      "VAR-014,30," + iso(30) + ",Cairn 19,feather,F-03: long grey primary with rust tip (the neighbours),RO",
      "VAR-015,33," + iso(33) + ",Cairn 19,plaster,track cast T-01 (three toes),RO",
      "VAR-016,35," + iso(35) + ",Cairn 19,rock,rim rock: warm to the hand at dawn,AM",
      "VAR-017,39," + iso(39) + ",east of C19,water,Item A: water,TH",
      "VAR-018,39," + iso(39) + ",east of C19,water,Item A: water (second outlet),TH",
      "VAR-019,39," + iso(39) + ",east of C19,soil,Item A: ground,AM",
      "VAR-020,39," + iso(39) + ",east of C19,rock,Item A: rock with sinter crust,AM",
      "VAR-021,39," + iso(39) + ",east of C19,plant,Item B: needle cluster,MC",
      "VAR-022,39," + iso(39) + ",east of C19,plant,Item B: cone scales,RO",
      "VAR-023,40," + iso(40) + ",east of C19,plant,Item B: bark (fallen branch only),RO",
      "VAR-024,40," + iso(40) + ",east of C19,feather,Item C: moulted contour feather,RO",
      "VAR-025,40," + iso(40) + ",east of C19,feather,Item C: moulted primary,RO",
      "VAR-026,40," + iso(40) + ",east of C19,audio,Item C: dawn chorus (JR recorder 2),JR",
      "VAR-027,43," + iso(43) + ",Cairn 18,ice core,0-2 m,TH",
      "VAR-028,47," + iso(47) + ",Cairn 15,ice core,0-2 m,TH",
      "VAR-030,42," + iso(42) + ",Cairn 19,ice core,0-2 m (repeat of VAR-012 site),TH",
      "VAR-031,43," + iso(43) + ",Cairn 18,ice core,2-4 m,TH",
      "VAR-032,46," + iso(46) + ",Cairn 16,rock,cairn stone: lichen growth since 1962 (photo pair),RO",
      "VAR-033,47," + iso(47) + ",Cairn 15,ice core,0-2 m,TH",
      "VAR-034,48," + iso(48) + ",Cairn 14,snow,surface snow for isotopes,TH",
      "VAR-035,49," + iso(49) + ",Cairn 13,lichen,repeat of VAR-005: 4 mm larger in 64 years,RO",
      "VAR-036,51," + iso(51) + ",Cairn 12,water,supraglacial stream (drains west: normal),TH",
      "VAR-037,52," + iso(52) + ",Cairn 12,rock,repeat of VAR-003 (same flake; still there),AM",
      "VAR-038,53," + iso(53) + ",Cairn 10,ice core,0-2 m,TH",
      "VAR-039,54," + iso(54) + ",Cairn 9,ice core,0-2 m,TH",
      "VAR-040,55," + iso(55) + ",Cairn 8,water,supraglacial stream,TH",
      "VAR-041,56," + iso(56) + ",Cairn 11,snow,surface snow for isotopes,TH",
      "VAR-042,58," + iso(58) + ",Cairn 19,audio,recorder recovered: season file set (JR),JR"
    ]);
    return rows.join("\n");
  }
  function cairnsFound(live) {
    var rows = ["cairn,found_day,date,offset_from_1962_m,height_m,condition,by",
      "Cairn 11,1," + iso(1) + ",3.1,1.8,intact (camp),all",
      "Cairn 12,3," + iso(3) + ",4.6,1.6,intact; paint flake,AM/TH",
      "Cairn 13,5," + iso(5) + ",2.2,1.4,top stones fallen,TH/RO",
      "Cairn 10,7," + iso(7) + ",5.0,1.9,intact,AM/MC",
      "Cairn 9,8," + iso(8) + ",3.8,1.2,half under snow,TH/RO",
      "Cairn 8,10," + iso(10) + ",6.4,1.7,intact,JR/MC"];
    if (live) rows = rows.concat([
      "Cairn 14,20," + iso(20) + ",2.9,1.5,intact,TH/AM",
      "Cairn 15,22," + iso(22) + ",3.3,1.6,intact,TH/JR",
      "Cairn 16,23," + iso(23) + ",4.1,1.3,leaning,AM/MC",
      "Cairn 17,21," + iso(21) + ",1.9,1.8,intact,TH",
      "Cairn 18,24," + iso(24) + ",2.6,1.7,intact,TH/RO",
      "Cairn 19,20," + iso(20) + ",0.8,2.0,intact: three flat stones on top (Holm's mark),TH/JR",
      "Cairn 7,58," + iso(58) + ",7.2,1.1,from the air only,flight",
      "Cairn 1,58," + iso(58) + ",-,-,gone: the snout has retreated 1.9 km since 1962,flight"]);
    return rows.join("\n");
  }
  var STORES_LAYOUT = `
FOOD TENT - who put what where (JR)

  +--------------------------------------------+
  |  BAGS (1 per person per day)   |  FUEL     |
  |  rows A-E, oldest at the door  |  20 L x 6 |
  |--------------------------------|  jerrycans|
  |  BULK: oats, lentils, rice     |           |
  |  milk powder, cocoa (RUTH)     |  STOVES   |
  |--------------------------------+-----------|
  |  TREATS (locked: Ruth has the key)          |
  |  peaches 12 tins, chocolate, one cheese    |
  +--------------------------------------------+
                 door (downwind)

Count every evening, write it in daily-count.csv, initials. Open bags count
as tenths. Do not eat the treats and then count them. You know who you are.
`;
  var BACKUP_NOTE = `
BACKUP, DAY 10 (Wednesday 19 August 2026), 20:58Z.  JR

Copied: ~/expedition/plan, /stores, /survey. Not copied: ~/1962 (it's on
the grey drive and it doesn't change, which is the point of 1962).

Every tenth day, as promised. The card is 128 GB, which sounded like a lot
until Mirela started shooting RAW. Next backups go to the grey drive.

If something on the server and something here disagree, the server is newer.
That doesn't make it right. It makes it newer.
`;

  var SIDE_TRIP_NOTE = `
# Side trip, Days 39-40

Decided round the stove, Day 37. Written up by Ansel because somebody had to.

## Who
- All five. Nobody stays at camp: the AWS and Jonas's recorder can mind themselves.

## Where
- Cairn 19, then 096 degrees and down off the rim. Holm's bearing, from her 1962 sheet.
- Tamsin says 3.8 km and about 430 m of descent, if the warm patch is where her numbers put it.

## Why
- Tamsin: to prove it is an instrument fault. (Her words.)
- Jonas: to stand where the dawn caller is calling from.
- Ruth: the neighbours. She will not say more.
- Mirela: "Plate 14."
- Ansel: the warm corner. Rocks do not lie, and these rocks are warm.

## How
- Two days' rations drawn on Day 38: 10.0 pd, 4.0 L. Two tents. The light stove.
- Back at camp by dark on Day 40. The laptop stays here.
- Kari at Lund told on the Day 38 sked that we miss four skeds. She said "have fun". We intend to.
`;

  var TRACK = `
time_utc,day,waypoint,grid_E,grid_N,elev_m,note
${at(39, "03:31")},39,camp (Cairn 11),5120,7410,1655,left 05:31 local
${at(39, "06:02")},39,Cairn 15,5980,7385,1641,
${at(39, "07:44")},39,Cairn 17,6610,7362,1630,
${at(39, "08:57")},39,Cairn 19,7105,7340,1612,end of the 1962 line. turned 096
${at(39, "09:20")},39,WP-1,7400,7309,1598,rim
${at(39, "10:05")},39,WP-2,7905,7255,1460,steep; snow gone
${at(39, "10:48")},39,WP-3,8410,7203,1322,ground warm through boots
${at(39, "11:30")},39,WP-4,8920,7150,1210,mist
${at(39, "12:15")},39,WP-5,9180,7124,1182,camp E (two tents)
${at(40, "02:58")},40,WP-5,9180,7124,1182,up before dawn. everyone. nobody asked
${at(40, "04:40")},40,WP-6,9255,7090,1176,the shore
${at(40, "09:30")},40,WP-5,9180,7124,1182,packed
${at(40, "14:10")},40,Cairn 19,7105,7340,1612,
${at(40, "18:55")},40,camp (Cairn 11),5120,7410,1655,back 20:55 local. nobody said a word for an hour
`;

  var LEDGER = (function () {
    var r = rng(5), names = ["Ansel", "Ruth", "Tamsin", "Jonas", "Mirela"], tot = [0, 0, 0, 0, 0];
    var notes = { 3: "first game; Tamsin explains the rules for 40 minutes", 9: "Mirela bids 0 on seven cards and makes it", 14: "Jonas claims the deck is cold-damaged",
      17: "DISPUTE: Ansel 'remembered' the trump after it was turned down (JR)", 18: "Ansel: 'I have an excellent memory.' Ruth: 'Not that excellent.' Points stand", 23: "Tamsin: Mirela's 0 bid on 7 cards is 'mathematically insulting'",
      27: "DISPUTE: the Jonas shuffle. Seven riffles exactly. Ruth now shuffles. Ruth's ruling is final", 31: "Ansel deals himself the ace of trumps three hands running. Re-dealt by Ruth",
      35: "Ruth wins. Nobody accuses Ruth of anything", 38: "early night: packing", 39: "(away)", 40: "(away)", 41: "nobody could concentrate. Abandoned after three hands. Everybody grinning",
      44: "birthday rules: Jonas may bid anything and is always right" };
    var out = ["day,date,dealer,Ansel,Ruth,Tamsin,Jonas,Mirela,leader,note"];
    for (var d = 3; d <= 44; d++) {
      if (d === 39 || d === 40) { out.push([d, iso(d), "-", tot[0], tot[1], tot[2], tot[3], tot[4], "-", notes[d]].join(",")); continue; }
      for (var i = 0; i < 5; i++) tot[i] += Math.floor(r() * 9) + (i === 0 && d >= 15 && d <= 31 ? 2 : 0) + (d === 44 && i === 3 ? 25 : 0);
      var best = tot.indexOf(Math.max.apply(null, tot));
      out.push([d, iso(d), names[d % 5], tot[0], tot[1], tot[2], tot[3], tot[4], names[best], notes[d] || ""].join(","));
    }
    return out.join("\n");
  })();

  var SNORING = `
rank,name,peak_dB,median_dB,nights_recorded,character,notes (TH)
1,Ansel,74,61,22,the avalanche,first by a distance; denies all charges
2,Jonas,63,52,22,the kettle,whistles on the in-breath; claims it's the guy-lines
3,Mirela,58,44,22,the commentator,talks in her sleep: "not the lentils" (x4) and "look up" (x2)
4,Tamsin,51,39,22,the metronome,the recording equipment is evidently miscalibrated
5,Ruth,38,31,22,the ledger,silent; possibly not asleep at all; possibly watching us
`;

  var FIRST_MEAL = `
# What I will eat first at home

Written Day 30, when it was all anybody could talk about. Sworn on the theodolite.

## Ansel
- A whole roast chicken, alone, standing up, in the kitchen.
- Then a second, more civilised meal with plates.

## Ruth
- Jollof rice my sister's way, with fried plantain, and nobody counting anything.
- A salad. A real one. With a tomato in it that has never been frozen.

## Tamsin
- Toast. Precisely two slices. Butter to the edges.
- Then, possibly, a third slice. Uncertainty unacceptable; will report.

## Jonas
- Schnitzel the size of the plate, my mother's potato salad, a cold beer, in that order.
- Fresh bread so soft you can't cut it straight.

## Mirela
- Grilled sardines on the harbour wall in Porto, with my fingers.
- Pastel de nata, three. One for each week past Day 40.
`;

  var RECIPES = `
# Recipes, menu A to menu Z

Mirela's, tested on five scientists. All of these work. Some of them work well.

## Week 1: menu A (we were young)
- Lentil dal with fried onion. Lentils 400 g, onion 2, curry powder 2 tbsp, salt. Simmer 25 min at camp altitude (it takes longer up here; be patient).
- Rice with cheese. Do not let Ansel near the cheese.

## Week 2: menu A with ambition
- Porridge with cocoa and milk powder ("mud"). Oats 80 g per person, cocoa 1 tbsp, milk powder 2 tbsp. Better than it sounds.
- Pasta with the sardine tins mashed in, lemon powder, black pepper.

## Week 3: menu A and a half
- Oatcakes on the lid of the big pan. Oats, milk powder, a little oil, water to bind, pressed thin. 4 min a side. Count them (Tamsin will).
- "Soup of the day" (the day is always lentil).

## Week 4: the clever week
- Crumble with no fruit: oats, sugar, butter fried golden, poured over hot custard made from milk powder and the vanilla Ruth was hiding.
- Fried rice with dried egg and the last spring onion, shared in five exact portions.

## Week 5: the inventive week
- Dal pancakes: leftover dal, flour, water, fried. Genuinely good. Jonas asked for the recipe, which is this.
- "Risotto": rice, stock cube, milk powder, the cheese rind Ansel thought he had hidden.

## Week 6: Day 41 week (everyone too happy to care)
- Peaches from the tin, eaten from the tin, outside, at dawn. No recipe. Do it once in your life.
- Birthday cake for Day 44: see Ruth. It is in the medical box.

## Week 6 and a half: the leftovers week
- Lentil "meatballs": cooked lentils mashed with oats, curry powder and an egg's worth of dried egg. Roll, flatten, fry. Six per person. Tamsin counted.
- Porridge risotto: no. We tried. Do not.
- Hot milk powder with a square of chocolate melted in, and a pinch of salt. Bedtime. Ruth's prescription.

## Week 7 onward: menu Z
- Oranges, from the flight. Peel, eat, smell your hands for an hour.
- Orange peel candied in sugar syrup on the stove: twenty minutes, low, stir. Jonas ate the whole batch before it cooled.
- Rice pudding with orange zest. The best thing anybody cooked all season, by unanimous vote, Ansel abstaining (he made it).

## Rules of the cook tent
- The cook does not wash up.
- Whoever complains about the food cooks tomorrow (Sandvik's rule, reversed, in Aas's honour).
- Nobody counts the treats except Ruth.
- Altitude: water boils at about 94 C up here. Everything takes a third longer. Plan for it.
`;

  var LOST = `
# Lost property, Varda 2026

- Tamsin's pencil sharpener. Last seen Day 6. Tamsin has continued to sharpen pencils. Nobody knows how.
- Ansel's second glove (left). Found Day 19 on top of Cairn 12, folded. Nobody admits it.
- One tin of peaches (Day 44). Not lost. Eaten. Birthday. Case closed (RO).
- Jonas's good mood: never lost.
- Mirela's lens cap: lost Day 2, Day 8, Day 15, Day 27, Day 33. Found every time in Mirela's pocket.
- Sandvik's dignity (1962): see the cook's menu, in 1962/misc.
`;

  var ROTA = `
ROTA (cook / count / water / radio)

         cook     count    water    radio
Mon      Mirela   Jonas    Tamsin   Jonas
Tue      Ruth     Tamsin   Ansel    Jonas
Wed      Ansel    Mirela   Jonas    Jonas
Thu      Tamsin   Jonas    Ruth     Jonas
Fri      Jonas    Ruth     Mirela   Jonas
Sat      Mirela   Ansel    Tamsin   Jonas
Sun      everyone cooks something; Ruth judges; nobody wins

Radio is always Jonas. Jonas likes it that way. Nobody else knows the knobs.
`;

  var BIRDS = `
BIRDS RECORDED IN THE VARDA REGION (checklist compiled by R. Okonkwo, Day -20, from the literature)

Plateau and icefield (above 1,400 m):
  snow bunting          regular in passage; the only songbird you will hear up here
  raven                 resident; will steal anything shiny, and then come back for the rest
  rock ptarmigan        edges of nunataks
  gyrfalcon             rare; one record, 1988

Valley floors (below 600 m, west side, Lund):
  common crane          passage only; breeds far to the south, in bogs, never up here
  whooper swan          lakes, summer
  long-tailed duck      lakes
  meadow pipit, wheatear, white wagtail

Breeding birds above 1,000 m in this range, all species, all years: snow bunting, ptarmigan, raven.
Trees above 900 m in this range: none. Not one. (Treeline here is about 450 m.)

Wetlands and coast (Lund fjord, sea level):
  eider, black guillemot, kittiwake, arctic tern, oystercatcher, purple sandpiper

Passage only, recorded over the icefield (high, in flight, autumn):
  pink-footed goose, barnacle goose, whooper swan, common crane (one record, 1997, flying south)

Cranes of any kind breeding in this range: none recorded. Ever.

Nothing else is expected. If you see anything else, write it down exactly and tell me.
Do not guess. Describe: size, colour, legs, bill, call, what it was doing, and where.

HOW TO DESCRIBE A BIRD YOU DO NOT KNOW (R.O., for everyone)
  1. Size: against something you know. "Raven-sized." "Taller than Brekke" is not a unit.
  2. Shape: neck long or short; legs long or short; bill straight, hooked, or dagger.
  3. Colour: the whole bird first, then the edges: wing tips, tail, head.
  4. What it did: walked, hopped, swam, waded, soared, flapped.
  5. Call: write it as you hear it. Count the notes. Say if it rose or fell.
  6. Where: ground, water, air, ice. Time, in Z.
  7. How many.
  8. Then stop. Do not name it. Naming comes later, with evidence.

MAMMALS, for completeness
  arctic fox (tracks on the plateau, twice; never seen)
  stoat (one, at the Lund hut, stealing from the bin)
  humans: five, Day 1 to Day 60, behaving well on the whole
`;

  var expeditionShared = D("expedition", at(58, "17:30"), [
    T("README.md", at(1, "18:30"), `
# expedition

Shared work for the Varda Icefield Resurvey 2026. Everybody can read it all.

## Folders
- plan: the route, the ration plan, the comms plan, the flights.
- stores: the evening count.
- survey: what we found and what we took.
- team: the important things (rota, card ledger, recipes).
- reference: what the books say.
- 1962: Sandvik's expedition, transcribed by Tamsin. The cairns we are re-finding.

## House rules
- Times in Z. Samples labelled per Tamsin's rules or not at all.
- Back up every tenth day. The card is in the radio box.
`),
    D("plan", at(37, "20:44"), [
      T("route.md", at(37, "20:40"), ROUTE_LIVE),
      T("ration-plan.csv", at(37, "20:41"), rationPlanCsv(true)),
      T("comms-plan.md", "2026-08-08T16:00:00", COMMS),
      T("flights.txt", "2026-08-08T16:05:00", FLIGHTS),
      T("side trip - days 39-40.md", at(37, "20:44"), SIDE_TRIP_NOTE)
    ]),
    D("stores", at(FLY_OUT, "06:30"), [
      T("daily-count.csv", at(FLY_OUT, "06:30"), countCsv(FLY_OUT)),
      T("food-tent layout.txt", at(1, "17:00"), STORES_LAYOUT)
    ]),
    D("survey", at(56, "18:20"), [
      T("cairns-found.csv", at(58, "17:30"), cairnsFound(true)),
      T("sample-register.csv", at(56, "18:20"), sampleRegister(true)),
      T("weather.csv", at(FLY_OUT, "06:10"), weatherCsv()),
      T("track - days 39-40.csv", at(41, "22:41"), TRACK)
    ]),
    D("team", at(44, "22:30"), [
      T("oh-hell ledger.csv", at(44, "22:30"), LEDGER),
      T("snoring league.csv", at(33, "08:15"), SNORING),
      T("first meal home.md", at(30, "21:20"), FIRST_MEAL),
      T("recipes - menu A to menu Z.md", at(46, "19:00"), RECIPES),
      T("lost property.md", at(44, "23:10"), LOST),
      T("rota.txt", at(1, "19:00"), ROTA)
    ]),
    D("reference", "2026-07-21T10:00:00", [
      T("birds of the Varda region - checklist.txt", "2026-07-21T10:00:00", BIRDS),
      B("Varda geology 1:250000 (scan).pdf", "2026-07-21T10:05:00", "18.4 MB")
    ])
  ]);

  /* ================= /media/sdcard ================= */
  var sdcard = D("sdcard", at(41, "20:22"), [
    D("backup-day-10", at(10, "20:58"), [
      T("BACKUP-NOTE.txt", at(10, "20:58"), BACKUP_NOTE),
      D("plan", at(10, "20:58"), [
        T("route.md", "2026-08-08T15:50:00", ROUTE_BASE),
        T("ration-plan.csv", "2026-08-08T15:55:00", rationPlanCsv(false)),
        T("comms-plan.md", "2026-08-08T16:00:00", COMMS),
        T("flights.txt", "2026-08-08T16:05:00", FLIGHTS)
      ]),
      D("stores", at(10, "20:58"), [
        T("daily-count.csv", at(10, "20:30"), countCsv(10)),
        T("food-tent layout.txt", at(1, "17:00"), STORES_LAYOUT)
      ]),
      D("survey", at(10, "20:58"), [
        T("cairns-found.csv", at(10, "19:10"), cairnsFound(false)),
        T("sample-register.csv", at(10, "19:12"), sampleRegister(false))
      ])
    ]),
    D(".cal", at(41, "20:22"), [
      IMG("cal-0611.webp", at(40, "04:11"), "alpine-lake.webp", "3000x2000", "8.9 MB"),
      IMG("cal-0626.webp", at(40, "04:26"), "foggy-pines.webp", "3000x2000", "9.4 MB"),
      IMG("cal-1238.webp", at(39, "10:38"), "river-canyon.webp", "3000x2000", "10.1 MB")
    ])
  ]);

  /* ================= setups and the four easter-egg themes ================= */
  var SETUP = {
    ruth: { name: "Field notebook", by: "Dr. Ruth Okonkwo", parts: ["address", "sidebar", "preview", "status"], theme: "solarized-light", layout: "hairline-ledger", icons: "minimal", view: "details", keys: { search: "Ctrl+F" } },
    ansel: { name: "Everything, at once", by: "Ansel Moreau", parts: ["tabs", "address", "sidebar", "miller", "preview", "split", "status"], theme: "horizon", layout: "floating-islands", icons: "material", view: "tiles", keys: { palette: "Ctrl+K", goHome: "Alt+H" } },
    tamsin: { name: "Two decimal places", by: "Tamsin Hale", parts: ["address", "split", "status"], theme: "nord", layout: "compact", icons: "classic", view: "details", keys: { toggleDual: "Ctrl+D", viewDetails: "Alt+1", viewList: "Alt+2" } },
    jonas: { name: "Radio tent", by: "Jonas Reiter", parts: ["address", "terminal", "status"], theme: "hacker", layout: "default", icons: "default", view: "list", keys: { toggleTerminal: "Alt+T", gitGraph: "Alt+G" } },
    mirela: { name: "Contact sheet", by: "Mirela Costa", parts: ["tabs", "sidebar", "preview"], theme: "aurora", layout: "soft-cards", icons: "catppuccin", view: "tiles", keys: { togglePreview: "Alt+P" } }
  };
  function cfg(id, date, themes) {
    return D(".config", date, [D("tauri-explorer", date, [JS(id + ".setup.json", date, SETUP[id])].concat(themes || []))]);
  }

  /* ================= the sealed folder (Cairn 19) ================= */
  var ANNOUNCEMENT = `
# EMBARGOED until Tuesday 1 December 2026, 10:00 CET

Draft 4. 16 November 2026. Sealed. Filed with Cairn 19, where Nora Halloran turned east in 1962, and so did we.

## A warm valley, a stand of pines, and a crane that was painted in 1962 and never believed

On 17 and 18 September 2026 the five members of the Varda Icefield Resurvey walked east from Cairn 19, the last cairn of Eirik Sandvik's 1962 survey line, on a bearing of 096 degrees: 3.8 km, and 430 m down off the rim of the icefield.

Below the rim lies a small valley, about two kilometres long, free of ice all year round. Its floor is warmed from beneath by geothermal ground: rock at 14 to 22 C at the surface, springs at 38 C, a lake that never freezes, and a river that drains east, away from the ice. That is why the meltwater at Cairn 19 runs the wrong way, and why a thermistor ten metres down in the ice there reads above zero.

In the valley, at 1,180 m and some 700 m above the local treeline, grows a stand of about 140 pines, in mist most mornings.

Among them lives a population of cranes: 31 adults and 9 young of the year, on 14 nest platforms. They are tall and grey, with rust-tipped primaries and a two-note dawn call that matches no crane in any sound library. They do not appear to migrate. We believe they are a species new to science.

They were seen once before. On 3 September 1962 the expedition's artist, Nora Halloran, walked east from Cairn 19 alone and came back with wet boots, describing "a green place, with trees, and a grey bird as tall as Brekke". Two days later she painted it in ink, from life, with cold hands. Her leader struck it from the 1963 report as fanciful. Her friend Ingrid Holm, the surveyor, wrote Halloran's bearing in the margin of her Cairn 19 sheet and never rubbed it out: 096, and down. Sixty-four years later, we followed it.

We propose to call the valley Halloransdal, and the bird Halloran's crane, Grus halloranae.

The valley has been protected since 12 November 2026 by order of the county. Its location will not be published, and access is by research permit only. Please do not go looking. They have managed beautifully without us.

## The five
- Ansel Moreau, leader: "I went down to measure some warm rocks. I will be telling this story at dinner for the rest of my life, and for once every word of it will be true."
- Tamsin Hale, glaciology: "It was not an instrument fault. I checked. Twice. To two decimal places."
- Jonas Reiter, acoustics: "I spent two weeks blaming a guy-line. The guy-line would like an apology. So would the cranes."
- Ruth Okonkwo, biology: "I counted them twice, and I am finally allowed to write the number. Forty."
- Mirela Costa, photography: "Nora, we saw them. They are exactly as you painted them, and they looked at us as if we were late."

## Notes for editors
- Scientific paper: submitted. Images: M. Costa. Sound: J. Reiter. Plate 14 reproduced by kind permission of the Holm family and of Siobhan Halloran, Galway.
- Film: "as if we were late", M. Costa, first light on 18 September, 3 minutes. It is in this folder, beside this file. Watch it last.
`;
  var SEALED = [
    T("announcement - embargoed to 1 December.md", "2026-11-16T16:18:00", ANNOUNCEMENT),
    { name: "as if we were late.mp4", kind: "file", type: "video", src: "assets-expedition/the-valley.mp4", poster: "assets-expedition/the-valley-poster.webp", size: "13.6 MB", date: at(40, "04:02"), px: "1920x1080" }
  ];

  /* ================= ~/ruth ================= */
  var HOOK = `
# Day 41. Saturday 19 September. Late.

We agreed it tonight, all five of us, round the stove, with the last of the cocoa.

- Nobody writes the word. Not in a journal, not in a message home, not on the side of a sample bag.
- Nobody writes the place.
- On this laptop it is Item A, Item B and Item C, and nothing more.
- Not until Tamsin's numbers have been checked twice, and Jonas's recordings by somebody who is not Jonas, and the ground has a kind of protection that a press release cannot undo.

I have been a field biologist for twenty-two years. I have never had to sit on my hands like this.

Mirela says somebody in 1962 saw it first and was told she was imagining things. Tamsin says that is not evidence. Tamsin was smiling when she said it, which is new.

I counted them twice. I am not writing the number either.

R.
`;
  function rlog(n, mod, text) { return T("day " + dn(n) + ".md", mod, "# Day " + n + ", " + longDay(n) + "\n\n" + body(text)); }
  var ruth = D("ruth", at(58, "21:00"), [
    G([
      T("medical kit count.csv", at(43, "19:30"), `
item,count,expiry,note
plasters (assorted),142,2028-03,Tamsin uses them as sample labels. Stop it
blister kit (hydrocolloid),23,2027-11,see blisters ranked
paracetamol 500 mg,96,2028-01,
ibuprofen 400 mg,64,2027-09,
sunscreen SPF50,7,2027-06,the snow reflects everything. wear it
lip balm,11,2027-12,Ansel has three. Ansel is not entitled to three
oral rehydration sachets,40,2028-05,
tea lights,4,-,for the cook tent on dark evenings
candle (birthday),1,-,MC. Not medical. Do not issue before Day 44
gauze,30,2029-01,
throat lozenges,58,2027-10,Jonas: 'for the radio voice'
`),
      T("blisters, ranked.csv", at(30, "20:15"), `
rank,name,worst_blister,location,cause,patient_quality
1,Ansel,the size of a 2-euro coin,left heel,new boots (he was warned),complains eloquently
2,Mirela,two,both little toes,kneeling for photographs,does not notice until told
3,Tamsin,one,right heel,refused moleskin on principle,measured it herself to 0.1 mm
4,Jonas,none,-,-,disappointed to have nothing to report
5,Ruth,none,-,doctor heal thyself,not telling
`),
      T("weigh-in, sundays.csv", at(56, "08:10"), `
day,date,Ansel_kg,Ruth_kg,Tamsin_kg,Jonas_kg,Mirela_kg,note
7,${iso(7)},84.2,66.0,58.4,79.5,61.3,baseline-ish
14,${iso(14)},83.1,65.6,58.0,78.6,60.9,
21,${iso(21)},82.4,65.1,57.7,78.0,60.2,
28,${iso(28)},81.9,64.9,57.6,77.4,60.0,
35,${iso(35)},81.3,64.5,57.3,77.0,59.6,
42,${iso(42)},81.6,64.9,57.6,77.3,60.1,everyone up after Days 39-40. Nobody ate more. Happiness?
49,${iso(49)},82.0,65.2,57.9,77.9,60.6,oranges
56,${iso(56)},82.3,65.4,58.1,78.2,60.8,
`),
      T("packing list - fly out day 60.txt", at(58, "21:00"), `
FLY OUT, DAY 60 - Ruth's list

[ ] samples: cold box A (ice), cold box B (everything else: see register)
[ ] cold box B to be opened by NOBODY until the lab. Especially VAR-024 and VAR-025.
[ ] medical kit (return unused to Lund hut store)
[ ] field notebooks x5 (personal; in personal bags)
[ ] the laptop (Jonas's job; dry bag; he will say "73" when it's packed)
[ ] the SD card (Jonas)
[ ] the grey drive (Jonas)
[ ] Tamsin (she will want to measure one more thing)
`)
    ]),
    G([
      D("log", at(44, "22:10"), [
        rlog(1, at(1, "20:40"), `
Flown in. Five well people, one well-stocked medical box, and an icefield the size of a small country.

Ansel's knee: fine. Tamsin's asthma: fine, inhaler in her chest pocket. Jonas: fine, and already in love with the radio. Mirela: fine, and has already lost her lens cap.

My other job, the one I actually came for, is to write down every living thing we see up here. The checklist says that will not take long: snow buntings, ravens, ptarmigan on the nunataks. I have brought the big notebook anyway.
`),
        rlog(7, at(7, "21:00"), `
First weigh-in. Everyone very brave about it except Ansel, who weighed himself three times to get a better number.

Snow buntings at Cairn 10. A raven following the sledge, hoping for cheese. Lichen on Cairn 13: sampled (VAR-005).
`),
        rlog(16, at(16, "20:50"), `
Helped Tamsin read Sandvik's handwriting in the 1962 scans. It is a doctor's handwriting. I am a doctor. It took us an hour to agree that one word was "herring".

The 1962 cook was called Aas. I like him already.
`),
        rlog(30, at(30, "21:10"), `
A feather on the snow 40 m east of Cairn 19, lying where the wind had dropped it. A long grey primary, rust at the tip, 31 cm.

That is too long for a raven, too grey for an eagle, and too big for anything on my checklist above 600 m. Full measurements in F-03 measurements.txt. Sampled as VAR-014.

I am calling whoever dropped it the neighbours until I know better. I am not going to guess. Guessing is how people get things wrong in print.
`),
        rlog(33, at(33, "20:30"), `
Tracks in fresh snow at the rim by Cairn 19. Three forward toes, no hind toe showing, 11.5 cm long, stride 52 cm. Walking, not hopping. They came up from the east, went once round the cairn, and went back down. Plaster cast T-01 (VAR-015).

The neighbours came to look at the cairn. I find that I am very moved by this and I cannot say exactly why.
`),
        rlog(37, at(37, "22:20"), `
Round the stove tonight we put it all on the table. Tamsin: the warm patch is real (her probes passed the ice bath yesterday). Jonas: the dawn caller is real, from the east, below the rim. Ansel: the rock at the rim is warm to the hand. Me: the feather and the tracks.

Then Mirela put a print of an old ink drawing on the table, from the 1962 folder, and nobody said anything for a long time.

We go on Thursday. Two days. I said: we look, we count, we touch nothing we don't have to, and we come back.
`),
        rlog(38, at(38, "19:20"), `
Packed. Ruth's rules for the side trip, agreed by all:
- no shouting
- no running
- no flash
- no closer than 50 m to anything with feathers
- if something looks at you, stand still and let it finish

The laptop stays here. So does this log, until Saturday.
`),
        rlog(41, at(41, "22:05"), `
Nothing for Days 39 and 40: the laptop stayed at camp, and so, frankly, did my handwriting.

As agreed tonight, I will not write the word. Item C, then. I counted Item C twice, once on each morning, with Mirela's long lens and my own eyes, and got the same number both times, which in my experience of counting anything with feathers has never happened before.

The number is in the place I keep the things I cannot help keeping.
`),
        rlog(44, at(44, "22:10"), `
Jonas's birthday. Mirela's cake (ration bars, porridge, cardamom, a tin of peaches I am officially unaware of) came out of my medical box, where it had been hiding behind the gauze for a week. The candle too.

Jonas thought, for a fortnight, that Mirela was plotting something about him. She was.
`)
      ]),
      D("field biology", at(37, "21:40"), [
        T("feathers and tracks - summary.md", at(37, "21:40"), `
# Feathers and tracks, east line (R.O.)

## F-03 (Day 30)
- Primary feather, 31.0 cm, grey, rust tip. 40 m east of Cairn 19.
- Not raven (too long), not eagle (wrong colour, wrong shape), not swan (not white; wrong vane).
- Specimen folder: specimens/F-03.

## T-01 (Day 33)
- Track: three forward toes, no hind toe, 11.5 cm, stride 52 cm. Rim at Cairn 19.
- A tall, long-legged walking bird. On ice. At 1,600 m. In September.

## Working name
- The neighbours. Until I know better.

## What I will not do
- Guess in writing.
`),
        D("specimens", at(33, "20:40"), [
          D("F-03", at(30, "21:30"), [
            T("F-03 measurements.txt", at(30, "21:30"), `
SPECIMEN F-03   (register VAR-014)
Collected: Day 30, ${longDay(30)}, 10:12 local, 40 m east of Cairn 19, on snow.
Collector: R. Okonkwo

Type:            primary (outer wing), moulted naturally (calamus clean, no blood)
Length:          310 mm
Vane width:      42 mm (outer), 61 mm (inner)
Colour:          ash grey; distal 38 mm rust-brown, sharply bordered
Shaft:           pale, stout
Condition:       fresh; this year's moult

Comparison (from the books, and my memory, both imperfect):
  raven primary          ~ 230 mm   black          no
  white-tailed eagle     ~ 400 mm   brown, broad   no
  whooper swan           ~ 300 mm   white          no
  common crane           ~ 300 mm   grey, NO rust  close, and no

Nothing on the regional checklist above 600 m comes near it.
Stored dry, in paper, in cold box B. Do not open it to show people.
`),
            B("F-03_on-snow_scale-bar.raw", at(30, "08:15"), "26.2 MB")
          ]),
          G([
            T("T-01 track cast.txt", at(33, "20:40"), `
CAST T-01   (register VAR-015)   Day 33, rim at Cairn 19. R.O.

   \\   |   /
    \\  |  /       three forward toes, spread about 110 degrees
     \\ | /        no hind toe impression (raised hind toe?)
      \\|/         length 115 mm, width 104 mm
       o          stride 520 mm, walking

Direction: up from the east, once round the cairn (anticlockwise), back east.
`)
          ])
        ])
      ])
    ]),
    D(".not yet", at(41, "22:30"), [
      T("count, day 40 (twice).txt", at(41, "22:30"), `
Item C, count. Not for anyone yet. R.O.

Afternoon of Day 39 (arrival, from the shore):   adults 31, young of the year 9
Morning of Day 40 (first light, from the rise): adults 31, young of the year 9

Nest platforms (old and new, in the reeds at the lake edge): 14.
Forty. Forty of them. Twice.
`),
      T("F-03, drawn.txt", at(41, "22:40"), `
F-03, drawn from memory at 23:00 because I can't sleep

      |
      |\\
      | \\
      |  \\
      |   \\         grey
      |    \\
      |     \\
      |      \\
      |    ###\\      rust
      |   #####\\
      |___######
      |

She drew a better one in 1962. Plate 14. I've seen it now.
`),
      T("names - do not show Tamsin.md", at(43, "21:55"), `
# Names I have thought of and must not say aloud

- The neighbours (mine, used up)
- Halloran's bird (Mirela's, and right)
- Item C (everybody's, and terrible)
- The latecomers ("as if I were late")
- Tamsin will want something with a decimal point in it.
`)
    ]),
    cfg("ruth", "2026-08-02T10:00:00")
  ]);

  /* ================= ~/ansel ================= */
  function alog(n, mod, text) { return T("day " + dn(n) + ".md", mod, "# Day " + n + ". " + longDay(n) + ".\n\n" + body(text)); }
  var ansel = D("ansel", "2026-11-16T16:22:00", [
    D("journal", at(45, "21:30"), [
      alog(1, at(1, "21:15"), `
Flew in this morning. Sandvik stood on this exact plateau in 1962 and complained about herring. I intend to stand on it and complain about nothing at all.

The team are superb. I chose them myself, which is the only thing about this expedition I can take any credit for. Halvorsen's Foundation is paying; the least I can do is make sure they get a good season's measurements and a good story.
`),
        alog(12, at(12, "21:00"), `
Sorted the geology kit. Found three rock hammers. Brought three rock hammers. One for each mood.

Ate a whole cheese. It has been logged in the stores, generously, as one person-day.
`),
        alog(19, at(19, "20:40"), `
Last day on the west plateau block. Every cairn so far within seven metres of Holm's position. She was the best surveyor I have ever read, and nobody outside a basement in the Polar Institute knows her name.
`),
        alog(35, at(35, "20:55"), `
Up at Cairn 19 at dawn with Jonas, who wanted to hear his mystery caller for himself.

We didn't hear it. We saw something else: vapour, rising out of the cloud below the rim, in a straight still column, the way steam rises off a hot bath in a cold room. And the rim rock under my hand was warm. Not "less cold". Warm.

I have started calling it the warm corner, privately. Granite does not do that on its own. Something under there is doing it. Sample VAR-016. I am trying very hard to be a sober scientist about this.
`),
        alog(37, at(37, "23:10"), `
I am now certain the warm corner is geothermal. Warm rim rock, a column of vapour, Tamsin's warm thermistor, meltwater running east off Cairn 19 instead of west to the Lund: there is a heat source below that rim. I'd stake my best hammer on it.

Tamsin, I am told, is still writing that it is an instrument fault. Tamsin passed her own probes in an ice bath yesterday and has not yet forgiven them.

Put the side trip in the route and the ration plan tonight. Days 39-40. All five. 096, Holm's bearing, and down.
`),
        alog(38, at(38, "19:35"), `
Drew two days for the side trip: 10.0 pd, 4.0 L. Told Kari at Lund we will miss four skeds and why: "a short trip east". She said have fun. Packing the small hammer. Two of the three moods will have to stay behind.
`),
        alog(41, at(41, "21:40"), `
Days 39 and 40: not written here. The laptop stayed at camp.

Tonight we agreed: no word, no place, nothing written that a stranger could read and go looking for. Item A is mine to write up. Item B is Mirela's and Ruth's. Item C is everybody's.

I am the leader and it was my idea, and it is still very difficult.

I wrote Per a message last night when we got back, and read it this evening, and deleted it, which was the right thing. Sent him this instead by radio-mail: "Something wonderful. Can't say. Trust me."
`),
        alog(45, at(45, "21:30"), `
Flight in. Oranges. A letter from Per in the mailbag. He trusts me. He has told his board to hold a date in December and to ask no questions, which is the most generous thing anybody has ever done for me.
`)
      ]),
      D("Documents", "2026-11-16T15:58:00", [
        D("geology", at(41, "23:05"), [
          T("warm corner - rock temps.csv", at(41, "23:05"), `
day,date,time_utc,site,depth_cm,temp_C,note
35,${iso(35)},04:10,Cairn 19 rim rock,0,+3.4,warm to the hand. air -9
35,${iso(35)},04:25,Cairn 19 rim rock,5,+4.1,
36,${iso(36)},04:05,Cairn 19 rim rock,0,+3.1,
36,${iso(36)},04:20,Cairn 19 + 20 m E,0,+5.6,
39,${iso(39)},08:40,WP-3 (1322 m),0,+9.8,Item A
39,${iso(39)},10:30,WP-5 (1182 m),0,+14.2,Item A
39,${iso(39)},11:05,WP-5 (1182 m),10,+19.7,Item A
40,${iso(40)},07:10,spring 1,0,+38.0,Item A: water
40,${iso(40)},07:40,spring 2,0,+36.4,Item A: water
40,${iso(40)},08:15,lake margin,0,+11.9,Item A: water; never freezes?
40,${iso(40)},08:30,WP-6 (1176 m),10,+22.0,Item A
`),
          T("notes - sinter.md", at(41, "23:00"), `
# Sinter, Item A (A.M.)

- Rock VAR-020 has a white siliceous crust: sinter. Sinter is what hot water leaves behind when it cools at the surface.
- It does not form from rumour or from instrument faults.
- Heat flow at least an order of magnitude above anything mapped in this range. The 1:250,000 geology sheet shows plain granite here. The 1:250,000 geology sheet has never been east of Cairn 19.
`)
        ]),
        D("sponsor deck", at(9, "22:30"), [
          B("varda_resurvey_sponsor_deck_FINAL_final_v7_USE THIS ONE (2).pdf", "2026-07-02T01:14:00", "48.7 MB"),
          B("varda_resurvey_sponsor_deck_FINAL_final_v6.pdf", "2026-07-01T23:50:00", "48.6 MB"),
          T("talk notes - Halvorsen dinner.txt", "2026-06-20T18:00:00", `
- Thank Per. Then thank Per again.
- 1962: Sandvik, Holm, the cook, the artist. Show the cairn photo. Not the herring.
- "We are going to find nineteen cairns and measure how much ice has gone." (Keep it modest.)
- Do NOT promise discoveries. You always promise discoveries.
`)
        ]),
        T("protection order - granted 12 Nov 2026.txt", "2026-11-13T09:20:00", `
COUNTY GOVERNOR - ENVIRONMENT DEPARTMENT
Decision, 12 November 2026

Area: "Varda E-19" (coordinates held on file; not for publication)
Applicant: A. Moreau, for the Varda Icefield Resurvey and the Halvorsen Polar Foundation

The area is placed under interim protection with immediate effect. Access by
research permit only. No overflights below 1,000 m. No publication of the
location.

The Department thanks the applicants for applying before announcing, which
the Department wishes more people would do.
`)
      ]),
      D("mail", at(45, "15:00"), [
        G([
          T("2026-08-08 Per Halvorsen - good luck.eml", "2026-08-08T17:40:00", `
From: Per Halvorsen <p.halvorsen@halvorsenfoundation.no>
To: Ansel Moreau <moreau@varda.radio>
Subject: Good luck

Ansel,

All five of you, safe home with good numbers: that is all the Foundation asks.
Send me something by radio-mail each week, even if it's only the weather.

Per
`),
          T("2026-09-05 Per Halvorsen - Re progress.eml", at(27, "18:20"), `
From: Per Halvorsen <p.halvorsen@halvorsenfoundation.no>
To: Ansel Moreau <moreau@varda.radio>
Subject: Re: Varda - week 4

Nineteen cairns found or nearly found, ice measured, nobody cross. You have
no idea how rare that last part is.

Per

PS. Kari at Lund says your radio operator signs everything "73". She has started doing it back.
`),
          T("2026-09-23 Per Halvorsen - (by the flight).eml", at(45, "15:00"), `
From: Per Halvorsen <p.halvorsen@halvorsenfoundation.no>
To: Ansel Moreau <moreau@varda.radio>
Subject: (by the flight)

Ansel,

Your radio-mail of the 19th said only: "Something wonderful. Can't say. Trust me."

I trust you. I have asked the board to hold a date in December and to ask me
no questions until then, and for once they have agreed.

Send oranges' worth of news when you can.

Per
`)
        ])
      ]),
      D(".drafts", "2026-11-16T15:58:00", [
        T("to Per - the calm version (send 1 Dec).txt", "2026-11-16T15:50:00", `
Dear Per,

The announcement goes out at ten this morning. You will have read it by now.

You asked no questions for ten weeks. Thank you. It is yours as much as ours;
none of us would have been east of Cairn 19 without you.

Ansel
`),
        T("to Siobhan Halloran, Galway (send 1 Dec).txt", "2026-11-16T15:58:00", `
Dear Ms Halloran,

You do not know me. In 1962 your aunt Nora went on an expedition to the Varda
icefield as its artist, and came back with a painting of a bird that nobody
believed in.

We went and looked. She was right, about all of it.

Ansel Moreau
`)
      ]),
      cfg("ansel", "2026-08-02T10:05:00")
    ]);

  /* ================= ~/tamsin ================= */
  function tlog(n, mod, text) { return T("day " + dn(n) + ".md", mod, "# Day " + n + " (" + shortDay(n) + ")\n\n" + body(text)); }
  var tamsin = D("tamsin", "2026-11-03T22:15:00", [
    D("notes", at(45, "20:30"), [
      D("field diary", at(45, "20:30"), [
        tlog(2, at(2, "20:10"), `
First ice cores at Cairn 11. Good cores. Labelled correctly (by me). Labelled incorrectly (by Ansel, who wrote "nice ice" on the bag). Relabelled.

Rules for labelling are now in my notes folder. Read them. I will know if you haven't.
`),
        tlog(9, at(9, "21:00"), `
Jonas typed up my stake readings to one decimal place. Again. 2.4 is not 2.41. The stake knows the difference. Told him so. He said "the stake has never spoken to me." I said that was because he never listens.

Snoring audit begins tonight. Recording equipment: my phone. Method: rigorous.
`),
        tlog(15, at(15, "22:15"), `
Transcribed Holm's 1962 sheets for Cairns 11-19. Holm's numbers are beautiful. Holm's handwriting is legible, which puts her above everybody on this expedition except me.

Odd margin on Cairn 19: "N.H. 096" and an arrow pointing down. Not a bearing to any cairn: there is nothing east of 19. Holm did not do decoration. Noted; parked.
`),
        tlog(22, at(22, "20:50"), `
Thermistor string C17-C19 in since yesterday. T1-T6 sensible: minus six and a bit, as ice at 5-10 m should be.

T7, ten metres down at Cairn 19, reads +0.8 C.

Ice at ten metres cannot be above zero. It would not be ice. This is an instrument fault. I have flagged T7 as FAULT in the repo and I am mildly furious with the manufacturer. Draft complaint started.
`),
        tlog(25, at(25, "21:30"), `
Dye test at the melt pond by Cairn 19: fluorescein in, and it came out on the EAST side of the cairn, heading for the rim. Everything else on this plateau drains west, to the Lund. It has done so since the Ice Age, and since 1962 according to Holm.

So the water runs the wrong way, and the probe beside it reads warm. Two separate faults, side by side. That happens. (Does it?)
`),
        tlog(29, at(29, "20:40"), `
Swapped T7 and T3 (C18). If T7 is faulty, the warm reading moves to C18 with it.

It did not move. The warm reading stayed at Cairn 19, in probe T3, which has been perfectly behaved for a week. Results in probe-T7-swap-test.csv.

Ansel keeps saying "the warm corner" in a meaningful voice. I am not engaging.
`),
        tlog(33, at(33, "08:30"), `
Snoring league published (team folder). Ansel first by a distance. He has asked for a recount. Denied.

The warm reading continues. I continue to say "fault" out loud, but more quietly.
`),
        tlog(36, at(36, "21:00"), `
Ice bath. Every probe, all eight, in slush at exactly 0.00 C, half an hour: all within 0.05 C. They are fine. They were always fine.

It is not the probe.

Deleted my complaint to the manufacturer. They will never know how close they came.
`),
        tlog(37, at(37, "23:30"), `
Ansel says the warm corner is geothermal and is staking his best hammer on it. I say that one warm thermistor and some wrong-way water are a measurement, not a corner, and that he cannot have my data for a story until it is a number with an error bar.

Then Mirela showed us the drawing. And I worked out the margin on Holm's Cairn 19 sheet: N.H. is Nora Halloran. 096, and down. I wrote it on the sheet, in the 2026 note, so it is not only in my head.

We are going on Thursday. I am going to prove that it is an instrument fault. (I am not going to prove that.)
`),
        tlog(41, at(41, "22:50"), `
No entries for 39-40. The laptop was here; I was not.

Item A: the water samples are VAR-017 and VAR-018 and they are warm, and I am not writing how warm. Item A explains T7. Item A explains the dye. Item A explains everything I have been rude to a thermistor about for nineteen days.

Renamed the FAULT flag in the repo. It is called ITEM_A now. That is all I am prepared to say in writing.

Ansel says I owe him a hammer. I do not; he staked his own hammer, not mine. But I owe somebody something.
`),
        tlog(45, at(45, "20:30"), `
Flight in. Oranges, which I counted (48), and a crate of ice-core tubes, which I also counted.

Ran Jonas's numbers myself. Ran Ruth's count against Mirela's frames: Item C, same number. Ran my own numbers twice, as agreed. They are good numbers.

Somebody has to check them who isn't one of us. That will be the paper. Until then: two decimal places, and silence.
`)
      ]),
      T("LABELLING RULES - READ THIS.md", at(2, "21:30"), `
# Rules for labelling samples (T. Hale). Not suggestions.

- Pencil. Not pen. Pen runs. Not marker. Marker smears. Pencil.
- The ID from the register first, then the day, then the site. VAR-014 / D30 / C19.
- No adjectives. "Nice ice" is not a site. "Interesting rock" is not a type.
- Depths in metres, two decimal places. 2.4 is not 2.41.
- If you don't know what it is, write "unknown". Not "?". Not "thing". Not a drawing of it (Mirela).
- Do not use Ruth's plasters as labels.
- If you relabel something, cross it out once, neatly, and initial it. Do not scribble. Scribbling is how 1962 got its herring problem.
- From Day 41: Items A, B and C as agreed. Nothing more specific on any bag.
`),
      T("handwriting, a complaint.md", at(16, "22:40"), `
# Handwriting on this expedition, ranked (worst first)

- Sandvik, 1962. Ruth has a medical degree and it took her an hour to read "herring".
- Ansel. Writes "nice ice" on core bags. Writes his 7s like 1s and his 1s like 7s, so they cancel.
- Jonas. Fine, but types my numbers to one decimal place, which is worse than bad handwriting.
- Mirela. Beautiful. Mostly drawings.
- Ruth. A doctor, legible. Suspicious.
- Holm, 1962. Perfect. Every number readable. Every angle closes. I would have liked her.
- Me.
`)
    ]),
    D("survey", at(58, "19:30"), [
      T("ice-temp C17-C19.csv", at(58, "19:30"), iceTempCsv()),
      T("dye test D25.csv", at(25, "21:10"), `
time_utc,site,observation,distance_m,direction
${at(25, "09:00")},melt pond C19,dye in (fluorescein 20 g),0,-
${at(25, "09:40")},C19 east channel,dye visible,85,east
${at(25, "10:20")},C19 east channel,dye visible,240,east
${at(25, "11:00")},rim,dye at the rim lip; channel drops out of sight,310,east
${at(25, "11:00")},C19 west side,no dye,0,-
${at(25, "12:00")},C18 stream (drains west),no dye,-,-
`),
      T("ablation stakes.csv", at(56, "17:00"), (function () {
        var r = rng(31), out = ["day,date,stake,site,surface_drop_m,reader"];
        [6, 13, 20, 27, 34, 41, 48, 55].forEach(function (d) {
          ["S01", "S02", "S03", "S04", "S05", "S06"].forEach(function (s, i) {
            out.push([d, iso(d), s, "Cairn " + (8 + i * 2), (0.05 + (d - 6) * 0.006 + r() * 0.03).toFixed(2), d === 13 && i < 3 ? "JR (was 1 d.p.; corrected TH)" : "TH"].join(","));
          });
        });
        return out.join("\n");
      })()),
      D("thermistors", at(36, "21:00"), [
        T("string C17-C19 - layout.txt", at(21, "20:00"), `
THERMISTOR STRING, EAST LINE (installed Day 21)

  C17 ---------------- C18 ---------------- C19 --- rim
  T1 (5 m)             T3 (5 m)             T5 (5 m)
  T2 (10 m)            T4 (10 m)            T6 (7 m)
                                            T7 (10 m)   <- the warm one
  T8: control, C17, 3 m, in a dry hole
`),
        D("C19", at(36, "21:00"), [
          D("tests", at(36, "21:00"), [
            T("probe-T7-swap-test.csv", at(29, "20:30"), `
day,date,position,probe,temp_C_10m,note
28,${iso(28)},C19 10 m,T7,+0.82,before swap
28,${iso(28)},C18 10 m,T3,-6.11,before swap
29,${iso(29)},C19 10 m,T3,+0.80,after swap: warm stays at C19
29,${iso(29)},C18 10 m,T7,-6.09,after swap: T7 reads cold at C18
30,${iso(30)},C19 10 m,T3,+0.83,
30,${iso(30)},C18 10 m,T7,-6.12,
conclusion,,,,,the warmth belongs to the place and not to the probe. (TH; reluctantly)
`),
            T("ice-bath calibration D36.csv", at(36, "21:00"), `
probe,reading_in_ice_bath_C,offset_C,verdict
T1,0.02,+0.02,fine
T2,-0.03,-0.03,fine
T3,0.01,+0.01,fine
T4,0.04,+0.04,fine
T5,-0.02,-0.02,fine
T6,0.00,0.00,fine
T7,0.03,+0.03,fine (sorry T7)
T8,-0.01,-0.01,fine
`)
          ])
        ])
      ])
    ]),
    G([
      D("varda-thermal", "2026-11-03T22:15:00", [
        T("README.md", "2026-11-03T22:15:00", `
# varda-thermal

Thermistor and ablation analysis, Varda Icefield Resurvey 2026. T. Hale.

## Status of the C19 warm reading
- It is not the instrument. (Swap test, Day 29. Ice bath, Day 36. Repeat ice bath at the lab, 30 October.)
- It is not the data logger, the cable, the cold, Jonas, or the manufacturer.
- It is Item A.

## Run
    python3 analyse.py ~/tamsin/survey/ice-temp\\ C17-C19.csv
`),
        T("analyse.py", at(41, "22:45"), `
import csv, sys

ITEM_A = {"T7_C19_10m"}          # was: FAULTY = {"T7_C19_10m"}  (renamed D41; see log)

def load(path):
    with open(path) as f:
        return list(csv.DictReader(f))

def summary(rows):
    for col in ("T5_C19_5m", "T6_C19_7m", "T7_C19_10m", "T8_control"):
        vals = [float(r[col]) for r in rows if r[col]]
        tag = " (ITEM_A)" if col in ITEM_A else ""
        print(f"{col:12s} mean {sum(vals)/len(vals):+.2f} C over {len(vals)} days{tag}")

if __name__ == "__main__":
    summary(load(sys.argv[1]))
`),
        T("flags.csv", at(41, "22:45"), `
probe,flag,since,by
T7_C19_10m,ITEM_A,D22,TH
`),
        T("drainage.py", at(27, "22:05"), `
# Where does the meltwater go? Downhill. Usually.

# Dye released D25; where it came out.
DYE = {"C17": "west", "C18": "west", "C19": "east"}

def route(cairn):
    """The way meltwater leaves a cairn, by the DEM's steepest descent."""
    return "west"   # the whole plateau tilts to the Lund. Everyone knows that.

if __name__ == "__main__":
    for cairn, seen in DYE.items():
        model = route(cairn)
        flag = "" if model == seen else "   <- model disagrees with dye (model checked twice)"
        print(f"{cairn}: model {model:5s} dye {seen}{flag}")
`),
        T("notes.md", at(36, "21:20"), `
# Notes on T7 (in order, honestly)

- D22: +0.8 C at 10 m. Impossible. FAULT.
- D25: dye drains east at C19. Unrelated. Probably.
- D29: swapped T7 and T3. The warmth stayed at C19. Inconvenient.
- D36: ice bath. Every probe fine. Very inconvenient.
- Conclusion pending. (It is not pending.)
`),
        T("calibration.csv", at(36, "21:20"), `
probe,offset_C
T1,+0.02
T2,-0.03
T3,+0.01
T4,+0.04
T5,-0.02
T6,0.00
T7,+0.03
T8,-0.01
`)
      ])
    ]),
    cfg("tamsin", "2026-08-02T10:10:00", [JS("whiteout.theme.json", at(18, "22:00"), { name: "Whiteout", dark: false, v: ["#f6f8f9", "#e5ebee", "#122029", "#4a5b66", "#2b78ad", "#8aa6b6"] })])
  ]);

  /* ================= ~/jonas ================= */
  function jlog(n, mod, text) { return T("day " + dn(n) + ".md", mod, "# Day " + n + ", " + longDay(n) + "\n\n" + body(text) + "\n\n73"); }
  var UNK_SUMMARY = `
# UNK-7, by hand (J.R.)

The recorder at Cairn 19 was there for icequakes. It found something else.
The full log is /var/log/acoustic/detector-C19.log: hundreds of lines, one per
sound. grep it from the terminal if you like. This is the short version, counted by hand.

## Detections of UNK-7 per dawn
| day | date | count |
|---|---|---|
${unkTable()}

## What it is not
- Not the guy-lines. I took them all down on Day 30 and it kept calling.
- Not wind. Day 31 was flat calm at 0400Z, and it called four times.
- Not in my reference library (2,300 northern calls). Best match, every time: common crane, 0.4. In this library 0.4 means no.

## What it is
- Two notes, rising, about 400 Hz, two to three seconds. Always at dawn.
- Bearing 094-099 from the second mic: from the east, below the rim.
- A big throat. A long windpipe. Something tall.

## From Day 41
- It is Item C. That is all I am writing.
- Total for the season: ${unkTotal(26, 57)} detections. I owe the guy-lines an apology.
`;
  var jonas = D("jonas", at(58, "10:30"), [
    D("journal", at(44, "23:00"), [
      jlog(1, at(1, "21:40"), `
Flew in at 09:20 local on Sorli's Otter. Two passes over the plateau, then down on the skis like a man sitting on a sofa.

Mast up by 15:00. First sked to Lund at 1800Z, 5 and 7 both ways. Kari said "welcome to the quietest office in the world."

Told everyone the clock is UTC. Ansel has asked twice what time it is.
`),
      jlog(10, at(10, "21:05"), `
Backup day. Copied plan, stores and survey to the SD card. Mirela asked if she could put her photos on it. She has 400 GB of photos. The card is 128 GB. We negotiated. She lost.
`),
      jlog(20, at(20, "21:20"), `
Put the acoustic recorder up at Cairn 19 for Tamsin's icequakes. Mast 2.1 m, three guy-lines, two mics. It hears the ice crack and the wind sing and a raven say rude things. Lovely.
`),
      jlog(26, at(26, "21:00"), `
New thing in the dawn recording at Cairn 19. The detector filed it as UNK-7: two notes, rising, about 400 Hz. Once, at 05:52 local, then nothing.

Almost certainly the NE guy-line singing in the dawn wind. Guy-lines do that. I'll listen properly tomorrow. File is in the recorder folder.
`),
      jlog(30, at(30, "21:30"), `
Four days of UNK-7 now, more every dawn. Took the guy-lines down at 14:10Z and bolted the mast to the rock. If it calls tomorrow, it is not a guy-line.

Ruth found a feather today she won't guess about. I said: a big bird would have a big voice. She said: "I'm not guessing." Ruth's neighbours, she calls whoever it is.
`),
      jlog(31, at(31, "07:10"), `
It called. Four times, before sunrise, in a flat calm, with no guy-lines to sing. Not GUY. Not WIND.

Best one: 2026-09-09_0436_C19_UNK-7.wav. I've listened to it fifty times. The library says common crane, 0.41. The library is trying to be polite.
`),
      jlog(34, at(34, "21:10"), `
Tamsin brought me tea at the radio. The mug has a label on it, in pencil, per her rules: "VAR-TEA / D34 / radio tent / 2.00 sugars". I have never been so precisely cared for.

Mirela has been strange all week. She stops talking when I come into the cook tent. I think she's planning something about me. I hope it isn't another portrait.
`),
      jlog(37, at(37, "22:00"), `
The second mic gives a bearing: 094 to 099, every time. From the east, below the rim, where officially there is nothing.

Best recording so far: 2026-09-12_0412_C19_UNK-7.wav. Two birds, I think, answering each other.

Round the stove tonight we put everything together. Ruth's neighbours, Ansel's warm corner, Tamsin's warm probe, my caller. Then Mirela put down the drawing. We go on Thursday.
`),
      jlog(41, at(41, "22:20"), `
Nothing for 39-40. I was not here. The recorder was, and it heard twenty-seven calls on the dawn of Day 40 while we were standing below the rim listening to the same voices with our own ears.

Item C. That's all.

And for the record: Mirela says she saw them first, from the rim. That's a matter of opinion. I HEARD them first, on Day 26, at 05:52 local, and I have the file to prove it.

Copied Mirela's frames off her cards tonight, the way she asked. Details in my backup notes.
`),
      jlog(44, at(44, "23:00"), `
It's my birthday. I didn't tell anybody. Mirela knew anyway; she'd known since Day 14. That was the secret. That was the whole secret. A cake made of ration bars and porridge, a candle out of Ruth's medical box, and a card everyone signed (Tamsin signed hers "2.00").

Best birthday I have had, on the best expedition I will ever be on, three days after the best morning of my life.
`)
    ]),
    D("acoustics", at(58, "10:30"), [
      T("UNK-7 by hand.md", at(45, "19:40"), UNK_SUMMARY),
      T("reference library - what it isn't.txt", at(34, "20:50"), `
REFERENCE LIBRARY, northern birds, 2,300 calls (JR's, from three sound archives)

UNK-7 best matches, averaged over ${unkTotal(26, 34)} detections (Days 26-34):

  Grus grus (common crane)          0.41   wrong shape; wrong pitch; not up here
  Cygnus cygnus (whooper swan)      0.13
  Branta leucopsis (barnacle goose) 0.09
  Corvus corax (raven)              0.04   (the raven is offended)
  wind in a guy-line                0.02   (I had to add this to the library myself)

Anything below 0.6 is "not this". Everything is below 0.6.
`),
      D("recorder-C19", at(58, "10:30"), [
        T("README.txt", at(20, "14:00"), `
Recorder at Cairn 19. One .wav per detection worth keeping. Names:
  date_time(UTC)_site_class.wav
The laptop can't play them (no speakers, and Tamsin would complain anyway).
`),
        B("2026-08-30_0218_C19_ICE.wav", at(21, "02:18"), "2.1 MB"),
        B("2026-09-01_1402_C19_RAVEN.wav", at(23, "14:02"), "1.4 MB"),
        D("2026-09", at(58, "10:30"), [
          B("2026-09-04_0352_C19_UNK-7.wav", at(26, "03:52"), "3.0 MB"),
          B("2026-09-05_0330_C19_GUY.wav", at(27, "03:30"), "4.8 MB"),
          B("2026-09-09_0436_C19_UNK-7.wav", at(31, "04:36"), "3.2 MB"),
          B("2026-09-12_0412_C19_UNK-7.wav", at(34, "04:12"), "6.4 MB"),
          B("2026-09-18_0402_C19_UNK-7 (dawn chorus).wav", at(40, "04:02"), "18.9 MB"),
          B("2026-09-30_0611_C19_ICE.wav", at(52, "06:11"), "2.2 MB")
        ])
      ])
    ]),
    D("radio", at(41, "20:25"), [
      T("backups.txt", at(41, "20:25"), `
BACKUP LOG (JR)

Day 10  20:58Z  plan, stores, survey -> /media/sdcard/backup-day-10      card now 61% full
Day 20  21:30Z  everything -> grey drive                                  (card too small for Mirela)
Day 30  21:40Z  everything -> grey drive
Day 41  20:22Z  MC's two cards from Days 39-40 -> NOT the server, NOT her Pictures folder, as agreed.
                The three frames she picked are on the card, hidden, under a dull name:
                    /media/sdcard/.cal
                She calls them "calibration frames". They are not calibration frames.
                Everything else from those cards -> grey drive, encrypted.
Day 50  21:15Z  everything -> grey drive
Day 59  20:00Z  everything -> grey drive. Laptop packs tomorrow. 73
`),
      T("sked book.txt", at(FLY_OUT, "06:40"), (function () {
        var out = ["SKED BOOK, Varda 2026 (JR). One line per day. Lund = Kari Olsen, XV9LB. Times Z.", ""];
        for (var d = 1; d <= FLY_OUT; d++) {
          var w = WX[d], line = "D" + dn(d) + " " + shortDay(d) + "  ";
          if (d === 1) line += "1800Z only. first sked from camp. 5/7 both ways. Kari: 'welcome to the quietest office in the world'";
          else if (d === 39 || d === 40) line += "no skeds: all five away east of C19, pre-arranged on D38";
          else if (d === 41) line += "0800Z 5/9. back, all five, very cheerful. Kari: 'you sound different.' 1800Z radio-mail from AM to Per H: 'Something wonderful. Can't say. Trust me.'";
          else if (d === 45) line += "0800Z 5/7. flight confirmed. 1140 local: flight in. oranges.";
          else if (d === FLY_OUT) line += "0800Z last sked. Kari: 'come back sometime. 73.' Laptop packed. 73";
          else line += "0800Z ok  1800Z ok  wx " + w.t + "C " + w.dir + " " + w.kmh + " " + w.sky + (d === 26 ? "  (told Kari about the dawn caller; she laughed)" : d === 38 ? "  (told Kari we miss four skeds: 'short trip east')" : d === 44 ? "  (Kari sang happy birthday. Badly. 73)" : "");
          out.push(line);
        }
        return out.join("\n");
      })()),
      T("sked notes.txt", at(38, "19:00"), `
SKED NOTES

0800Z and 1800Z with Kari at Lund (XV9LB). Format per comms plan. Sign 73.
Day 38 1800Z: told Kari we miss Day 39 0800Z, 1800Z and Day 40 0800Z, 1800Z.
  Reason given: "short trip east". Kari: "have fun. 73". She has started saying 73.
Day 41 0800Z: back. "All five back and very well." Kari: "you sound different." Yes.
`)
    ]),
    T(".bash_history", at(58, "10:40"), `
cd /var/log/acoustic
grep -c UNK-7 detector-C19.log
grep -n NOTE detector-C19.log
grep NOTE detector-C19.log
cd ~/jonas/acoustics
ls recorder-C19/2026-09
mkdir /media/sdcard/.cal
cp /mnt/mc-card1/D40_0611.webp /media/sdcard/.cal/cal-0611.webp
cp /mnt/mc-card1/D40_0626.webp /media/sdcard/.cal/cal-0626.webp
cp /mnt/mc-card2/D39_1238.webp /media/sdcard/.cal/cal-1238.webp
ls -la /media/sdcard/.cal
grep -c UNK-7 /var/log/acoustic/detector-C19.log
`),
    cfg("jonas", "2026-08-02T10:15:00", [JS("tent at 3 a.m..theme.json", at(24, "01:00"), { name: "Tent at 3 a.m. (headlamp)", dark: true, v: ["#120e0a", "#1c1610", "#ffdcaa", "#c09468", "#ff9a3c", "#c7782e"] })])
  ]);

  /* ================= ~/mirela ================= */
  function mlog(n, mod, text) { return T("day " + dn(n) + ".md", mod, "# " + longDay(n) + " (day " + n + ")\n\n" + body(text)); }
  var mirela = D("mirela", at(46, "21:00"), [
    D("notebook", at(46, "21:00"), [
      mlog(2, at(2, "21:30"), `
Ansel performs for the camera. Ruth looks straight into it as if it owed her money. Tamsin asks what my aperture is and then tells me it's wrong. Jonas waves. Every single time, Jonas waves.

Lost my lens cap. Found it in my pocket.
`),
      mlog(8, at(8, "21:50"), `
The decimal war. Tamsin wants two places, Jonas types one. Every evening they argue about it at the radio for exactly ten minutes, and every evening both of them come back to the cook tent happier than they left. Some friendships are built on agreement. Theirs is built on 0.01.
`),
      mlog(14, at(14, "22:00"), `
Found something out about J. today, by accident, from the passport page he left on the table at the Lund check-in. I wasn't snooping. It was just there, face up.

I'm not telling anybody. Not even him. Especially not him. Day 44.
`),
      mlog(22, at(22, "21:40"), `
Talked to R. She'll keep it in the medical box, behind the gauze, where J. never looks. He must not find out before 44.

It is very hard to keep a secret in a tent.
`),
      mlog(28, at(28, "22:10"), `
Got the second thing past him today. Close: he was in the food tent counting and I had it under my jacket. It's from my own daily bag, saved since Day 15, before anyone asks the stores sheet any questions. I've seen the way Tamsin looks at that sheet.
`),
      mlog(34, at(34, "23:20"), `
Spent the evening in the 1962 folder Tamsin transcribed, looking at the artist's sketchbook scans. Most of them are raw files the laptop can't open. One isn't: plate 14.

It's a bird. A tall grey bird standing among pines, in ink, on survey paper. On the back, in pencil: "E of 19. 5.ix.62. From life. Cold hands."

East of 19. Ruth's feather came from east of 19. Jonas's caller calls from east of 19.

I am calling it Halloran's bird, in here, where nobody reads. I'm not saying it out loud yet. Ruth would ask me for evidence, and all I have is a drawing that a man struck out of a report sixty-four years ago because he thought it was a dream.
`),
      mlog(37, at(37, "23:40"), `
I put plate 14 on the table tonight. Printed small, on the laptop printer that only Jonas can make work. Nobody spoke for a long time. Then Tamsin said "N.H." in a strange voice and went to find Holm's sheet.

We go on Thursday.
`),
      mlog(41, at(41, "23:15"), `
Saturday. Day 41.

I have to write something or I will burst, and I have promised not to write anything. So.

On Day 39 we walked east from Cairn 19 and down, and the snow ran out under our boots, and the air changed.

On Day 40 I got up in the dark and sat on a rock, and the light came, and I understood that a woman from Galway had once sat very near that rock with cold hands and drawn exactly what I was looking at.

Item A. Item B. Item C. That is all you get from me, notebook.

For the record, since Jonas is telling everyone he heard them first: I saw them first. From the slope on the way down, on Day 39, through the long lens, at 12:38 local, before anybody else had their eyes open to it. He heard a sound in a machine. I saw them.

The three frames I could not stop looking at are not in Pictures. Jonas has them, somewhere dull, in his backups.

And I filmed first light. Three minutes, from the rock, on Day 40. It is not going in Pictures, and not on the card with the stills, and not anywhere a person browsing this laptop would look for a film. It will go where the bearing starts, sealed, beside whatever Ansel writes when we are allowed to write it.
`),
      mlog(44, at(44, "22:40"), `
J.'s birthday. That was my secret, all along. (Notebook: you may have thought it was something else. It wasn't. Just cake.)

He blew out Ruth's candle and wished for something and wouldn't say what. I know what. We all wished for the same thing: that the paper comes back with no corrections, and that nobody ever builds a road to Item A.
`),
      mlog(46, at(46, "21:00"), `
Light snow. Peaches. Tamsin counting oranges (48, "for the record"). Ansel reading a letter from Per with his hand over his mouth.

I keep looking east from camp. You can't see anything from here. That's the point. That's what will keep them safe.
`),
      T(".day 44 - for J.md", at(28, "22:20"), `
# Day 44: J's birthday. NOT A WORD.

- Cake: two ration bars (MY OWN, saved one a week since Day 15, not from stores), porridge oats, the last of the cardamom, milk powder. Bake in the big pan with the lid, low, 25 min. It will be terrible. It will be perfect.
- Peaches: one tin. Ruth will look the other way. Ruth has agreed to look the other way.
- Candle: in Ruth's medical box, behind the gauze.
- Card: everyone signs. Tamsin to sign to two decimal places.
- Song: no. Brekke's accordion is sixty-four years too far away.
`)
    ]),
    D("Pictures", at(46, "20:00"), [
      D("2026 Varda", at(46, "20:00"), [
        D("selects", at(46, "20:00"), [
          IMG("D00_lund-harbour, the evening before.webp", at(0, "18:40"), "sea-cliffs.webp", "3000x2000", "9.8 MB"),
          IMG("D01_sandur from the Otter.webp", at(1, "07:05"), "dunes.webp", "3000x2000", "7.1 MB"),
          B("D07_ruth-weighing-ansel.raw", at(7, "18:10"), "25.6 MB"),
          B("D20_jonas-and-the-recorder-mast.raw", at(20, "12:20"), "25.9 MB"),
          B("D36_tamsin-ice-bath (she is not amused).raw", at(36, "15:05"), "26.4 MB"),
          B("D44_cake (do not look closely).raw", at(44, "18:40"), "24.0 MB"),
          T("selects - read me.txt", at(46, "20:00"), `
Selects, Varda 2026 (MC). One folder of good ones; the rest are in raw/.

There is nothing here from Days 39 and 40. That is not a mistake.
`)
        ]),
        D("raw", at(46, "19:30"), [
          G([
            B("D01_0920_otter-landing.raw", at(1, "07:20"), "25.1 MB"),
            B("D02_1410_tamsin-relabels-ansels-core.raw", at(2, "12:10"), "24.7 MB"),
            B("D06_2140_cook-tent-lantern.raw", at(6, "19:40"), "23.9 MB")
          ]),
          G([
            B("D36_0612_cairn-19-vapour-column.raw", at(36, "04:12"), "26.8 MB"),
            B("D37_2230_plate-14-on-the-table.raw", at(37, "20:30"), "22.4 MB"),
            B("D38_1800_packing-the-sledge.raw", at(38, "16:00"), "25.3 MB"),
            B("D41_2140_five-people-not-saying-a-word.raw", at(41, "19:40"), "24.6 MB"),
            B("D42_0700_looking-east.raw", at(42, "05:00"), "25.0 MB")
          ])
        ])
      ])
    ]),
    cfg("mirela", "2026-08-02T10:20:00", [JS("item A at dawn.theme.json", at(41, "23:50"), { name: "Item A at dawn", dark: true, v: ["#13201c", "#1b2c27", "#f3efe0", "#a9bdb2", "#f0a35e", "#6fa38a"] })])
  ]);

  /* ================= ~/1962 (Sandvik's papers) ================= */
  // Sandvik's line: Cairn 1 at the Lund snout to Cairn 19 at the east rim. Built by Ingrid Holm, Jul-Aug 1962.
  var C62 = [null,
    ["Lund snout", "12 Jul", 1.6, "on the moraine rib, left bank. The glacier tongue 40 m away."],
    ["Lund bend", "13 Jul", 1.8, "on a rock step above the first icefall."],
    ["Tarn", "14 Jul", 1.5, "beside a meltwater tarn. Aas washed the pans here and complained of the cold."],
    ["Tongue", "15 Jul", 1.7, "medial moraine. Brekke carried the top stone 200 m because 'it looked right'."],
    ["Icefall foot", "16 Jul", 1.9, "foot of the second icefall."],
    ["Icefall head", "18 Jul", 1.6, "head of the second icefall. Two days to get here. Sandvik wrote a poem. It is not reproduced."],
    ["Plateau edge", "19 Jul", 1.8, "first rock of the plateau. the artist sketched the cairn with Aas sitting on it."],
    ["Nunatak W", "21 Jul", 1.7, "west nunatak, summit."],
    ["Nunatak E", "22 Jul", 1.7, "east nunatak, summit. Hail."],
    ["Long flat", "24 Jul", 1.2, "in the middle of nothing. Holm: 'a cairn is a promise that somebody stood here.'"],
    ["Halfway", "25 Jul", 1.9, "halfway, by Sandvik's reckoning; 47%, by Holm's."],
    ["Camp", "19 Jul", 1.8, "main camp, 1962 and 2026. Built first, numbered later."],
    ["Nordre", "28 Jul", 1.6, "north knoll."],
    ["Windy", "30 Jul", 1.4, "named by Aas, for reasons."],
    ["Holm's step", "2 Aug", 1.5, "a rock step on the ice. Holm insisted."],
    ["Plateau E", "5 Aug", 1.6, ""],
    ["Twin", "7 Aug", 1.3, "twin rocks, cairn on the southern."],
    ["Long east", "12 Aug", 1.8, "eastern plateau. Fog for three days."],
    ["Rim approach", "20 Aug", 1.7, "the ground falls gently east from here."],
    ["East rim", "29 Aug", 2.0, "the end of the line. The rim falls away east into cloud."]
  ];
  var FOUND2026 = { 8: [10, 6.4], 9: [8, 3.8], 10: [7, 5.0], 11: [1, 3.1], 12: [3, 4.6], 13: [5, 2.2], 14: [20, 2.9], 15: [22, 3.3], 16: [23, 4.1], 17: [21, 1.9], 18: [24, 2.6], 19: [20, 0.8] };
  function cairnSheet(n, extra) {
    var c = C62[n], f = FOUND2026[n];
    var s = "CAIRN " + n + " - \"" + c[0] + "\"\n\n1962 (I. Holm's sheet, transcribed by T. Hale)\n  Built: " + c[1] + " 1962 by I. Holm" + (n === 4 ? " and L. Brekke" : "") + "\n  Height: " + c[2].toFixed(1) + " m. Three flat stones laid in a row on top (Holm's mark on every cairn she built).\n  Site: " + c[3] + "\n";
    if (extra) s += extra;
    s += "\n2026 resurvey\n";
    if (f) s += "  Found Day " + f[0] + " (" + longDay(f[0]) + "), " + f[1].toFixed(1) + " m from the 1962 position. Still standing.\n";
    else if (n === 1) s += "  Gone. The snout has retreated 1.9 km since 1962; the cairn went with the moraine. Seen from the air, Day 58.\n";
    else s += "  Not visited on foot (lower line). " + (n === 7 ? "Seen from the air, Day 58." : "Weather on the flight out did not oblige.") + "\n";
    return s;
  }
  function cairnFile(n) { return T("Cairn " + pad(n) + " - " + C62[n][0] + ".txt", n <= 7 ? at(58, "19:00") : at((FOUND2026[n] || [15])[0], "20:30"), cairnSheet(n)); }

  var C19_EXTRA = `
  Margin, in Holm's hand, pencil: "N.H. 096 ↓"
  [TH, Day 15: no idea. Not a bearing to any cairn: there is nothing east of 19.
   N.H. is not a survey abbreviation I know. Holm did not do decoration.]
  [TH, Day 37: I know now. Nora Halloran. 096 degrees, and down.]
`;

  var DIARY = {
    "1962-07": [
      ["1962-07-10.txt", `
10 July 1962. Lund.

Arrived at Lund by the coastal boat. Five of us, and two tons of things, of which perhaps one ton is useful.

Aas, our cook, has brought eleven kinds of herring and no salt. He says the herring is already salty. I said that is not the point. He said it was exactly the point.

Holm has spent the evening checking the theodolite against the church spire. She says the spire leans 0.4 degrees. The priest says it does not. I believe Holm.

Our artist (the Arts Council's idea, not mine) drew the harbour, the boat, the herring, and me looking at the herring. It is a good likeness. I did not ask for it.
`],
      ["1962-07-19.txt", `
19 July 1962. Plateau. Cairn 11.

Up at last. Holm built the main camp cairn before we had the tents up: three flat stones in a row on the top, as she does. "So you will know it is one of mine," she says, as if anyone else were building any.

Aas made a stew. It contained, he said, reindeer. I have eaten reindeer. This was not reindeer. It may have been the herring, in disguise.

The artist sat on Cairn 7 this morning and drew Aas sitting on Cairn 7, which she then said was "for the composition".
`],
      ["1962-07-28.txt", `
28 July 1962. Cairn 12.

Today's porridge had the consistency of a theological argument: thick, grey, and impossible to finish.

I have told Aas that a cook on an expedition is the most important man on it, which is true, and which I hoped would encourage him. He said, "Then I should be leading it." Brekke laughed so much he dropped the staff.

Holm's angles close to within four seconds. I have never seen better. I have told her so. She said, "I know."
`]
    ],
    "1962-08": [
      ["1962-08-06.txt", `
6 August 1962. Cairn 15.

Brekke has brought an accordion. Nobody knew. He produced it tonight from inside his sleeping bag, where it has evidently been all along. He knows three tunes. We have heard all three, eleven times.

The artist paints in the evenings with her gloves on, cutting the fingertips off one by one as the weeks go on. She has two fingertips left to sacrifice.
`],
      ["1962-08-17.txt", `
17 August 1962. Cairn 17.

Fog for three days. Holm built Cairn 17 by compass and pacing and when the fog lifted it was exactly where the plan said. Aas, impressed for the first time this summer, made pancakes. They were good. I will not tell him.
`],
      ["1962-08-29.txt", `
29 August 1962. Cairn 19.

The end of the line. Holm built Cairn 19 on the last solid rock before the eastern rim. Beyond it the ground drops away into cloud and there is nothing to survey: steep ice, then mist, then, I suppose, the same as everywhere else.

We stood around it for a while, as people do at ends of things. The artist said the mist down there "looked warm". I said mist is not warm. She said "this one is" and wrote something in her book.
`]
    ],
    "1962-09": [
      ["1962-09-03.txt", `
3 September 1962. Cairn 19.

The artist walked east from Cairn 19 after lunch "to see what the light did", and came back at supper with wet boots. Wet, in September, at this height, where everything is frozen.

She says that below the rim there is a green place, with trees, and a grey bird as tall as Brekke that stood in the shallows and looked at her "as if I were late". She says the water was warm.

I told her that the light had evidently done a great deal. She took it well. Aas gave her the last of the cocoa and said nothing, which for Aas is a speech.
`],
      ["1962-09-05.txt", `
5 September 1962. Cairn 19.

The artist has painted the bird. Ink, on survey paper borrowed from Holm. Tall, grey, a long neck, standing among pines. It is very fine. It is also impossible. There are no trees within a thousand metres of this altitude and no bird of that kind in the whole of the north.

Holm, who never humours anybody, humoured her: took a bearing from Cairn 19 to where the artist said she had gone down. Wrote it in the margin of her sheet. I have asked her to rub it out. She has not.
`],
      ["1962-09-08.txt", `
8 September 1962. Camp.

I have asked the artist not to mention her green place in her notes for the report. A survey report is not a place for dreams. She said she would not mention it in my report, and that her own notes were her own business.

Aas made a cake for Brekke's birthday from oats, condensed milk and something he refused to name. It was the best thing he has cooked all summer. I told him so, in error.
`],
      ["1962-09-14.txt", `
14 September 1962. Camp.

Last night on the plateau. Brekke played all three tunes. The artist gave each of us a drawing. Mine is of me, frowning at a herring. Holm's is of Holm at the theodolite. Aas's is of Aas with a ladle, with a halo. Aas has wrapped his in oilskin and put it inside his shirt.

I asked what she had kept for herself. She said, "The bird."
`],
      ["1962-09-20.txt", `
20 September 1962. Lund.

Down the Lund in four days, all well, all fed (Aas), all accounted for (Holm). The boat tomorrow.

On the quay the artist - Miss Halloran; I find I want to write her name - said, "You'll see. Someone will go and look." I said nobody would, because there was nothing to look at. She laughed. I have been thinking about that laugh all evening, which is not like me.
`]
    ]
  };
  function diaryFolders() {
    return Object.keys(DIARY).map(function (m) {
      var pages = DIARY[m];
      return D(m, at(15, "21:00"), pages.map(function (p, i) { return T(p[0], at(13 + i % 3, "2" + (i % 3) + ":1" + i), p[1]); }));
    });
  }

  var MAP_OVERVIEW = `
SANDVIK LINE 1962 - OVERVIEW (Holm's sketch, redrawn in characters by TH)

   W                                                                    E
                         the plateau (1,600 - 1,700 m)
              C8 . . C9 . . C10 . . C11 . . C12 . C13 . C14 . C15 . C16
             /                     [CAMP]                              \\
           C7                                                     C17 . C18 . C19 |
          /                                                                       |  rim
        C6   (second icefall)                                                     |  ..mist..
        |                                                                         |
        C5                                                                         ?
         \\
          C4 - C3 - C2 - C1   Lund snout (1962)
                              Lund snout (2026): 1.9 km further back

  scale: about 4 km per row of dots. Grid north up. Don't trust it for anything but order.
`;
  var MAP_EAST = `
EAST LINE, CAIRNS 14-19 (Holm, August 1962; redrawn TH)

      C14 ----- 2.6 km ----- C15 ----- 2.4 km ----- C16
                                                     \\
                                                      2.1 km
                                                       \\
                         C17 ----- 2.2 km ----- C18 ---- 1.9 km ---- C19
                         (fog)                                       /|\\  three flat stones
                                                                      |
                                                       rim, 300 m east. steep ice. cloud.

  Holm's closing error on the east line: 0.04 m in 13.2 km.
  Tamsin's closing error on the same line, 2026, with GPS: 0.06 m. (She is not pleased about this.)
`;
  var MAP_MONSTER = `
EAST OF CAIRN 19: WHERE THE DATA RAN OUT
Holm's field sheet 31, 1962. Survey ends at C19. Everything to the right of the
rim is blank on the sheet, except for what somebody drew there in ink. Redrawn TH.

    C19
     ^  rim
     |  |
     |  |    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
     |  |   ~~        HER ER INGENTING  (E.S.)          ~~
     |  |   ~~   ("here there is nothing" - Sandvik's   ~~
     |  |   ~~    hand, in pencil, over the ink)        ~~
     |  |   ~~                                          ~~
     |  |   ~~      __        __        __              ~~
     |  |   ~~  ___/  \\______/  \\______/  \\____  ,      ~~
     |  |   ~~ /  o                             \\/ \\     ~~
     |  |   ~~ \\__/\\___ a sea monster, swimming  ___/    ~~
     |  |   ~~         in the cloud. Halloran's.         ~~
     |  |   ~~                                          ~~
     |  |   ~~                                    |\\    ~~
     |  |   ~~        (bottom right corner, tiny: | ) a ~~
     |  |   ~~         long-legged bird. Easy to /  \\   ~~
     |  |   ~~         miss. I missed it till D41.)     ~~
     |  |    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

  [TH: Sandvik wrote "nothing". Halloran drew a monster, to annoy him, and a bird,
   for herself. I have now spent sixty-four years' worth of irritation on this sheet.]
`;

  var AAS_MENU = `
AAS'S MENU, PLATEAU, JULY 1962 - with Sandvik's notes in the margin (transcribed TH)

MONDAY     herring, potatoes                 "the herring was at least honest"
TUESDAY    porridge, herring                 "why"
WEDNESDAY  reindeer stew                     "it was not reindeer"
THURSDAY   fish soup                         "the fish was herring"
FRIDAY     pancakes, cloudberry jam          "excellent. do not tell him"
SATURDAY   whatever is left                  "it was herring"
SUNDAY     Aas's Sunday surprise             "the surprise was herring"

Aas's note at the bottom, in different ink:
  "The leader complains of herring. The leader has had second helpings
   every day. I have counted. K.A."
`;
  var REPORT_P38 = `
SANDVIK, E. (1963). Varda Icefield Survey 1962: Report. Page 38.

NOTE ON OMISSIONS

The artist's notebooks contain an account of a "green place" with trees and
large birds, said to lie below the eastern rim of the icefield, east of
Cairn 19. As no ground of this kind can exist at such an elevation, and as
it was not visited by any surveyor, the account has been omitted as
fanciful. The artist's drawings of the expedition itself are reproduced as
plates 1 to 9, and are much admired.                                  E.S.

[TH: plates 1 to 9. Plate 14 is not among them.]
`;
  var REPORT_P41 = `
SANDVIK, E. (1963). Report. Page 41.

ACKNOWLEDGEMENTS

The leader thanks Miss I. Holm for the survey, which is exact; Mr L. Brekke
for his strength and his music; Miss N. Halloran for her drawings; and the
cook.

[TH: "the cook". Not by name. Sandvik's diary for 8 September calls Aas's cake
 the best thing he cooked all summer. He never put that in print either.]
`;
  var HALLORAN_LETTER = `
N. Halloran to I. Holm. Galway, 2 March 1963. (Holm papers, box 3; transcribed TH)

Dear Ingrid,

They have cut my green place out of the report. Page 38, "fanciful". I am not
cross. I was cross for a week and now I am not. I know where it is.

You took the bearing for me, from your Cairn 19: 096, and down. Keep it
somewhere, will you, where it won't be rubbed out. Someone will go and look.
Not us; we are too old and too busy and Eirik would never forgive either of
us. But someone.

I have kept the bird. Plate 14. It is on my wall and it looks at me every
morning as if I were late.

Give my love to Knut. Tell him the cake was the best thing on the ice and that
I said so in writing, which is more than some people did.

Nora
`;

  var README_1962 = `
# 1962: Sandvik's Varda Icefield Survey, transcribed

Source: the Polar Institute archive, boxes 14 (Sandvik) and 3 (Holm). Scanned 2025.
Transcribed by T. Hale, with help from R. Okonkwo (who can read doctors' handwriting, and therefore Sandvik's).

## Who they were
- Eirik Sandvik, leader. Kept the diary. Complained.
- Ingrid Holm, surveyor. Built every cairn. Her sheets are the only reliable numbers in this folder.
- Knut Aas, cook. The subject of most of the complaints, and of none of the second helpings.
- Lars Brekke, assistant surveyor, sledge, accordion (three tunes).
- Nora Halloran, artist, from Galway. Sent by an arts council. Painted everything, including the cook.

## What is where
- diary: Sandvik's diary, one file per page I could read.
- cairns: Holm's sheets, Cairn 1 at the Lund snout to Cairn 19 at the east rim, with our 2026 resurvey under each.
- maps: Holm's sketch maps, redrawn by me in characters, because the scans are the colour of tea.
- halloran: what survives of the artist. Two letters. One sketchbook, partly.
- report 1963: the pages that matter.
- misc: the menu.
`;

  var y1962 = D("1962", "2026-11-16T16:20:00", [
    T("README.md", at(15, "22:10"), README_1962),
    D("diary", at(15, "21:00"), diaryFolders()),
    D("cairns", "2026-11-16T16:20:00", [
      D("west line", at(58, "19:00"), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(cairnFile)),
      D("east line", "2026-11-16T16:20:00", [
        T("Cairn 11 - Camp.txt", at(1, "20:30"), cairnSheet(11)),
        cairnFile(12), cairnFile(13), cairnFile(14), cairnFile(15), cairnFile(16), cairnFile(17), cairnFile(18),
        D("Cairn 19 - East rim", "2026-11-16T16:20:00", [
          T("sheet.txt", at(37, "21:05"), cairnSheet(19, C19_EXTRA)),
          B("C19_D20_three-flat-stones.raw", at(20, "09:14"), "25.1 MB"),
          D(".sealed", "2026-11-16T16:20:00", SEALED)
        ])
      ])
    ]),
    D("maps", at(16, "20:00"), [
      T("overview.txt", at(16, "19:40"), MAP_OVERVIEW),
      T("east line, cairns 14-19.txt", at(16, "19:50"), MAP_EAST),
      T("east of Cairn 19 - where the data ran out.txt", at(41, "23:30"), MAP_MONSTER)
    ]),
    D("halloran", at(34, "22:05"), [
      G([
        T("Halloran to Holm, 2 Mar 1963.txt", at(16, "21:10"), HALLORAN_LETTER),
        T("Halloran to the Arts Council, Jun 1962.txt", at(16, "21:30"), `
N. Halloran to the Arts Council of Ireland. Galway, 2 June 1962.

Thank you for the grant. I accept with pleasure. I have bought boots, which I
am told are the important thing, and paper, which I know is.

I am told the expedition is going to measure a great deal of ice. I intend to
look at whatever is not ice. I expect there will not be much, which will make
it easier to choose.

Yours, N. Halloran
`)
      ]),
      D("sketchbook 2", at(34, "22:05"), [
        B("plate 10 - Brekke and the accordion.raw", "2025-11-03T14:10:00", "61.2 MB"),
        B("plate 11 - Aas with a ladle (and a halo).raw", "2025-11-03T14:11:00", "58.9 MB"),
        B("plate 12 - Holm at the theodolite.raw", "2025-11-03T14:12:00", "60.4 MB"),
        B("plate 13 - mist below the rim.raw", "2025-11-03T14:13:00", "57.7 MB"),
        IMG("plate 14.webp", "2025-11-03T14:14:00", "crane.webp", "2400x2400", "6.2 MB"),
        B("plate 15 - Sandvik frowning at a herring.raw", "2025-11-03T14:15:00", "59.0 MB"),
        T("scan notes.txt", at(34, "22:05"), `
Sketchbook 2, scanned 2025 from the Holm papers, box 3 (not Sandvik's box: Holm kept it).

Plates 10-13, 15: raw scans only (too big to convert on the laptop).
Plate 14: converted. Ink on survey paper. Unsigned, undated. A pencil note on
the back in Halloran's hand: "E of 19. 5.ix.62. From life. Cold hands."

[MC, Day 34: I have been looking at plate 14 for an hour.]
`)
      ])
    ]),
    D("report 1963", at(16, "21:40"), [
      T("p38 - note on omissions.txt", at(16, "21:40"), REPORT_P38),
      T("p41 - acknowledgements.txt", at(16, "21:45"), REPORT_P41)
    ]),
    D("misc", at(13, "21:00"), [
      T("Aas - menu, with Sandvik's notes.txt", at(13, "21:00"), AAS_MENU),
      T("packing list 1962.txt", at(13, "20:30"), `
PACKING LIST, 1962 (Sandvik)

theodolite (Holm)                1
staffs                           2
tents                            3
sledges                          2
paraffin                         120 l
herring, assorted                "enough" (Aas)
salt                             0  (see above)
accordion                        0  (as far as I knew)
paper, drawing                   1 ream (the artist)
paper, survey                    2 reams (of which the artist used one)
`)
    ]),
    JS(".halloran-1962.theme.json", at(41, "23:35"), { name: "1962, sepia", dark: false, v: ["#efe4cc", "#e3d3ad", "#2e2112", "#5f4a2c", "#8a3b12", "#a8773b"] })
  ]);

  /* ================= Tamsin's analysis repo: conceding, one commit at a time =================
     main, plus two side routes: drainage-model (D26-27, merged D28: the model agrees with the dye)
     and warm-bias (D30-33, still open: a "correction" that turned out to belong to a place). */
  var H = "/home/varda";
  var R = H + "/tamsin/varda-thermal";
  var commits = [
    { hash: "e41c0de", author: "Tamsin Hale", date: "2026-11-03T22:15:00", parents: ["a7f19b2"], refs: ["main"],
      msg: "README: it is not the instrument\n\nRepeat ice bath at the lab on 30 October, with the lab's reference probe. All eight within 0.05 C.\nI have now tested these thermistors more than anything I have ever owned. They were right on Day 22.\nThe C19 reading is real. It is Item A. That's all this README is going to say until 1 December.",
      files: [{ path: "README.md", status: "M", diff: "--- a/README.md\n+++ b/README.md\n@@ -2,8 +2,10 @@\n \n Thermistor and ablation analysis, Varda Icefield Resurvey 2026. T. Hale.\n \n-## Known issues\n-- T7 at C19 reads warm. Under investigation. Probably the probe.\n+## Status of the C19 warm reading\n+- It is not the instrument. (Swap test, Day 29. Ice bath, Day 36. Repeat ice bath at the lab, 30 October.)\n+- It is not the data logger, the cable, the cold, Jonas, or the manufacturer.\n+- It is Item A.\n \n ## Run" }] },
    { hash: "a7f19b2", author: "Tamsin Hale", date: at(41, "22:45"), parents: ["5c0ffee"],
      msg: "rename FAULTY to ITEM_A\n\nIt was never faulty. I am not writing down what it is. Nobody is. We agreed.\nI owe T7 an apology and Ansel nothing (he staked his own hammer).",
      files: [
        { path: "analyse.py", status: "M", diff: "--- a/analyse.py\n+++ b/analyse.py\n@@ -1,13 +1,13 @@\n import csv, sys\n \n-FAULTY = {\"T7_C19_10m\"}          # +0.8 C at 10 m. Impossible. Manufacturer to be told.\n+ITEM_A = {\"T7_C19_10m\"}          # was: FAULTY = {\"T7_C19_10m\"}  (renamed D41; see log)\n \n def load(path):\n     with open(path) as f:\n         return list(csv.DictReader(f))\n \n def summary(rows):\n     for col in (\"T5_C19_5m\", \"T6_C19_7m\", \"T7_C19_10m\", \"T8_control\"):\n         vals = [float(r[col]) for r in rows if r[col]]\n-        tag = \" (FAULTY: ignore)\" if col in FAULTY else \"\"\n+        tag = \" (ITEM_A)\" if col in ITEM_A else \"\"\n         print(f\"{col:12s} mean {sum(vals)/len(vals):+.2f} C over {len(vals)} days{tag}\")" },
        { path: "flags.csv", status: "M", diff: "--- a/flags.csv\n+++ b/flags.csv\n@@ -1,2 +1,2 @@\n probe,flag,since,by\n-T7_C19_10m,FAULTY,D22,TH\n+T7_C19_10m,ITEM_A,D22,TH" }
      ] },
    { hash: "5c0ffee", author: "Tamsin Hale", date: at(36, "21:20"), parents: ["29d5a11"],
      msg: "ice bath: all eight probes within 0.05 C\n\nSlush at 0.00 C, thirty minutes, every probe. Every probe fine. T7 included.\nIt is not the probe.\nDeleted the complaint to the manufacturer. They will never know.",
      files: [
        { path: "calibration.csv", status: "A" },
        { path: "notes.md", status: "M", diff: "--- a/notes.md\n+++ b/notes.md\n@@ -3,3 +3,5 @@\n - D22: +0.8 C at 10 m. Impossible. FAULT.\n - D25: dye drains east at C19. Unrelated. Probably.\n - D29: swapped T7 and T3. The warmth stayed at C19. Inconvenient.\n+- D36: ice bath. Every probe fine. Very inconvenient.\n+- Conclusion pending. (It is not pending.)" }
      ] },
    { hash: "f00d1e5", author: "Tamsin Hale", date: at(33, "22:40"), parents: ["6a3f0b9"], refs: ["warm-bias"],
      msg: "warm-bias: key the correction by cairn, not by probe\n\nWhichever probe sits at C19 reads +0.8. So the correction belongs to C19, not to a probe.\nA correction that belongs to a place is not a correction. It is a measurement.\nParking this branch. Not merging it. Not deleting it either (evidence).",
      files: [{ path: "analyse.py", status: "M", diff: "--- a/analyse.py\n+++ b/analyse.py\n@@ -3,3 +3,4 @@\n FAULTY = {\"T7_C19_10m\"}          # +0.8 C at 10 m. Impossible. Manufacturer to be told.\n-WARM_BIAS = {\"T3\": -0.80}        # since the D29 swap. T3 seems to have caught it off T7.\n+# Keyed by place, not probe: whatever sits at C19 reads warm.\n+WARM_BIAS = {\"C19\": -0.80}       # ...which is not what a correction is. Parked. TH, D33\n " }] },
    { hash: "6a3f0b9", author: "Tamsin Hale", date: at(30, "21:05"), parents: ["29d5a11"],
      msg: "warm-bias: subtract 0.80 C from T3 until it behaves\n\nSince the swap, T3 reads warm at C19. It must have caught it off T7. Is that a thing probes do?\nTemporary. On a branch, so main stays honest.",
      files: [{ path: "analyse.py", status: "M", diff: "--- a/analyse.py\n+++ b/analyse.py\n@@ -3,2 +3,3 @@\n FAULTY = {\"T7_C19_10m\"}          # +0.8 C at 10 m. Impossible. Manufacturer to be told.\n+WARM_BIAS = {\"T3\": -0.80}        # since the D29 swap. T3 seems to have caught it off T7.\n " }] },
    { hash: "29d5a11", author: "Tamsin Hale", date: at(29, "20:35"), parents: ["8d4e1a0"],
      msg: "swap test T7<->T3: the warm reading stays at C19\n\nIf T7 were faulty the warmth would have moved to C18 with it. It didn't.\nT3, a perfectly sensible probe, now reads +0.80 at C19. T7 reads -6.09 at C18.\nThe warmth belongs to the place. (Writing this under protest.)",
      files: [{ path: "notes.md", status: "M", diff: "--- a/notes.md\n+++ b/notes.md\n@@ -3,2 +3,3 @@\n - D22: +0.8 C at 10 m. Impossible. FAULT.\n - D25: dye drains east at C19. Unrelated. Probably.\n+- D29: swapped T7 and T3. The warmth stayed at C19. Inconvenient." }] },
    { hash: "8d4e1a0", author: "Tamsin Hale", date: at(28, "21:30"), parents: ["3a9d0c2", "9e57f10"],
      msg: "Merge branch 'drainage-model'\n\nThe model and the dye agree: C17 and C18 drain west to the Lund, C19 drains east, over the rim.\nThe map says there is only more ice over the rim. Maps have been wrong before. (Not usually by this much.)",
      files: [{ path: "drainage.py", status: "A" }] },
    { hash: "9e57f10", author: "Tamsin Hale", date: at(27, "22:05"), parents: ["c19a3e7"], refs: ["drainage-model"],
      msg: "drainage: check the model against the dye\n\nRe-ran it on the DEM twice. The DEM is from 1962 and has opinions.\nC19 disagrees with the model in exactly the way the dye did. The model shrugs.",
      files: [{ path: "drainage.py", status: "M", diff: "--- a/drainage.py\n+++ b/drainage.py\n@@ -1,8 +1,13 @@\n # Where does the meltwater go? Downhill. Usually.\n \n+# Dye released D25; where it came out.\n+DYE = {\"C17\": \"west\", \"C18\": \"west\", \"C19\": \"east\"}\n+\n def route(cairn):\n     \"\"\"The way meltwater leaves a cairn, by the DEM's steepest descent.\"\"\"\n     return \"west\"   # the whole plateau tilts to the Lund. Everyone knows that.\n \n if __name__ == \"__main__\":\n-    for cairn in (\"C17\", \"C18\", \"C19\"):\n-        print(f\"{cairn}: {route(cairn)}\")\n+    for cairn, seen in DYE.items():\n+        model = route(cairn)\n+        flag = \"\" if model == seen else \"   <- model disagrees with dye (model checked twice)\"\n+        print(f\"{cairn}: model {model:5s} dye {seen}{flag}\")" }] },
    { hash: "3a9d0c2", author: "Tamsin Hale", date: at(27, "08:10"), parents: ["d7e25aa"],
      msg: "README: list known issues (one)\n\nSo the lab knows I noticed. Probably the probe.",
      files: [{ path: "README.md", status: "M", diff: "--- a/README.md\n+++ b/README.md\n@@ -2,5 +2,8 @@\n \n Thermistor and ablation analysis, Varda Icefield Resurvey 2026. T. Hale.\n \n+## Known issues\n+- T7 at C19 reads warm. Under investigation. Probably the probe.\n+\n ## Run" }] },
    { hash: "c19a3e7", author: "Tamsin Hale", date: at(26, "21:40"), parents: ["d7e25aa"],
      msg: "drainage model: meltwater goes downhill (a bold claim)\n\nOn a branch, because I would like to be wrong in private first.",
      files: [{ path: "drainage.py", status: "A" }] },
    { hash: "d7e25aa", author: "Tamsin Hale", date: at(25, "21:15"), parents: ["b0a7f22"],
      msg: "dye test: C19 drains EAST\n\nEverything else on the plateau drains west to the Lund. C19 drains east, over the rim.\nA second, unrelated fault, beside the first one. That can happen.\n(Can it?)",
      files: [{ path: "notes.md", status: "M", diff: "--- a/notes.md\n+++ b/notes.md\n@@ -2,1 +2,2 @@\n - D22: +0.8 C at 10 m. Impossible. FAULT.\n+- D25: dye drains east at C19. Unrelated. Probably." }] },
    { hash: "b0a7f22", author: "Tamsin Hale", date: at(22, "20:55"), parents: ["0e1a5ed"],
      msg: "flag T7 as FAULTY: +0.8 C at 10 m is impossible\n\nIce at ten metres cannot be above zero. It would not be ice.\nExclude T7 from all summaries until replaced. Complaint to manufacturer drafted.",
      files: [
        { path: "flags.csv", status: "A" },
        { path: "notes.md", status: "A" },
        { path: "analyse.py", status: "M", diff: "--- a/analyse.py\n+++ b/analyse.py\n@@ -1,4 +1,6 @@\n import csv, sys\n \n+FAULTY = {\"T7_C19_10m\"}          # +0.8 C at 10 m. Impossible. Manufacturer to be told.\n+\n def load(path):" }
      ] },
    { hash: "0e1a5ed", author: "Tamsin Hale", date: at(11, "20:00"), parents: [],
      msg: "initial thermistor and ablation analysis\n\nTwo decimal places throughout. Jonas, this means you.",
      files: [{ path: "README.md", status: "A" }, { path: "analyse.py", status: "A" }] }
  ];

  /* ================= the tree ================= */
  // One shared field laptop, one account. The visitor starts in this folder; searches from here reach everything but the card.
  var varda = D("varda", "2026-11-16T16:22:00", [
    T("day 41 - nobody say the word yet.md", at(41, "21:58"), HOOK),
    T("laptop rules - read me (JR).txt", at(1, "19:30"), `
LAPTOP RULES (JR)

1. One account, five folders. Your folder is your name. Write in your own folder.
2. Shared work goes in expedition/. Sandvik's papers are in 1962/. Don't edit 1962; it's 1962.
3. Times in Z. The laptop runs on UTC. Camp is UTC+2.
4. It lives in the dry bag when nobody is typing.
5. Backups to the SD card every tenth day. I'll do it. You'll forget.
6. Do not put tea on it. Tamsin, this means mugs with labels too.

73
`),
    T("there is no wifi.txt", at(3, "20:02"), `
There is no wifi.

There has never been wifi. We are on an icefield. The nearest router is in
the Lund hut, 60 km away, and it doesn't work either.

Please stop asking the laptop.   (JR)
`),
    ansel, jonas, mirela, ruth, tamsin, expeditionShared, y1962
  ]);
  var home = D("home", "2026-08-01T12:00:00", [varda]);
  var media = D("media", at(41, "20:14"), [sdcard]);


  // a few folders above are written as bare arrays for brevity; the engine wants flat kids
  (function flatten(n) { if (n.kids) { n.kids = n.kids.flat(Infinity).filter(Boolean); n.kids.forEach(flatten); } })({ kids: [etc, home, media, usr, varDir] });

  TX.expedition = {
    title: "Varda Icefield Resurvey",
    users: [
      { id: "varda", name: "Varda field laptop", home: H, blurb: "The shared field laptop of the Varda Icefield Resurvey 2026. One account, five people, a folder each.",
        bookmarks: [H, H + "/expedition", H + "/expedition/survey", H + "/1962"],
        setup: { parts: [], theme: "light", layout: "default", icons: "material", view: "details", path: H } }
    ],
    tree: { name: "", kind: "dir", kids: [etc, home, media, usr, varDir] },
    trash: [
      {
        node: T("to Per - DO NOT SEND (far too excited).txt", at(40, "21:40"), `
Per!!!

Sit down. Are you sitting down? I'm not. I can't.

East of Cairn 19, down off the rim, there is a VALLEY. Not ice. Ground. Warm
ground, Per, warm enough to stand on in your socks. Springs you could bathe in.
A lake that steams at dawn and has plainly never frozen in its life. A river
running east out of the ice, the wrong way, which is why Tamsin's meltwater
has been misbehaving for three weeks.

And PINES. Trees, Per. A wood. At 1,180 metres, seven hundred metres above the
treeline, standing in mist like something out of a book about somewhere else.

And in the pines

(No. I can't. I'll tell you properly. I'll tell everyone properly, when we
are allowed to. Ruth would never forgive me for the next word, and she would be
right.)

Ansel
`),
        from: H + "/ansel/mail",
        deleted: at(41, "20:50")
      },
      {
        node: B("D40_0558_first frame (too blurred).raw", at(40, "03:58"), "23.2 MB"),
        from: H + "/mirela/Pictures/2026 Varda/raw",
        deleted: at(41, "19:10")
      },
      {
        node: T("complaint to the manufacturer - probe T7 (draft 3, furious).txt", at(23, "21:40"), `
To: Customer Services, Polar Thermometry Ltd
Re: Thermistor probe T7, serial PT-4417-07. Formal complaint (draft 3)

Dear Sir or Madam,

Your probe, installed at 10.00 m in glacier ice, reports a temperature of
+0.8 C. Glacier ice at 10.00 m cannot be at +0.8 C. If it were, it would not
be glacier ice; it would be a puddle, and I would be standing in it.

I have had this probe for nine days. In that time it has reported nothing but
impossible numbers, consistently, to two decimal places, which I would
normally admire.

I expect a replacement, an apology, and an explanation, in that order.

Yours faithfully,
T. Hale (Dr)

[draft 4 will be firmer]
`),
        from: H + "/tamsin/notes",
        deleted: at(36, "21:30")
      },
      {
        node: B("snoring - exhibit A (D22, 03:14).m4a", at(22, "01:14"), "11.8 MB"),
        from: H + "/expedition/team",
        deleted: at(33, "09:02")
      }
    ],
    repos: {}
  };
  TX.expedition.repos[R] = { branch: "main", commits: commits };
})();
