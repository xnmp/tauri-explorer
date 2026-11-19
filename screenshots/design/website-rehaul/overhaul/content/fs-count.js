/* Fictional filesystem: "The Count's laptop". Castle Morvane, above the village of Nether Brindle.
 * Consumed as window.TX_FS.count. "Today" in the fiction is Thursday 19 November 2026.
 * Count Casimir Morvanescu was born on 28 November 1426. The laptop is run by his familiar, H. (Hollis) Pike.
 * Gothic comedy. Nobody dies, nobody is harmed, nobody is in danger. The only secret is a birthday party.
 *
 * ================================ SOLUTION WALKTHROUGH ================================
 * HOOK (first screen, ~/): "INCIDENT LOG - who is taking my furniture.md". Since 3 November someone opens the
 * great hall curtains, takes forty chairs, the 32-ft long table and the good candelabrum, and chalks numbers on the
 * floor. It always happens while the Count is in the library with earmuffs on during bell practice, writing to the
 * Council, and "Hollis was at choir on each occasion". The Count suspects a conspiracy. So does the visitor.
 *
 * STRANDS (independent; any two make the answer obvious; all of them converge):
 *  1. Bells. ~/village/bell-ringers/practice rota - autumn 2026.csv: Tuesdays and Thursdays, "extended (per H.)" on
 *     exactly the incident dates (the log's times are just after 22:30, the extended finish), with notes such as
 *     "Mott's van at the back gate", "bring chalk", "Gary: NOT the sausage rolls". New method since October:
 *     "Morvane Surprise Major", 600 changes, to be rung on Sat 28 Nov "when the hall lights come on".
 *  2. Choir. ~/hollis/his lordship's evenings - November.csv says Hollis is at 'choir' (in quotes) on Tuesdays and
 *     Thursdays and at choir (no quotes) on Wednesdays; ~/hollis/choir/Wednesday choir - notes.md says the choir
 *     meets on Wednesdays only. The choir is learning "Sasevek Ouri" in Old Morvanish (words, phonetic). Translate it
 *     with ~/memoirs/appendix - a glossary of Old Morvanish.md (split pane; or search a word such as "velmor"):
 *     "Six hundred winters on the hill ... come down, our lord, the long table is in the hall ... we love you".
 *  3. Cake. ~/accounts/invoices 2026/ is a long folder of look-alike numbered invoices; the biggest (sort by size)
 *     is "invoice 2026-019.txt" from Pottle's Bakery: a cake to serve 300, "NO GARLIC, obviously", six candles
 *     ("600 is a fire risk"), delivery Sat 28 Nov 18:00, kitchen door, and Agnes's note "put it behind your dot".
 *     Content search finds it too ("garlic", "cake", "300").
 *  4. Council. ~/correspondence/council/: every reply asks the Count to write more, preferably on a Tuesday or
 *     Thursday evening (stalling: keep him in the library). One reply has an internal note left in ("he must NOT
 *     come out of that library on a Tuesday"); the minutes of 10 Nov close the village hall "for furniture" and
 *     discuss "Project S". The planning dispute over his bats ends in "the statutory dusk inspection", Saturday
 *     28 November, 19:00, in the Great Hall, formal dress, lights off until the Inspector arrives: the lure.
 *  5. Birthday. ~/personal/diary - private (Hollis, do NOT read).md: "Six hundred. The village could not possibly
 *     know." ~/memoirs/drafts by century/1400s/1426 - I am born, magnificently.md: born 28 November 1426.
 *     Beetroot ledger (~/beetroot/orders - Hart's Roots, 2025-26.csv): one order of 180 L for "300 glasses",
 *     delivery 23 Nov, billed to the Village Hall fund. The immortals' mail: the Baroness "SEE YOU ON THE 28TH"
 *     then tries to unsend it; Bartholomew replies-all asking who Hollis is and why he wants him to sing.
 *  6. Recycle Bin (restore matters). "handover - in case I am dismissed before the 28th.txt" restores to
 *     ~/hollis/admin. It says everything for the 28th is "in the century he refuses to discuss, in his own
 *     memoirs. Behind a dot", explains that dotted folders need hidden files turned on, and that Hollis's own notes
 *     are "behind the dot in my folder".
 *  7. Hidden folder. ~/hollis/README - for his lordship.txt ("There is nothing behind the dot") and Agnes's invoice
 *     point at ~/hollis/.private (hidden): what we borrowed and when (matches the incident log line for line), cover
 *     stories, the guest list (300), Hollis's diary, and "where everything is.md", which names the final place.
 *     (Hollis's own setup, ~/hollis/admin/everything in its place.setup.json, turns hidden files on, too.)
 *
 * FINAL LOCATION (hidden; never reached by search): ~/memoirs/drafts by century/1700s/.28 November/
 *   The 1700s folder otherwise holds only "we do not speak of it.md" (the century he refuses to discuss; the
 *   memoir README says it was "withdrawn by the author"). Inside: invitation.webp (+ the printer's wording), the
 *   plan for the night.md, seating - the long table.csv, the present.webp (a portrait of him, exactly his age and
 *   smiling, painted by Class 3B because he does not show in photographs or mirrors), and Hollis's letter
 *   "for my lord, afterwards.md": he is loved. It is in the files.
 *
 * ================================ FEATURE -> MOMENT ================================
 *  Preview pane ......... skimming letters, invoices and selfies without opening each one
 *  Split pane ........... portrait 1611 as painted vs as repainted; bins letter 7 draft vs as sent; dating profile
 *                         draft 1 vs draft 7; choir lyrics beside the glossary (the translation strand)
 *  Search in Files ...... "garlic" / "cake" -> the bakery invoice; "velmor", "dornu" -> the glossary; "28" or
 *                         "Hollis" across the council and immortal mail; "choir" -> the Tuesday/Wednesday mismatch
 *  Quick Open ........... "glossary", "rota", "handover" (after restoring), "invoice"
 *  Sort by size ......... invoices 2026: the bakery invoice is three times the size of the rest
 *  Sort by date / CSV ... beetroot ledger (one 180 L row), castle inventory (MISSING rows), bell rota (extended rows)
 *  Recycle Bin restore .. Hollis's handover note (critical); also the Agincourt chapter and two unsent rants
 *  Hidden files ......... ~/hollis/.private and the final folder in 1700s; ~/.config holds the Count's setup/theme
 *  Miller / folder peek . memoirs/drafts by century/<century>/... (the 1700s folder that is nearly empty)
 *  Terminal (side) ...... grep -ri garlic ~, cat the rota, git log in the memoir
 *  Git graph (side) ..... ~/memoirs/memoir: branches agincourt, definitely-not-agincourt (merged), younger,
 *                         hollis/fact-check (merged "under protest")
 *  Themes / setups ...... ~/.config/tauri-explorer/ (the Count: "By candlelight", theme "Crypt, but tasteful"),
 *                         ~/hollis/admin/ (Hollis: "Everything in its place"), ~/beetroot/ ("Lower Meadow 2025")
 */
