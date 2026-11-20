/* Fictional filesystem: "The life list". Len Hewitt's laptop, turned into an escape room for his granddaughter.
 * Consumed as window.TX_FS.escape. Modern day: "today" in the fiction is Thursday 19 November 2026.
 * Len (70) walked the Cley / Wiveton / Glandford post round at dawn from 1979 to 2019 and has 399 species on his
 * British list. Freya (20, Computer Science at Leeds) plays. Nobody is ill, lost or in trouble. Except the squirrel.
 *
 * ======================================== THE SOLUTION ========================================
 *
 *   START  (~/FREYA - START HERE.txt)
 *     |
 *     +--> L1 the biscuit tin.lock (word)  ----+--> L3 Ringing/the ringing box.lock (word) --+
 *     |                                        |                                            |
 *     |                                        +--> L5 Bird club/the bureau.lock (word) ----+--> L6 number 400.lock
 *     |                                                                                     |    (digits, final)
 *     +--> L2 Garden/the shed.lock (digits) -----> L4 Kit/telescope case.lock (dial) -------+
 *
 *   L1 and L2 are open from the start and independent. L3 and L5 take their QUESTION from L1's contents; L4 takes its
 *   question from L2's. L6 needs one piece from each of L3, L4 and L5 (plus the chat, which L4 points to).
 *
 * L1  the biscuit tin       answer "wiveton"       feature: Search in Files
 *     Prompt: Dennis has claimed a hoopoe every spring since 1988; once Len saw it too; which village?
 *     Every typed-up notebook (~/Notebooks, 14 files) has one "Dennis's hoopoe" line. Exactly one of all the hoopoe
 *     lines on the machine says "I saw it too": 1997, "Wiveton churchyard". (The committee's accepted one, Salthouse
 *     2003, is the red herring: Len "didn't see it".)
 * L2  the shed              answer "0647"          feature: sort by size
 *     Prompt: the morning Gerald (the squirrel) stayed longest: the time he arrived. ~/Garden/Feeder cam/squirrel
 *     incidents has 14 clips named "YYYY-MM-DD HHMM.mp4"; one is 1.62 GB (72 minutes), the rest 0-60 MB. Sort by
 *     size: "2026-10-17 0647.mp4". Fallback: "incident notes.md" names the Great Siege as 17 October; one clip that day.
 * L3  the ringing box       answer "senegal"       feature: two documents side by side (split / preview)
 *     Question (from L1): the country where the furthest of LEN'S birds was found. Not the group's furthest.
 *     ~/Ringing/recoveries round-up 2026.md lists 8 recoveries of the whole group with ring, country and km;
 *     ~/Ringing/ringing log 2025.csv is Len's own rings. Exact matches: ANB4417 (Holt), AKX1902 (Belgium),
 *     ALC0291 (Portugal), ALC0287 (Senegal, ~4,400 km). Traps: swallow ALC0278 (South Africa, not his: digits
 *     swapped) and Sandwich tern (Ghana, not his) are further.
 * L4  the telescope case    answer "718"           feature: Recycle Bin restore
 *     Question (from L2): the last three figures of the telescope's serial number; "the paperwork went where your nan
 *     never looks ... she doesn't read the bin". The optics receipt is in the Recycle Bin (from ~/Paperwork/receipts);
 *     restore and read: "Serial no.  61902718".
 * L5  the bureau            answer "pallid swift"  feature: hidden files (and a thing search cannot find)
 *     Question (from L1): the bird the committee took off Len's list in 2019. Minutes, letter and newsletter all
 *     refuse to name it; the only place the name exists is ~/Bird club/.appeal to the committee (draft 11).md, a
 *     dot-file, so Search in Files never finds it. (Optional side route: none; the git repo deliberately never names it.)
 * L6  number 400 (final)    answer "0512"          feature: putting it together (tide table)
 *     L3 gives where (Holkham Gap) and the tide rule: morning low water after sunrise and before 10:00.
 *     L4 gives the day rule: Saturday only (Nan home on weekdays; Freya refuses Sundays) and "while you're home".
 *     The chat (~/Phone backup/WhatsApp) gives Freya's dates: home Fri 27 Nov, back Sun 6 Dec.
 *     L5 holds the only tide page for 21 Nov - 12 Dec (Wells Bar, with sunrise).
 *     Saturdays in the window: 28 Nov (low water 03:0x / 15:2x: no) and 5 Dec (08:51, sunrise 07:4x: yes).
 *     (21 Nov also fits the tide but Freya is in Leeds; Fri 4 / Sun 6 fit the tide but fail the day rule.)
 *     Opens on: Saturday 5 December, Holkham Gap, ten to eight. Number 400 is a shore lark: the one Freya saw at six.
 *
 * Rewards: ~/.config/tauri-explorer/len.setup.json ("The round") and "dawn hide.theme.json" (both hidden).
 * Optional side route: ~/Lists/life-list is a git repository Freya set up in 2024 (main, a merged branch
 * freya/iso-dates and an unmerged club-version). Not needed for any lock.
 */
