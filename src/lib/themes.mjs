// Topic themes ("beats"). Used to match news/trend topics to personas (x_behavior.beats)
// and to flag grave topics that must only be handled seriously.

export const THEMES = {
  ai: /\b(a\.?i\.?|artificial intelligence|chatbot|chatgpt|openai|llm|machine learning|robot\w*|automation|algorithm\w*|deepfake\w*|agi)\b/i,
  tech: /\b(tech\w*|app|apps|smartphone\w*|iphone|android|google|apple|meta|microsoft|amazon|software|startup\w*|silicon valley|crypto\w*|bitcoin|internet|online|social media|tiktok|x\.com|twitter|data|privacy|hack\w*|cyber\w*|chip\w*|nvidia|gadget\w*|vr|metaverse)\b/i,
  politics: /\b(election\w*|vote\w*|voting|parliament|congress|senate|president\w*|prime minister|minister\w*|government\w*|policy|policies|campaign\w*|democra\w*|party|parties|poll\w*|referendum|coalition|diplomat\w*|summit|sanction\w*|tariff\w*|white house|kremlin)\b/i,
  war: /\b(war|wars|military|troops|army|missile\w*|drone strike\w*|airstrike\w*|ceasefire|invasion|bomb\w*|nato|conflict|weapon\w*|nuclear)\b/i,
  economy: /\b(econom\w*|market\w*|stock\w*|shares|inflation|interest rate\w*|prices?|wealth\w*|billionaire\w*|bank\w*|tax\w*|budget|debt|gdp|recession|trade|profit\w*|company|companies|ceo\w*|earnings|merger|ipo|rent|housing)\b/i,
  labor: /\b(strike\w*|union\w*|worker\w*|jobs?|layoff\w*|wage\w*|labou?r|employ\w*|unemploy\w*|gig|hustle|four-day|remote work|office|burnout)\b/i,
  science: /\b(scien\w*|study|studies|research\w*|researchers|physic\w*|quantum|biolog\w*|evolution|fossil\w*|dna|gene\w*|brain\w*|neuro\w*|experiment\w*|discover\w*|species|archaeolog\w*|telescope)\b/i,
  health: /\b(health\w*|hospital\w*|doctor\w*|medic\w*|vaccine\w*|virus\w*|disease\w*|cancer|drug\w*|mental health|sleep|diet|obesity|longevity|ageing|aging|pandemic|outbreak)\b/i,
  climate: /\b(climate|warming|emission\w*|carbon|heatwave\w*|wildfire\w*|flood\w*|drought\w*|weather|storm\w*|hurricane\w*|environment\w*|pollution|renewable\w*|solar|oil|fossil fuel\w*|cop\d\d)\b/i,
  religion: /\b(relig\w*|church\w*|pope|vatican|mosque\w*|islam\w*|muslim\w*|christian\w*|jewish|judaism|synagogue\w*|hindu\w*|buddhis\w*|temple\w*|faith|god|prayer\w*|ramadan|easter|christmas|diwali|spiritual\w*)\b/i,
  culture: /\b(film\w*|movie\w*|music|album\w*|song\w*|concert\w*|celebrit\w*|oscar\w*|grammy|netflix|tv series|artist\w*|museum\w*|book\w*|novel\w*|fashion|festival\w*|trend\w*|viral|meme\w*|halloween|game\w*|gaming|streamer\w*)\b/i,
  sports: /\b(football|soccer|nba|nfl|mlb|nhl|tennis|cricket|olympic\w*|world cup|champions league|premier league|match|coach\w*|player\w*|team\w*|marathon|f1|formula 1|super bowl|league|transfer)\b/i,
  media: /\b(media|journalis\w*|news|newspaper\w*|press|censor\w*|misinformation|disinformation|propaganda|podcast\w*|influencer\w*|broadcast\w*|bbc|cnn|fox)\b/i,
  law: /\b(court\w*|judge\w*|trial\w*|lawsuit\w*|sued|sue|ruling|verdict|law|laws|legal|illegal|ban\w*|regulat\w*|police|arrest\w*|prison\w*|jail\w*|crime\w*|fine[ds]?|supreme court)\b/i,
  rights: /\b(rights|freedom\w*|liberty|protest\w*|activis\w*|equalit\w*|inequalit\w*|discriminat\w*|racis\w*|women|gender|feminis\w*|migrant\w*|refugee\w*|asylum|colonial\w*|indigenous|slavery|civil)\b/i,
  education: /\b(school\w*|universit\w*|college\w*|student\w*|teacher\w*|exam\w*|education\w*|campus|curriculum|homework|degree\w*|graduat\w*|literacy)\b/i,
  space: /\b(space|nasa|spacex|esa|rocket\w*|moon|mars|asteroid\w*|orbit\w*|satellite\w*|astronaut\w*|galax\w*|planet\w*|cosmos|universe)\b/i,
  death: /\b(death\w*|dies|died|dead|funeral\w*|mortality|grief|obituar\w*|euthanasia|afterlife)\b/i,
  love: /\b(love|dating|marriage\w*|wedding\w*|divorce\w*|relationship\w*|romance|friendship\w*|lonel\w*|family|families|parent\w*|children|kids)\b/i,
  food: /\b(food\w*|restaurant\w*|chef\w*|recipe\w*|coffee|cheese|bread|diet\w*|vegan\w*|meat|wine|beer|eating|snack\w*|pizza)\b/i,
  cities: /\b(city|cities|urban|traffic|cars?|transport\w*|commut\w*|housing|rent|tourism|tourist\w*|airport\w*|flight\w*|train\w*)\b/i,
  wellness: /\b(productiv\w*|self-help|routine\w*|habit\w*|morning|mindful\w*|meditat\w*|wellness|gym|fitness|happiness|happy|stress|anxiety|screen time|dopamine|motivation)\b/i,
  status: /\b(luxur\w*|billionaire\w*|celebrit\w*|influencer\w*|fame|famous|rich|royal\w*|king|queen|prince\w*|brand\w*|designer|status|followers|yacht\w*|mansion\w*)\b/i,
};

export const THEME_KEYS = Object.keys(THEMES);

/** Tragedy / violence markers. Topics matching these are "grave": serious personas, serious tone, no memes. */
export const GRAVE = /\b(killed|kills|killing|dead|deaths?|death toll|died|dies|massacre\w*|shooting\w*|shot dead|stabb\w*|murder\w*|genocide|famine|starv\w*|earthquake\w*|tsunami|flood\w*|wildfire\w*|hurricane|crash(?:es|ed)?|explosion\w*|terror\w*|attacks? (?:on|in|at|kill\w*)|attacked|kill|air ?strikes?|strikes? (?:on|in|kill\w*)|shelling|hostage\w*|suicide|abuse\w*|rape|assault\w*|victims?|wounded|injured|casualt\w*|refugee\w*|bombing\w*|airstrike\w*|missing|funeral\w*|war crime\w*|child\w* (?:killed|died)|epidemic|outbreak)\b/i;

export function themesOf(text) {
  const t = String(text ?? '');
  return THEME_KEYS.filter((k) => THEMES[k].test(t));
}

export function isGrave(text) {
  return GRAVE.test(String(text ?? ''));
}
