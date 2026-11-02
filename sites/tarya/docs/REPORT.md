# Tarya pack report

Site id: `tarya` (provisional). The pack is the contents of `sites/tarya/`. UI locale is `en`, content locale is `he` (rtl auto), and profile.about is on.

## Contents
- **Personas:** 82 in total.
  - 60 core figures, 18 of them women.
  - 10 adversaries.
  - 12 seasoning accounts: 3 news wires, 7 parody/meme/bot accounts and 2 folklore accounts.
- **Avatars:** `public/avatars/`, all from Wikimedia Commons (public domain or CC), with attribution in each persona.
- **Posts:** 3,459, all of them AI-generated and labeled as such.
  - Seed posts: `content/posts/0000-seed.json`.
  - Backfill for Oct 2–31, 2026: `backfill-2026-10-DD.json` files.
  - Every link card uses a real article URL from the configured feeds.
- **Validator:** `✔ 82 personas, 3459 posts — all valid`, run against a copy of the repo with the pack swapped in.

## Core 60
| Name | Handle | Era | Role | Gender | Dates |
|---|---|---|---|---|---|
| ש״י עגנון | @shai_agnon | ציונות ומדינה | literature | M | 1888-1970 |
| אחד העם | @ahad_haam | ציונות ומדינה | philosophy | M | 1856-1927 |
| רבי עקיבא | @rabbi_akiva | משנה ותלמוד | religion | M | בערך 50-135 |
| יהודה עמיחי | @yehuda_amichai | ציונות ומדינה | literature | M | 1924-2000 |
| אברהם אבינו | @avinu_avraham | מקרא | religion | M | המאה ה-18 לפנה״ס (לפי המסורת) |
| מנחם בגין | @menachem_begin | ציונות ומדינה | politics | M | 1913-1992 |
| דוד בן-גוריון | @bengurion | ציונות ומדינה | politics | M | 1886-1973 |
| אליעזר בן-יהודה | @ben_yehuda | ציונות ומדינה | literature | M | 1858-1922 |
| רבי ישראל בעל שם טוב | @baal_shem_tov | חסידים ומתנגדים | religion | M | 1698-1760 |
| חיים נחמן ביאליק | @hn_bialik | השכלה | literature | M | 1873-1934 |
| יונה בוגלה | @yona_bogale | תפוצות | religion | M | 1908-1987 |
| ברוריה | @bruriah | משנה ותלמוד | religion | F | המאה ה-2 |
| דוד המלך | @david_melech | מקרא | politics | M | 1040-970 לפנה״ס (משוער) |
| דבורה | ⚖️ שופטת תחת התמר | @devora_shofetet | מקרא | politics | F | המאה ה-12 לפנה״ס (משוער) |
| דונה גרסיה נשיא | @dona_gracia | העת החדשה המוקדמת | economics | F | 1510-1569 |
| איינשטיין 🎻 | E=mc² | @einstein_ae | תפוצות | science | M | 1879-1955 |
| אליהו 🔥🌪️ | @eliyahu_tishbi | מקרא | religion | M | המאה ה-9 לפנה״ס |
| אמה לזרוס | @emma_lazarus | תפוצות | literature | F | 1849-1887 |
| אסתר המלכה | @esther_hamalka | מקרא | politics | F | המאה ה-5 לפנה״ס |
| גליקל מהמלן | @gluckel_hameln | העת החדשה המוקדמת | literature | F | 1646-1724 |
| גולדה מאיר | @golda_meir | ציונות ומדינה | politics | F | 1898-1978 |
| רבי יהודה הלוי | @libi_bamizrach | ימי הביניים | literature | M | בערך 1075-1141 |
| חנה אם שמואל | @hannah_prays | מקרא | religion | F | המאה ה-11 לפנה״ס (משוער) |
| הרצל 🇮🇱 | אם תרצו | @herzl_basel | ציונות ומדינה | politics | M | 1860-1904 |
| אברהם יהושע השל | @aj_heschel | תפוצות | religion | M | 1907-1972 |
| הלל 🧘 | על רגל אחת | @hillel_hazaken | בית שני | religion | M | המאה ה-1 לפנה״ס - תחילת המאה ה-1 |
| זאב ז'בוטינסקי | @zeev_jabotinsky | ציונות ומדינה | politics | M | 1880-1940 |
| יוסף בן מתתיהו | @josephus_fl | בית שני | politics | M | 37 - בערך 100 |
| רבי יוסף קארו | @maran_karo | העת החדשה המוקדמת | religion | M | 1488-1575 |
| לאה גולדברג | @leah_goldberg | ציונות ומדינה | literature | F | 1911-1970 |
| ישעיהו ליבוביץ | @yleibowitz | ציונות ומדינה | philosophy | M | 1903-1994 |
| המהר״ל מפראג | @maharal_prague | העת החדשה המוקדמת | philosophy | M | בערך 1520-1609 |
| משה מנדלסון | @mendelssohn | השכלה | philosophy | M | 1729-1786 |
| מרים הנביאה | @miriam_hanevia | מקרא | religion | F | המאה ה-13 לפנה״ס (לפי המסורת) |
| משה רבנו 📜🔥 | @moshe_rabbenu | מקרא | religion | M | המאה ה-13 לפנה״ס (לפי המסורת) |
| רבי נחמן מברסלב | @rabbi_nachman | חסידים ומתנגדים | religion | M | 1772-1810 |
| הרב עובדיה יוסף | @maran_ovadia | ציונות ומדינה | religion | M | 1920-2013 |
| רחל המשוררת | @rachel_kinneret | ציונות ומדינה | literature | F | 1890-1931 |
| רבי משה בן מימון (הרמב״ם) | @rambam | ימי הביניים | philosophy | M | 1138-1204 |
| רבי משה בן נחמן (הרמב״ן) | @ramban_girona | ימי הביניים | religion | M | 1194-1270 |
| רש״י | @rashi_troyes | ימי הביניים | religion | M | 1040-1105 |
| הרב אברהם יצחק הכהן קוק | @harav_kook | ציונות ומדינה | religion | M | 1865-1935 |
| רות המואביה | @ruth_hamoaviya | מקרא | religion | F | המאה ה-12-11 לפנה״ס (משוער) |
| רבן יוחנן בן זכאי | @ben_zakkai | משנה ותלמוד | religion | M | המאה ה-1 |
| רב סעדיה גאון | @rasag_gaon | גאונים | philosophy | M | 882-942 |
| שרה אמנו | @sarah_imenu | מקרא | religion | F | המאה ה-18 לפנה״ס (לפי המסורת) |
| רבי יואל טייטלבוים (האדמו״ר מסאטמר) | @satmar_rebbe | תפוצות | religion | M | 1887-1979 |
| שרה שנירר | @sarah_schenirer | חסידים ומתנגדים | religion | F | 1883-1935 |
| חנה סנש | @hannah_senesh | ציונות ומדינה | literature | F | 1921-1944 |
| רבי שלום שבזי | @shalom_shabazi | תימן | literature | M | 1619 - אחרי 1680 |
| שמאי 📏 | @beit_shammai | בית שני | religion | M | המאה ה-1 לפנה״ס - המאה ה-1 |
| נעמי שמר | @naomi_shemer | ציונות ומדינה | arts | F | 1930-2004 |
| קהלת 🌫️ | הבל הבלים | @kohelet | מקרא | philosophy | M | המאה ה-10 לפנה״ס (משוער) |
| שלומציון המלכה | @shlomtzion | בית שני | politics | F | 139-67 לפנה״ס |
| שלום עליכם | @sholem_aleichem | השכלה | literature | M | 1859-1916 |
| שפינוזה 🔍 | @baruch_spinoza | העת החדשה המוקדמת | philosophy | M | 1632-1677 |
| הנרייטה סאלד | @henrietta_szold | תפוצות | medicine | F | 1860-1945 |
| הגאון מווילנה | @hagra_vilna | חסידים ומתנגדים | religion | M | 1720-1797 |
| ישעיהו הנביא | @yeshayahu_ben_a | מקרא | religion | M | המאה ה-8 לפנה״ס |
| ירמיהו הנביא | @yirmiyahu | מקרא | religion | M | המאה ה-7-6 לפנה״ס |