(function () {
  "use strict";
  var TX = (window.TX_FS = window.TX_FS || {});

  /* ---------------- helpers ---------------- */
  var ASSETS = "assets-count/";
  function body(s) { return s.replace(/^\n/, "").replace(/\n$/, ""); }
  function D(name, date, kids) { return { name: name, kind: "dir", date: date, kids: kids }; }
  function T(name, date, text) { return { name: name, kind: "file", date: date, text: body(text) }; }
  function B(name, date, size, type) { var n = { name: name, kind: "file", date: date, size: size }; if (type) n.type = type; return n; }
  function IMG(name, date, file, px, size) { return { name: name, kind: "file", date: date, src: ASSETS + file, px: px, size: size }; }
  function JS(name, date, obj) { return { name: name, kind: "file", date: date, text: JSON.stringify(obj, null, 2) }; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function rng(seed) { var s = seed >>> 0; return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

  /* ---------------- calendar ---------------- */
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function ymd(d) { return d.toISOString().slice(0, 10); }
  function addDays(d, n) { return new Date(d.getTime() + n * 86400000); }
  function U(s) { return new Date(s + "T00:00:00Z"); }
  function nov(day, hm) { return "2026-11-" + pad(day) + "T" + (hm || "12:00") + ":00"; }

  var H = "/home/casimir";

  /* ================= /etc ================= */
  var etc = D("etc", "2026-03-02T21:00:00", [
    T("motd", "2026-03-02T21:00:00", `
  CASTLE MORVANE - household laptop "morvane"
  Property of Count Casimir Morvanescu. Administered by H. Pike.

  - His lordship's files: wherever he left them. I have since moved them.
  - My files: hollis/. Please do not tidy them, my lord. They are tidy.
  - The laptop does not need a cloth over it at dawn. It is not a parrot.
  - Wi-Fi reaches the great hall, the library and, on a still night, the bats.
`),
    T("hostname", "2019-02-14T22:00:00", "morvane"),
    T("os-release", "2019-02-14T22:00:00", `
NAME="Morvane Linux"
PRETTY_NAME="Morvane Linux 26.04 (Battlement)"
ID=morvane
VERSION_CODENAME=battlement
HOME_URL="up the hill, past the duck pond, mind the drawbridge"
`)
  ]);

  /* ================= ~/ (the first screen) ================= */
  var HOOK = `
# INCIDENT LOG
### Being a record of the Outrages committed against Castle Morvane, its Great Hall and its furniture, in the autumn of 2026

Dictated by Casimir, Count Morvanescu. Typed by H. Pike, who would like it noted that he types what he is told.

---

**Tuesday 3 November, 22:41.** I come up from the library after the bells (earmuffs; a letter to the Council concerning the bins) and find the curtains of the Great Hall OPEN. All eleven. The sun came in at 07:12 the next morning and found me on the stairs. I do not burst into flames, whatever the films say. I come out in freckles. I now have freckles. I am of an age where one does not want freckles.

**Thursday 5 November, 22:38.** The chairs. Forty of them. The good ones, with arms. Not knocked over: *gone*. The floor where they stood is cleaner than the floor where they did not. Someone has mopped around my chairs, and then taken them.

**Tuesday 10 November, 22:45.** THE LONG TABLE. Thirty-two feet of oak, made in this hall in 1511 by eleven men and a horse. It does not fit through the door. It has never fitted through the door. It has gone through the door.

**Thursday 12 November, 22:33.** The good candelabrum: the five-branched one, silver, Augsburg, 1650. The curtains open again. And in the hall, unmistakably, a smell of sponge.

**Tuesday 17 November, 22:50.** Chalk on the floor of the Great Hall, in lines, with numbers. Someone has *measured* my hall. Hollis has copied the marks exactly (see the great hall folder). Also found: one crumb of sausage roll. Hollis denies the sausage roll.

**Wednesday 18 November, 23:10.** Not an Outrage. From the village, on the wind: singing, in the old tongue, which nobody has spoken to me since my nurse. I stood at the window for some time. Logged at Hollis's insistence; he says everything must be logged.

## Observations
- Every Outrage occurs while the bells are being practised, when I am down in the library with my earmuffs on, writing to the Council. They are timing it. They know my habits.
- Hollis was at choir on each occasion. Hollis has a great deal of choir.
- Nothing has been damaged. Things are taken and, I suspect, *cared for*. This is somehow worse.

## Suspects
1. **The Parish Council.** Motive: the bats. Opportunity: none; they are kept busy answering my letters, which they do with touching thoroughness.
2. **The bell-ringers.** Motive: my letters. Opportunity: none; they are ringing at the time. Unless they ring with one hand.
3. **Mr Mott, the roofer.** Motive: I asked him to come at midnight. Alibi: he will not set foot here after dark.
4. **The Baroness von Dammerlicht.** Motive: the matter of the borrowed gondola, 1683. Opportunity: she lives in Bavaria and cannot work her email.
5. **Mrs Pottle of the bakery.** Motive: none. But the sponge.
6. **Hollis.** [H.: I object to being on the list.] Hollis is on the list for form's sake. Hollis has never moved so much as a chair without first writing a memo about it.

Hollis has filed every scrap of evidence. Somewhere on this machine is the answer. I do not know how to find anything on it; that is what Hollis is for.

[H.: Noted.]

C.
`;

  var README_LORD = `
MY LORD: HOW THE LAPTOP WORKS (third edition)

1. It is switched on. It is always switched on. Please stop bowing to it.
2. To open something, click on it twice, quickly. Not once, slowly, with feeling.
3. Your folders are at the top of this list. Folders are where things live.
   I have made one for everything. You will find I have made one for me.
4. The square at the bottom of the screen is not a window. Do not open it for air.
5. "The cloud" is not weather. Your memoirs are in no danger of rain.
6. If a letter to the Council is longer than the Council, it is too long.
7. You do not appear in the camera. This is not the camera's fault. (See Pictures.)
8. If something seems to have gone missing, it is in a folder. I have filed it.
   I file everything. It is a condition.

H.
`;

  var PASSWORDS = `
PASSWORDS (private) (Hollis: avert your eyes)

email ................ Password1476
bank ................. Password1476
council portal ....... Password1476!   (they made me add a symbol. I chose the exclamation. It suits me)
the dating app ....... Password1476    (Hollis says this is "a red flag". It is not red. It is a number)
the Wi-Fi ............ Password1476
the beetroot website . Password1476
the drawbridge ....... Password1476    (it is a lever. one pulls it. but in spirit)
the laptop ........... Password1476

1476: the year I became Count. Nobody will ever guess it.

[H.: It is carved over the gate, my lord. In letters two feet high.]
`;

  /* ================= ~/castle ================= */
  var HALL_INVENTORY = `
item,since,maker,condition,status,note
"long table, oak, 32 ft",1511,"eleven men and a horse",sound,MISSING since Tue 10 Nov,"built in the hall; never fitted through the door"
"chairs with arms (x40)",1702,"unknown (do not ask)",good,MISSING since Thu 5 Nov,"acquired in the century we do not discuss"
"benches (x6)",1598,"the village carpenter, Tobias",wobbly,present,"nobody took the benches. I am hurt on their behalf"
"candelabrum, five-branched, silver",1650,Augsburg,polished,MISSING since Thu 12 Nov,"the good one"
"candlesticks, ordinary (x12)",1820,Sheffield,adequate,present,"left behind. a judgement?"
"curtains, velvet (eleven drops)",1890,Liberty of London,"faded, one side only",present,"OPENED Tue 3 Nov and Thu 12 Nov by persons unknown"
fireplace,1440,"stone; my great-grandfather",draughty,present,"too big to take, one assumes"
"portrait of my grandfather",1512,"after Master Hans",stern,present,"he has seen everything. he says nothing"
"suit of armour (Siegfried)",1520,Nuremberg,"one gauntlet missing since 1520",present,"moved two feet to the left, Tue 17 Nov"
"minstrels' gallery",1511,"same eleven men; same horse","rail wobbly",present,"recently swept. by whom?"
"the good rug",1880,Isfahan,"worn where I pace",present (ROLLED UP),"rolled, by persons unknown, and left very neatly"
"bat saucer",2019,Hollis,chipped,present,"water for the visiting bats; refilled daily"
"fire irons (set)",1702,"unknown (do not ask)",good,present,
"one paper star, silver",2026,unknown,new,"present (found under Siegfried, Tue 17 Nov)","filed by Hollis. Hollis files everything"
`;

  var LONG_TABLE = `
# The long table: provenance

Made in the Great Hall in the spring of 1511 for my grandfather's feast, by eleven men and a horse. The horse did not do the joinery but was present throughout and is mentioned in the accounts.

- Oak, from the wood below the castle, which is still there and still looks at me reproachfully.
- Thirty-two feet long. Seats forty with arms, sixty without, and eighty if they are fond of one another.
- Built in the hall because it could not be carried into it. It has therefore never left it.
- Pegged, not glued. Master Tobias said glue was "for people who expect to be finished".

## Uses, 1511-2026
- 1511: the feast. A great success. My grandfather sang.
- 1648: a treaty, of sorts, between two neighbouring families, over a goat.
- 1851 to the present: correspondence. I write at the near end. The far end has been empty for some time.
- 10 November 2026: gone.

I have asked Hollis how thirty-two feet of oak can leave a room it cannot leave. Hollis said, "Woodworm, my lord," and then went to choir.
`;

  var CHALK = `
CHALK MARKS ON THE GREAT HALL FLOOR, found Tue 17 Nov, 22:50.
Copied exactly, as instructed. Not interpreted. (H.)

   north wall (fire)
   ------------------------------------------------------------
   |  T1  32 ft  <-- TURN N-S -->                              |
   |  40 ch (arms) both sides of T1                            |
   |                                                           |
   |  A  B  C  D       (trestles; G.M. x8)                     |
   |  E  F  G  H                                               |
   |                                                           |
   |  "C."  --> X   (head of T1, facing door)                  |
   |                                                           |
   |  gallery: 31 (+ Kit)                                      |
   |  300?  (incl. kids)                                       |
   |  lights: ON THE BELL                                      |
   ------------------------------------------------------------
   south wall (door)

His lordship asks what "C." stands for. I said "Ceiling, my lord, probably". He accepted this.
`;

  var CASTLE_INVENTORY = (function () {
    var rows = [
      "room,item,since,status,note",
      "great hall,long table (oak; 32 ft),1511,MISSING (Tue 10 Nov),see the great hall folder",
      "great hall,chairs with arms (x40),1702,MISSING (Thu 5 Nov),",
      "great hall,candelabrum (five-branched),1650,MISSING (Thu 12 Nov),",
      "great hall,the good rug,1880,rolled up,",
      "great hall,Siegfried (armour),1520,moved 2 ft,",
      "great hall,curtains (velvet),1890,opened twice,freckles",
      "library,desk (letters to the Council),1702,present,the near end of the long table being unavailable",
      "library,earmuffs (lambswool; red),2026,present,bought by Hollis on 2 Nov; Hollis insisted on red",
      "library,earmuffs (spare; black),2026,present,Hollis also insisted on a spare",
      "library,books (approx. 11000),1450-2026,present,eleven of them read twice",
      "library,the chair that creaks,1611,present,it has opinions",
      "library,globe (pre-Australia),1590,present,I have added Australia in pencil",
      "kitchen,stove (enormous),1890,present,used for beetroot only",
      "kitchen,garlic,never,ABSENT,never has been; never will be",
      "kitchen,kitchen door key,1720,with Hollis,Hollis has the key now. Hollis has all the keys",
      "kitchen,beetroot juice (Lower Meadow),2025,present (14 L),",
      "chapel,organ,1702,present,one pipe whistles in an east wind",
      "chapel,pews (x8),1600,present,",
      "armoury,coat hooks (x300),1640,present,for the armour that was sold in 1919",
      "armoury,armour,1500-1650,SOLD 1919,for the roof. the roof was not done",
      "east tower,bats (212),varies,present,protected; named",
      "east tower,roof,1440,poor,see roof",
      "east tower,bucket (under the leak),2003,present,the bucket has a name (Gerald)",
      "west tower,telescope,1781,present,a gift from the eighteenth century; we do not speak of it",
      "west tower,the moon (view of),always,present,",
      "bedchamber,four-poster bed,1590,present,the curtains are the ones that matter",
      "bedchamber,mirror (No. 9),2026,RETURNED,see personal/mirrors",
      "bedchamber,mirror (No. 10),2026,on order,",
      "bedchamber,capes (x31),1450-2026,present,Hollis has labelled them by decade",
      "gatehouse,drawbridge,1440,works (mostly),see renovation",
      "gatehouse,the lever,1440,present,Password1476 (in spirit)",
      "gatehouse,sign over the gate (1476),1476,present,two feet high. Hollis mentions this often",
      "crypt,wine racks (empty),1600,present,converted to beetroot in 1926",
      "crypt,the old trunk,1702,present,locked. key lost in the eighteenth century",
      "battlements,deckchair,1953,present,for the moon",
      "battlements,flag (family arms),1980,present (faded),the bat on it has gone pink",
      "stables,horse,none since 1923,ABSENT,",
      "stables,Mr Mott's ladder (left behind),2026,present,he says he will collect it in daylight",
      "everywhere,dust,1426-2026,present,Hollis is keeping it for something. he will not say what"
    ];
    return rows.join("\n");
  })();

  var INVENTORY_NOTES = `
# Inventory notes (H.)

Annual count, November 2026. Conducted at his lordship's request ("count everything, Hollis, they may come for the spoons").

- Items missing: four (table, chairs, candelabrum; the rug is merely rolled).
- Items mysteriously cleaner than before: eleven.
- Items added: one paper star, silver (great hall, under Siegfried). Filed.
- Spoons: all present. His lordship counted them twice, and then once more, in the old tongue, for luck.
- Dust: present. Do not remove the dust in the great hall until further notice. (This is not a request I can explain at this time.)
`;

  var ROOF_MOTT = `
MOTT & DAUGHTER ROOFING - Nether Brindle - "We go up so you don't have to"

QUOTE No. 2611                                   9 October 2026
For: Castle Morvane, east tower. Client: Count C. Morvanescu

Strip and re-slate east tower roof (approx. 140 m2) ......... 18,400
Lead flashing, valleys and the bit where the bucket is ...... 3,900
Scaffold, 70 ft, six weeks ................................... 6,200
Bat-friendly ridge tiles (12), as required by the Council .... 960
                                                     TOTAL  29,460

TERMS
- Daylight hours only: 8 till 4, Monday to Friday. Not negotiable.
  (I'm not going up a seventy-foot tower in the dark, your lordship,
  with respect, not for you and not for the Queen.)
- Works cannot start until the Council's bat inspection is done.
- The bucket (Gerald) to be retired with honours.

Gary Mott & Jess Mott
`;

  var ROOF_NIGHT = `
NIGHTFALL ROOFING
"Roofs by moonlight. Cash. No questions. No ladders (we have our methods)."

Quote for "the big castle":
- whole roof: 400 cash
- start: any night, 2 a.m.
- method: confidential

[Note from his lordship: At last, a firm that understands the hours. Hollis, accept.]

[Note from H.: They are three teenagers from Over Brindle with a trampoline.
 I have met their method. Declined, with thanks, and a biscuit each.]
`;

  var ROOF_EMAILS = `
# Gary Mott, re: night work (thread, filed by H.)

**From:** Count Morvanescu
**Subject:** The roof, and the matter of the hour

Dear Mr Mott, I am delighted with your quote. Might your men begin at midnight? It is the most agreeable hour, and I could hold the ladder.

---

**From:** Gary Mott
**Subject:** RE: The roof, and the matter of the hour

Your lordship, with the greatest respect: no. Daylight. Tuesdays I'm free from 10.

---

**From:** Count Morvanescu

Mr Mott, ten in the morning is the middle of my night. Would dusk on the shortest day of the year suit? It is very nearly the afternoon.

---

**From:** Gary Mott

It would not. Also can't do anything the last week of November anyway, the trestles are spoken for. And the van. And Jess. And me.

Also I left my ladder in your stables. I'll get it. In daylight.

---

**From:** Count Morvanescu

Spoken for by whom, Mr Mott?

---

**From:** Gary Mott

Woodworm.

---

[H.: Thread closed. I have asked Mr Mott to stop answering questions with "woodworm". It is my answer.]
`;

  var RENOVATION_PLAN = `
# Renovation plan, 2026-2030 (H.)

Priority is set by what falls on whom.

1. **East tower roof.** Mott & Daughter, daylight only, once the bat inspection is done. (The inspection is booked: see correspondence/council/bats.)
2. **The drawbridge.** Rises. Does not entirely fall. Quote pending from a man who does drawbridges, of whom there is one.
3. **Damp, west wall of the library.** His lordship calls it "character". The books call it mould.
4. **Great hall.** Nothing to do. Do not touch the great hall. Do not dust it. (Until the end of the month.)
5. **The kitchen door.** New lock, so that only I have the key. Done 1 November.

Funds: the roof fund (see accounts) plus whatever the armour fetched in 1919, which was spent in 1919.
`;

  var QUOTES_COMPARED = `
job,firm,price_gbp,hours,verdict_his_lordship,verdict_H
east tower roof,Mott & Daughter,29460,daylight only,"rude about the hour",accept
east tower roof,Nightfall Roofing,400,2 a.m.,"at last; artisans",three teenagers and a trampoline
east tower roof,Battlement Bros (Over Brindle),41000,daylight only,"they spelled Morvane with an F",no
drawbridge,Albrecht Drawbridges (the one man),12800,any,"he understands chains",accept when he answers the phone
library damp,Dry-Rite,3400,daylight only,"they used the word 'mould' in front of the books",accept
library damp,his lordship (a candle and some patience),0,night,"traditional",no
bat loft (new),the Count himself,0,night,"a labour of love","please do not go on the roof"
`;

  var DRAWBRIDGE = `
THE DRAWBRIDGE: a history of complaints (kept by H.)

1440  built. goes up, goes down.
1511  the long table delivered in pieces over it; reassembled in the hall.
1702  goes up. stays up for eleven years. (we do not speak of it.)
1926  the beetroot lorry; a near thing.
1987  the chain sings in a north wind. his lordship likes it. nobody else does.
2019  the first delivery of the laptop. the courier refused to cross. I carried it.
2026  3 Nov: found DOWN in the morning, though I raised it at 18:00. his lordship
        asked who lowered it. I said it must have been the wind. it was the
        wind. (H.)
      10 Nov: down again. tyre marks. "the wind," I said. his lordship said the
        wind does not have tyres. I said "this one does, my lord", and went to
        choir.
`;

  var BAT_CENSUS = (function () {
    var r = rng(212), rows = ["month,roost,location,count,observer,note"];
    var NOTE = { "2026-10|B": "all present; they like the quiet", "2026-11|B": "unbothered by recent comings and goings. they like the chalk", "2026-06|A": "Little Ignatius has had twins", "2026-03|C": "the organ pipe; they were not impressed", "2026-11|A": "the Council's inspection booked for the 28th; I have told the bats" };
    ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"].forEach(function (m, i) {
      [["A", "east tower"], ["B", "great hall rafters"], ["C", "chapel"]].forEach(function (ro) {
        var base = ro[0] === "A" ? 150 : ro[0] === "B" ? 40 : 14, n = base + (i > 4 && i < 9 ? 12 : 0) + Math.floor(r() * 9) - 4;
        rows.push([m, ro[0], ro[1], n, i % 2 ? "his lordship" : "H.", NOTE[m + "|" + ro[0]] || ""].join(","));
      });
    });
    return rows.join("\n");
  })();

  var BATS_BY_NAME = `
# The bats, by name (a selection)

There are two hundred and twelve of them. I have named every one. The Council's objection describes them as "a population". They are not a population. They are Ignatius.

- **Ignatius.** The eldest. Roosts above the fireplace in the great hall. Looks at me as my grandfather's portrait does.
- **Little Ignatius.** Not little. Twins this June: Ignatia and Iggy.
- **The Baron.** No relation.
- **Mrs Whiskers.** Disapproves of the bell practice even more than I do.
- **Constance, Prudence, Patience and Gerald.** Not to be confused with Gerald the bucket.
- **Monsieur.** French, I suspect, from the way he hangs.
- **Agnes.** Named after Mrs Pottle, who once gave me a beetroot scone. Mrs Pottle does not know. Please do not tell her.
- **Hollis.** Organised. Always in the same place. Brings the others in at dawn.
- **The Two Hundred and Twelfth.** Arrived 3 November, the night the curtains were first opened. Very curious. Follows the chalk.

They are not "bats", Madam Clerk. They are household.
`;

  var castle = D("castle", nov(17, "23:20"), [
    D("great hall", nov(17, "23:20"), [
      T("inventory - great hall.csv", nov(17, "23:15"), HALL_INVENTORY),
      T("the long table - provenance.md", nov(10, "23:30"), LONG_TABLE),
      T("chalk marks on the floor (copied by H).txt", nov(17, "23:20"), CHALK),
      IMG("the great hall, as found (Tue 17 Nov).webp", nov(17, "22:52"), "great-hall-as-found.webp", "2400x1600", "4.1 MB")
    ]),
    D("inventory", nov(16, "02:10"), [
      T("castle inventory 2026.csv", nov(16, "02:10"), CASTLE_INVENTORY),
      T("inventory notes (H).md", nov(16, "02:30"), INVENTORY_NOTES)
    ]),
    D("roof", "2026-10-22T16:40:00", [
      T("quote - Mott & Daughter (daylight only).txt", "2026-10-09T15:10:00", ROOF_MOTT),
      T("quote - Nightfall Roofing (cash, after dark).txt", "2026-10-14T02:20:00", ROOF_NIGHT),
      T("emails - Gary Mott on night work.md", "2026-10-22T16:40:00", ROOF_EMAILS),
      IMG("castle from the village green (survey photo).webp", "2026-10-09T11:30:00", "castle-from-the-green.webp", "2400x1600", "5.3 MB")
    ]),
    D("renovation", "2026-11-01T21:00:00", [
      T("renovation plan 2026-2030.md", "2026-11-01T21:00:00", RENOVATION_PLAN),
      T("quotes compared.csv", "2026-10-23T20:00:00", QUOTES_COMPARED),
      T("the drawbridge - a history of complaints.txt", nov(10, "23:50"), DRAWBRIDGE)
    ]),
    D("bats", nov(14, "05:30"), [
      T("bat census (H).csv", nov(14, "05:30"), BAT_CENSUS),
      T("the bats, by name.md", "2026-09-30T03:00:00", BATS_BY_NAME)
    ])
  ]);

  /* ================= ~/correspondence ================= */
  var BINS_DRAFT = `
Castle Morvane
Nether Brindle
Tuesday 3 November 2026, in the library, a quarter to ten, during the bells

To the Clerk of Nether Brindle Parish Council

Madam,

BINS. (Letter the seventh.)

For the seventh time I must draw the Council's attention to the hour at which
my bins are collected. It is seven o'clock in the morning. At seven o'clock in
the morning I am, as the whole village knows, asleep, as is any reasonable
person of my habits. The lorry reverses. It beeps as it reverses. It beeps,
Madam, for four minutes, directly beneath the window of a man who has been
alive since 1426 and has never once beeped at anybody.

I have asked that the bins be collected at two in the morning, when I am up
and could assist. I have offered to make tea. The Council has not replied to
my offer of tea. I find this wounding.

If the Council will not move the bins, I shall be obliged to take steps.

I remain, Madam, your most obedient and exceedingly tired servant,

Casimir, Count Morvanescu

[H.: Not this one, my lord. "Take steps" reads as a threat. You do not take
 steps. You take the stairs, slowly, in a cape. Revised version sent.]
`;
  var BINS_SENT = `
Castle Morvane
Nether Brindle
Tuesday 3 November 2026, in the library, a quarter to ten, during the bells

To the Clerk of Nether Brindle Parish Council

Madam,

BINS. (Letter the seventh.)

For the seventh time I must draw the Council's attention to the hour at which
my bins are collected. It is seven o'clock in the morning. At seven o'clock in
the morning I am, as the whole village knows, asleep, as is any reasonable
person of my habits. The lorry reverses. It beeps as it reverses. It beeps,
Madam, for some minutes, directly beneath the window of a man who has been
alive since 1426 and has never once beeped at anybody.

I have asked that the bins be collected at two in the morning, when I am up
and could assist. I have offered to make tea. The Council has not yet had the
opportunity to reply to my offer of tea. I am sure that it will.

If the Council will not move the bins, I shall be obliged to write again.

I remain, Madam, your most obedient and well-rested servant,

Casimir, Count Morvanescu
`;
  var BINS_REPLY = `
NETHER BRINDLE PARISH COUNCIL
The Village Hall (closed until the end of the month), Church Lane

5 November 2026

Dear Count Morvanescu,

Thank you for your seventh letter regarding the bins, which was read aloud at
the Council's meeting and very much enjoyed.

The Council would be grateful if you could set out, in a further letter, at
your leisure and in as much detail as you wish, the precise hours at which
you are awake, so that we may put them to the waste contractor. The Council
finds that letters written on a Tuesday or Thursday evening are particularly
clear.

On the matter of tea: yes please. Not yet. Later in the month, perhaps.

Yours sincerely,

Priya Lal
Clerk to the Council
`;
  var BELLS_1 = `
Castle Morvane
Thursday 10 September 2026

To the Clerk of Nether Brindle Parish Council

Madam,

I write concerning the bells of St Wendreda's, which are practised on Tuesdays
and Thursdays from half past seven until nine, directly below my library.

I have no objection to bells. I was present at the casting of two of them
(1488 and 1611) and I have a great fondness for the tenor, whose name is Old
Tom. My objection is to Grandsire Triples, which is played as if it were
being chased.

I ask only that the Council invite the ringers to practise something calmer.

Your obedient servant,

Casimir, Count Morvanescu
`;
  var BELLS_4 = `
Castle Morvane
Thursday 5 November 2026, in the library, with earmuffs, ten o'clock, during the bells

To the Clerk of Nether Brindle Parish Council

Madam,

The bells. (Letter the fourth.)

The practice, which once ended at nine, now ends at half past ten. The bells
are louder, longer and, if I may say so, they are learning something. A new
tune: it circles and returns, like a moth around a candle, and never quite
lands. I have heard it every Tuesday and every Thursday since the middle of
October, and I confess I find myself humming it.

On each occasion I have retired to the library with my earmuffs (red;
Hollis's choice) and written to you, as you will have noticed.

I ask the Council: what are they learning, and for what?

Your obedient, and slightly deafened, servant,

Casimir, Count Morvanescu
`;
  var BELLS_REPLY = `
NETHER BRINDLE PARISH COUNCIL

9 November 2026

Dear Count Morvanescu,

Thank you for your fourth letter about the bells, which we have passed to the
Tower Captain, Mr Fudge, who has promised to reply in person.

In the meantime, could his lordship let us have his views on the bells at
greater length? A full account of the matter, written on a practice evening
while it is fresh, from the library, would help the Council a great deal.

The Council is unable to say what the ringers are learning, or for what, as
the Council does not know. (The Council has been asked to say this.)

Yours sincerely,

Priya Lal
Clerk to the Council
`;
  var PLANNING_OBJECTION = `
NETHER BRINDLE PARISH COUNCIL - PLANNING

Application 26/0412: re-roofing of the east tower, Castle Morvane.
Applicant: Count C. Morvanescu. Agent: H. Pike.

NOTICE OF OBJECTION (holding)                              2 October 2026

The east tower contains a known roost of common pipistrelle bats, a protected
species. Works may not proceed until a statutory dusk inspection of the roost
has been carried out by a licensed Inspector in the presence of the applicant.

A date for the inspection will be set in due course.

P. Lal, Clerk
`;
  var PLANNING_DIGNITY = `
Castle Morvane
Tuesday 10 November 2026, in the library, during the bells (and the drawbridge; the wind again)

To the Clerk of Nether Brindle Parish Council

Madam,

ON THE DIGNITY OF BATS.

Your notice of 2 October describes my bats as "a known roost". I do not dispute
that they are known. I dispute that they are a roost. They are Ignatius,
Little Ignatius, the Baron (no relation), Mrs Whiskers, and two hundred and
eight others, each of whom I have named, several of whom I have nursed, and
one of whom (Monsieur) I suspect of being French.

The suggestion that I would allow any harm to come to them is wounding. I
have lived beside these bats, and their great-great-great-grandparents, since
before your Council was founded. I fed their ancestors from a saucer.

Inspect them, by all means. They will enjoy it. But inspect them knowing that
they are household.

I remain, Madam, wounded but cordial,

Casimir, Count Morvanescu
`;
  var PLANNING_INSPECTION = `
NETHER BRINDLE PARISH COUNCIL - PLANNING

Application 26/0412: STATUTORY DUSK INSPECTION OF THE BAT ROOST

13 November 2026

Dear Count Morvanescu,

We are pleased to confirm the statutory dusk inspection of the roost at Castle
Morvane.

  Date:   Saturday 28 November 2026
  Time:   19:00 (the Inspector will call for you at the library at 18:55)
  Place:  the inspection will begin in the Great Hall

Please note:
- The applicant must be present in person.
- The Inspector asks that his lordship dress formally. It is a formal
  inspection.
- Please do not light the Great Hall before the Inspector arrives. Bats are
  sensitive to light. Leave it entirely to us.
- We understand some furniture may be absent from the Great Hall. The Council
  has no knowledge of this.

Thank you for your letter on the dignity of bats. It has been pinned up in the
Post Office.

Yours sincerely,

Priya Lal
Clerk to the Council
`;
  var PLANNING_NOTE_LEFT_IN = `
NETHER BRINDLE PARISH COUNCIL

12 November 2026

Dear Count Morvanescu,

Thank you for your letter regarding the streetlights on Church Lane, which you
describe as "a lighthouse for moths". The Council has noted your views.

Could we trouble you for a further letter, setting out which of the lights
trouble you most, and at what hours? There is no hurry. A Tuesday would be
ideal.

Yours sincerely,

Priya Lal
Clerk to the Council



----- original note -----
From: Priya
To: Gary; cc: Hollis
Re: Tuesdays

Gary - is the trestle thing sorted for the 28th? And Hollis, can you keep
him writing two a week until then? He's lovely but he must NOT come out of
that library on a Tuesday. I'll keep asking for "more detail".
Remember to delete this before sen
`;
  var MINUTES = `
# Nether Brindle Parish Council: minutes of the meeting of 10 November 2026
*Held in the Post Office back room (the Village Hall being closed for furniture).*

**Present:** Cllr D. Fudge (Chair), Cllr A. Pottle, Cllr D. Hart, Cllr J. Okafor, Cllr G. Mott, Cllr S. Fudge, Cllr B. Ames. **Clerk:** P. Lal. **In attendance:** Mr H. Pike (observer; left early "for choir").

1. **Apologies.** None. Full house. Cllr Mott arrived with sawdust on him; no questions were asked.
2. **Minutes of the last meeting.** Approved.
3. **Correspondence from the Castle.** Eleven letters received since the last meeting (bins, three; bells, four; bats, two; streetlights, one; the tone of the duck pond, one). *Resolved:* that each be answered promptly, warmly and at length, and that each answer ask for more detail.
4. **Bell practice.** The Tower Captain reported that practices will continue to run until 22:30 on Tuesdays and Thursdays until the end of the month, "for the new method". *Resolved:* noted with thanks.
5. **Planning 26/0412 (the east tower).** The statutory dusk inspection is fixed for Saturday 28 November at 19:00, beginning in the Great Hall. The Clerk will act as Inspector, being licensed (she did a course).
6. **Village Hall.** Closed to bookings until 28 November. The Hall is currently occupied by a table.
7. **Post Office collection tin.** £297, two buttons, one euro. *Resolved:* that it be spent as agreed.
8. **Any other business.** Project S was discussed. Not minuted. Cllr Fudge asked whether "S" stood for what he thought it stood for. The Clerk said that it did. Cllr Fudge was delighted.

Next meeting: 1 December, assuming everyone has recovered.
`;

  var ILSE_1 = `
FROM: BARONESS ILSE VON DAMMERLICHT
TO: COUNT CASIMIR
SUBJECT: RE: RE: RE: FW: RE: IS THIS THE ELECTRIC LETTER

CASIMIR.

I AM WRITING TO YOU ON THE ELECTRIC LETTER. MY GREAT-GREAT-GREAT-GREAT
NEPHEW HAS SHOWN ME. EVERYTHING IS IN CAPITALS. I CANNOT MAKE IT STOP. I AM
NOT SHOUTING. I AM SIMPLY VERY FAR AWAY.

HOW ARE YOUR BATS. MINE ARE WELL. ONE HAS LEARNED TO OPEN THE FRIDGE.

I STILL HAVE YOUR GONDOLA. I REGARD THE MATTER AS CLOSED.

WITH ETERNAL REGARD,
ILSE
SENT FROM MY SCHLOSS
`;
  var ILSE_2 = `
FROM: BARONESS ILSE VON DAMMERLICHT
TO: COUNT CASIMIR
SUBJECT: SEE YOU ON THE 28TH!!!

CASIMIR!!! SEE YOU ON THE 28TH!!! I HAVE BOUGHT A HAT.

---------------------------------------------------------------------------

FROM: BARONESS ILSE VON DAMMERLICHT
TO: COUNT CASIMIR
SUBJECT: UNSEND

CASIMIR PLEASE DISREGARD THE PREVIOUS ELECTRIC LETTER. A MAN CALLED HOLLIS
HAS TOLD ME THERE IS SOMETHING CALLED "UNSEND". I HAVE PRESSED EVERYTHING.
THE SCREEN IS NOW IN SPANISH.

THERE IS NO 28TH. I DID NOT BUY A HAT.

WITH ETERNAL REGARD (AND NOTHING ELSE),
ILSE
ENVIADO DESDE MI SCHLOSS
`;
  var ILSE_REPLY = `
My dear Ilse,

How lovely to have two letters from you in one evening, after a silence of
nineteen years.

I shall be at home on the 28th, as I have been on every 28th since 1476.
You are always welcome; you know the way, and the drawbridge has been
lowering itself lately, so there is no need to shout.

Do bring the hat. I confess I did not follow the rest. Who is this Hollis
of whom you speak? I know only one Hollis, and he would never write to
Bavaria without first writing me a memo about it.

Your friend across the centuries,
C.

P.S. The fridge. Remarkable. Mine still cannot work the doorbell.
`;
  var MARQUISE = `
[FAX - 3 pages - received 02:14, 14 November 2026]

From the Marquise de Nuit, Chateau de Nuit, near Rouen

Mon cher Casimir,

Thank you for your letter of 14 March 2004, which reached me this week. Yes:
I should love to see the new millennium in with you. I trust it went well.

Your Mr Hollis has also written, about the end of this month. Naturellement,
I shall come. I shall arrive at the hour of fashion, which is one in the
morning, and I shall bring the good candles, since I am told yours are
"away".

I have not yet learned the electric letter. I see no reason to begin now.
The fax was good enough for Napoleon (he sent me one; it was about a horse).

With undying affection,
Heloise

[page 2 of 3: a drawing of a horse]
[page 3 of 3: blank, except for "ne lui dis rien"]
`;
  var BARTHOLOMEW = `
From: Bartholomew of Prague
To: The Undying Correspondence Society (all six members)
Subject: Reply all: who is Hollis?

Dear all,

I have received a letter from a Mr Hollis asking (a) whether I can still sing
in Old Morvanish, (b) whether I am "free on the 28th" and (c) my seat
preference, "near the fire or near the door, given the circumstances".

I am free on every date. I have been free since 1612.

Can somebody explain what is happening? I have replied to all because I do
not know which of you is Mr Hollis.

Yours, perplexed, in Prague,
Bartholomew

> From: Ilse
> BARTHOLOMEW. YOU HAVE DONE IT AGAIN. NOBODY IS MR HOLLIS. MR HOLLIS IS A
> DIFFERENT PERSON. CASIMIR IS ON THIS LIST. STOP REPLYING TO ALL.
>
>> From: the Marquise (by fax, transcribed by Bartholomew's grandson)
>> Ne lui dis rien.
>>
>>> From: Casimir
>>> My friends, what is happening? Who is singing? Why does nobody tell me
>>> anything? Also, Bartholomew: near the fire. Always near the fire.
`;
  var SOCIETY_RULES = `
# The Undying Correspondence Society: rules

Founded 1652 by letter. Six members. Meets never. Corresponds always.

1. Do not reply to all. *(Proposed by everyone, 1998, after Bartholomew.)*
2. Capitals are not shouting. *(Ilse's motion, 2011. Carried, under protest, in capitals.)*
3. Letters older than twenty years need not be answered, but will be. *(The Marquise.)*
4. No discussion of the eighteenth century. *(Casimir's motion, 1801. Carried unanimously. Nobody asked why. Everybody knew.)*
5. Birthdays are not to be mentioned after the first three hundred. It is considered tactless. *(Bartholomew, 1726. Repealed by email, November 2026, by a Mr H. Pike, who is not a member, and whose motion was nevertheless carried 5-0, Casimir not having been told.)*
6. The gondola is closed. *(Ilse.)* The gondola is not closed. *(Casimir.)*
`;

  var correspondence = D("correspondence", nov(14, "02:20"), [
    D("council", nov(13, "11:00"), [
      D("bins", nov(5, "16:00"), [
        T("bins - letter 7, draft (too strong).txt", nov(3, "21:45"), BINS_DRAFT),
        T("bins - letter 7, as sent.txt", nov(3, "22:10"), BINS_SENT),
        T("council reply - bins.txt", nov(5, "16:00"), BINS_REPLY)
      ]),
      D("bells", nov(9, "12:00"), [
        T("bells - complaint 1 (September).txt", "2026-09-10T21:30:00", BELLS_1),
        T("bells - complaint 4 (November).txt", nov(5, "22:05"), BELLS_4),
        T("council reply - bells (please write more).txt", nov(9, "12:00"), BELLS_REPLY)
      ]),
      D("bats (planning)", nov(13, "11:00"), [
        T("planning - notice of objection.txt", "2026-10-02T10:00:00", PLANNING_OBJECTION),
        T("planning - my reply on the dignity of bats.txt", nov(10, "22:20"), PLANNING_DIGNITY),
        T("planning - reply about the streetlights.txt", nov(12, "15:30"), PLANNING_NOTE_LEFT_IN),
        T("planning - the dusk inspection.txt", nov(13, "11:00"), PLANNING_INSPECTION)
      ]),
      T("minutes - parish council, 10 November.md", nov(11, "09:00"), MINUTES)
    ]),
    D("immortals", nov(14, "02:20"), [
      T("Baroness Ilse - RE RE RE FW is this the electric letter.txt", "2026-10-30T03:12:00", ILSE_1),
      T("Baroness Ilse - SEE YOU ON THE 28TH.txt", nov(8, "04:40"), ILSE_2),
      T("my reply to Ilse.txt", nov(8, "23:15"), ILSE_REPLY),
      T("the Marquise - by fax, as ever.txt", nov(14, "02:20"), MARQUISE),
      T("Bartholomew (Prague) - reply all.txt", nov(11, "01:05"), BARTHOLOMEW),
      T("the Undying Correspondence Society - rules.md", nov(11, "06:00"), SOCIETY_RULES)
    ])
  ]);

  /* ================= ~/memoirs ================= */
  var MEMOIR_README = `
# My Memoirs
### by Casimir, Count Morvanescu (b. 1426). In six centuries and nine drafts.

Hollis says a memoir should be "in one place". I have lived in one place for six hundred years; my memoir may live where it likes.

- **drafts by century**: the drafts, one folder to a century, as they occurred to me. The eighteenth century has been withdrawn by the author.
- **memoir**: the "repository", which Hollis made for me in 2019. It remembers every version of me. I make "branches". Hollis calls them "alternate pasts", and sighs.
- **appendix - a glossary of Old Morvanish**: the language of this valley until about 1490, and after that the language of my nurse, Old Marta, and of nobody else. For the scholars.

Dedicated to Hollis, who has read every draft, and to the village of Nether Brindle, which has read none.
`;

  var GLOSSARY = `
# Appendix: a glossary of Old Morvanish

Old Morvanish was spoken in this valley until about 1490. After that it was spoken by my nurse, Old Marta, and only to me, and mostly to tell me off. I set down here every word I remember, so that it is not lost. Nobody has asked for it. Hollis typed it, very slowly, and said "how interesting" eleven times.

Nouns take -u after "v" (in): dorn, the hall; v dornu, in the hall. Plurals end in -i.

| word | meaning | note |
|---|---|---|
| dorn | hall; the great hall | |
| dornu | (in) the hall | as in "v dornu", in the hall |
| grav | count; lord | what the village called my father, to his face |
| i | and | |
| je | is | |
| jesh | still; even now | Marta: "jesh pisko!" (still writing!) |
| kandi | candles | |
| konsil | the council | a word Marta used as a curse |
| libam | we love | |
| libam te | we love you | not a phrase I heard often. Marta was not sentimental |
| mi | our | |
| na | on; upon | |
| nivé | come down | what one shouts up a staircase |
| ouri | winters; years of a life | the polite way to speak of age |
| pisko | one who writes letters | Marta's word for me, aged four days. Unfair then; accurate now |
| pogach | cake | a round one, for feasts |
| sasé | six | |
| sasévek | six hundred | a number I have not needed until recently |
| stal | table | |
| te | you | |
| tulo | long | tulo stal, the long table |
| v | in | |
| velm | hill | |
| velmor | on the hill; the castle | "the one on the hill" means me |
| vek | a hundred | also: a great many, as of bats |
| vesla | feasting; joy | |
| zvon | bell | |
| zvoni | bells | |
| zvonjat | (they) ring | |
| garl | garlic | an oath. not used in polite company. or in this house |
| marmu | nurse | |
| noshka | a small bat | also a term of endearment, for children |

## Phrases
- *Nivé, grav!* "Come down, lord!" What the village shouted up at my father on feast days.
- *Jesh pisko na konsil.* "Still writing to the council." Marta, of my father, 1430. Of me, every day since.
- *Sasé ouri.* "Six winters." How old I was when I was told I was too old to be carried.
`;

  // drafts by century
  var C1426 = `
# 1426: I am born, magnificently

I was born on the twenty-eighth of November, 1426, in the room above the kitchens, during a thunderstorm, as was proper.

My father was away at a war. My mother said I came out frowning, as though I already had a letter to write.

There was a feast in the great hall when I was a week old. The whole valley came. I do not remember it, but I am told I cried at the bells, and that my nurse, Old Marta, held me up at the window and the village shouted up at me in the old tongue. I like to think it was something kind. Marta said it was "the usual".

Nobody has given me a feast since. One does not expect it. One is not a baby.
`;
  var C1476 = `
# 1476: I become Count

At fifty I became Count Morvanescu. The ceremony was short. The sign over the gate was carved in letters two feet high, and has been mentioned to me by Hollis on several occasions since.

I resolved then to be a good Count: to keep the roof on, to keep the bells in tune, to write to whoever needed writing to. I have managed two of the three.
`;
  var DRAFT_LATIN = `
MEMORIAE MEAE
Liber Primus

Natus sum anno MCCCCXXVI, in tempestate, ut decet.

[abandoned 1502: I could not think of the Latin for "drawbridge".]
`;
  var DRAFT_VERSE = `
THE COUNTIAD
an epic, in rhyming couplets

Sing, Muse, of Casimir, of noble birth,
The finest Count that ever trod the earth;
Of how he

[abandoned 1503: nothing rhymes with Morvanescu. I tried for a year.]
`;
  var C1511 = `
# 1511: the long table

My grandfather wanted a feast, and a feast needs a table, and so eleven men and a horse built one in the great hall in the spring of 1511. It was too big to come in, so it was born there, like me.

The whole valley sat at it. My grandfather sang. I was eighty-five and still being told to sit up straight.

I have written at the near end of it ever since. The far end, these days, is mostly for the post.
`;
  var C1532 = `
# 1532: I discover portraiture

A painter from Antwerp came through the valley and offered to paint me. I said, "As I am?" He said, "Or a little better." I have been sitting for portraits ever since, each of them a little better than the last, and the earlier ones, at intervals, improved retrospectively. (See portraits. Hollis has views.)
`;
  var C1611 = `
# 1611: sitting for Master Vos

Master Vos painted me in a ruff, at one hundred and eighty-five, looking (he said) "a vigorous fifty". I thought fifty was unkind and said so. He said, "You should see what you look like." I said I had not seen what I looked like since 1426, mirrors having never agreed with me.

The portrait hangs on the stairs. It has been improved since.
`;
  var C1666 = `
# 1666: an alibi

I was not in London. I wish this recorded. Whatever was said in certain letters at the time, I was here, in the valley, writing to the Council about a goat.
`;
  var C1700S = `
# The eighteenth century

We do not speak of it.

If it happened to me at all, it happened to someone in a very large wig who looked a great deal like me and made certain choices regarding the harpsichord.

Hollis: this folder is closed. Nobody needs to open it. I shall never open it again.
`;
  var C1851 = `
# 1851: the Great Exhibition

I went to London (I was allowed back by then) to see the Crystal Palace. It was entirely glass and open all day. I lasted eleven minutes and came home with freckles and a souvenir thimble.
`;
  var C1888 = `
# 1888: the moustache

For one year I wore a moustache. It was the fashion. The bats did not recognise me, and the village wrote to ask whether I was a new Count. I shaved it off on New Year's Eve and the bats came home.
`;
  var C1926 = `
# 1926: the beetroot conversion

In the spring of 1926 a doctor in the village (Dr Hart, the grandfather of my supplier) suggested that a gentleman of my age and constitution would do very well on beetroot juice. "Earthy," he said. "Red. You'll hardly notice the difference."

I noticed the difference. But I have been on beetroot for a hundred years now, and I have never felt better, and the village, I think, has never felt better about me. Mrs Hart sends a jar of pickled beetroot every Christmas with a card that says "keep it up". I have kept it up.
`;
  var C1969 = `
# 1969: the moon

I watched them land on the moon from the battlements, in a deckchair, with a wireless. Someone walked on it. I have looked at the moon every night for five hundred and forty years and never once thought of walking on it. I felt, for the first time, young.
`;
  var C2019 = `
# 2019: Hollis buys me a laptop

Hollis came up the hill with a box, crossed the drawbridge on foot because the courier would not, and said, "My lord, it is time." I said, "Time for what?" He said, "Email."

I now correspond with the Council by email and by post, both, to be sure. Hollis says this is "redundant". I say the Council deserves both.
`;
  var C2026 = `
# 2026: the year of the conspiracy (in progress)

Something is afoot in the great hall. I record it here for posterity, which will want to know.

Chairs. A table. The candelabrum. Chalk. A sausage roll. Singing on the wind, in Marta's tongue.

And in nine days I shall be six hundred, which nobody knows, and which I have not mentioned, and will not mention, and am mentioning only here, in a memoir, which nobody reads.
`;

  // the final folder: hidden, inside the century he refuses to discuss
  var INVITATION_TEXT = `
THE VILLAGE OF NETHER BRINDLE
requests the pleasure of your company
at the
SIX HUNDREDTH BIRTHDAY
of
HIS LORDSHIP COUNT CASIMIR MORVANESCU
(who must not know)

Saturday 28 November 2026
Seven o'clock: please be in by half past six, quietly
The Great Hall, Castle Morvane: by the kitchen door

Dress: your best. Garlic: none whatsoever.
Bring: a candle, a chair if you've a spare, and a kind word.
RSVP: Hollis, at choir. Quietly.

[for the printer: Pottle's will do the lettering on the cake in Old Morvanish;
 the card is in English, so the Mott boys can read it]
`;
  var PLAN = `
# Saturday 28 November: the plan for the night

Six hundred years ago tonight, in the room above the kitchens, during a thunderstorm, a baby was born who would complain about the bins for six centuries. Tonight the village says thank you.

Nobody tells him. (Everybody has told everybody not to tell him, which in Nether Brindle is the same thing as a secret.)

## Before
- **14:00** Gary, Jess and the ringers: the long table back in through the kitchen, legs back on, turned north-south (per the chalk). Waxed. Forty chairs, re-glued. Trestles A to H (Gary's).
- **15:00** June: the choir up to the minstrels' gallery by the back stair. Thirty-one, plus Kit.
- **16:00** the good rug back down. The candelabrum, polished within an inch of its life (Agnes; her mother's method).
- **16:30** H.: curtains CLOSED. He has had enough freckles.
- **17:00** the village in by the kitchen door, quietly. Coats on the hooks in the armoury (there are three hundred; there always were). Garlic check at the door: Agnes has a nose for it.
- **18:00** the cake (Pottle's) by the fire. Not near the fire. By it.
- **18:30** lights off. Silence. (Derek will try to tell a joke. Derek: don't.)

## The lure
- **18:55** Priya, in her council lanyard, knocks at the library: "The dusk inspection, your lordship. In the Great Hall, if you would."
- He will have dressed for it. He has been dressing for it since Tuesday.
- H. carries the lamp. H. opens the door.

## 19:05
- Lights: all five branches and the twelve.
- Bells: Morvane Surprise Major, six hundred changes, Derek's band. (About twenty minutes. He will complain about the hours. Let him.)
- Choir, from the gallery: *Sasévek Ouri*, all three verses. The children take the last line.
- Three hundred people say, more or less together: happy birthday.

## After
- Cake. Six candles (Agnes's ruling: six hundred is a fire risk).
- Beetroot "wine" for him and anybody brave (Dilys). Proper wine for everybody else.
- **The present** (the picture beside this file): a portrait by Class 3B, Nether Brindle Primary, with help. He has spent five hundred years having himself painted younger. This one is exactly his age, and he is smiling in it, because the children insisted that is what he looks like. And since no mirror has ever shown him: here he is.
- Speeches: one (Priya). He will want to reply. Allow eleven minutes. He will take forty. Nobody will mind.
- The Baroness, the Marquise and Bartholomew arrive "fashionably", which for them is one in the morning. Somebody keep three plates.

## If anything goes wrong
- If he guesses early: he won't. He thinks it is a conspiracy. It is.
- If the drawbridge sticks: Gary.
- If he cries: he will say it is the dust. It is the dust. We have kept the dust especially.
`;
  var SEATING = `
seat,name,who,note
1,His lordship,the Count,"head of the long table, facing the door. the big chair"
2,Hollis Pike,the familiar,"at his right hand. as ever"
3,Priya Lal,Clerk to the Council,"at his left. she has earned it (eleven letters)"
4,Agnes Pottle,the bakery,"near the cake; keeps the knife"
5,Derek Fudge,Tower Captain,"arrives 19:30, after the ringing, deafened"
6,Kit Fudge (11),composer of Morvane Surprise Major,"wants to ask him about 1426 for her project"
7,June Okafor,choir,"after the singing"
8,Gary Mott,Mott & Daughter,"sawdust permitted"
9,Jess Mott,Mott & Daughter,"she took the table legs off. she will put them back"
10,Dilys Hart,Hart's Roots,"the beetroot. bring the Lower Meadow"
11-18,the ringers (8),St Wendreda's,"after the peal; they will be thirsty"
19-26,Class 3B (8 reps),Nether Brindle Primary,"with the present. Miss Ames in charge"
27,Miss B. Ames,Class 3B's teacher,"and councillor; she did the eyebrows"
28,Mrs Bellweather (the younger),the Post Office,"her great-great-grandmother sent him a ham in 1826"
29,Sue Fudge,ringer and councillor,"tea"
30-34,the Mott boys (5),assorted,"for lifting"
35,the Baroness Ilse von Dammerlicht,Bavaria,"from 1 a.m. HAT"
36,the Marquise de Nuit,Rouen,"from 1 a.m. bringing candles"
37,Bartholomew,Prague,"from 1 a.m. near the fire; always near the fire"
38,Dr Tom Hart,the surgery,"grandson of the doctor who prescribed the beetroot (1926)"
39,Reverend Ames,St Wendreda's,"let Old Tom ring last"
40,Ignatius,the eldest bat,"in the rafters above. counted as a guest at his lordship's certain insistence"
`;
  var FOR_MY_LORD = `
My lord,

You will be reading this afterwards, having at last turned on hidden files to find out how we did it. I estimate this will take you until March.

I am sorry about the chairs. And the table, and the candelabrum, and the curtains, and the freckles. I am not sorry about anything else.

You told me once, in 1952 or thereabouts, that nobody remembers a birthday after the first hundred. That the village tolerated you, the way one tolerates weather. I have filed a great many things for you since, and I can report, with documentation, that this is untrue.

Three hundred people carried a table. Thirty-one people learned a language that nobody has spoken since your nurse. Eight people rang for twenty minutes without stopping, which Derek says is not quite a peal but felt like one. A parish clerk answered eleven letters about bins. A class of eight-year-olds painted you from memory, because you do not show up in photographs, and they remembered you smiling, so that is how they painted you.

You are not tolerated, my lord. You are loved. It is in the files.

Happy birthday.

Your servant, always,
H.

P.S. The bins will still be collected at seven. Priya says some things are beyond even her.
`;

  var FINAL = D(".28 November", nov(18, "23:40"), [
    IMG("invitation.webp", nov(16, "21:00"), "invitation.webp", "1600x2240", "2.4 MB"),
    T("invitation - wording for the printer.txt", nov(2, "20:10"), INVITATION_TEXT),
    T("the plan for the night.md", nov(18, "23:40"), PLAN),
    T("seating - the long table.csv", nov(17, "23:55"), SEATING),
    IMG("the present.webp", nov(16, "16:30"), "the-present.webp", "2400x1800", "5.6 MB"),
    T("for my lord, afterwards.md", nov(18, "23:58"), FOR_MY_LORD)
  ]);

  /* ---- the memoir repository (side route: git graph, terminal) ---- */
  var R = H + "/memoirs/memoir";
  var M_README = `
# The Memoirs of Casimir, Count Morvanescu

Six hundred years, give or take, in six chapters, give or take.

- Chapters are in chapters/.
- Hollis's corrections are in notes/.
- Alternate pasts are on branches, where they belong. (H.)
`;
  var M_01 = `
# I. In which I am born (1426)

I was born on the twenty-eighth of November, 1426, in the room above the kitchens, during a thunderstorm, as was proper.

My nurse, Old Marta, spoke to me only in Old Morvanish, and mostly to tell me off. Her word for me was pisko. It means one who writes letters. I was four days old.
`;
  var M_02 = `
# II. In which I become Count (1476)

In 1476, at the age of fifty, I became Count Morvanescu, and I have remained so, the paperwork never having caught up.

I resolved to keep the roof on, the bells in tune and the Council informed. I have managed two of the three.
`;
  var M_03 = `
# III. In which I go on campaign (1445)

In my youth I went to war, once, briefly, in the rain.

I was nowhere near Agincourt. I wish to be clear about this, having been unclear about it in several earlier drafts.

(H.: Agincourt was in 1415. You were born in 1426.)

I was at the siege of a small town whose name I have forgotten, for eleven days, in charge of the soup. Nobody was harmed by the soup, whatever was said at the time.
`;
  var M_04 = `
# IV. In which I am painted (1532 onwards)

I sat for Master Vos in 1611 at one hundred and eighty-five years of age, looking fifty-four.

Since then I have had the portrait improved three times. Pemberton & Vale have been most accommodating, and I see no reason why they should ever stop.
`;
  var M_05 = `
# V. The beetroot conversion (1926)

On the advice of Dr Hart, I took up beetroot juice in the spring of 1926. A hundred years later I have never felt better. The village, I believe, has never felt better about me.
`;
  var M_06 = `
# VI. The conspiracy (2026; in progress)

Chairs. A table. The candelabrum. Chalk on the floor. A sausage roll.

On the eighteenth of November, singing on the wind, in Marta's tongue. I could not make out the words. I stood at the window until the bells stopped.

[draft: who? why? Hollis says "probably the wind". Hollis has said "probably the wind" more this month than in the last seventy years.]
`;
  var M_FACT = `
# Fact-check (H.)

| claim | where | verdict |
|---|---|---|
| became Count in 1467 | ch. II | 1476. It is carved over the gate. |
| present at Agincourt | ch. III | Agincourt: 1415. You: 1426. |
| nowhere near Agincourt | ch. III | Correct, if over-emphatic. |
| looked thirty in 1611 | ch. IV (branch "younger") | Master Vos wrote "fifty-four" on the back. |
| "I have never owned a harpsichord" | (withdrawn chapter) | We do not speak of it. |
`;
  function df(path, minus, plus, at) {
    var lines = ["--- a/" + path, "+++ b/" + path, "@@ -" + (at || 1) + "," + (minus.length + 1) + " +" + (at || 1) + "," + (plus.length + 1) + " @@"];
    return lines.concat(minus.map(function (l) { return "-" + l; }), plus.map(function (l) { return "+" + l; })).join("\n");
  }
  var CH3 = "chapters/03-a-youthful-campaign.md";
  var memoirCommits = [
    { hash: "c0115ed", author: "Casimir Morvanescu", date: nov(18, "23:30"), parents: ["b0d1e5a"], refs: ["main"],
      msg: "chapter 6: singing on the wind\n\nIn Marta's tongue. I could not make out the words.\nHollis says probably the wind. Hollis has said that a great deal lately.",
      files: [{ path: "chapters/06-the-conspiracy.md", status: "M", diff: df("chapters/06-the-conspiracy.md", [], ["", "On the eighteenth of November, singing on the wind, in Marta's tongue. I could not make out the words. I stood at the window until the bells stopped."], 3) }] },
    { hash: "b0d1e5a", author: "Casimir Morvanescu", date: nov(2, "03:10"), parents: ["bee7f00"],
      msg: "chapter 6: the conspiracy (in progress)\n\nSomething is afoot. Posterity will want to know.",
      files: [{ path: "chapters/06-the-conspiracy.md", status: "A" }] },
    { hash: "bee7f00", author: "Casimir Morvanescu", date: "2025-06-01T02:00:00", parents: ["acce97d"],
      msg: "chapter 5: the beetroot conversion (1926)\n\nA hundred years. Earthy. Red. One hardly notices the difference.\n(One notices the difference.)",
      files: [{ path: "chapters/05-the-beetroot-conversion.md", status: "A" }] },
    { hash: "acce97d", author: "Casimir Morvanescu", date: "2024-02-14T01:00:00", parents: ["1611ace", "fac7c4f"],
      msg: "Merge branch 'hollis/fact-check'\n\nI accept these corrections under protest.\nUnder considerable protest.\nThe sign over the gate is very large, I grant.",
      files: [{ path: "chapters/02-the-title-1476.md", status: "M" }, { path: CH3, status: "M" }, { path: "notes/fact-check.md", status: "A" }] },
    { hash: "fac7c4f", author: "Hollis Pike", date: "2024-02-11T10:15:00", parents: ["fac7c4e"], refs: ["hollis/fact-check"],
      msg: "fact-check: chapter 3 (Agincourt, again)\n\nThe merged 'definitely-not-agincourt' version stands. Adding the date, so it stays stood.\nAlso: the soup. It is in the parish records. Nobody was harmed by the soup.",
      files: [{ path: CH3, status: "M", diff: df(CH3, [], ["", "(H.: Agincourt was in 1415. You were born in 1426.)", "", "I was at the siege of a small town whose name I have forgotten, for eleven days, in charge of the soup. Nobody was harmed by the soup, whatever was said at the time."], 5) }] },
    { hash: "fac7c4e", author: "Hollis Pike", date: "2024-02-10T09:40:00", parents: ["1611ace"],
      msg: "fact-check: 1476, not 1467\n\nThe file name said 1476 and the text said 1467. The gate says 1476, in letters two feet high.",
      files: [
        { path: "chapters/02-the-title-1476.md", status: "M", diff: df("chapters/02-the-title-1476.md", ["In 1467, at the age of fifty, I became Count Morvanescu, and I have remained so, the paperwork never having caught up."], ["In 1476, at the age of fifty, I became Count Morvanescu, and I have remained so, the paperwork never having caught up."], 3) },
        { path: "notes/fact-check.md", status: "A" }
      ] },
    { hash: "30a6e01", author: "Casimir Morvanescu", date: "2023-05-03T03:40:00", parents: ["30a6e00"], refs: ["younger"],
      msg: "and in the README\n\nConsistency, Hollis. You are always on about consistency.",
      files: [{ path: "README.md", status: "M", diff: df("README.md", [], ["", "The author is thirty."], 3) }] },
    { hash: "30a6e00", author: "Casimir Morvanescu", date: "2023-05-02T02:55:00", parents: ["1611ace"],
      msg: "make me thirty in every chapter\n\nIf the portraits can be improved, so can the prose.",
      files: [
        { path: "chapters/02-the-title-1476.md", status: "M", diff: df("chapters/02-the-title-1476.md", ["In 1467, at the age of fifty, I became Count Morvanescu, and I have remained so, the paperwork never having caught up."], ["In 1467, at the age of thirty, I became Count Morvanescu, and I have remained so, the paperwork never having caught up."], 3) },
        { path: "chapters/04-the-portraits.md", status: "M", diff: df("chapters/04-the-portraits.md", ["I sat for Master Vos in 1611 at one hundred and eighty-five years of age, looking fifty-four."], ["I sat for Master Vos in 1611 at thirty years of age, looking thirty."], 3) }
      ] },
    { hash: "1611ace", author: "Casimir Morvanescu", date: "2022-01-15T04:20:00", parents: ["3e1d0c5"],
      msg: "chapter 4: the portraits\n\nPemberton & Vale have been most accommodating. Until recently.",
      files: [{ path: "chapters/04-the-portraits.md", status: "A" }] },
    { hash: "3e1d0c5", author: "Casimir Morvanescu", date: "2021-10-28T03:00:00", parents: ["445cafe", "ab5e17c"],
      msg: "Merge branch 'definitely-not-agincourt'\n\nHollis says this one is at least possible.",
      files: [{ path: CH3, status: "M" }] },
    { hash: "ab5e17c", author: "Casimir Morvanescu", date: "2021-10-27T01:30:00", parents: ["445cafe"], refs: ["definitely-not-agincourt"],
      msg: "chapter 3: I was nowhere near Agincourt\n\nI wish to be clear about this.",
      files: [{ path: CH3, status: "M", diff: df(CH3, ["[more to follow]"], ["I was nowhere near Agincourt. I wish to be clear about this, having been unclear about it in several earlier drafts."], 5) }] },
    { hash: "decaf15", author: "Hollis Pike", date: "2021-10-26T09:00:00", parents: ["1415bad"], refs: ["agincourt"],
      msg: "agincourt: a note\n\nAgincourt: 1415. His lordship: 1426.\nLeaving this branch where it is, as a monument.",
      files: [{ path: CH3, status: "M", diff: df(CH3, [], ["", "(H.: Agincourt was in 1415. You were born in 1426. You were not magnificent at Agincourt. You were not.)"], 7) }] },
    { hash: "1415bad", author: "Casimir Morvanescu", date: "2021-10-25T02:15:00", parents: ["445cafe"],
      msg: "chapter 3: I was at Agincourt\n\nSt Crispin's Day. I remember it vividly. Mud. Speeches. Me.",
      files: [{ path: CH3, status: "M", diff: df(CH3, ["[more to follow]"], ["It was St Crispin's Day, 1415. I stood beside King Henry at Agincourt. He turned to me and said, \"Casimir, you are magnificent.\" I said, \"I know.\""], 5) }] },
    { hash: "445cafe", author: "Casimir Morvanescu", date: "2020-04-11T03:30:00", parents: ["1476c0f"],
      msg: "chapter 3: a youthful campaign",
      files: [{ path: CH3, status: "A" }] },
    { hash: "1476c0f", author: "Casimir Morvanescu", date: "2019-03-09T02:45:00", parents: ["1426aaa"],
      msg: "chapter 2: I become Count",
      files: [{ path: "chapters/02-the-title-1476.md", status: "A" }] },
    { hash: "1426aaa", author: "Casimir Morvanescu", date: "2019-03-02T01:10:00", parents: [],
      msg: "begin memoir, at last\n\nHollis says this is a 'repository'. It remembers everything.\nSo do I. Between us, nothing is lost.",
      files: [{ path: "README.md", status: "A" }, { path: "chapters/01-born-1426.md", status: "A" }] }
  ];

  var memoirs = D("memoirs", nov(18, "23:40"), [
    T("README - six centuries, nine drafts.md", "2025-06-01T02:30:00", MEMOIR_README),
    T("appendix - a glossary of Old Morvanish.md", "2024-09-12T03:00:00", GLOSSARY),
    D("memoir", nov(18, "23:30"), [
      T("README.md", "2019-03-02T01:10:00", M_README),
      D("chapters", nov(18, "23:30"), [
        T("01-born-1426.md", "2019-03-02T01:10:00", M_01),
        T("02-the-title-1476.md", "2024-02-14T01:00:00", M_02),
        T("03-a-youthful-campaign.md", "2024-02-14T01:00:00", M_03),
        T("04-the-portraits.md", "2022-01-15T04:20:00", M_04),
        T("05-the-beetroot-conversion.md", "2025-06-01T02:00:00", M_05),
        T("06-the-conspiracy.md", nov(19, "03:05"), M_06)
      ]),
      D("notes", "2024-02-14T01:00:00", [
        T("fact-check.md", "2024-02-14T01:00:00", M_FACT)
      ])
    ]),
    D("drafts by century", nov(18, "23:40"), [
      D("1400s", "2025-01-20T03:00:00", [
        T("1426 - I am born, magnificently.md", "2025-01-20T03:00:00", C1426),
        T("1476 - I become Count.md", "2025-01-21T02:40:00", C1476),
        D("early drafts", "2019-04-01T02:00:00", [
          T("draft 1 (Latin, abandoned 1502).txt", "2019-04-01T02:00:00", DRAFT_LATIN),
          T("draft 2 (in verse, abandoned 1503).txt", "2019-04-01T02:05:00", DRAFT_VERSE)
        ])
      ]),
      D("1500s", "2025-02-02T03:00:00", [
        T("1511 - the long table.md", "2025-02-02T03:00:00", C1511),
        T("1532 - I discover portraiture.md", "2025-02-03T03:00:00", C1532)
      ]),
      D("1600s", "2025-02-20T03:00:00", [
        T("1611 - sitting for Master Vos.md", "2025-02-20T03:00:00", C1611),
        T("1666 - an alibi (I was not in London).md", "2025-02-21T03:00:00", C1666)
      ]),
      D("1700s", nov(18, "23:40"), [
        T("we do not speak of it.md", "2019-04-02T04:00:00", C1700S),
        FINAL
      ]),
      D("1800s", "2025-03-11T03:00:00", [
        T("1851 - the Great Exhibition.md", "2025-03-10T03:00:00", C1851),
        T("1888 - the moustache.md", "2025-03-11T03:00:00", C1888)
      ]),
      D("1900s", "2025-04-02T03:00:00", [
        T("1926 - the beetroot conversion.md", "2025-04-01T03:00:00", C1926),
        T("1969 - the moon.md", "2025-04-02T03:00:00", C1969)
      ]),
      D("2000s", nov(19, "03:00"), [
        T("2019 - Hollis buys me a laptop.md", "2025-05-01T03:00:00", C2019),
        T("2026 - the conspiracy (in progress).md", nov(19, "03:00"), C2026)
      ])
    ])
  ]);

  /* ================= ~/beetroot ================= */
  var BEET_ORDERS = (function () {
    var r = rng(1926), rows = ["delivery_date,product,litres,field,vintage,price_gbp,status,signed_for,note"];
    var FIELDS = [["Lower Meadow", "2024"], ["Top Field", "2024"], ["The Bog", "2024"], ["Lower Meadow", "2025"], ["Top Field", "2025"], ["Orchard Strip", "2025"]];
    var NOTES = ["", "", "", "", "", "his lordship: \"insolent, with a finish of shed\"", "", "his lordship: \"earthy. too earthy. like being buried in a pleasant way\"", "", "returned one crate: \"this beetroot has seen things\"", "", "", "his lordship: \"magnificent\"", "", "late (tractor)", "", "his lordship sent his compliments to the field", ""];
    var d = U("2025-01-06"), end = U("2026-11-16"), i = 0;
    while (d <= end) {
      var f = FIELDS[Math.min(FIELDS.length - 1, Math.floor(i / 17))], litres = 14 + (r() < 0.12 ? 2 : 0);
      rows.push([ymd(d), "juice (cold-pressed)", litres, f[0], f[1], (litres * 3.2).toFixed(2), "delivered", r() < 0.85 ? "H.P." : "his lordship (in a cape)", NOTES[Math.floor(r() * NOTES.length)]].join(","));
      d = addDays(d, 7); i++;
    }
    rows.push("2026-11-23,juice (cold-pressed),14,Lower Meadow,2025,44.80,scheduled,H.P.,");
    rows.push("2026-11-23,\"'beetroot wine' (non-alcoholic) and juice, for the village harvest supper\",180,Lower Meadow,2025,612.00,scheduled,H.P.,\"300 glasses. deliver to the KITCHEN DOOR, not the front. bill the Village Hall fund, NOT the castle (H.)\"");
    return rows.join("\n");
  })();
  var TASTING = `
# Tasting notes: a century of beetroot

Taken at the near end of the long table (when it was there), by candlelight, at 21:00 precisely.

- **Lower Meadow 2025.** Deep, patient, faintly of rain on a church roof. The best in a decade. I have asked Dilys to thank the meadow.
- **Top Field 2025.** Bright, a little forward. A young beetroot that wants to be liked.
- **Orchard Strip 2025.** Apples in the background, like a rumour.
- **The Bog 2024.** Profound. Unsettling. I enjoyed it very much and do not wish to discuss it.
- **Top Field 2024.** Insolent, with a finish of shed.
- **Lower Meadow 1976 (the drought year).** I still think of it.
- **Anything with garlic.** Not a beetroot. An act of aggression.

Hollis's tasting notes, for completeness: "Red."
`;
  var DILYS = `
HART'S ROOTS - Back Lane Farm, Nether Brindle
"Beetroot since 1926 (before that, mostly turnips)"

Dear Count,

Thank you for your note about the Top Field 2024 ("insolent"). I've passed it
on to the field. It's very sorry.

Your usual order carries on, Mondays, 14 litres, the Lower Meadow 2025 as you
asked. My grandad would be thrilled you're still on it. A hundred years this
spring!

All the best,
Dilys

P.S. Hollis, the other order's in hand for Monday the 23rd. 180 litres, the
"wine" and the plain, 300 glasses' worth. Kitchen door. I'll bill the hall
fund. Mum's the word. D.
`;
  var BEET_WINE = `
# Beetroot "wine" (non-alcoholic, mostly)

For special occasions. There have not been many lately.

- 4 L Lower Meadow juice
- 1 L apple juice (Orchard Strip, for the rumour)
- 2 cinnamon sticks, 6 cloves, the peel of one orange
- honey, to taste (Hollis's taste; mine is "less")

Warm gently. Never boil. Strain. Serve in the good glasses, at the long table, to as many people as you can find.

Serves: six, or one, over a week.
`;
  var BORSCHT = `
# Borscht for one

1. One beetroot. One onion. One potato. One carrot. One Count.
2. Chop. Simmer. Taste. Sigh.
3. Do not, under any circumstances, add garlic. Some recipes will tell you to. Those recipes were written by people who have never met me.
4. Eat at the near end of the table. Look at the far end. Think about the 1511 feast. Wash up.

(H.: This recipe makes enough for two. It always has. I have pointed this out.)
`;

  var beetroot = D("beetroot", nov(16, "18:00"), [
    T("orders - Hart's Roots, 2025-26.csv", nov(16, "18:00"), BEET_ORDERS),
    T("tasting notes - a century of beetroot.md", "2026-10-28T21:30:00", TASTING),
    T("Dilys Hart - re the Top Field.txt", nov(12, "10:20"), DILYS),
    JS("Lower Meadow 2025.theme.json", "2026-10-28T21:40:00", { name: "Lower Meadow 2025", by: "Dilys Hart (for his lordship)", dark: false, v: ["#f7eef0", "#ecdde2", "#2a0f1a", "#6e4a58", "#9c1f4b", "#c46a8a"] }),
    D("recipes", "2026-09-02T03:00:00", [
      T("beetroot 'wine' (non-alcoholic).md", "2026-09-02T03:00:00", BEET_WINE),
      T("borscht for one.md", "2025-12-01T02:00:00", BORSCHT)
    ])
  ]);

  /* ================= ~/portraits ================= */
  var PORTRAIT_REGISTER = `
year,painter,title,apparent_age_as_painted,improved,apparent_age_now,hangs,note
1532,a painter from Antwerp,"Young Count with Hawk",42,1790 / 1902,"29","the stairs","the hawk was also improved"
1580,Master Hans the Younger,"The Count in Black",60,2003,"35","library",
1611,Master Vos,"Portrait in a Ruff",54,1802 / 1955 / 2011 / 2024,"31","the stairs","see the two pictures in this folder"
1702,unknown,"The Count with Harpsichord",--,--,--,"the crypt, face to the wall","we do not speak of it"
1820,R. Linnell,"The Count at Dusk",48,1990,"30","great hall",
1888,J. Sargent (a pupil of),"The Count with Moustache",50,never,"50","the stable","the moustache cannot be improved; I tried"
1953,Miss E. Parr (Over Brindle WI),"His Lordship",55,2019,"33","kitchen","Miss Parr painted me from memory as I do not sit still"
2024,Pemberton & Vale (restorers),"(improvements only)",--,--,--,--,"four rounds on the Vos. a fifth declined"
`;
  var PEMBERTON = `
PEMBERTON & VALE - Fine Art Restoration - est. 1838

17 October 2026

Dear Count Morvanescu,

Thank you for returning the Vos (1611) with your request for "a further
improvement; perhaps fifteen years; and the chin".

We have now improved this portrait four times (1802, 1955, 2011 and, under
our present partner, 2024). We enclose for your files a photograph of the
work as Master Vos left it and as it hangs today.

We must respectfully decline a fifth round. At the present rate the sitter
will shortly be an infant, and Master Vos (whose original signature reads
"aged 185, looks 54, sat very badly") would, we feel, have something to say.

May we gently suggest that his lordship has a perfectly good face, and that
the people who see it every day seem to like it very much.

Yours faithfully,

A. Vale
for Pemberton & Vale

enc. two photographs
`;
  var portraits = D("portraits", "2026-10-17T15:30:00", [
    IMG("portrait 1611 - as painted.webp", "2026-10-17T15:20:00", "portrait-1611-as-painted.webp", "1600x2000", "3.8 MB"),
    IMG("portrait 1611 - as repainted (2024).webp", "2026-10-17T15:21:00", "portrait-1611-repainted.webp", "1600x2000", "3.9 MB"),
    T("portrait register.csv", "2026-10-18T02:00:00", PORTRAIT_REGISTER),
    T("Pemberton & Vale - re your fifth request.txt", "2026-10-17T15:30:00", PEMBERTON)
  ]);

  /* ================= ~/village ================= */
  var WHOS_WHO = `
# Who's who in Nether Brindle (by H., for his lordship, who forgets names)

- **Agnes Pottle**: Pottle's Bakery, Church Lane. Has never once let garlic into a castle order. Knows everyone's business and keeps it.
- **Derek Fudge**: Tower Captain, St Wendreda's. Rings Tuesdays and Thursdays. Loud, in both senses. Kind.
- **Kit Fudge (11)**: his niece. Composes ringing methods. Asked his lordship in September what the 1400s were like, for school.
- **Sue Fudge**: ringer, councillor, tea.
- **Priya Lal**: Clerk to the Parish Council. Answers every letter. Every one. At length.
- **Gary and Jess Mott**: Mott & Daughter Roofing. Daylight only. Gary says "woodworm" when he means "no comment".
- **Dilys Hart**: Hart's Roots, the beetroot. Her grandfather, Dr Hart, put his lordship on beetroot in 1926.
- **June Okafor**: runs the Brindle Community Choir. Wednesdays, the village hall. Tenors wanted, always.
- **Miss B. Ames**: teaches Class 3B. In September 3B wrote asking what the 1400s were like. His lordship replied in thirty-one pages, with drawings. They wrote back: "thank you, you are our favourite".
- **Mrs Bellweather**: the Post Office. Her great-great-grandmother sent his lordship a ham in 1826.
`;
  var NEWSLETTER = `
# The Brindle Bugle: November

**Village Hall** closed to bookings until the end of the month (furniture). Sorry, Pilates.

**Bell practice** is running late on Tuesdays and Thursdays until the end of the month: the ringers are learning a new method composed by our own Kit Fudge (11)! Earplugs at the Post Office, free, while stocks last.

**Choir**: Wednesdays, 7.30, the village hall (well, the back room of the Post Office this month). New members welcome, especially tenors, especially anyone who can roll an R.

**Lost**: one tape measure (25 ft), last seen "up the hill". Also one sausage roll, last seen with Gary. Please return the tape measure.

**Post Office collection tin**: thank you, everyone! £297, two buttons and a euro. You know what it's for. (Don't say.)

**From the Castle**: his lordship asks us to remind residents that the bins are collected at 7 a.m., "an hour unfit for bins", and that he would welcome anyone's views. Please do not send him your views. He will reply.

**Diary**: Sat 28th, 7 p.m. Council business at the Castle (bats). Nothing else is happening on Saturday the 28th. Nothing at all. See you there.
`;
  var BELL_ROTA = (function () {
    var rows = ["date,day,start,finish,method,ringers,notes"];
    var METHODS = ["Plain Bob Doubles", "Grandsire Triples", "Stedman Doubles", "Cambridge Surprise Minor", "Plain Bob Major"];
    var NOTES = ["tea: Derek", "tea: Sue", "Kit on the treble", "new rope on the 4th", "tea: Kit's mum", "Sue away", "", ""];
    var EXT = {
      "2026-11-03": "extended to 22:30 (per H.: he's in the library with the earmuffs). keep it LOUD. curtains crew 7.45",
      "2026-11-05": "extended (per H.). tenors leave at the break for the hall; they've a lift",
      "2026-11-10": "extended: THE LONG ONE. Mott's van at the back gate 8pm. don't stop till Gary texts",
      "2026-11-12": "extended (per H.). Agnes collecting the silver 8.10. curtains again (June measuring the light)",
      "2026-11-17": "extended (per H.). Priya + Gary in the hall: bring chalk. Gary: NOT the sausage rolls",
      "2026-11-19": "extended (per H.). choir in the gallery for acoustics; sing QUIETLY",
      "2026-11-24": "extended (per H.): the rug",
      "2026-11-26": "extended (per H.): last one before the night. full touch"
    };
    var d = U("2026-09-01"), i = 0;
    while (d <= U("2026-11-26")) {
      var dow = d.getUTCDay();
      if (dow === 2 || dow === 4) {
        var k = ymd(d), learning = d >= U("2026-10-20"), ext = EXT[k];
        var note = ext || (k === "2026-09-10" ? "letter from the Castle (1st): 'calmer, please'" : k === "2026-10-20" ? "NEW: Morvane Surprise Major (Kit's composition). 600 changes when it's right. for the 28th" : NOTES[i % NOTES.length]);
        rows.push([k, DAYS[dow], "19:30", ext ? "22:30" : "21:00", learning ? "Morvane Surprise Major (learning)" : METHODS[i % METHODS.length], ext ? 8 : 6 + (i % 3), "\"" + note + "\""].join(","));
        i++;
      }
      d = addDays(d, 1);
    }
    rows.push("2026-11-28,Sat,19:05,c. 19:25,\"Morvane Surprise Major: 600 changes, full band\",8,\"start when the hall lights come on. NOT early. NOT late. (Derek)\"");
    return rows.join("\n");
  })();
  var TOWER_CAPTAIN = `
St Wendreda's, Nether Brindle - from the ringing chamber

Dear Count,

Thanks for your fourth letter, which we read out in the ringing chamber at the
break. Lovely handwriting. Kit wants to know what a "moth at a candle" sounds
like, and is very pleased you've been humming it.

You're quite right that practice has been running late. We're learning a new
method: Morvane Surprise Major. It's named after your castle, as it happens.
Kit composed it (she's eleven and very good at maths). It's a long one, about
six hundred changes when it's rung right, and we're not ringing it right yet.

Practice goes back to normal after the 28th. Sorry, after the end of the
month.

Earmuffs are a good idea. A very good idea. Keep them on.

All the best,
Derek Fudge
Tower Captain

P.S. Old Tom (the tenor) sends his regards. He's 538 this year. Not that
anyone's counting.
`;
  var village = D("village", nov(12, "09:30"), [
    T("who's who in Nether Brindle (by H).md", "2026-09-20T21:00:00", WHOS_WHO),
    T("the Brindle Bugle - November.md", "2026-11-01T08:00:00", NEWSLETTER),
    D("bell-ringers", nov(12, "09:30"), [
      T("practice rota - autumn 2026.csv", nov(12, "09:30"), BELL_ROTA),
      T("Tower Captain - re your fourth complaint.txt", nov(7, "11:15"), TOWER_CAPTAIN)
    ])
  ]);

  /* ================= ~/accounts ================= */
  function inv(no, date, vendor, lines, total, foot) {
    return T("invoice 2026-" + (no < 10 ? "00" : "0") + no + ".txt", date + "T10:00:00",
      vendor + "\n\nINVOICE                                   Date: " + date + "\nTo: Castle Morvane, Nether Brindle\n\n" + lines.join("\n") + "\n\n                                  TOTAL   " + total + "\n" + (foot || "Paid with thanks."));
  }
  var BAKERY_INVOICE = `
POTTLE'S BAKERY - 4 Church Lane, Nether Brindle
"Bread since 1891. Cake since before that, probably."

INVOICE No. 0117                                     Date: 2026-11-16
To: Mr H. Pike, c/o The Castle

   ** Hollis, love: please don't leave this lying about where he'll see it.
      Put it behind your dot, like you said. A. **

Qty  Item                                                           GBP
1    Celebration cake, four tiers, to serve 300                  186.00
       - sponge: dark chocolate & beetroot (per H.; Dilys's beetroot)
       - icing: black, with silver stars
       - NO GARLIC, obviously. We've scrubbed the whole kitchen.
         Twice. Our Kevin has been sent to his nan's with the
         garlic bread.
       - lettering: in the old language, as per H.
         (H. is checking the spelling. "Sasevek" has an accent.)
6    Candles, large, church                                       21.00
       - We have talked about this, Hollis. 600 is a fire risk.
         Six large ones. One per century. Final answer.
300  Sausage rolls (vegetarian: beetroot & thyme)                  90.00
       - minus one, which Gary has had already, in your hall,
         on Tuesday. Charged to Gary.
1    Delivery: Sat 28 Nov, 18:00, kitchen door (H. to unlock)       0.00
1    Polishing: candelabrum, five-branched (Mum's method)          0.00

                                              TOTAL           297.00
                                              PAID            297.00

Paid by: the collection tin at the Post Office (297.00, two buttons, a
euro, and a note from Kit: "for the Count's cake I hope he likes it")

Thank you for your custom!  Agnes
`;
  var BAKERY = { name: "invoice 2026-019.txt", kind: "file", date: "2026-11-16T17:30:00", text: body(BAKERY_INVOICE) };
  var invoices = D("invoices 2026", nov(18, "10:00"), [
    inv(1, "2026-01-31", "HART'S ROOTS - Back Lane Farm", ["Beetroot juice, Lower Meadow 2024, Jan (4 deliveries)  56 L"], "179.20"),
    inv(2, "2026-02-03", "WICKS & SONS, Chandlers", ["Candles, beeswax, tall (x120)", "Candles, beeswax, stubby (x40)"], "214.00"),
    inv(3, "2026-02-28", "HART'S ROOTS - Back Lane Farm", ["Beetroot juice, Top Field 2025, Feb (4 deliveries)  56 L"], "179.20"),
    inv(4, "2026-03-09", "REFLECT & CO. - Mirrors of Distinction", ["Mirror, gilt, oval (No. 7)"], "340.00", "Refunded in full: returned (\"defective\")."),
    inv(5, "2026-03-31", "HART'S ROOTS - Back Lane Farm", ["Beetroot juice, Top Field 2025, Mar (5 deliveries)  70 L"], "224.00"),
    inv(6, "2026-04-14", "ROYAL MAIL", ["Second-class stamps (x400): correspondence, Council"], "340.00", "Note: the Council office is 400 yards away. (H.)"),
    inv(7, "2026-04-30", "HART'S ROOTS - Back Lane Farm", ["Beetroot juice, Orchard Strip 2025, Apr (4 deliveries)  56 L"], "179.20"),
    inv(8, "2026-05-20", "REFLECT & CO. - Mirrors of Distinction", ["Mirror, cheval, mahogany (No. 8)"], "520.00", "Refunded in full: returned (\"defective\")."),
    inv(9, "2026-05-31", "HART'S ROOTS - Back Lane Farm", ["Beetroot juice, Orchard Strip 2025, May (5 deliveries)  70 L"], "224.00"),
    inv(10, "2026-06-30", "HART'S ROOTS - Back Lane Farm", ["Beetroot juice, Lower Meadow 2025, Jun (4 deliveries)  56 L"], "179.20"),
    inv(11, "2026-07-31", "HART'S ROOTS - Back Lane Farm", ["Beetroot juice, Lower Meadow 2025, Jul (5 deliveries)  70 L"], "224.00"),
    inv(12, "2026-08-12", "WICKS & SONS, Chandlers", ["Candles, beeswax, tall (x120)"], "180.00"),
    inv(13, "2026-08-31", "HART'S ROOTS - Back Lane Farm", ["Beetroot juice, Lower Meadow 2025, Aug (4 deliveries)  56 L"], "179.20"),
    inv(14, "2026-09-30", "HART'S ROOTS - Back Lane Farm", ["Beetroot juice, Lower Meadow 2025, Sep (4 deliveries)  56 L"], "179.20"),
    inv(15, "2026-10-09", "MOTT & DAUGHTER ROOFING", ["Survey, east tower (daylight)"], "150.00"),
    inv(16, "2026-10-17", "PEMBERTON & VALE, Restorers", ["Return carriage, the Vos (1611), fifth improvement declined"], "85.00"),
    inv(17, "2026-10-31", "HART'S ROOTS - Back Lane Farm", ["Beetroot juice, Lower Meadow 2025, Oct (5 deliveries)  70 L"], "224.00"),
    inv(18, "2026-11-02", "BRINDLE HABERDASHERY", ["Earmuffs, lambswool, red", "Earmuffs, lambswool, black (spare)"], "38.00"),
    BAKERY,
    inv(20, "2026-11-17", "REFLECT & CO. - Mirrors of Distinction", ["Mirror, Venetian, bevelled (No. 9)"], "610.00", "Refunded in full: returned (\"defective\")."),
    inv(21, "2026-11-18", "WICKS & SONS, Chandlers", ["Candles, beeswax, tall (x120)", "Candles, beeswax, tall, EXTRA (x300), per H."], "630.00")
  ]);
  var BUDGET = `
category,jan,feb,mar,apr,may,jun,jul,aug,sep,oct,nov,note
beetroot,179.20,179.20,224.00,179.20,224.00,179.20,224.00,179.20,179.20,224.00,224.00,steady. like his lordship
candles,0,214.00,0,0,0,0,0,180.00,0,0,630.00,"November: see the extra 300 (H.)"
stamps (letters to the Council),40.00,52.00,61.00,340.00,48.00,55.00,60.00,44.00,71.00,96.00,128.00,the Council is 400 yards away
mirrors,0,0,340.00,0,520.00,0,0,0,0,0,610.00,all refunded. all "defective"
mirrors (refunded),0,0,-340.00,0,-520.00,0,0,0,0,0,-610.00,
roof fund,500,500,500,500,500,500,500,500,500,500,500,at this rate: 2031
restorers,0,0,0,0,0,0,0,0,0,85.00,0,fifth improvement declined
earmuffs,0,0,0,0,0,0,0,0,0,0,38.00,red (and a spare)
bat saucer,0,0,0,0,0,0,0,0,0,0,0,it is a saucer
"the 28th (H.: from my own pocket)",0,0,0,0,0,0,0,0,0,0,0,"see elsewhere. not his lordship's to pay. not his lordship's to know"
`;
  var accounts = D("accounts", nov(18, "10:00"), [
    T("household budget 2026.csv", nov(18, "10:05"), BUDGET),
    invoices
  ]);

  /* ================= ~/personal ================= */
  var DIARY = `
# Private. (Hollis: this means you.)

**1 November.** Hollis has given me a new diary, again. He says writing things down "helps". It has not helped since 1520, but I am fond of Hollis, and the paper is good.

**8 November.** The chairs are gone, and now the table. I have not told the village. One does not tell the village one has mislaid forty chairs. They would laugh. They laugh at me quite often, I think, although always kindly, as if I had said something funny, which I had not.

**15 November.** The date approaches. I have not mentioned it to Hollis. One does not mention it. Six hundred. There is no one left who was there for the first one, and the village could not possibly know. I have told nobody since 1826, when I told a Mrs Bellweather and she sent a ham.

I shall spend it as I spend most evenings: with the bats, a glass of Lower Meadow, and a letter to the Council. It will be perfectly pleasant. And then there is the bat inspection, which is something. I shall wear the good cape.

**18 November.** Singing on the wind tonight, in the old tongue. I must be getting sentimental. I asked Hollis to find out who it was. Hollis said "Probably the wind, my lord," very quickly, and went to bed at nine, which he has not done since 1952.
`;
  var PROFILE_1 = `
# Profile (draft 1)

**Name:** Casimir
**Age:** 599
**Lives:** in a castle, on a hill, above a village that is fond of him (unconfirmed)
**Looking for:** a companion for long evenings. Very long evenings. Evenings, mostly.

**About me:** I am a Count of the old school: courteous, well-read, and in correspondence with the Parish Council. I enjoy candlelight, the fifteenth century, bats, and beetroot (Lower Meadow, ideally the 2025).

**Dislikes:** garlic, mornings, Grandsire Triples, mirrors (they dislike me first), and the bin lorry.

**My ideal evening:** a feast in the great hall, the long table full from end to end, bells, singing. It has not happened since 1511, but one may hope.

**Photo:** attached. (It is a very good chair.)
`;
  var PROFILE_7 = `
# Profile (draft 7, with Hollis's edits)

**Name:** Casimir
**Age:** 599 *(H.: "Young at heart" tested better)*
**Lives:** in a castle, on a hill, above a village that is fond of him *(H.: confirmed. Strike "unconfirmed".)*
**Looking for:** a companion for long evenings. *(H.: one "evenings" is plenty.)*

**About me:** I am a Count of the old school: courteous, well-read, and in correspondence with the Parish Council. I enjoy candlelight, the fifteenth century, bats, and beetroot. *(H.: removed the vintage. It reads as showing off.)*

**Dislikes:** garlic, mornings, mirrors (they dislike me first), and the bin lorry. *(H.: removed Grandsire Triples. The ringers are on this app.)*

**My ideal evening:** a feast in the great hall, the long table full from end to end, bells, singing. *(H.: removed "It has not happened since 1511". Leave it there. Leave it hopeful.)*

**Photo:** attached. *(H.: It is a chair, my lord. We have discussed the chair.)*
`;
  var MATCHES = `
MATCHES THIS WEEK: 0

The app suggests: "Try adding a photo where we can see your face!"
I have added fourteen. (H.: they are all of the chair.)

The app suggests: "Tell people what makes you unique!"
I have told them. (H.: you told them about the gondola.)

The app suggests: "Not having luck? Try widening your age range!"
It is already 18 to 600. One cannot widen it further. One has tried.

One new message, from "Ilse_vonD_REAL":
  "CASIMIR IS THIS YOU. WHY ARE YOU ON HERE. ALSO WHY IS IT A CHAIR."
`;
  var MIRRORS = `
order,date,mirror,price_gbp,returned,reason given
1,2025-04-02,"Mirror, hall, plain",120.00,2025-04-09,"defective: shows the hall only"
2,2025-06-11,"Mirror, bathroom, LED",89.00,2025-06-14,"defective: shows the light, not the face"
3,2025-08-19,"Mirror, convex, Georgian",410.00,2025-08-20,"defective; also Georgian (we do not speak of it)"
4,2025-10-03,"Mirror, compact, travel",12.00,2025-10-04,"defective: shows my hat but not the man inside it"
5,2025-12-12,"Mirror, full length, 'True View'",260.00,2025-12-20,"defective: false advertising"
6,2026-01-22,"Mirror, smart (with app)",699.00,2026-01-23,"the app says 'no face detected'. I have a face. Hollis can vouch for it"
7,2026-03-09,"Mirror, gilt, oval",340.00,2026-03-16,"defective: shows Hollis, which is not what I ordered"
8,2026-05-20,"Mirror, cheval, mahogany",520.00,2026-05-28,"defective; also the frame was too cheerful"
9,2026-11-02,"Mirror, Venetian, bevelled",610.00,2026-11-17,"defective. I had hoped, before the 28th, to see what six hundred looks like"
10,2026-11-18,"Mirror, antique, 'as seen in castles'",450.00,,"on order. this one will be different"
`;
  var REFLECT = `
REFLECT & CO. - Mirrors of Distinction - Customer Care

Ref: return No. 9 (Mirror, Venetian, bevelled)

Dear Count Morvanescu,

Thank you for returning your ninth mirror, which our technicians have examined
with great care. We are pleased to report that it reflects perfectly.

We note your reason for return: "it shows the room, the candle, the cape on its
hook, and the bat on the sill, but not the man in front of it." We have tested
it in front of several men. It shows them all.

We are, of course, happy to refund you once again. We would, however, ask
whether a mirror is really what his lordship is looking for.

With every good wish,

Customer Care, Reflect & Co.

P.S. A Mr Pike telephoned to ask us, very politely, to stop selling you
mirrors. We said we could not do that. He said "Fine. Not long now, anyway."
`;
  var personal = D("personal", nov(18, "23:50"), [
    T("diary - private (Hollis, do NOT read).md", nov(18, "23:50"), DIARY),
    D("dating", nov(4, "03:30"), [
      T("profile - draft 1 (mine).md", "2026-09-14T02:00:00", PROFILE_1),
      T("profile - draft 7 (with Hollis).md", "2026-10-02T21:10:00", PROFILE_7),
      IMG("profile photo (attempt 14).webp", "2026-09-14T01:30:00", "profile-photo-attempt-14.webp", "1600x2000", "2.9 MB"),
      T("matches.txt", nov(4, "03:30"), MATCHES)
    ]),
    D("mirrors", nov(18, "14:00"), [
      T("orders and returns.csv", nov(18, "14:00"), MIRRORS),
      T("Reflect & Co - customer care.txt", nov(17, "16:20"), REFLECT),
      B("return label (9th).pdf", nov(17, "09:00"), "84 KB")
    ])
  ]);

  /* ================= ~/Pictures ================= */
  var SELFIES_WHY = `
WHY ARE MY SELFIES EMPTY (H., for the fourth time)

My lord,

You do not appear in photographs. You have never appeared in photographs. You
did not appear in the daguerreotype in 1841, which you blamed on the
daguerreotype, or in the Polaroid in 1972, which you blamed on Polaroid.

The phone is not broken. Nine phones have not been broken. The great hall
looks very well in your selfie. So does the library. So does the cup, which
you are holding, and which is therefore floating.

If you would like a picture of yourself, the only reliable method is a person
who knows your face and is willing to paint it from memory. I am told there
are such people. I am told they are closer than you think.

H.
`;
  var Pictures = D("Pictures", "2026-10-31T23:30:00", [
    D("selfies", "2026-10-31T23:30:00", [
      IMG("selfie - great hall, new cape.webp", "2026-10-31T23:10:00", "selfie-great-hall.webp", "2400x1600", "4.4 MB"),
      IMG("selfie - library, reading.webp", "2026-10-20T01:45:00", "selfie-library.webp", "1600x2000", "3.6 MB"),
      T("why are my selfies empty (H).txt", "2026-10-31T23:30:00", SELFIES_WHY)
    ])
  ]);

  /* ================= ~/hollis ================= */
  var HOLLIS_README = `
README - for his lordship

My lord,

This is my folder. There is nothing in it but rotas, receipts and the choir.
Nothing here concerns you, or the great hall, or any particular date.

There is nothing behind the dot.

(Disregard the previous sentence. There is no previous sentence.)

H.
`;
  var EVENINGS = (function () {
    var TOPIC = { 3: "the bins (letter 7)", 5: "the bells (letter 4)", 10: "the bats: on their dignity", 12: "the streetlights (too bright)", 17: "the duck pond (its tone)", 19: "the bins (letter 8)", 24: "the bells (letter 5)", 26: "a letter of thanks to the Council for its replies (he will enjoy this)" };
    var rows = ["date,day,his lordship 19:00-22:30,letter topic (supplied),me"];
    for (var n = 1; n <= 28; n++) {
      var d = U("2026-11-" + pad(n)), dow = d.getUTCDay(), lord, me, topic = "";
      if (n === 28) { lord = "the bat inspection: 19:00, Great Hall (dress: formal)"; topic = "none needed"; me = "here. very much here"; }
      else if (dow === 2 || dow === 4) { lord = "library; earmuffs on (the bells)"; topic = TOPIC[n] || ""; me = "'choir'"; }
      else if (dow === 3) { lord = "beetroot tasting; the bats"; me = "choir"; }
      else if (dow === 0) { lord = "memoirs"; me = "here"; }
      else if (dow === 6) { lord = "correspondence (the immortals)"; me = "here"; }
      else { lord = ["the battlements (the moon)", "the bats", "memoirs"][n % 3]; me = "here"; }
      rows.push([ymd(d), DAYS[dow], "\"" + lord + "\"", "\"" + topic + "\"", me].join(","));
    }
    return rows.join("\n");
  })();
  var FRIDGE = `
# Notes left on the fridge (archive)

- *To whoever left the beetroot juice on the windowsill "to catch the moonlight": it has caught a fly.*
- *My lord: the dishwasher is not a "hot cupboard". Your cape is now cape-shaped in a new way.*
- *The bats' saucer has been moved back. I moved it. Because it was on the stairs. Where people walk. In the dark. Which is always.*
- *Please do not write to the Council in red ink. They think you are cross. You are cross. But they need not know.*
- *There are 212 bats and one of me.*
- *Whoever keeps signing for parcels "C., Count, Lord of the Hill and the Valley and Some Of The Next Valley": the courier would like a shorter name.*
- *Mirror No. 10 is on order. I have not cancelled it. I have thought about it.*
- *The kitchen door is now locked and I have the only key. This is for security. It is not for anything else. (Nov 1)*
`;
  var TODO = `
# To do (H.)

- [x] Bins: letter 7. Sent the revised version. The first one said "take steps".
- [x] Earmuffs, red. And a spare. (He will lose one. He always loses one.)
- [x] New lock on the kitchen door. One key. Mine.
- [ ] Agnes re: S. (lettering: accent on the e)
- [ ] Mott: Tues 10th, 8pm, back gate. Mind the drawbridge (lower it at 7.50; raise it at 22.20)
- [ ] Keep the dust in the great hall. DO NOT LET MRS BELLWEATHER DUST.
- [ ] Re-file the eighteenth century
- [ ] Do not hum at breakfast. You have been humming at breakfast.
- [ ] Find out what Kit's method sounds like when it's right
- [ ] Practise saying "probably the wind" without blinking
`;
  var HANDBOOK = `
# Staff handbook (staff: me)

**1.** The familiar shall rise at dusk and retire at dawn, or at nine on choir nights.

**2.** The familiar shall file everything. Everything. (He cannot help it, and has stopped trying.)

**3.** The familiar shall not dust the great hall without instruction. (Amended 1 Nov 2026: shall not dust it at all, until further notice.)

**4.** The familiar shall not lie to his lordship.
   *(Amended 1 Nov 2026, temporarily: except where furniture is concerned.)*
   *(Amended 3 Nov: and curtains.)*
   *(Amended 12 Nov: and silver.)*
   *(Amended 18 Nov: and the wind.)*

**5.** The familiar shall be present on his lordship's birthday. (Added 1952. Never once required. He has never once mentioned it.)

**6.** The familiar shall remember that he is fond of his lordship, especially on Tuesdays, when it is hardest.
`;
  var CHOIR_NOTES = `
# Wednesday choir: notes (H.)

Brindle Community Choir. **Wednesdays only**, 19:30-21:00, the village hall (this month: the back room of the Post Office, the hall being full of table). Director: June Okafor.

## Winter programme
1. "In the Bleak Midwinter" (tenors: breathe)
2. "The Holly and the Ivy"
3. "Ding Dong Merrily" (Derek wants to bring a handbell. Derek may not.)
4. **Item 4.** The old song, *Sasévek Ouri*, in Old Morvanish. Coach: me, the only one of us who knows the vowels. NOT for Christmas. For the 28th.

## Notes for Item 4
- Thirty-one voices, plus Kit, who has a solo on the last line.
- The tenors keep singing *pisko* as "biscuit".
- June wants to rehearse in the castle gallery for the acoustics. Only on a Thursday, during the bells, when he's in the library with the earmuffs. Only quietly. (We tried on the 18th, which was a Wednesday, in the village; the wind carried it up the hill. He heard. He stood at the window. He did not understand the words. He has written them in his own glossary and never read it back.)
`;
  var LYRICS = `
SASÉVEK OURI
(trad. Old Morvanish; words as taught by H. Pike; phonetic spelling under each line)
Brindle Community Choir - Item 4 - Wednesdays only - DO NOT TAKE HOME

1.  Sasévek ouri na velmor,
    SAH-seh-vek OO-ree nah VEL-mor
    i jesh pisko na konsil.
    ee YESH PEES-ko nah kon-SEEL

    Nivé, nivé, mi grav!
    NEE-veh, NEE-veh, mee GRAHV
    Tulo stal je v dornu.
    TOO-lo STAHL yeh v DOR-noo

2.  Zvoni zvonjat sasévek,
    ZVO-nee ZVON-yaht SAH-seh-vek
    kandi, pogach i vesla.
    KAN-dee, po-GAHCH, ee VES-la

    Nivé, nivé, mi grav!
    Tulo stal je v dornu.

3.  (slowly; everybody; Kit and the children on the last line)
    Libam te, mi grav. Libam.
    LEE-bahm teh, mee GRAHV. LEE-bahm.

June: "Lovely. But the tenors are still singing 'pisko' as 'biscuit'."
H.: The translation is on the back of my copy. My copy is not leaving my pocket.
`;
  var LEAVE = `
LEAVE REQUEST

Employee:     H. Pike (familiar)
Employer:     Count C. Morvanescu (signature held by H. Pike, under power of attorney, 1987)
Dates:        Sunday 29 November 2026 (one day)
Reason:       I expect to be tired.
              Also emotional. Mostly tired.

Approved:     yes (H. Pike, on his lordship's behalf)
Comment:      He would approve it. He has never refused me anything, except a
              day off, which he forgets exists.
`;
  var CONTRACT = `
CONTRACT OF SERVICE (1952, renewed annually by handshake)

The familiar agrees:
  - to manage the household, the correspondence and the bats;
  - to keep his lordship from the worst of the twentieth century, and later
    the twenty-first;
  - to keep his lordship's secrets.

His lordship agrees:
  - to pay in candles, beetroot and conversation, at the familiar's choice;
  - to keep the familiar's secrets. (He does not know he has agreed to this. It
    is in the small print. I wrote the small print.)

Signed: C. (with a flourish)      H. (with a pen that works)
`;
  var HOLLIS_SETUP = {
    name: "Everything in its place", by: "H. Pike",
    theme: "solarized-light", layoutTheme: "hairline-ledger", iconTheme: "minimal", viewMode: "details",
    showSidebar: true, showAddressBar: true, showStatusBar: true, showPreviewPane: false,
    millerLayers: 2, folderPeek: true, showHidden: true, terminal: false, split: true,
    keybindings: { "general.openContentSearch": "Ctrl+F", "view.toggleHidden": "Ctrl+H", "file.newFolder": "Ctrl+Shift+N" }
  };

  // ~/hollis/.private: hidden. Reached by the README's slip, Agnes's note on the invoice, the restored handover note
  // and Hollis's own setup (which shows hidden files).
  var WHERE = `
# Where everything is (for the 28th)

Because I file everything, and cannot stop, and he can find nothing, and I am counting on both.

| what | where |
|---|---|
| guest list (300, give or take Bartholomew) | here |
| what we borrowed, and when | here |
| cover stories | here |
| **the invitation, the plan, the present** | **his memoirs, "drafts by century": the one century he will not discuss. Behind a dot.** He said in my first week, "Hollis, we do not speak of the eighteenth century," and we have not, and I keep things in it. |
| the cake | Agnes. The invoice is filed with the others. (I could not bring myself to misfile it.) |
| the song | the choir folder. The translation is in my pocket. (His own glossary would do it too. He wrote it. He has never read it back.) |
| the table legs | Mott's van |
| the table | the village hall, being waxed |
| the chairs | the village hall, being re-glued |
| the candelabrum | Agnes's back room, being polished |
| the dust | the great hall. Do not touch the dust. |
| my nerve | unknown |
`;
  var BORROWED = `
date,time,item,taken by,taken to,why,cover story if asked
2026-11-03,19:45,curtains (all eleven: opened),Derek's sister + Kit's mum,(stayed put),"airing; the hall smells of the eighteenth century","they blew open"
2026-11-03,19:50,drawbridge (lowered),me,(stayed put),"to let them in","the wind"
2026-11-05,19:50,chairs with arms (x40),the choir tenors (in relays),the village hall,"re-gluing the wobbly ones; polish","woodworm treatment"
2026-11-10,20:00,"the long table (legs off, top on Gary's trestles)","Gary, Jess + six ringers",the village hall,"waxed; first time since 1890","woodworm (the table has the worst of it)"
2026-11-12,20:10,candelabrum (five-branched),Agnes,the bakery (back room),"polishing (her mum's method: bicarbonate and patience)","sent for valuation"
2026-11-12,20:15,curtains (opened again),June,(stayed put),"measuring the light for the choir in the gallery","they blew open"
2026-11-17,19:40,"the hall itself (measured; chalk)","Priya + Gary",(stayed put),"the layout for the night","the bat surveyors"
2026-11-17,19:41,one paper star (dropped),Kit,under Siegfried,"practising decorations","he will not ask about a star. (he asked about the star.)"
2026-11-17,21:30,one sausage roll,Gary,Gary,hunger,"deny everything"
2026-11-24,20:00,(planned) the good rug back down,ringers,the great hall,,
2026-11-28,14:00,(planned) everything back,everybody,the great hall,,"there will be no need of a cover story by then"
`;
  var COVER = `
# Cover stories (agreed, H. and the village)

If his lordship asks about:

- **the chairs**: woodworm treatment. Woodworm are nocturnal. (Untrue. Unchallenged.)
- **the table**: woodworm, worst case. "It has been taken away to be treated, my lord." (True, in a sense: it has been waxed.)
- **the curtains**: they blew open. (Eleven of them. Inward. He did not query the physics. He is kind.)
- **the candelabrum**: sent for valuation. He will be upset that anyone would value it. He values it.
- **the chalk**: the bat surveyors.
- **the singing**: probably the wind.
- **why I go to choir on Tuesdays and Thursdays when choir is on Wednesdays**: he has not asked. If he asks: extra rehearsals. (This is true. It is just not singing.)
- **the 28th**: say nothing. Look at the floor. If cornered: "the bat inspection, my lord."
`;
  var GUESTS = `
group,number,contact,bringing,notes
the choir,31,June,"the song (Item 4)","in the gallery from 15:00; back stair"
the ringers,8,Derek,the bells,"in the tower; they join us at 19:30, deafened"
Class 3B and their families,58,Miss Ames,the present,"the children on the last line of the song"
the Parish Council,7,Priya,"the lure (the 'inspection')","Priya in her lanyard"
Pottle's,6,Agnes,"cake (300), sausage rolls (299)","garlic check at the kitchen door"
Hart's Roots,4,Dilys,"beetroot 'wine', 180 L","and proper wine, for everybody else"
Mott & Daughter,7,Gary,"trestles A-H, the table legs, the van","daylight to set up; Gary has agreed to stay after dark, 'just this once'"
Over Brindle WI,22,Mrs Parr,"jam, and Miss Parr's 1953 portrait (on loan)",
the Post Office and Church Lane,41,Mrs Bellweather,"chairs (spare), candles",
the surgery,5,Dr Tom Hart,"a first-aid kit, for Derek's ears",
St Wendreda's,3,Reverend Ames,"let Old Tom ring last",
the duck pond residents' association,12,Sue,"an apology regarding the tone of the duck pond",
the allotments,19,Dilys,"beetroot (decorative)",
the pub,24,the landlord,"the piano (on wheels)",
the bus (the 47),1,the driver,"the 47 will wait at the bottom of the hill until 23:00",
everyone else,49,word of mouth,"a candle and a kind word each",
the immortals,3,me,"a hat (Ilse), candles (the Marquise), his voice (Bartholomew)","from 1 a.m."
TOTAL,300,,,"give or take Bartholomew"
`;
  var HDIARY = `
# I am a terrible liar (a diary, H.)

**1 November.** Agreed with Priya, Agnes, Derek and June: we do it. The 28th. Six hundred. I said I would be the inside man. I have never been an inside man. I have only ever been an inside familiar.

**3 November.** Curtains. He came up at 22:41 and stood in the hall in the moonlight and said "Hollis, who has done this?" I said "the wind, my lord." He said "The wind has never been so thorough." He is right. The wind has never been so thorough.

**5 November.** Chairs. I said woodworm. I have no idea why I said woodworm. I have been saying woodworm ever since.

**10 November.** The table. He nearly caught us. Came up ten minutes early because the earmuffs pinched. Derek and Jess were halfway over the drawbridge with the legs. I wrote a handover note that night, in case he sacked me. Then I deleted it. Nobody is sacking anybody. Pull yourself together, Hollis.

**12 November.** He started an incident log. He dictated it. I typed it. I am typing the evidence against myself, beautifully formatted.

**17 November.** Gary ate a sausage roll in the great hall. I have filed the crumb.

**18 November.** The choir, on the wind. He stood at the window for an hour. He said, "Hollis, it is Marta's tongue. Nobody has sung in it since I was small." I said, "Probably the wind, my lord." I went to bed at nine so that he would not see my face.

Ten days. I can do ten days.
`;

  var hollis = D("hollis", nov(18, "23:58"), [
    T("README - for his lordship.txt", "2026-11-01T22:00:00", HOLLIS_README),
    T("his lordship's evenings - November.csv", nov(14, "09:00"), EVENINGS),
    T("notes left on the fridge (archive).md", nov(1, "08:30"), FRIDGE),
    T("to do.md", nov(18, "08:00"), TODO),
    T("staff handbook (staff - me).md", nov(18, "23:30"), HANDBOOK),
    D("choir", nov(18, "21:30"), [
      T("Wednesday choir - notes.md", nov(18, "21:30"), CHOIR_NOTES),
      T("Sasevek Ouri - words (phonetic).txt", "2026-10-21T22:00:00", LYRICS),
      { name: "rehearsal - item 4 (Wed 18 Nov).m4a", kind: "file", type: "audio", date: nov(18, "21:05"), size: "6.2 MB", duration: "3:41" }
    ]),
    D("admin", nov(16, "08:00"), [
      T("contract of service (1952).txt", "2026-01-01T00:05:00", CONTRACT),
      T("leave request - Sun 29 Nov.txt", nov(16, "08:00"), LEAVE),
      JS("everything in its place.setup.json", "2026-02-02T09:00:00", HOLLIS_SETUP)
    ]),
    D(".private", nov(18, "23:58"), [
      T("where everything is.md", nov(18, "23:58"), WHERE),
      T("what we borrowed and when.csv", nov(17, "23:59"), BORROWED),
      T("cover stories.md", nov(12, "23:40"), COVER),
      T("guest list.csv", nov(16, "22:00"), GUESTS),
      T("diary - I am a terrible liar.md", nov(18, "23:55"), HDIARY)
    ])
  ]);

  /* ================= ~/.config ================= */
  var COUNT_SETUP = {
    name: "By candlelight", by: "Count Casimir Morvanescu",
    theme: { name: "Crypt, but tasteful", dark: true, v: ["#16121a", "#211a26", "#ece3d6", "#a99bb0", "#b3243f", "#9b7bb5"] },
    layoutTheme: "soft-cards", iconTheme: "classic", viewMode: "tiles",
    showSidebar: true, showAddressBar: false, showStatusBar: false, showPreviewPane: true,
    millerLayers: 0, folderPeek: true, showHidden: false, terminal: false, split: false,
    keybindings: { "navigation.goHome": "Alt+H" }
  };
  var config = D(".config", "2026-10-31T23:05:00", [
    D("tauri-explorer", "2026-10-31T23:05:00", [
      JS("by candlelight.setup.json", "2026-10-31T23:05:00", COUNT_SETUP),
      JS("crypt, but tasteful.theme.json", "2026-10-31T23:00:00", COUNT_SETUP.theme)
    ])
  ]);

  /* ================= the tree ================= */
  var casimir = D("casimir", nov(19, "07:30"), [
    T("INCIDENT LOG - who is taking my furniture.md", nov(19, "07:30"), HOOK),
    T("passwords.txt", "2026-04-01T02:00:00", PASSWORDS),
    T("READ ME, MY LORD - the laptop.txt", "2026-03-02T21:30:00", README_LORD),
    accounts, beetroot, castle, correspondence, hollis, memoirs, personal, Pictures, portraits, village, config
  ]);
  var home = D("home", "2019-02-14T22:00:00", [casimir]);
  var ROOT = [etc, home];

  TX.count = {
    title: "The Count's laptop",
    users: [
      { id: "casimir", name: "Count Casimir Morvanescu", home: H,
        blurb: "The household laptop of Castle Morvane, above the village of Nether Brindle. Owned by a six-hundred-year-old count; run by his familiar, who files everything.",
        bookmarks: [H, H + "/castle/great hall", H + "/correspondence", H + "/memoirs", H + "/hollis"],
        setup: { parts: [], theme: "dark", layout: "default", icons: "material", view: "details", path: H } }
    ],
    tree: { name: "", kind: "dir", kids: ROOT },
    trash: [
      {
        node: T("handover - in case I am dismissed before the 28th.txt", nov(10, "23:50"), `
HANDOVER NOTES
in case I am dismissed before the 28th
(for whoever comes next; or for Agnes; or for me, if I am un-dismissed)

He nearly caught us tonight. He came up from the library ten minutes early
because the earmuffs were "pinching", and Derek and Jess Mott were halfway
across the drawbridge with the table legs. I said it was woodworm treatment.
He said "at night?" I said woodworm are nocturnal. He accepted this, because
he is kind, and because he is also nocturnal.

So, in case:

1. Beetroot at 21:00, warmed, never hot. The good glass. Lower Meadow 2025.
2. He writes to the Council on Tuesdays and Thursdays, in the library, with
   the earmuffs on, while the bells ring. Let him. Supply a topic (see my
   November sheet). Priya answers every letter and asks for more detail.
3. The bells must be loud and long until the 28th. Derek knows.
4. Everything for the 28th (the invitation, the plan, the present) is in the
   one place in this house he will never open: the century he refuses to
   discuss, in his own memoirs, under drafts by century. Behind a dot, so it
   does not show. Dotted folders do not appear unless hidden files are turned
   on. He has never turned on hidden files. He believes it is a setting for
   shy people.
5. My own notes are behind the dot in my folder. Same reason.
6. On the night: if he cries, he will say it is the dust. Agree that it is
   the dust. I have kept the dust.

H.

(Deleting this. It is melodramatic. Nobody is dismissing anybody. Pull
yourself together, Hollis.)
`),
        from: H + "/hollis/admin",
        deleted: nov(11, "00:05")
      },
      {
        node: T("1415 - Agincourt, where I was magnificent.md", "2021-10-25T02:00:00", `
# 1415: Agincourt, where I was magnificent

It was St Crispin's Day. I stood beside King Henry in the mud. He turned to me and said, "Casimir, you are magnificent." I said, "I know."

I remember the arrows, the rain, the speeches. I remember that I was very brave and extremely well dressed.

[H.: My lord. Agincourt was in 1415. You were born in 1426. I have moved this to the bin, gently. You may restore it if you wish. You will not be any more at Agincourt for having restored it.]
`),
        from: H + "/memoirs/drafts by century/1400s",
        deleted: "2025-01-22T09:00:00"
      },
      {
        node: T("bells - complaint 5 (unsent, unhinged).txt", nov(17, "22:15"), `
Madam,

THE BELLS. Letter the fifth. I can hear them THROUGH THE EARMUFFS. They are
learning the moth tune and they have NEARLY GOT IT and I find, to my horror,
that I want them to get it. Tonight they very nearly got it and I stood up.
In the library. Alone. And conducted.

I demand to know what it is called.

C.

[H.: not sent. Filed in the bin, which is still filing.]
`),
        from: H + "/correspondence/council/bells",
        deleted: nov(17, "22:40")
      },
      {
        node: T("mirror - one-star review (not posted).txt", nov(17, "16:40"), `
REVIEW: Mirror, Venetian, bevelled (No. 9)    *  (one star)

Shows the room. Shows the candle. Shows the cape on its hook. Shows the bat on
the windowsill (Monsieur), who looked, I thought, rather smug.

Does not show me. Nine mirrors now, and not one of them has shown me what I
look like. I had particularly wanted to know this month. A man of a certain
age would like, once, to see his own face, and to know whether it is one that
anybody would miss.

[H.: not posted. My lord, I have filed this somewhere safe. Somewhere it
 can be got back from. Please give it ten days.]
`),
        from: H + "/personal/mirrors",
        deleted: nov(17, "17:00")
      }
    ],
    repos: {}
  };
  TX.count.repos[R] = { branch: "main", changes: [{ path: "chapters/06-the-conspiracy.md", status: "M", base: body(M_06).split("\n\n[draft:")[0] }], commits: memoirCommits };
})();