(function () {
  "use strict";
  var TX = (window.TX_FS = window.TX_FS || {});

  /* ---------------- helpers ---------------- */
  var ASSETS = "assets-escape/";
  function body(s) { return s.replace(/^\n/, "").replace(/\n$/, ""); }
  function D(name, date, kids) { return { name: name, kind: "dir", date: date, kids: kids }; }
  function T(name, date, text) { return { name: name, kind: "file", date: date, text: body(text) }; }
  function B(name, date, size, type) { var n = { name: name, kind: "file", date: date, size: size }; if (type) n.type = type; return n; }
  function IMG(name, date, file, px, size) { return { name: name, kind: "file", date: date, src: ASSETS + file, px: px, size: size }; }
  function JS(name, date, obj) { return { name: name, kind: "file", date: date, text: JSON.stringify(obj, null, 2) }; }
  function CLIP(name, date, size, duration) { return { name: name, kind: "file", type: "video", poster: ASSETS + "gerald.webp", date: date, size: size, duration: duration, px: "1920x1080" }; }
  function AUD(name, date, size, duration) { return { name: name, kind: "file", type: "audio", date: date, size: size, duration: duration }; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function hm(min) { min = ((Math.round(min) % 1440) + 1440) % 1440; return pad(Math.floor(min / 60)) + ":" + pad(min % 60); }

  /* A lock is a text file whose text is JSON (see the Lock app). ENCODE_LOCKS wraps that JSON as "TXLOCK1" + base64,
     so the real app's preview pane and Search in Files cannot read answers or contents; only flip it once the Lock app
     decodes that form. */
  var ENCODE_LOCKS = true;
  function b64(s) {
    var bytes = unescape(encodeURIComponent(s)), A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", out = "";
    for (var i = 0; i < bytes.length; i += 3) {
      var a = bytes.charCodeAt(i), b = bytes.charCodeAt(i + 1), c = bytes.charCodeAt(i + 2), n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < bytes.length ? A[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? A[n & 63] : "=");
    }
    return out.replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  }
  function LOCK(name, date, spec) {
    var json = JSON.stringify(spec, null, 2);
    return { name: name, kind: "file", date: date, text: ENCODE_LOCKS ? "TXLOCK1\n" + b64(json) : json };
  }

  var H = "/home/len";

  /* ================= the tide page (Wells Bar) and sunrise: one source of truth ================= */
  // Days are 2026 dates in GMT (= UTC in winter). The page runs Sat 21 November to Sat 12 December.
  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function utc(m, d) { return Date.UTC(2026, m - 1, d); }
  function sunriseMin(m, d) {   // NOAA approximation for Holkham (52.97 N, 0.81 E), minutes after 00:00 UTC
    var lat = 52.97 * Math.PI / 180, lon = 0.81;
    var doy = Math.round((utc(m, d) - Date.UTC(2026, 0, 1)) / 864e5) + 1;
    var g = 2 * Math.PI / 365 * (doy - 1 + (7.75 - 12) / 24);
    var eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    var dec = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    var ha = Math.acos(Math.cos(90.833 * Math.PI / 180) / (Math.cos(lat) * Math.cos(dec)) - Math.tan(lat) * Math.tan(dec)) * 180 / Math.PI;
    return 720 - 4 * (lon + ha) - eq;
  }
  // Low waters 12h25m apart (a semi-diurnal tide slips ~50 min a day), anchored on Sat 5 Dec 08:51; highs ~6h13m before.
  var LW_REF = utc(12, 5) + (8 * 60 + 51) * 6e4, CYCLE = 745;
  function tidesOn(m, d) {
    var start = utc(m, d), end = start + 864e5, lw = [], hw = [];
    for (var k = -40; k <= 40; k++) {
      var t = LW_REF + Math.round(CYCLE * k + 5 * Math.sin(k * 0.45)) * 6e4;
      var h = t - Math.round(373 + 4 * Math.cos(k * 0.37)) * 6e4;
      if (t >= start && t < end) lw.push((t - start) / 6e4);
      if (h >= start && h < end) hw.push((h - start) / 6e4);
    }
    return { lw: lw, hw: hw };
  }
  var PAGE = [];
  (function () {
    for (var i = 0; i < 22; i++) {
      var dt = new Date(utc(11, 21) + i * 864e5), m = dt.getUTCMonth() + 1, d = dt.getUTCDate(), t = tidesOn(m, d);
      PAGE.push({ day: DAYS[dt.getUTCDay()], d: d, m: m, hw: t.hw.map(hm), lw: t.lw.map(hm), sunrise: hm(sunriseMin(m, d)) });
    }
  })();
  function tidePage() {
    var out = ["| Day | Date | High water | Low water | Sunrise |", "|---|---|---|---|---|"];
    PAGE.forEach(function (r) { out.push("| " + r.day.slice(0, 3) + " | " + r.d + " " + MON[r.m - 1] + " | " + r.hw.join(", ") + " | " + r.lw.join(", ") + " | " + r.sunrise + " |"); });
    return out.join("\n");
  }
  var SAT5 = PAGE.filter(function (r) { return r.m === 12 && r.d === 5; })[0];

  /* ================= ringing: one source of truth for the log and the group's round-up ================= */
  var PLACE = {
    "Glandford (garden)": [52.928, 1.041], "Cley reedbed": [52.953, 1.055], "Cley beach": [52.963, 1.058], "Blakeney Point": [52.974, 0.913],
    "Gdańsk, Poland": [54.352, 18.646],
    "Holt, Norfolk": [52.906, 1.089], "Zwin, Knokke-Heist": [51.362, 3.360], "Lagoa de Santo André": [38.108, -8.796],
    "Djoudj National Park": [16.360, -16.270], "Ladysmith, KwaZulu-Natal": [-28.560, 29.780], "Winneba": [5.350, -0.630],
    "Sandgerði, Reykjanes": [64.040, -22.710]
  };
  function km(a, b) {
    var p = PLACE[a], q = PLACE[b], r = Math.PI / 180, dl = (q[0] - p[0]) * r, dn = (q[1] - p[1]) * r;
    var x = Math.sin(dl / 2) * Math.sin(dl / 2) + Math.cos(p[0] * r) * Math.cos(q[0] * r) * Math.sin(dn / 2) * Math.sin(dn / 2);
    return Math.round(6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)));
  }
  function fmtD(s) { var p = s.split("-"); return +p[2] + " " + MON[+p[1] - 1] + " " + p[0]; }
  function days(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 864e5); }
  // ring, species, ringed (date, place), found (date, place), country, circumstances
  var RECOVERIES = [
    ["ALC0278", "Swallow", "2025-08-06", "Cley reedbed", "2026-01-30", "Ladysmith, KwaZulu-Natal", "South Africa", "caught at a roost by a ringer; released"],
    ["SR17304", "Sandwich Tern", "2024-06-22", "Blakeney Point", "2026-01-14", "Winneba", "Ghana", "caught on the beach; ring read and released"],
    ["ALC0287", "Sedge Warbler", "2025-08-09", "Cley reedbed", "2026-01-21", "Djoudj National Park", "Senegal", "caught by a ringer; released"],
    ["ALC0291", "Reed Warbler", "2025-08-16", "Cley reedbed", "2025-09-21", "Lagoa de Santo André", "Portugal", "caught by a ringer; released"],
    ["EX40926", "Turnstone", "2024-11-02", "Cley beach", "2025-05-17", "Sandgerði, Reykjanes", "Iceland", "ring read in the field"],
    ["GDANSK FS71203", "Black-headed Gull", "2019-06-11", "Gdańsk, Poland", "2026-02-08", "Cley beach", "England", "ring read in the field (a Polish bird found here)"],
    ["AKX1902", "Lesser Redpoll", "2025-03-29", "Glandford (garden)", "2025-10-18", "Zwin, Knokke-Heist", "Belgium", "caught by a ringer; released"],
    ["ANB4417", "Blue Tit", "2025-01-12", "Glandford (garden)", "2026-02-03", "Holt, Norfolk", "England", "killed by a cat"]
  ];
  function roundUp() {
    var rows = RECOVERIES.map(function (r) {
      return "| " + r[0] + " | " + r[1] + " | " + fmtD(r[2]) + ", " + r[3] + " | " + fmtD(r[4]) + ", " + r[5] + " | " + r[6] + " | " + km(r[3], r[5]).toLocaleString("en-GB") + " | " + days(r[2], r[4]) + " | " + r[7] + " |";
    });
    return body(`
# Glaven Ringing Group: recoveries round-up, 2026

Compiled by Pat Moss for The Turnstone, from the BTO's reports up to the end of October.

Ringers' initials have been left off this year, at the request of a member who would rather not be congratulated in the Spar. Members know their own rings.

| Ring | Species | Ringed | Found | Country | km | Days | How |
|---|---|---|---|---|---|---|---|
${rows.join("\n")}

## Notes
- The swallow is the group's furthest ever. Well done to its ringer, who knows who she is.
- The Sandwich tern was ringed as a chick on the Point and is now, apparently, wintering better than any of us.
- The gull is not ours. It is Polish. It has been coming to Cley beach for six winters and has better attendance than the committee.
- Distances are straight lines. The birds did not go in straight lines. Nor would you.
`);
  }
  var RINGING_LOG = `
ring,species,age,sex,date,site,wing_mm,mass_g,notes
ANB4411,Blue Tit,4,F,2025-01-12,Glandford (garden),64,11.0,
ANB4412,Great Tit,5,M,2025-01-12,Glandford (garden),77,18.6,bit me. customary
ANB4413,Coal Tit,4,-,2025-01-12,Glandford (garden),61,9.4,
ANB4414,Blue Tit,5,M,2025-01-12,Glandford (garden),66,11.2,
ANB4415,Long-tailed Tit,4,-,2025-01-12,Glandford (garden),60,8.1,one of nine. the other eight watched
ANB4416,Dunnock,4,-,2025-01-12,Glandford (garden),70,20.3,
ANB4417,Blue Tit,5,F,2025-01-12,Glandford (garden),63,10.9,
AKX1901,Lesser Redpoll,5,M,2025-03-29,Glandford (garden),71,10.8,on the nyjer
AKX1902,Lesser Redpoll,5,F,2025-03-29,Glandford (garden),70,10.4,on the nyjer
AKX1903,Goldfinch,4,M,2025-03-29,Glandford (garden),82,16.5,
AKX1904,Chiffchaff,4,-,2025-04-26,Glandford (garden),60,7.6,
AKX1905,Blackcap,4,M,2025-04-26,Glandford (garden),74,18.9,sang in the bag. full marks
ALC0283,Reed Warbler,3J,-,2025-08-02,Cley reedbed,65,11.8,group session
ALC0284,Cetti's Warbler,3,-,2025-08-02,Cley reedbed,59,12.6,shouted at me
ALC0285,Sedge Warbler,3J,-,2025-08-02,Cley reedbed,65,12.2,
ALC0286,Sedge Warbler,3,-,2025-08-02,Cley reedbed,66,13.9,fattening
ALC0287,Sedge Warbler,3,-,2025-08-09,Cley reedbed,66,11.0,fat score 3. off to Africa on that
ALC0288,Reed Warbler,3,-,2025-08-09,Cley reedbed,66,12.0,
ALC0289,Bearded Tit,3J,M,2025-08-09,Cley reedbed,61,14.2,said good morning to it out loud
ALC0290,Sedge Warbler,3J,-,2025-08-16,Cley reedbed,64,11.6,
ALC0291,Reed Warbler,3,-,2025-08-16,Cley reedbed,67,12.4,
ALC0292,Whitethroat,3,-,2025-08-16,Cley reedbed,72,15.1,from the brambles by the path
ANB4418,Blue Tit,3,M,2025-10-18,Glandford (garden),65,11.3,
ANB4419,Great Tit,3,F,2025-10-18,Glandford (garden),73,17.0,
ANB4420,Robin,3,-,2025-10-18,Glandford (garden),72,18.1,stayed on my finger afterwards. robins do
`;

  /* ================= locks ================= */
  var LOCK_DATE = "2026-11-16T21:";
  var TIN = {
    lock: "The biscuit tin",
    kind: "word",
    length: 7,
    prompt: "Dennis has claimed a hoopoe every spring since 1988. Once, I saw it too. Which village?",
    answer: "wiveton",
    hints: [
      "It's in my notebooks. All fourteen of the typed-up ones. I'm sorry.",
      "You don't need forty years of weather. Look for the bird, not the year. Every notebook has a Dennis's hoopoe in it.",
      "Only one of those lines says I saw it too. It was on my round, in a churchyard, at ten past six."
    ],
    opens: {
      title: "Your nan's biscuit tin",
      image: ASSETS + "tin-photo-holkham-2013.webp",
      text: body(`
No biscuits. There have not been biscuits in this tin since 1987.

Inside:

- **A photograph.** Holkham Gap, January 2013. You, six, in your dad's old red coat, pointing at the beach. Me in the background, looking the other way, at forty common scoter. Keep hold of it. It matters later.
- **A key on orange baler twine**, labelled RINGING BOX in my capitals.
- **A note, in pencil:**

> Wiveton churchyard, 22 April 1997, ten past six, the vicarage post in my hand. It was a hoopoe. I have never told Dennis I saw it, and nor will you.
>
> Two more locks open from here, and they don't mind which you do first.
>
> **The ringing box** opens on the country where the furthest of my birds was found. Not the group's furthest. Mine.
>
> **The bureau** opens on the bird the committee took off my list in 2019. I don't say its name in the house.
`),
      reveal: [H + "/Ringing", H + "/Bird club"]
    }
  };
  var SHED = {
    lock: "The shed",
    kind: "digits",
    length: 4,
    prompt: "Four figures. The morning Gerald stayed longest: the time he arrived.",
    answer: "0647",
    hints: [
      "Gerald is on camera. Every visit is a clip, and every clip is named for the moment it started.",
      "The longer he stays, the bigger the clip. One of them is enormous.",
      "The biggest clip's name is a date and a time. You want the time, four figures, no colon."
    ],
    opens: {
      title: "The shed",
      text: body(`
The padlock has been oiled. By me. Last night. Torch in my teeth.

Inside: two sacks of sunflower hearts, the bad flask, the second squirrel baffle (defeated by Gerald in one morning), and the box the telescope came in. Empty. Suspicious, if you're your nan.

Taped inside the lid:

> The telescope is in its case. On the laptop that's Kit. In the house it's under the winter duvet in the spare room, where nobody has looked since 2009.
>
> The case has three brass dials, set to **the last three figures of its serial number**.
>
> The paperwork went where your nan never looks. She reads the bank statements. She does not read the bin.
`),
      reveal: [H + "/Kit"]
    }
  };
  var RINGING_BOX = {
    lock: "The ringing box",
    kind: "word",
    length: 7,
    prompt: "A ringer's padlock. Seven letters. The tin has the question.",
    answer: "senegal",
    hints: [
      "The tin asked for the country where the furthest of MY birds was found. Not the group's furthest. Mine.",
      "The round-up lists everyone's rings; my ringing log lists only mine. Match them exactly. Every character counts: ALC0278 is not ALC0287.",
      "Mine went to Holt, Belgium, Portugal, and one much further: a sedge warbler, eleven grams. Which country?"
    ],
    opens: {
      title: "The ringing box",
      image: ASSETS + "postcard-holkham-gap.webp",
      text: body(`
Pliers. A string of A rings. A pencil worn down to the metal. Forty years of wing lengths, all to the millimetre, none of them disputed.

And a postcard of Holkham Gap: the pines, the boardwalk, the beach going on for ever. On the back, in my writing:

> **Where.** Holkham Gap. Lady Anne's Drive to the far end, the boardwalk through the pines, then east along the edge of the saltmarsh, just above the strandline.
>
> **When, part one: the tide.** The water has to be going out and gone. I want the morning low water **after sunrise and before ten o'clock**. Any earlier and we're looking in the dark. Any later and the dogs have been.
>
> What we're looking for I'm not putting on a postcard. Postcards get read. I should know.

ALC0287, if you're wondering, weighed eleven grams when I let it go in Cley reedbed, and it flew to Senegal on that. I have trouble getting to Fakenham.
`),
      reveal: [H + "/Tides"]
    }
  };
  var CASE = {
    lock: "The telescope case",
    kind: "dial",
    length: 3,
    prompt: "Three brass dials. The shed has the question.",
    answer: "718",
    hints: [
      "The shed told you: the last three figures of the telescope's serial number. It's on the receipt.",
      "I threw the receipt away. Things you throw away on a computer don't go far, as your nan found out with the Christmas card list.",
      "It's in the bin. Fish it out, put it back where it came from, and read the line that says Serial."
    ],
    opens: {
      title: "The telescope",
      image: ASSETS + "telescope-under-duvet.webp",
      text: body(`
Ninety-five millimetre objective, thirty to seventy times. I'll say no more about it in writing, as it's evidence.

Taped to the eyepiece cover:

> **When, part two: the day.**
>
> Not a weekday. Your nan is at home on weekdays and will ask why the good flask is going out at seven in the morning.
>
> Not a Sunday. You said, in writing, that you would not get up early on a Sunday for anything including the Rapture. I have taken you at your word.
>
> Saturday, then. Your nan is at aqua aerobics in Fakenham from seven.
>
> And it has to be while you're home. You told me the dates. It's in the chat; I keep everything.
`),
      reveal: [H + "/Phone backup/WhatsApp"]
    }
  };
  var BUREAU = {
    lock: "The bureau",
    kind: "word",
    length: 11,
    groups: [6, 5],
    prompt: "Two words. The tin has the question.",
    answer: "pallidswift",
    hints: [
      "The tin asked for the bird the committee took off my list in 2019.",
      "The minutes won't name it, the letter won't name it, and you won't find it by looking for it. I keep it where it can't be seen.",
      "My appeal, draft eleven, is in the Bird club folder, keeping out of sight. The bird's name begins with P."
    ],
    opens: {
      title: "The bureau",
      text: body(`
The drawer sticks. Lift, then pull.

My appeal, drafts one to ten, in pencil. (Eleven is on the laptop, out of sight, where it can't upset anybody.) And under them the page I actually came for: **the tide table** for the end of November and the start of December, Wells Bar, which lives in here because coffee can't reach it.

**When, part three: the tide page.** Times are GMT, which is what we're on. Sunrise is mine, from the almanac.

${tidePage()}

> That's everything. Where, from the ringing box. Which days, from the telescope. And this. Put them together and there's one morning.
>
> The last lock has been in my home folder since you started, being patient. It's called number 400.
`),
      reveal: [H + "/number 400.lock"]
    }
  };
  var FOUR_HUNDRED = {
    lock: "Number 400",
    kind: "digits",
    length: 4,
    final: true,
    prompt: "Which morning? Day, then month: four figures.",
    answer: "0512",
    hints: [
      "Three things decide it: where and the tide (the ringing box), which days (the telescope, and the chat), and the tide page (the bureau).",
      "Saturdays while you're home: there are two. Only one has the morning low water after sunrise and before ten.",
      "One of those Saturdays has its low water in the dark. The other is in December. Day, then month: 0 _ 1 2."
    ],
    opens: {
      title: "Number 400",
      image: ASSETS + "sketch-shore-lark.webp",
      text: body(`
**Saturday 5 December. Holkham Gap. Ten to eight.**

Lady Anne's Drive, the far end, by the boardwalk. Sunrise is ${SAT5.sunrise}. Low water is ${SAT5.lw[0]}. I'll be there from half seven with the telescope up, but you won't need it.

Number 400 is a **shore lark**.

You found one first. Holkham Gap, January 2013, while I was looking at scoter: you pulled my sleeve and said there was a sparrow with a yellow face and little horns on the beach behind us. By the time I turned round it had gone, and I wrote "F. reports" in the notebook, which is what we write when we don't quite believe somebody.

It is a pale brown lark with a yellow face, a black mask, and two tiny black feathers on its head like horns. You were six, and you described it better than the field guide does.

I've walked the other way at the Gap every winter since. Thirteen winters. I've muted Holkham on the bird news. It was never mine to tick on my own.

There are fourteen of them there this year, I'm told. I haven't looked.

Bring the good flask. It's on the dresser. Your nan will ask. Tell her it's for me.

Grandad
`),
      reveal: []
    }
  };

  /* ================= ~/.config: the two rewards ================= */
  var SETUP = { name: "The round", by: "Len Hewitt", parts: ["address", "sidebar", "preview", "status"], theme: "solarized-light", layout: "hairline-ledger", icons: "classic", view: "details", keys: { search: "Ctrl+F", goHome: "Alt+H" } };
  var DAWN_HIDE = { name: "Dawn hide", by: "Len Hewitt", dark: true, v: ["#17140f", "#221e17", "#efe3c8", "#a8987a", "#e8a25a", "#7f8f5a"] };
  var config = D(".config", "2026-11-16T20:10:00", [
    D("tauri-explorer", "2026-11-16T20:10:00", [
      JS("len.setup.json", "2026-11-16T20:05:00", SETUP),
      JS("dawn hide.theme.json", "2026-11-16T20:10:00", DAWN_HIDE)
    ])
  ]);

  /* ================= ~/Notebooks ================= */
  function nb(year, mod, text) { return T(year + " - notebook " + (year - 1975) + ".md", mod, "# Notebook " + (year - 1975) + ": " + year + "\n\n" + body(text)); }
  var notebooks = D("Notebooks", "2026-11-15T19:40:00", [
    T("how I'm typing these up.txt", "2026-11-15T19:40:00", `
Fifty notebooks, 1976 to now, in the shoebox under the stairs.

I'm typing up one a week, not in order. Fourteen done. Thirty-six to go.
Spelling corrected. Opinions left in. Anything in square brackets is me now,
not me then.

Dennis has claimed a hoopoe in every single one since 1988. I have left them
all in. Your nan says that's petty. It is.
`),
    nb(1988, "2026-09-06T20:10:00", `
- 9 Jan. Round took till eleven: trees still down on the Glandford road from October's storm. A woodcock sat in the ford and watched me post Mrs Ellery's catalogues.
- 14 Feb. Barn owl on the Wiveton bridge post, 06:05. Same post as last winter. Same owl? Same post.
- 23 Apr. Dennis Pike's first hoopoe: Kelling Heath. "Pinkish, with a sort of hat." I was forty yards away and saw a jay. This, I suspect, is the start of something.
- 30 May. Nightjars churring at Kelling, 21:40. Took your nan. She said it sounded like a moped a long way off. She's not wrong.
- 18 Oct. Pinkfeet over the round at first light, a skein a minute for twenty minutes. Late with the post. Worth it.
`),
    nb(1991, "2026-09-13T20:30:00", `
- 7 Feb. Snow. The round took seven hours. Fieldfares in every hedge. A bittern in the Glandford ford at 05:50, standing in the road as if it were waiting for a parcel. Mrs Pratt gave me soup on the step.
- 20 Apr. Dennis's hoopoe: Salthouse, by the duck pond. He showed me a photograph. It was a photograph of a hedge. "It's in there," he said.
- 12 Jun. A bittern booming at Cley, from the East Bank. The first I've ever heard. Stood still for an hour. Missed the second delivery.
- 24 Sep. Wryneck in Cley churchyard, on the path, ant-eating. Looked at me like I was the odd one.
`),
    nb(1994, "2026-10-04T19:55:00", `
- 15 Jan. Shore lark reported on Salthouse beach. Went after the round. Dipped, by ten minutes and one spaniel. That's nine times now. It's a bogey bird.
- 2 May. Dennis's hoopoe: Blakeney Quay. "Flew off just as you arrived, Len." It always does.
- 19 Aug. Your dad (14) came on the round in the holidays. Said nothing for two hours. Then: "Is that a kestrel?" It was. Best morning of my career.
- 30 Oct. Little auks off Cley in a northerly, eleven, like clockwork toys. Hands too cold to write. This is written later.
`),
    nb(1997, "2026-08-30T20:00:00", `
- 4 Jan. Hard frost. Barn owl hunting the Glaven meadows at eight in the morning, which means it's hungry.
- 22 Apr. Dennis's hoopoe: Wiveton churchyard, 06:10, on my round. I saw it too. Pink and black and white, crest up, probing the grass by the lych gate as if it owned the parish. I had the vicarage post in my hand. I didn't tell him. I'm not going to.
- 5 Jun. Spotted flycatchers back in the Glandford mill wall. Fourth year running.
- 11 Oct. Yellow-browed warbler in Wells Woods after the round. Home in time for tea, which never happens.
`),
    nb(2000, "2026-10-11T20:15:00", `
- 1 Jan. First bird of the century: a robin on the delivery-office bike shed, 05:31. Dennis says his was a hoopoe. It was January.
- 29 Apr. Dennis's hoopoe: Weybourne, on the old camp. A mistle thrush, in good light, from where I stood.
- 17 Jul. Swifts screaming round Cley church, thirty-four. I count them every July. I always will.
- 3 Nov. Snow buntings on Salthouse beach, sixty. Lovely. Not a shore lark among them. I looked at every one.
`),
    nb(2003, "2026-10-18T19:30:00", `
- 8 Apr. Dennis's hoopoe: Salthouse churchyard. Accepted by the records committee, which he chairs. I didn't see it. Nobody saw it. It's in the county report now, so it must be true.
- 7 Jun. Your dad married your mum. Three swifts over the church during the vows. I counted them. Your nan saw me counting.
- 23 Sep. Red-backed shrike at Blakeney Point. Walked the shingle both ways. My knees have written to complain.
`),
    nb(2006, "2026-11-01T20:40:00", `
- 14 Mar. F. born, 05:50, Norwich. Seven pounds two. First chiffchaff of the year at Glandford, 07:10, on the way home from the hospital. [I have never said which I wrote down first. Look at the times.]
- 26 Apr. Dennis's hoopoe: Letheringsett, on the lawn at the Hall. The Hall says it was one of their peacocks.
- 9 Dec. Dipped shore lark at Titchwell, by a morning. Eleven.
`),
    nb(2009, "2026-11-08T19:45:00", `
- 2 Jan. F. (2) says "duck" at everything, including the cat. Wrong about the cat.
- 21 Apr. Dennis's hoopoe: Cley windmill. It was a jay. I have a photograph of it being a jay.
- 13 Jun. Four spoonbills at Cley, asleep, as spoonbills always are when you've driven to see them.
- 28 Oct. Pallas's warbler in Wells Woods. A little lemon in the pines. Bird of the autumn.
`),
    nb(2011, "2026-09-20T20:20:00", `
- 15 Jan. Dipped shore lark, Cley Eye. Fourteenth time. I've started a tally on the inside cover.
- 18 Apr. Dennis's hoopoe: Glandford ford. It was a leaf. A big leaf, I'll grant him.
- 3 Jul. F. (5) on the round with me in the school holidays, in the van. Asked the name of every bird. Asked the name of every cow.
- 1 Sep. Pied flycatcher in my own garden. Sat on the washing line like a postcard.
`),
    nb(2013, "2026-11-14T21:05:00", `
- 19 Jan. Holkham Gap with F. (6), in her dad's old red coat. Common scoter off the Gap, 40+, one velvet among them. F. pulled my sleeve: "a sparrow with a yellow face and little horns" on the beach behind us. Turned round: nothing. Wrote: F. reports. [I shouldn't have written that.]
- 27 Apr. Dennis's hoopoe: Holt, on a roof, at night. He has bought a torch.
- 22 Dec. Waxwings in the Holt Tesco car park, thirty, eating the ornamental rowans. Your nan did the big shop. I did not.
`),
    nb(2016, "2026-10-25T20:00:00", `
- 10 Jan. Holkham. At the Gap I walked west, to the pines. I go west at the Gap now.
- 24 Apr. Dennis's hoopoe: Morston, during the cricket. Nobody stopped the cricket.
- 6 Aug. Twenty-two little egrets roosting at Cley. When I started there weren't any. Some things get better.
`),
    nb(2019, "2026-10-28T21:15:00", `
- 25 Apr. Dennis's hoopoe: Stiffkey. He sent a photograph. The photograph is of a jay. That is four photographs of jays in thirty years.
- 14 May. Dauke's Hide, 06:20. [I'm not writing it here either. See the appeal. Don't see the appeal.]
- 30 Aug. Last round. Forty years: Cley, Wiveton, Glandford. Barn owl on the Wiveton bridge post at 05:58, as if somebody had told it.
`),
    nb(2022, "2026-11-02T20:30:00", `
- 16 Apr. Dennis's hoopoe: Kelling Heath again. "It's come back." It hasn't, Dennis. It never came.
- 2 Jul. Bempton with your nan. The albatross was still there, sitting on the cliff among the gannets. Your nan said "it's a big gull". [It is not a big gull.]
- 9 Oct. F. (16) taught me to take a screenshot. Then how to delete forty screenshots.
`),
    nb(2025, "2026-11-09T19:50:00", `
- 19 Apr. Dennis's hoopoe: Cley, by ear. "Heard it, Len." From inside his car. With the radio on.
- 12 May. Nest box 2: nine eggs.
- 9 Aug. Sedge warbler in Cley reedbed, ALC0287, eleven grams. Off you go.
- 3 Oct. A grey squirrel on the feeder, looking at me. I have named him Gerald, because you name your enemies.
`)
  ]);

  /* ================= ~/Hide logbooks ================= */
  var hides = D("Hide logbooks", "2026-01-25T16:00:00", [
    T("Dauke's Hide, Cley - May 2019 (photographed, typed).txt", "2019-05-26T18:30:00", `
DAUKE'S HIDE LOGBOOK, May 2019. Photographed on my phone, typed up by me.
Spelling as found. (L.H.)

08 May  Avocets 26, Ruff 4, Temminck's stint 1 (Pat's Pool, west end)   - P. Moss
09 May  Wood sandpiper 2. Nice!!                                          - "the Clarks, Leicester"
10 May  Hobby hawking over the reeds. Also Temminck's still           - L.H.
11 May  HOOPOE flew over towards Walsey Hills (prob.)                     - D.P.
11 May  No it didn't                                                      - several hands

[page for 12 to 18 May torn out]
[pencil, inside the cover: "Who tore the page out?" - D.P.
                           "Not me." - L.H.
                           "It was him." - D.P.
                           "It was the wind." - L.H.]

19 May  Spoonbill 1 asleep. Typical.                                      - anon
21 May  Little gull, first-summer                                         - P. Moss
22 May  Is there a toilet                                                 - unsigned
`),
    T("Island Hide, Titchwell - January 2026 (typed).txt", "2026-01-25T16:00:00", `
ISLAND HIDE, TITCHWELL. Logbook, January 2026. Typed from photos. (L.H.)

03 Jan  Brent geese 400+, Water pipit on the freshmarsh                   - M. Ellery
06 Jan  Twite 7 on the saltmarsh. Hooray                                  - S. & R. Okafor
09 Jan  SWALLOW 1 over the reedbed                                        - D.P.
09 Jan  In January?                                                       - pencil
09 Jan  It was a swallow-shaped crisp packet                              - different pencil
11 Jan  Marsh harriers 6 going to roost                                   - P. Moss
14 Jan  HOOPOE (heard)                                                    - D.P.
14 Jan  He's doing it in January now                                      - pencil
20 Jan  Spotted redshank 1. Golden plover 2,000+ up at once. Bliss        - L.H.
24 Jan  Please could the person eating egg sandwiches stop                - unsigned
`)
  ]);

  /* ================= ~/Bird club ================= */
  var TURNSTONE = `
# The Turnstone
Newsletter of the Glaven Valley Bird Club. Autumn 2026. Editor: Pat Moss.

## From the Chair
Thank you to everybody who came to the AGM, and to Mr Hewitt for the flapjack, which was submitted with a full description and accepted unanimously.

## The hoopoe
Mr Pike reports his annual hoopoe, this year at Cley, by ear, from his car. He asks us to point out that this is the thirty-ninth consecutive spring. We point it out.

## Members' lists, 2026
| Member | British list | Since |
|---|---|---|
| L. Hewitt | 398* | 1976 |
| D. Pike | 371 | 1979 |
| M. Ellery | 344 | 1988 |
| P. Moss | 302 | 1995 |
| S. Okafor | 211 | 2019 |

*399 according to Mr Hewitt. See the minutes of July 2019. Correspondence on this matter is closed. Mr Hewitt has asked us to say that he is not bitter, and we say it.

## Ringing
The group's recoveries round-up is on the club laptop and in members' inboxes. A swallow has reached South Africa, a sedge warbler Senegal, and a Polish gull has reached Cley, again.

## Small ads
- FOR SALE: telescope, Opticron, 1998, "well loved". Apply L. Hewitt. **Withdrawn: part-exchanged.** (Part-exchanged for what, Len? - Ed.)
- WANTED: a squirrel baffle that works. Apply L. Hewitt. Urgently.

## Dates
- Sat 28 November: no field meeting (it's Maureen Hewitt's seventieth, and half the club is going).
- Sat 12 December: Christmas social, the Bell. Bring a plate. Dennis, bring a different plate.
`;
  var MINUTES_2019 = `
# Glaven Valley Bird Club: Records Committee
Minutes of the meeting held 9 July 2019, at the Chair's house.

Present: D. Pike (Chair), M. Ellery, P. Moss (Secretary), H. Gurney, R. Baines, T. Self, A. Clarke.

1. Apologies: none.
2. Minutes of the last meeting: agreed.
3. Records for 2018: all accepted, except the hoopoe, which the Chair withdrew "for now".
4. **Record 2019/031.** Cley, Dauke's Hide, 14 May 2019, 06:20, observer L. Hewitt. Four minutes, with direct comparison. Full written description, no photograph. **Not accepted**, four votes to three. The Chair abstained, audibly.
   At the Secretary's request the species is not named in these minutes, "to spare everybody".
5. Any other business: the hide logbook at Dauke's is missing a page. Nobody knows anything.

Next meeting: October.
`;
  var MINUTES_2026 = `
# Glaven Valley Bird Club: Annual General Meeting
Minutes. 14 October 2026, Wiveton village hall.

1. Chair's report: membership up to 61. Thanks to the tea rota.
2. Treasurer's report: £1,214.30 in the account. The squirrel baffle fund is closed.
3. Motion (D. Pike): that the club recognise a new records category, "claimed, heard". Not seconded.
4. Motion (M. Ellery): that the club stop discussing Mr Pike's hoopoe at meetings. Carried, 40 votes to 1.
5. Any other business:
   - Mr Hewitt asked whether the Records Committee would reconsider record 2019/031. The Chair said no. Mr Hewitt said he was not bitter. This is minuted at his request.
   - Mr Pike said he had heard a hoopoe on the way in. The meeting moved on (see item 4).
   - Mr Hewitt announced that he is "one off four hundred and has been for five years, on purpose". Asked to explain, he said he would explain in December.
`;
  var DECISION = `
GLAVEN VALLEY BIRD CLUB - RECORDS COMMITTEE

12 July 2019

Dear Mr Hewitt,

Record 2019/031: Cley, Dauke's Hide, 14 May 2019

Thank you for your submission. The committee considered it at length on 9 July.

The description was careful, detailed, and in places very persuasive. On
balance the committee felt that, without a photograph, it could not entirely
eliminate the commoner species, and the record has not been accepted.

This is not a judgment on you as an observer. We know who walked the round.

Yours sincerely,

Pat Moss (Secretary)

p.s. Len, the Chair has asked me to add that he "had a feeling". I have added it.
`;
  var APPEAL = `
# Appeal to the Records Committee: record 2019/031 (draft 11)

Not sent. Ten drafts in the bureau. This one stays here, out of sight, because your nan has said that if I bring this bird up at the table one more time she'll put me in the bin with the receipts.

**Species: Pallid Swift** (*Apus pallidus*)
Cley, Dauke's Hide, over Pat's Pool. 14 May 2019, 06:20 to 06:24. Light: overcast, even, perfect. Observer: L. Hewitt.

With thirty-odd common swifts for direct comparison, all the time, at the same range:

- paler and browner all over, the colour of milky tea, not soot;
- a big pale throat patch, much larger than on the common swifts beside it;
- scaly underneath: pale edges to the body feathers, visible at twenty metres;
- a dark mask round the eye in a paler face;
- a darker saddle contrasting with paler inner wing;
- blunter wing tips, a broader head, and a slower, floppier way of flying, with more gliding.

I have counted swifts over Cley church every July for forty years. I know what a common swift looks like. This was not one.

I am not bitter.

L.H.

p.s. (not for sending) The committee voted four to three. Dennis abstained. He abstained with his eyebrows.
`;
  var birdClub = D("Bird club", "2026-11-16T21:30:00", [
    LOCK("the bureau.lock", LOCK_DATE + "30:00", BUREAU),
    T("The Turnstone - Autumn 2026.md", "2026-10-30T10:00:00", TURNSTONE),
    T("records committee minutes - July 2019.md", "2019-07-11T09:00:00", MINUTES_2019),
    T("AGM minutes - October 2026.md", "2026-10-16T18:20:00", MINUTES_2026),
    T("letter from the Secretary - 2019.txt", "2019-07-12T17:40:00", DECISION),
    T(".appeal to the committee (draft 11).md", "2026-02-11T22:50:00", APPEAL),
    T("hoopoe sweepstake 2027.csv", "2026-10-14T21:30:00", `
member,village,stake,note
M. Ellery,Kelling,£1,"he likes Kelling"
P. Moss,Cley,£1,"by ear again"
S. Okafor,Holt,£1,"roofs"
R. Baines,Blakeney,£1,
L. Hewitt,none,£2,"He'll say he heard it. Doesn't count as a place."
T. Self,Salthouse,£1,"the one that was accepted"
D. Pike,(not allowed to enter),£0,"conflict of interest"
`)
  ]);

  /* ================= ~/Ringing ================= */
  var ringing = D("Ringing", "2026-11-16T21:20:00", [
    LOCK("the ringing box.lock", LOCK_DATE + "20:00", RINGING_BOX),
    T("ringing log 2025.csv", "2025-10-18T14:30:00", RINGING_LOG),
    T("recoveries round-up 2026.md", "2026-11-02T09:15:00", roundUp()),
    T("ringing, for Freya.md", "2026-11-16T19:00:00", `
# Ringing, for Freya

You catch a bird in a fine net, very carefully, and put a tiny metal ring on its leg. Each ring has its own number, and nobody else in the world has that number.

You measure the wing, weigh it, write it all down, and let it go. Takes a minute. The bird is more annoyed than hurt, and some of them bite (great tits; it's personal).

If anyone anywhere catches it again, or finds it, they send the number to the BTO, and the BTO tells the ringer. That's a "recovery". It is the best post I ever get, and I used to deliver the post.

I've had a ringing permit since 1984. My own rings are in my log. The group's recoveries come out once a year in a round-up, all of us mixed together.
`)
  ]);

  /* ================= ~/Garden ================= */
  var CLIPS = [
    ["2026-09-28 0712.mp4", "2026-09-28T07:12:00", "18.4 MB", "1:06"],
    ["2026-10-02 0751.mp4", "2026-10-02T07:51:00", "7.9 MB", "0:28"],
    ["2026-10-03 0659.mp4", "2026-10-03T06:59:00", "41.2 MB", "2:31"],
    ["2026-10-09 1403.mp4", "2026-10-09T14:03:00", "12.6 MB", "0:46"],
    ["2026-10-11 0730.mp4", "2026-10-11T07:30:00", "56.3 MB", "3:27"],
    ["2026-10-14 0718.mp4", "2026-10-14T07:18:00", "23.0 MB", "1:24"],
    ["2026-10-17 0647.mp4", "2026-10-17T06:47:00", "1.62 GB", "72:14"],
    ["2026-10-21 1132.mp4", "2026-10-21T11:32:00", "4.1 MB", "0:15"],
    ["2026-10-26 0805.mp4", "2026-10-26T08:05:00", "33.8 MB", "2:04"],
    ["2026-10-30 0722.mp4", "2026-10-30T07:22:00", "9.7 MB", "0:35"],
    ["2026-11-02 1305.mp4", "2026-11-02T13:05:00", "0 B", "0:00"],
    ["2026-11-06 0741.mp4", "2026-11-06T07:41:00", "47.5 MB", "2:54"],
    ["2026-11-11 0709.mp4", "2026-11-11T07:09:00", "15.1 MB", "0:55"],
    ["2026-11-15 0736.mp4", "2026-11-15T07:36:00", "28.9 MB", "1:46"]
  ];
  var garden = D("Garden", "2026-11-16T21:10:00", [
    LOCK("the shed.lock", LOCK_DATE + "10:00", SHED),
    D("Feeder cam", "2026-11-15T07:38:00", [
      D("squirrel incidents", "2026-11-15T07:38:00", CLIPS.map(function (c) { return CLIP(c[0], c[1], c[2], c[3]); }).concat([
        IMG("Gerald (still).webp", "2026-10-17T07:02:00", "gerald.webp", "1920x1080", "412 KB"),
        T("incident notes.md", "2026-11-15T08:00:00", `
# Squirrel incidents, autumn 2026

The camera starts recording when something lands on the feeder and stops when it leaves. Each clip is named for the moment it started.

- **Suspect:** grey squirrel, male, one notched ear. Known as Gerald.
- **Baffle 1** (the cone): defeated 3 October. He went round it.
- **Baffle 2** (the dome): defeated 11 October. He went over it.
- **The Great Siege**, 17 October: he arrived before I was up, sat in the feeder like a man in a bath, and ate the lot. I watched most of it from the kitchen in my dressing gown, as I had run out of ideas.
- **Baffle 3** (the slinky on the pole, as recommended by the internet): installed 21 October. He sat and looked at it for fifteen seconds and left. Ongoing.
- 2 November: the camera recorded nothing for a whole clip. I think it was a leaf. Gerald would like it known it wasn't him.
`)
      ]))
    ]),
    D("Nest box cam", "2026-06-02T19:00:00", [
      T("box 2 (blue tits) - spring 2026.csv", "2026-06-02T19:00:00", `
date,event,count,note
2026-03-30,first moss carried in,,the camera is working. so is she
2026-04-12,cup lined (feathers),,one of them is a pigeon feather. ambitious
2026-04-19,first egg,1,
2026-04-28,clutch complete,10,ten. she has not been told about cost of living
2026-04-29,incubation starts,10,
2026-05-12,first hatched,3,
2026-05-13,hatched,9,one egg did not hatch
2026-05-20,eyes open,9,they look like small angry old men
2026-05-30,first fledged,4,
2026-05-31,fledged,9,all nine. I had a little sit down
2026-06-02,box empty,0,cleaned out in September (it's the law: not before)
`),
      IMG("box 2 - day 12.webp", "2026-05-24T10:14:00", "nestbox-cam.webp", "1280x960", "188 KB")
    ])
  ]);

  /* ================= ~/Kit ================= */
  var kit = D("Kit", "2026-11-16T21:25:00", [
    LOCK("telescope case.lock", LOCK_DATE + "25:00", CASE),
    T("flask policy.md", "2014-11-02T18:00:00", `
# Flask policy

**The good flask.** Green, steel, 1994. Keeps tea hot for eleven hours, which I have tested, twice, with a thermometer. Never goes out without me. Never lent. Not to Dennis, not to your dad, not to the vicar, who asked.

**The bad flask.** Tartan. The cup leaks. Lives in the shed. For the shed, and for Dennis.

**The new cup for the bad flask** did not fix the bad flask. The bad flask is not to be fixed. It has accepted what it is.
`),
    T("the bag - winter.md", "2025-11-30T20:00:00", `
# What goes in the bag (winter)

- Binoculars (8x42, the old ones, they're fine)
- Notebook, two pencils (pens freeze)
- The good flask (see policy)
- Two bacon rolls, wrapped in foil, wrapped in a tea towel
- Hat, gloves, the other gloves
- Fifty pence for the toilets at Holkham. Two quid for the car park. Four quid for the car park. I don't know any more
- A biscuit for whoever I'm with
- Not the telescope. The telescope does not exist. (Your nan.)
`)
  ]);

  /* ================= ~/Lists (and the git repository) ================= */
  var REPO = H + "/Lists/life-list";
  var lists = D("Lists", "2026-11-14T21:00:00", [
    T("life list - summary.md", "2026-11-14T21:00:00", `
# Life list: summary

British list, by the BOU's rules, birds seen by me, wild, alive, in Britain. Heard-only does not count. (Dennis.)

| Decade | Added | Running total |
|---|---|---|
| 1976-79 | 168 | 168 |
| 1980s | 97 | 265 |
| 1990s | 64 | 329 |
| 2000s | 41 | 370 |
| 2010s | 28 | 398 |
| 2020s | 1 | 399 |

- **No. 398.** 14 May 2019, Cley. (See appeal. Don't see appeal.) The club says this one doesn't count, which is why the club says 398.
- **No. 399.** Black-browed albatross, Bempton Cliffs, July 2021, sitting among the gannets as if it had always been there.
- **No. 400.** Nothing since 2021. People ask why. I tell them it's my knees.
`),
    T("round list 1979-2019.md", "2019-09-01T10:00:00", `
# The round list

Birds seen or heard from the post round (Cley, Wiveton, Glandford, and the lane back to Holt), 1979 to 2019, during working hours, while carrying post. Seen from the van counts. Seen from the pub does not.

**Total: 142.**

Some of them:
- **Barn owl**, Wiveton bridge post. Roughly four thousand mornings. Several owls, one post.
- **Bittern**, Glandford ford, 05:50, February 1991, standing in the road as if waiting for a parcel.
- **Hoopoe**, Wiveton churchyard, 1997. Don't tell Dennis.
- **Woodcock**, the ford again. The ford was good to me.
- **Red kite**, 2014, the first over the round. Now there are dozens. Your nan calls them "the new pigeons".
- **Swifts**, Cley church, every July, counted.
- **Pinkfeet**, every October, too many to count, so I didn't.

Best bird: the bittern. Best morning: your dad, 1994, "Is that a kestrel?"
`),
    T("bogey birds.md", "2026-11-14T21:10:00", `
# Bogey birds

A bogey bird is one you keep missing. You go, it's gone. You go again, it was there yesterday.

## Former bogey birds (got them in the end)
- Corncrake: nine tries. Islay, 1996, in a nettle bed, shouting.
- Dotterel: four tries. The fields at Choseley, three springs running, and then Cairngorm, 2001, in fog. My knees still remember.
- Long-eared owl: eleven years of looking in the wrong hawthorn.
- Bean goose: two hundred thousand pinkfeet and one bean goose. 2008.

## Current bogey birds
1. (I'm not writing this one down. Some people know. One of you was there.)
`),
    T("MyEBirdData.csv", "2026-11-15T09:30:00", `
Submission ID,Common Name,Scientific Name,Count,State/Province,County,Location,Date,Time,Protocol,Duration (Min),Observation Details
S217704412,Eurasian Blue Tit,Cyanistes caeruleus,6,GB-ENG,Norfolk,Glandford--garden,2026-11-15,07:30 AM,Stationary,45,
S217704412,Great Tit,Parus major,3,GB-ENG,Norfolk,Glandford--garden,2026-11-15,07:30 AM,Stationary,45,one ringed. ANB4419. hello again
S217704412,European Goldfinch,Carduelis carduelis,11,GB-ENG,Norfolk,Glandford--garden,2026-11-15,07:30 AM,Stationary,45,
S217704412,Eurasian Robin,Erithacus rubecula,1,GB-ENG,Norfolk,Glandford--garden,2026-11-15,07:30 AM,Stationary,45,same robin. sits on the spade
S217704412,Dunnock,Prunella modularis,2,GB-ENG,Norfolk,Glandford--garden,2026-11-15,07:30 AM,Stationary,45,
S217704412,Eurasian Nuthatch,Sitta europaea,1,GB-ENG,Norfolk,Glandford--garden,2026-11-15,07:30 AM,Stationary,45,
S217704412,Great Spotted Woodpecker,Dendrocopos major,1,GB-ENG,Norfolk,Glandford--garden,2026-11-15,07:30 AM,Stationary,45,on the suet. the squirrel watched
S217704412,Common Wood-Pigeon,Columba palumbus,X,GB-ENG,Norfolk,Glandford--garden,2026-11-15,07:30 AM,Stationary,45,X. I won't count them. they're not going anywhere
S217704412,Red Kite,Milvus milvus,2,GB-ENG,Norfolk,Glandford--garden,2026-11-15,07:30 AM,Stationary,45,over
S217704412,Pink-footed Goose,Anser brachyrhynchus,640,GB-ENG,Norfolk,Glandford--garden,2026-11-15,07:30 AM,Stationary,45,"skeins over going to the beet fields, counted in tens"
S217531009,Western Barn Owl,Tyto alba,1,GB-ENG,Norfolk,Wiveton--bridge,2026-11-11,06:55 AM,Stationary,15,on the post. still
S217531009,Eurasian Wren,Troglodytes troglodytes,1,GB-ENG,Norfolk,Wiveton--bridge,2026-11-11,06:55 AM,Stationary,15,
S217531009,Little Egret,Egretta garzetta,3,GB-ENG,Norfolk,Wiveton--bridge,2026-11-11,06:55 AM,Stationary,15,
S217531009,Common Redshank,Tringa totanus,14,GB-ENG,Norfolk,Wiveton--bridge,2026-11-11,06:55 AM,Stationary,15,
S217498876,Snow Bunting,Plectrophenax nivalis,28,GB-ENG,Norfolk,Salthouse--beach car park,2026-11-08,08:05 AM,Traveling,60,on the shingle. a man fed them seed. I said nothing
S217498876,Brant,Branta bernicla,210,GB-ENG,Norfolk,Salthouse--beach car park,2026-11-08,08:05 AM,Traveling,60,eBird calls them Brant. they are brent geese
S217498876,Eurasian Curlew,Numenius arquata,6,GB-ENG,Norfolk,Salthouse--beach car park,2026-11-08,08:05 AM,Traveling,60,
S217498876,Dovekie,Alle alle,2,GB-ENG,Norfolk,Salthouse--beach car park,2026-11-08,08:05 AM,Traveling,60,"north, fast, low. eBird calls them Dovekies. they are little auks. also a grey squirrel in the car park; eBird does not want to know"
`),
    D("life-list", "2026-11-14T21:40:00", [
      T("README.md", "2026-11-14T21:40:00", `
# Life list

Grandad's British list. Under version control since February 2024, so nothing gets lost and you can see every change. (Freya)

It is not a "database". It is a list. (Len)

## Rules
- One row per species. Date, place, notes.
- Edit the spreadsheet, then commit. Write what you changed and why.
- Number 400 is to be entered by nobody but me, and not before I've seen it with the person it's owed to. (Len)
`),
      T("NOTES.md", "2026-11-14T21:38:00", `
# Notes

- Total: 399. (The club's figure is 398. The club is welcome to its own branch.)
- Dates are now YYYY-MM-DD, at Freya's insistence. 14th May 2019 had a ring to it. 2019-05-14 sounds like a parcel.
- The falcons go after the birds of prey, where they have always been. A committee somewhere has put them next to the parrots. I have put them back.
- Nothing added since July 2021. On purpose.
- Bring the good flask.
`),
      B("life list.ods", "2026-03-03T19:05:00", "61 KB", "file")
    ])
  ]);

  /* ================= ~/Paperwork ================= */
  var RECEIPT = `
GLAVEN VALLEY OPTICS
High Street, Holt, Norfolk
VAT reg. 318 4471 02

RECEIPT                                   7 March 2026, 10:12
Customer: L. Hewitt (cash and card)

1  Swarovski ATX eyepiece module 30-70x      2,395.00
1  Swarovski 95 mm objective module          1,825.00
   Serial no.  61902718   (one number for the pair, as sold)
1  Stay-on case, ATX 95                         235.00
1  Lens cloth                                     0.00   (with our compliments)
   Part-exchange: Opticron scope, 1998,
   "well loved"                                 -40.00
                                            ---------
TOTAL                                         4,415.00

Paid:  card  2,000.00
       cash  2,415.00   (two envelopes and a Quality Street tin)

Customer asks that we do NOT post the warranty card. He will collect it.
He says he knows how the post works.

Thank you for your custom. Enjoy the view.
`;
  var paperwork = D("Paperwork", "2026-11-16T20:30:00", [
    D("receipts", "2026-10-21T15:10:00", [
      T("2025-12-20 replacement cup - for the BAD flask.txt", "2025-12-20T11:02:00", `
HOLT HARDWARE
1  Flask cup, 70 mm, tartan (nearest match)      4.99
TOTAL                                             4.99
Cash.
[It still leaks. It's not the cup. It's the flask. L.H.]
`),
      T("2026-09-02 seed, 2 x 25 kg sunflower hearts.txt", "2026-09-02T16:40:00", `
NORFOLK GRAIN & SEED, FAKENHAM
2  Sunflower hearts, 25 kg                       96.00
1  Nyjer, 5 kg                                   17.50
1  Suet pellets, 12.55 kg                        31.00
TOTAL                                           144.50
Card.
[About forty of that is Gerald's. L.H.]
`),
      T("2026-10-21 squirrel baffle (the third).txt", "2026-10-21T15:10:00", `
ORDER CONFIRMATION
1  "Guaranteed squirrel-proof" pole baffle (slinky type)   21.99
P&P                                                         3.95
TOTAL                                                      25.94
Delivered by: your local postman.
[Not me. Not any more. He was late. L.H.]
`)
    ]),
    T("Royal Mail - forty years (2019).txt", "2019-08-30T15:00:00", `
ROYAL MAIL, HOLT DELIVERY OFFICE

30 August 2019

Dear Len,

On behalf of everyone at Holt, congratulations on forty years' service, all of
them on the Cley, Wiveton and Glandford round.

In forty years you were late eleven times, by your own records, and each time
you have given us the reason in writing: "bittern", "hoopoe", "owl", "pinkfeet"
(several), "your dad", and once just "spring".

We will miss you. The barn owl on the Wiveton bridge will miss you.

With best wishes from the whole office, and a card from the van.
`),
    T("Maureen's 70th - Saturday 28th.md", "2026-11-12T20:45:00", `
# Maureen's seventieth: Saturday 28 November

- The Bell, from seven. Back room booked. Half the bird club coming (they asked; I couldn't stop them).
- Cake: Jo (lemon, NOT coffee).
- Freya home Friday 27th on the train to Norwich; I'll collect. Strike, so she's home a week and a bit.
- Speech: short. Do NOT mention the telescope. Do NOT mention birds more than twice.
- Present: the weekend in York she's wanted since 1998. Booked. Told nobody. The confirmation is in the shed, in the seed bin, where she will never look.
`)
  ]);

  /* ================= ~/Phone backup ================= */
  var CHAT = `
04/10/2026, 07:02 - Len: Good morning. A grey squirrel has defeated the baffle.
04/10/2026, 09:47 - Freya (granddaughter): grandad its 7am on a sunday why
04/10/2026, 09:47 - Freya (granddaughter): oh wait its 9.47. still
04/10/2026, 09:51 - Len: I have named him Gerald.
04/10/2026, 09:52 - Freya (granddaughter): ok gerald is my favourite family member now
17/10/2026, 08:15 - Len: <Media omitted>
17/10/2026, 08:15 - Len: He has eaten all of it.
17/10/2026, 11:30 - Freya (granddaughter): is that you in a dressing gown in the window
17/10/2026, 11:31 - Len: No.
22/10/2026, 19:20 - Freya (granddaughter): mum says you bought a telescope???
22/10/2026, 19:41 - Len: I bought a second-hand telescope for £180 from a man at the club. That is what your nan knows and it is what she will continue to know.
22/10/2026, 19:41 - Freya (granddaughter): how much was it actually
22/10/2026, 19:44 - Len: Less than a car.
22/10/2026, 19:44 - Freya (granddaughter): grandad
22/10/2026, 19:45 - Len: A small car.
22/10/2026, 19:45 - Freya (granddaughter): GRANDAD
02/11/2026, 21:10 - Len: Are you coming home for your nan's birthday.
02/11/2026, 21:34 - Freya (granddaughter): yes!! lecturers are striking (good for them) so im home fri 27th and back to leeds sun 6th
02/11/2026, 21:34 - Freya (granddaughter): get the spare room ready. or whatever room doesnt have a telescope in it
02/11/2026, 21:36 - Len: Noted. Would you come out birding with me one morning while you're home.
02/11/2026, 21:40 - Freya (granddaughter): birding is literally standing in a cold shed waiting for nothing to happen
02/11/2026, 21:40 - Freya (granddaughter): but yes ok. one morning. not a sunday. im not getting up early on a sunday for anything including the rapture
02/11/2026, 21:41 - Len: Noted.
02/11/2026, 21:41 - Freya (granddaughter): you always say noted like you're writing it down
02/11/2026, 21:41 - Len: I am writing it down.
09/11/2026, 18:05 - Freya (granddaughter): ok question. mum says you're on 399 birds and have been for like 5 years
09/11/2026, 18:06 - Freya (granddaughter): why not just go and see one more. there are LOADS of birds
09/11/2026, 18:20 - Len: I'm saving it.
09/11/2026, 18:20 - Freya (granddaughter): for what
09/11/2026, 18:31 - Len: Bring a coat when you come home.
09/11/2026, 18:31 - Freya (granddaughter): thats not an answer
09/11/2026, 18:31 - Len: Noted.
14/11/2026, 22:02 - Freya (granddaughter): btw i get a notification every time you commit to your list. you just committed a message that says "NOTES: no"
14/11/2026, 22:15 - Len: It was accurate.
17/11/2026, 10:12 - Len: I'm sending you my laptop. Special Delivery, guaranteed by 1pm tomorrow. I checked the tracking eleven times this morning and it's still at Norwich.
17/11/2026, 10:13 - Freya (granddaughter): why are you sending me your laptop
17/11/2026, 10:13 - Freya (granddaughter): grandad is this a scam. say something only grandad would say
17/11/2026, 10:20 - Len: Dennis's hoopoe.
17/11/2026, 10:20 - Freya (granddaughter): ok its you
17/11/2026, 10:21 - Len: It's a game. There's a file that says START. Everything else is for you to find. Don't ring me for clues. I won't answer, and your nan will.
18/11/2026, 12:41 - Freya (granddaughter): it came. 12.41. you're welcome royal mail
18/11/2026, 12:44 - Len: I know. I was watching the tracking.
`;
  var DENNIS = `
19/04/2025, 07:12 - Dennis Pike: Hoopoe. Cley. Heard it.
19/04/2025, 07:30 - Len: No.
19/04/2025, 07:31 - Dennis Pike: You don't know what I heard.
19/04/2025, 07:31 - Len: Neither do you.
06/04/2026, 06:58 - Dennis Pike: It's back.
06/04/2026, 07:40 - Len: It's April, Dennis. Of course it's back.
06/04/2026, 07:41 - Dennis Pike: so you admit it
06/04/2026, 07:41 - Len: No.
14/10/2026, 22:30 - Dennis Pike: What's this about "four hundred in December"?
14/10/2026, 22:52 - Len: Nothing you can claim by ear.
15/10/2026, 08:01 - Dennis Pike: Is it a hoopoe
15/10/2026, 08:01 - Len: Goodnight, Dennis.
15/10/2026, 08:02 - Dennis Pike: It's 8 in the morning
`;
  var ALERTS = `
BIRD NEWS - Norfolk, November 2026 (exported from the app. Holkham muted since January 2013.)

01 Nov 08:14  Pallas's Warbler 1 Wells Woods, by the drinking pool, mobile with tits
01 Nov 09:02  Holkham: [muted by user]
02 Nov 07:40  Rough-legged Buzzard 1 over Burnham Overy dunes, flew E
03 Nov 11:20  Grey Phalarope 1 Cley, North Scrape, showing well
05 Nov 08:55  Holkham: [muted by user]
06 Nov 07:31  Hume's Warbler 1 Holme, Firs, calling
08 Nov 08:20  Snow Bunting 28 Salthouse, beach car park; Little Auk 2 past N
09 Nov 07:48  Holkham: [muted by user]
11 Nov 10:05  Waxwing 14 Sheringham, Morrisons car park, on the berries
12 Nov 08:40  Holkham: [muted by user]
13 Nov 15:10  Hen Harrier 2 (ringtails) to roost Warham Greens
14 Nov 08:02  Holkham: [muted by user]
16 Nov 09:30  Hoopoe 1 Kelling Heath, per D. Pike (heard only) - unconfirmed
16 Nov 09:31  ...the app has asked whether you want to mute "D. Pike". You said yes.
`;
  /* ~/Phone backup/Camera: the year on the patch, 2026. Nothing here bears on a lock (no hoopoe, no shore lark,
     no squirrel times, nothing from the Gap). It is the machine's photo folder, for Tiles and the preview. */
  var CAMERA = D("Camera", "2026-11-15T08:10:00", [
    IMG("IMG_20260120_093318.jpg", "2026-01-20T09:33:18", "phone-the-good-flask.webp", "1536x1152", "842 KB"),
    IMG("the BAD flask (the new cup leaks too).jpg", "2026-01-03T10:15:00", "phone-the-bad-flask.webp", "1280x1280", "611 KB"),
    IMG("IMG_20260502_052233.jpg", "2026-05-02T05:22:33", "phone-glandford-ford.webp", "1248x936", "733 KB"),
    IMG("IMG_20260530_213009.jpg", "2026-05-30T21:30:09", "phone-kelling-heath-dusk.webp", "1536x1152", "905 KB"),
    IMG("spoonbills, Cley. Asleep. Typical.jpg", "2026-06-14T19:20:00", "phone-spoonbills-asleep.webp", "1536x1152", "788 KB"),
    IMG("IMG_20260822_203812.jpg", "2026-08-22T20:38:12", "phone-egrets-roosting.webp", "1536x1152", "861 KB"),
    IMG("IMG_20261008_071540.jpg", "2026-10-08T07:15:40", "phone-pinkfeet-at-sunrise.webp", "1536x1152", "694 KB"),
    IMG("flapjack for the AGM (one went before the vote).jpg", "2026-10-16T14:05:00", "phone-agm-flapjack.webp", "1280x1280", "702 KB"),
    IMG("baffle 3. the internet says guaranteed.jpg", "2026-10-21T15:34:00", "phone-baffle-three.webp", "1020x1360", "655 KB"),
    IMG("IMG_20261029_074406_PANO.jpg", "2026-10-29T07:44:06", "phone-marsh-panorama-first-frost.webp", "1600x544", "1.1 MB"),
    IMG("seal pups, Blakeney Point.jpg", "2026-11-04T12:40:00", "phone-seal-pups.webp", "1536x1152", "820 KB"),
    IMG("snow buntings, Salthouse (a man was feeding them).jpg", "2026-11-08T08:21:00", "phone-snow-buntings-shingle.webp", "1536x1152", "934 KB"),
    IMG("IMG_20261111_070214.jpg", "2026-11-11T07:02:14", "phone-barn-owl-on-the-post.webp", "1536x1152", "877 KB"),
    IMG("waxwings, Sheringham (through the bins).jpg", "2026-11-11T10:41:00", "phone-waxwings.webp", "1152x1536", "806 KB"),
    IMG("the robin. on the spade. as usual.jpg", "2026-11-15T07:52:00", "phone-robin-on-the-spade.webp", "1152x1536", "759 KB"),
    IMG("IMG_20261115_080311.jpg", "2026-11-15T08:03:11", "phone-woodpecker-on-the-suet.webp", "1152x1536", "812 KB"),
    T("what these are.md", "2026-11-15T08:10:00", `
# What's in Camera

Freya set the phone to put its pictures here by itself. Some I've named. The rest are called IMG and a long number, which is how the phone likes it.

- **The owl** is on the post by the bridge, 11 November, two minutes past seven. Same post. Same owl? Same post.
- **The pinkfeet**, 8 October, from the lane. I was meant to be getting milk.
- **The good flask** in the Island Hide, 20 January. Two thousand golden plover went up just after. I didn't take a picture of that. I watched it.
- **The ford**, 2 May, while the dawn chorus recorded. I stood still for twenty minutes. So did the picture.
- **Kelling Heath**, 30 May, waiting for the nightjars. Your nan was right about the moped.
- **The egrets** going to roost: thirty-one, counted. When I started on the round there weren't any.
- **The marsh from the East Bank**, first frost. A panorama: the phone makes you turn round slowly. I went too fast twice.
- **The woodpecker** on the suet. Gerald was watching from the fence. He is not in it. He would like that noted.
`)
  ]);
  var phone = D("Phone backup", "2026-11-18T12:45:00", [
    CAMERA,
    D("WhatsApp", "2026-11-18T12:45:00", [
      T("WhatsApp Chat with Freya (granddaughter).txt", "2026-11-18T12:45:00", CHAT),
      T("WhatsApp Chat with Dennis Pike.txt", "2026-10-15T08:02:00", DENNIS)
    ]),
    T("bird news - November 2026.txt", "2026-11-16T09:31:00", ALERTS)
  ]);

  /* ================= ~/Recordings ================= */
  var recordings = D("Recordings", "2026-11-15T03:40:00", [
    AUD("2026-04-11 0518 garden - blackcap and chiffchaff.m4a", "2026-04-11T05:18:00", "6.2 MB", "4:31"),
    AUD("2026-04-20 0552 Cley reedbed - bittern.m4a", "2026-04-20T05:52:00", "9.8 MB", "7:10"),
    AUD("2026-05-02 0436 Glandford ford - dawn chorus.m4a", "2026-05-02T04:36:00", "27.4 MB", "20:02"),
    AUD("2026-05-30 2147 Kelling Heath - nightjar.m4a", "2026-05-30T21:47:00", "8.1 MB", "5:55"),
    AUD("2026-10-08 0702 Cley - pinkfeet over.m4a", "2026-10-08T07:02:00", "4.4 MB", "3:12"),
    AUD("2026-11-15 0310 bedroom window - tawny owls.m4a", "2026-11-15T03:10:00", "3.9 MB", "2:51"),
    IMG("sonogram - yellowhammer, Glandford lane.webp", "2026-05-02T09:30:00", "sonogram-yellowhammer.webp", "1600x600", "96 KB"),
    T("what's on the tapes.md", "2026-11-15T03:40:00", `
# What's on the tapes

The laptop plays them through a speaker the size of a stamp, so here they are in words.

- **Blackcap and chiffchaff, garden, 11 April.** Chiffchaff says its own name, "chiff chaff chiff chiff chaff", like a dripping tap. The blackcap is the one doing the posh bit over the top.
- **Bittern, Cley, 20 April.** Three short in-breaths, then "WHOOMP. WHOOMP. WHOOMP." Like someone blowing over a very big bottle, a mile away. You feel it in your chest.
- **Dawn chorus, Glandford ford, 2 May.** Twenty minutes. Song thrush says everything twice. Wren is the loud one, absurdly loud for its size. Cetti's warbler shouts "CHET! chewee-chewee-chewee" from the reeds, once, and then won't do it again for the microphone.
- **Nightjar, Kelling, 30 May.** A churr that goes on and on, rising and falling, like a moped a long way off (your nan, 1988). Then a wing-clap.
- **Pinkfeet over, 8 October.** "Wink-wink. Wink-wink." Thousands. Not one of them in step.
- **Tawny owls, 15 November, 03:10.** Female "ke-WICK", male "hoo... hoo-hoo-hoo-hooo". Couldn't sleep. Nor could they.
- **Yellowhammer** (sonogram only, the recording's lost): "a little bit of bread and NO cheese". In your case, "no thank you".
`)
  ]);

  /* ================= ~/Tides ================= */
  var tides = D("Tides", "2026-11-16T19:30:00", [
    T("where the tide tables are.md", "2026-11-16T19:30:00", `
# Where the tide tables are

- **January to October:** the PDF. Wells Bar, from the harbour office.
- **November and December:** not here. In the bureau, where coffee can't get at it. (The October page has a ring on it. It was a mug.)

How to read one, for anybody who has never needed to:

- Two high waters and two low waters a day, more or less, each about fifty minutes later than the day before.
- **High water** covers the marsh edge and sends everything up into the dunes.
- **Low water** uncovers it, and that's when the birds come down to feed.
- Times are GMT in winter. Don't add an hour. I did, once, in 1983, and stood on Blakeney Point in the dark with a lot of water.
`),
    B("Wells Bar tide tables 2026, Jan to Oct.pdf", "2026-01-04T10:00:00", "1.3 MB", "pdf")
  ]);

  /* ================= the home folder ================= */
  var START = `
Freya,

You said birding is standing in a cold shed waiting for nothing to happen. Fair. This is that, indoors, with locks.

There are six locks on this laptop. Double-click one and it asks for its code. Every code is something you'd only know if you'd actually looked, which is the whole of birding.

Two you can try straight away: the biscuit tin is here, and the shed is in the Garden. They don't depend on each other. The others follow from what's inside. The last one, number 400, is also here, being patient.

Everything you need is on this laptop. Some of it is where your nan wouldn't look. None of it is on the internet, so don't.

When the last one opens you'll know where to be and when. I'll already be there.

Grandad

p.s. It's a game. Nobody's in trouble. Except Gerald.
`;
  var len = D("len", "2026-11-18T12:45:00", [
    T("FREYA - START HERE.txt", "2026-11-16T22:40:00", START),
    LOCK("the biscuit tin.lock", LOCK_DATE + "05:00", TIN),
    LOCK("number 400.lock", LOCK_DATE + "45:00", FOUR_HUNDRED),
    config, birdClub, garden, hides, kit, lists, notebooks, paperwork, phone, recordings, ringing, tides
  ]);
  var home = D("home", "2019-09-01T10:00:00", [len]);

  TX.escape = {
    title: "Len's laptop",
    desktop: { title: "Holkham Gap, first light" },
    users: [
      { id: "len", name: "Len Hewitt", home: H,
        blurb: "Grandad's laptop, posted to Leeds by Special Delivery. Six locks, one life list, and a bird he has been saving for thirteen winters.",
        bookmarks: [H, H + "/Notebooks", H + "/Bird club", H + "/Garden", H + "/Lists"],
        setup: { parts: [], theme: "solarized-light", layout: "default", icons: "material", view: "details", path: H } }
    ],
    tree: { name: "", kind: "dir", kids: [home] },
    trash: [
      { node: T("receipt - Glaven Valley Optics, 7 March.txt", "2026-03-07T10:12:00", RECEIPT),
        from: H + "/Paperwork/receipts", deleted: "2026-03-07T18:40:00" },
      { node: T("letter to the Secretary - draft 4 (do not send).txt", "2026-10-15T23:10:00", `
Dear Pat,

I write once more regarding record 2019/031, not because I am bitter, which I
am not, but because the Chair's "feeling" has now been in the minutes for seven
years and my description has not.

I would point out that in 2003 the committee accepted a hoopoe that nobody saw,
on the word of a man who

[stopped here. Your nan read it over my shoulder and said "Leonard."]
`), from: H + "/Bird club", deleted: "2026-10-15T23:14:00" },
      { node: T("notice to Gerald.txt", "2026-10-17T08:30:00", `
NOTICE OF EVICTION

To: Gerald (grey squirrel, one notched ear)
Re: The feeder, the bird table, the baffles (1 and 2), and my peace of mind

You are hereby given notice to quit the premises by Friday.

L. Hewitt (householder)

[Deleted. He can't read. I checked: I left it by the feeder. He ate the corner.]
`), from: H + "/Garden", deleted: "2026-10-18T07:05:00" },
      { node: B("IMG_4471 - Dennis's hoopoe, Stiffkey (it is a jay).jpg", "2019-04-25T09:12:00", "3.4 MB", "file"),
        from: H + "/Bird club", deleted: "2019-04-25T19:00:00" }
    ],
    repos: {}
  };

  /* ================= ~/Lists/life-list: Freya's repository, Len's opinions =================
     main; freya/iso-dates (merged under protest); club-version (never to be merged). */
  TX.escape.repos[REPO] = {
    branch: "main",
    commits: [
      { hash: "f1a5c40", author: "Len Hewitt", date: "2026-11-14T21:38:00", parents: ["c0ffee4"], refs: ["main"],
        msg: "NOTES: no\n\nNo, I am not writing down what number 400 is going to be. Freya gets a notification.\nAdded one line.",
        files: [{ path: "NOTES.md", status: "M", diff: "--- a/NOTES.md\n+++ b/NOTES.md\n@@ -4,3 +4,4 @@\n - The falcons go after the birds of prey, where they have always been. A committee somewhere has put them next to the parrots. I have put them back.\n - Nothing added since July 2021. On purpose.\n+- Bring the good flask." }] },
      { hash: "c0ffee4", author: "Len Hewitt", date: "2025-05-19T20:10:00", parents: ["b1ac4ed"],
        msg: "README: a rule about number 400\n\nNobody enters 400 but me. Not before I've seen it with the person it's owed to.\nFreya: this means you can't do it as a joke either.",
        files: [{ path: "README.md", status: "M", diff: "--- a/README.md\n+++ b/README.md\n@@ -6,3 +6,4 @@\n ## Rules\n - One row per species. Date, place, notes.\n - Edit the spreadsheet, then commit. Write what you changed and why.\n+- Number 400 is to be entered by nobody but me, and not before I've seen it with the person it's owed to. (Len)" }] },
      { hash: "b1ac4ed", author: "Len Hewitt", date: "2024-03-03T19:05:00", parents: ["4d0c71e"],
        msg: "taxonomy: put the falcons back\n\nSomebody has decided falcons are closer to parrots than to hawks. They may be right.\nOn this list they go with the hawks, where I've been looking for them since 1976.",
        files: [{ path: "life list.ods", status: "M" }, { path: "NOTES.md", status: "M", diff: "--- a/NOTES.md\n+++ b/NOTES.md\n@@ -2,2 +2,3 @@\n - Total: 399. (The club's figure is 398. The club is welcome to its own branch.)\n - Dates are now YYYY-MM-DD, at Freya's insistence. 14th May 2019 had a ring to it. 2019-05-14 sounds like a parcel.\n+- The falcons go after the birds of prey, where they have always been. A committee somewhere has put them next to the parrots. I have put them back." }] },
      { hash: "9c1b398", author: "Freya Hewitt", date: "2024-03-02T16:20:00", parents: ["4d0c71e"], refs: ["club-version"],
        msg: "club-version: the committee's figure (398)\n\nFor printing the club's version when they ask. Not for merging.\n(Grandad said: \"over my dead body\". He is fine. It's just not getting merged.)",
        files: [{ path: "life list.ods", status: "M" }, { path: "NOTES.md", status: "M", diff: "--- a/NOTES.md\n+++ b/NOTES.md\n@@ -1,2 +1,2 @@\n # Notes\n \n-- Total: 399. (The club's figure is 398. The club is welcome to its own branch.)\n+- Total: 398. (The club's figure. One record removed: 2019/031.)" }] },
      { hash: "4d0c71e", author: "Len Hewitt", date: "2024-02-24T10:30:00", parents: ["2e7f0a1", "5a1ee70"],
        msg: "Merge branch 'freya/iso-dates'\n\nMerged. Under protest.",
        files: [{ path: "life list.ods", status: "M" }, { path: "NOTES.md", status: "M" }] },
      { hash: "2e7f0a1", author: "Len Hewitt", date: "2024-02-18T21:15:00", parents: ["8b3d2c9"],
        msg: "NOTES: why the dates were the way they were\n\nBecause I wrote them by hand, in a notebook, in a hide, with cold fingers.",
        files: [{ path: "NOTES.md", status: "A", diff: "--- /dev/null\n+++ b/NOTES.md\n@@ -0,0 +1,3 @@\n+# Notes\n+\n+- Total: 399. (The club's figure is 398. The club is welcome to its own branch.)" }] },
      { hash: "5a1ee70", author: "Freya Hewitt", date: "2024-02-17T14:02:00", parents: ["8b3d2c9"], refs: ["freya/iso-dates"],
        msg: "dates: convert everything to ISO 8601 (YYYY-MM-DD)\n\n399 rows had dates in 11 different formats, including \"Tues, early\" and \"day after the storm\".\nThey're all YYYY-MM-DD now. You can sort them. You're welcome.",
        files: [{ path: "life list.ods", status: "M" }, { path: "NOTES.md", status: "M", diff: "--- a/NOTES.md\n+++ b/NOTES.md\n@@ -1,3 +1,4 @@\n # Notes\n \n - Total: 399. (The club's figure is 398. The club is welcome to its own branch.)\n+- Dates are now YYYY-MM-DD, at Freya's insistence. 14th May 2019 had a ring to it. 2019-05-14 sounds like a parcel." }] },
      { hash: "8b3d2c9", author: "Len Hewitt", date: "2024-02-11T09:40:00", parents: ["0a1b2c3"],
        msg: "README: corrections\n\nIt is not a database.",
        files: [{ path: "README.md", status: "M", diff: "--- a/README.md\n+++ b/README.md\n@@ -1,4 +1,6 @@\n # Life list\n \n-Grandad's British list database. Under version control since February 2024. (Freya)\n+Grandad's British list. Under version control since February 2024, so nothing gets lost and you can see every change. (Freya)\n+\n+It is not a \"database\". It is a list. (Len)" }] },
      { hash: "0a1b2c3", author: "Freya Hewitt", date: "2024-02-10T15:30:00", parents: [],
        msg: "initial commit: Grandad's life list, from the spreadsheet\n\nGrandad, this means if you delete a row by accident we can get it back.\nHe asked if it would work on the committee.",
        files: [{ path: "life list.ods", status: "A" }, { path: "README.md", status: "A" }] }
    ]
  };
})();