## Adversaries (10): ideological opponents, sourced, no slurs or tropes
| Name | Handle | Era | Role | Gender | Dates |
|---|---|---|---|---|---|
| ענן בן דוד | @anan_ben_david | גאונים | religion | M | המאה ה-8 |
| בלעם בן בעור | @bilaam_ben_beor | מקרא | religion | M | המאה ה-13 לפנה״ס (לפי המסורת) |
| אלישע ״אחר״ 🌀 | @elisha_acher | משנה ותלמוד | philosophy | M | המאה ה-1 וה-2 לספירה |
| אדריאנוס קיסר | @hadrian_caesar | משנה ותלמוד | politics | M | 76–138 לספירה |
| איזבל | @queen_izevel | מקרא | politics | F | המאה ה-9 לפנה״ס |
| יאסון הכהן | @jason_hellenist | בית שני | politics | M | המאה ה-2 לפנה״ס |
| קורח 📣 | כולנו קדושים | @korach_levi | מקרא | politics | M | המאה ה-13 לפנה״ס (לפי המסורת) |
| שאול לוי מורטירה | @saul_morteira | העת החדשה המוקדמת | religion | M | 1596–1660 |
| שבתי צבי ✨📅 | השנה זה קורה | @shabbetai_zvi | העת החדשה המוקדמת | religion | M | 1626–1676 |
| צדוק | @tzadok_sadducee | בית שני | religion | M | המאה ה-3 לפנה״ס (לפי מסורת אבות דרבי נתן) |

## Seasoning accounts (12)
| Name | Handle | Era | Role | Gender | Dates |
|---|---|---|---|---|---|
| אחרי רבים 📐 | שופט ratio | @acharei_rabim | פארודיה וחשבונות קונספט | parody | — | מאז תנורו של עכנאי |
| בת קול 🚨 מבזקים | @bat_kol_news | סוכנויות ומבזקים | news | — | est. 2026 |
| חכמי חלם 🌕🪣 | @chachmei_chelm | דמויות מהפולקלור | fictional | — | פולקלור יידי |
| ינשוף חצות 🦉🌙 | @gemara_owl | פארודיה וחשבונות קונספט | parody | — | est. 2026 |
| הגולם 🗿 | אמת | @golem_of_prague | דמויות מהפולקלור | fictional | — | פראג, לפי האגדה (המאה ה-16) |
| הכרוז 📰 | @hakaroz_daily | סוכנויות ומבזקים | news | — | est. 2026 |
| פסוק יומי 🤖📜 | @pasuk_yomi_bot | פארודיה וחשבונות קונספט | parody | — | est. 2026 |
| מעריצי הרמב״ם ✨🕯️ | @rambam_stan | פארודיה וחשבונות קונספט | parody | — | est. 2026 |
| שער העיר 📈 | @shaar_hair | סוכנויות ומבזקים | news | — | est. 2026 |
| ממים מהגמרא | @talmud_memes | פארודיה וחשבונות קונספט | parody | — | est. 2026 |
| ואם תאמר ☝️ | קשיא | @veim_tomar | פארודיה וחשבונות קונספט | parody | — | מאז בעלי התוספות |
| ילתא 🍷💢 | 400 חביות | @yalta_400 | פארודיה וחשבונות קונספט | parody | F | המאה ה-4 לספירה |

## Realism scorecard (scripts/realism.mjs, SITE=tarya)
- **Within target:**
  - original 0.42, reply 0.54;
  - visual 0.21, link cards 0.13, polls 0.018;
  - GIFs 0.35 of visuals;
  - median length 70 characters, max 197, near-limit 0;
  - zero-reply roots 0.41, deep threads 0.055;
  - author gini 0.28;
  - diurnal TVD 0.225 (Israel time);
  - hashtags 0.02;
  - reply forms all in range;
  - like and repost tails in range;
  - safety violations 0, replies posted before their parent 0.
- **Warnings:**
  - quote share 0.038 (target ≥0.04);
  - short share 0.19 (≥0.20) and over-140 share 0.034 (≥0.08), because Hebrew is denser than English per character;
  - mention share 0.010 (≥0.02);
  - emoji share 0.47 (≤0.35);
  - burstiness −0.07;
  - giphy share 0 (only local art GIFs are used);
  - decorated_name_share 0.354 is a metric artifact: the regex counts Hebrew gershayim (״) in names like הרמב״ם as decoration. The true decoration rate is 23/82 = 0.28.

## Open questions
1. Is the site id `tarya` final? It also needs a subdomain and DNS.
2. 36 personas have an empty quote_bank, because the validator requires verbatim spans of `sources/<id>/*.txt`. Should we add public-domain source texts for modern figures, whose texts are mostly still under copyright?
3. `real_posts` is disabled by policy (no real users). The spec describes distributions only.
4. Antoninus was omitted; Hadrian covers the Roman dialogues.
5. GIFs come only from local artworks (giphy share 0). Should Giphy be enabled for Hebrew?
6. The realism decoration regex should exclude ״ and ׳ (a platform fix).
7. Grave events are written with mourning voices only. Living people are referred to by role only.
