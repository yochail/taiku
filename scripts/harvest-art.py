#!/usr/bin/env python3
"""Grow the public-domain art library (media/art-library.json + public/media/art/*.webp).

Sources (open access only): Art Institute of Chicago API (CC0 images of public-domain works),
The Met Open Access API (CC0), Wikimedia Commons (license verified per file: Public domain / CC0).

  python scripts/harvest-art.py collect   # query the APIs -> <work>/candidates.json
  python scripts/harvest-art.py fetch     # download, filter, resize -> webp + manifest
  python scripts/harvest-art.py sheets    # contact sheets in <work>/sheets for a visual PG check
  python scripts/harvest-art.py drop ID.. # remove items (files + manifest entry)

Needs Pillow with WebP. Work dir: $ART_WORK (default .cache/art-work, git-ignored).
Each item is stored at max 1200px long side plus a 600px variant under public/media/art/600/.
"""
import concurrent.futures as cf
import io
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request

from PIL import Image, ImageDraw

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WORK = os.environ.get('ART_WORK') or os.path.join(ROOT, '.cache', 'art-work')
OUT = os.path.join(ROOT, 'public', 'media', 'art')
OUT_SM = os.path.join(OUT, '600')
MANIFEST = os.path.join(ROOT, 'media', 'art-library.json')
UA = 'Mozilla/5.0 (compatible; TaikuArtHarvester/0.2; +https://taiku.app; github.com/yochail/taiku)'
LONG, SMALL, Q_LONG, Q_SMALL = 1200, 600, int(os.environ.get('ART_Q', '62')), 64
os.makedirs(WORK, exist_ok=True)

# ---------------------------------------------------------------- queries
# (source, query, themes, n). Themes become tags; n = how many to keep from that query.
Q = []
def q(src, query, themes, n): Q.append((src, query, themes, n))

for query, themes, n in [
    ('cat', ['cats', 'animals'], 34), ('kitten', ['cats', 'animals'], 8), ('dog', ['dogs', 'animals'], 34),
    ('puppy', ['dogs', 'animals'], 6), ('bird', ['birds', 'animals'], 30), ('owl', ['birds', 'owls', 'animals'], 8),
    ('parrot', ['birds', 'animals'], 5), ('horse', ['horses', 'animals'], 14), ('cow cattle', ['animals', 'farm'], 8),
    ('sheep', ['animals', 'farm'], 6), ('monkey', ['animals', 'monkeys'], 5), ('lion', ['animals', 'lions'], 5),
    ('fish', ['animals', 'fish'], 6), ('rabbit', ['animals'], 4), ('duck', ['birds', 'animals'], 5),
    ('landscape', ['landscape', 'nature'], 34), ('mountain', ['landscape', 'mountains', 'nature'], 16),
    ('river', ['landscape', 'river', 'nature'], 14), ('seascape', ['sea', 'landscape'], 14),
    ('beach', ['sea', 'leisure'], 8), ('forest trees', ['landscape', 'forest', 'nature'], 10),
    ('winter snow', ['winter', 'snow', 'landscape'], 14), ('storm', ['storm', 'weather', 'drama'], 10),
    ('sunset', ['sunset', 'landscape'], 10), ('moonlight', ['night', 'moon'], 10), ('night', ['night'], 8),
    ('garden', ['garden', 'flowers'], 10), ('flowers still life', ['flowers', 'still life'], 10),
    ('harvest field', ['farm', 'work', 'landscape'], 10), ('ruins', ['ruins', 'history'], 20),
    ('street', ['city', 'street'], 14), ('Paris', ['city', 'paris'], 10), ('Venice', ['city', 'venice'], 10),
    ('bridge', ['city', 'bridge'], 6), ('railway train', ['trains', 'technology', 'travel'], 8),
    ('ship', ['ships', 'sea', 'travel'], 12), ('reading', ['reading', 'books', 'everyday life'], 16),
    ('letter', ['writing', 'letters', 'everyday life'], 10), ('kitchen', ['everyday life', 'home', 'food'], 6),
    ('cafe', ['cafe', 'everyday life', 'city'], 8), ('market', ['market', 'crowd', 'everyday life'], 8),
    ('children playing', ['children', 'play', 'everyday life'], 10), ('family', ['family', 'everyday life'], 6),
    ('sleeping', ['sleep', 'tired'], 8), ('crowd', ['crowd', 'people'], 10), ('festival', ['festival', 'crowd', 'celebration'], 8),
    ('feast banquet', ['feast', 'food', 'celebration'], 8), ('dance', ['dance', 'celebration'], 10),
    ('theater', ['theater', 'performance'], 6), ('music concert', ['music', 'performance'], 10),
    ('card players', ['games', 'everyday life'], 5), ('laughing', ['laughing', 'faces'], 6),
    ('portrait of a man', ['portrait', 'faces'], 14), ('portrait of a woman', ['portrait', 'faces'], 14),
    ('old man', ['portrait', 'old age', 'faces'], 8), ('self-portrait', ['portrait', 'faces'], 10),
    ('caricature', ['caricature', 'satire', 'faces'], 10), ('Daumier', ['caricature', 'satire'], 22),
    ('Hogarth', ['satire', 'engraving'], 8), ('Grandville', ['satire', 'illustration'], 6),
    ('astronomy', ['astronomy', 'science', 'cosmos'], 6), ('globe map', ['maps', 'science'], 8),
    ('scholar study', ['scholar', 'study', 'books'], 8), ('library books', ['books', 'library'], 6),
    ('battle', ['battle', 'history'], 10), ('soldiers', ['soldiers', 'history'], 5), ('knight', ['knights', 'medieval'], 5),
    ('Atget', ['old photo', 'city', 'paris'], 14), ('Stieglitz', ['old photo', 'city'], 6), ('Lewis Hine', ['old photo', 'work', 'people'], 10),
    ('Muybridge horse', ['old photo', 'motion', 'horses'], 4), ('daguerreotype', ['old photo', 'portrait'], 10),
    ('albumen print', ['old photo'], 10), ('Hokusai', ['japanese print', 'landscape'], 18), ('Hiroshige', ['japanese print', 'landscape'], 18),
    ('Kuniyoshi', ['japanese print'], 6), ('Egypt pyramids', ['egypt', 'ancient', 'ruins'], 6), ('Rome', ['rome', 'city', 'ancient'], 8),
    ('Greece temple', ['greece', 'ancient', 'ruins'], 6), ('lighthouse', ['sea', 'lighthouse'], 4), ('balloon', ['flight', 'technology'], 4),
    ('clock time', ['time'], 4), ('rain umbrella', ['rain', 'weather', 'city'], 6), ('fog', ['fog', 'weather'], 5),
    ('waiting', ['waiting', 'everyday life'], 4), ('school classroom', ['school', 'education'], 5), ('philosopher', ['philosophy'], 8),
]:
    q('aic', query, themes, n)

for query, themes, n in [
    ('philosopher', ['philosophy', 'scholar'], 14), ('Socrates', ['philosophy', 'ancient'], 5), ('Plato', ['philosophy', 'ancient'], 4),
    ('Aristotle', ['philosophy', 'ancient'], 4), ('Diogenes', ['philosophy', 'ancient', 'cynic'], 4), ('Homer', ['poetry', 'ancient'], 4),
    ('Seneca', ['philosophy', 'stoic'], 3), ('scholar', ['scholar', 'study'], 10), ('astronomer', ['astronomy', 'science'], 6),
    ('Durer', ['engraving', 'renaissance'], 12), ('Rembrandt etching', ['etching', 'portrait'], 12), ('Bruegel', ['everyday life', 'crowd'], 6),
    ('Daumier', ['caricature', 'satire'], 14), ('Rowlandson', ['satire', 'caricature'], 10), ('Cruikshank', ['satire', 'caricature'], 6),
    ('Gillray', ['satire', 'caricature'], 8), ('Piranesi', ['ruins', 'rome', 'engraving'], 12), ('Canaletto', ['city', 'venice'], 5),
    ('Turner', ['landscape', 'sea'], 6), ('Constable', ['landscape'], 5), ('Vermeer', ['everyday life'], 4),
    ('cat', ['cats', 'animals'], 16), ('dog', ['dogs', 'animals'], 16), ('owl', ['owls', 'birds', 'animals'], 6),
    ('bird', ['birds', 'animals'], 14), ('Nadar', ['old photo', 'portrait'], 8), ('Carleton Watkins', ['old photo', 'landscape'], 8),
    ('Atget', ['old photo', 'paris', 'city'], 8), ('Julia Margaret Cameron', ['old photo', 'portrait'], 5), ('stereograph', ['old photo'], 8),
    ('photograph street 1900', ['old photo', 'city', 'street'], 8), ('Hokusai', ['japanese print'], 10), ('Utamaro', ['japanese print', 'portrait'], 6),
    ('Chinese landscape painting', ['chinese painting', 'landscape'], 10), ('Chinese scholar', ['chinese painting', 'scholar'], 6),
    ('Persian miniature', ['persian painting', 'illustration'], 8), ('Indian painting', ['indian painting'], 8),
    ('Egyptian', ['egypt', 'ancient'], 6), ('Greek vase', ['greece', 'ancient'], 6), ('Roman bust', ['rome', 'ancient', 'portrait'], 6),
    ('tapestry', ['medieval'], 4), ('illuminated manuscript', ['medieval', 'books'], 8), ('map', ['maps'], 6),
    ('ship', ['ships', 'sea'], 6), ('banquet', ['feast', 'celebration'], 4), ('Goya', ['portrait', 'spain'], 6),
    ('Winslow Homer', ['sea', 'america'], 6), ('Hudson River School', ['landscape', 'america'], 6),
]:
    q('met', query, themes, n)

PERSONA_PORTRAITS = [
    ('Adam Smith', ['adam_smith']), ('Al-Ghazali', ['al_ghazali']), ('Aristotle', ['aristotle']), ('Jane Austen', ['austen']),
    ('Benjamin Franklin', ['ben_franklin']), ('Confucius', ['confucius']), ('Marie Curie', ['curie']), ('Charles Darwin', ['darwin']),
    ('René Descartes', ['descartes']), ('Emily Dickinson', ['dickinson']), ('Diogenes', ['diogenes']), ('Dostoevsky', ['dostoevsky']),
    ('Frederick Douglass', ['douglass']), ('Albert Einstein 1921', ['einstein']), ('Epicurus', ['epicurus']), ('Sigmund Freud', ['freud']),
    ('Galileo Galilei', ['galileo']), ('Hildegard of Bingen', ['hildegard']), ('David Hume', ['hume']), ('Hypatia', ['hypatia']),
    ('Alhazen', ['ibn_al_haytham']), ('Averroes', ['ibn_rushd']), ('Carl Jung', ['jung']), ('Immanuel Kant', ['kant']),
    ('Kierkegaard', ['kierkegaard']), ('Laozi', ['laozi']), ('Leonardo da Vinci', ['leonardo']), ('Ada Lovelace', ['lovelace']),
    ('Machiavelli', ['machiavelli']), ('Maimonides', ['maimonides']), ('Marcus Aurelius', ['marcus_aurelius']), ('Karl Marx', ['marx']),
    ('Mary Shelley', ['mary_shelley']), ('Murasaki Shikibu', ['murasaki']), ('Isaac Newton', ['newton']), ('Friedrich Nietzsche', ['nietzsche']),
    ('Florence Nightingale', ['nightingale']), ('Emmy Noether', ['noether']), ('Ramanujan', ['ramanujan']), ('Rumi', ['rumi']),
    ('William Shakespeare', ['shakespeare']), ('Socrates', ['socrates']), ('Sojourner Truth', ['sojourner_truth']), ('Spinoza', ['spinoza']),
    ('Nikola Tesla', ['tesla']), ('Mark Twain', ['twain']), ('Oscar Wilde', ['wilde']), ('William James', ['william_james']),
    ('Mary Wollstonecraft', ['wollstonecraft']), ('Virginia Woolf', ['woolf']), ('Plato', ['plato']), ('Pythagoras', ['pythagoras']),
    ('Zhuangzi', ['zhuangzi']), ('Wang Yangming', ['wang_yangming']), ('Ibn Khaldun', ['ibn_khaldun']), ('John Maynard Keynes', ['keynes']),
    ('Sun Tzu', ['sun_tzu']), ('Dogen Zenji', ['dogen']), ('Ban Zhao', ['ban_zhao']), ('Xanthippe', ['xanthippe']),
]
for name, people in PERSONA_PORTRAITS:
    Q.append(('commons', f'"{name}" portrait', ['portrait', 'thinkers'], 2, people))

for query, themes, n in [
    ('Flammarion engraving', ['cosmos', 'science', 'engraving'], 1), ('Harmonia Macrocosmica Cellarius', ['cosmos', 'astronomy', 'maps'], 8),
    ('Kunstformen der Natur Haeckel', ['science', 'nature', 'biology'], 10), ('Micrographia Hooke', ['science', 'microscope'], 4),
    ('Sidereus Nuncius moon Galileo', ['astronomy', 'moon', 'science'], 3), ('Kepler Mysterium Cosmographicum', ['astronomy', 'geometry'], 2),
    ('Vitruvian Man', ['leonardo', 'anatomy', 'geometry'], 1), ('Leonardo da Vinci codex drawing machine', ['inventions', 'technology'], 6),
    ('Audubon Birds of America plate', ['birds', 'animals', 'science'], 10), ('Maria Sibylla Merian plate', ['insects', 'nature', 'science'], 6),
    ('Philosopher Lecturing on the Orrery', ['science', 'cosmos'], 1), ('Babbage Difference Engine', ['computing', 'technology'], 2),
    ('Solvay conference 1927', ['old photo', 'science', 'crowd'], 1), ('Wright brothers first flight 1903', ['old photo', 'flight', 'technology'], 2),
    ('Endurance expedition Frank Hurley', ['old photo', 'exploration', 'ice'], 4), ('Exposition Universelle 1900 photograph', ['old photo', 'city', 'crowd'], 4),
    ('Library of Congress photograph 1910 street', ['old photo', 'city', 'street'], 6), ('Jacob Riis photograph', ['old photo', 'city'], 4),
    ('Tesla laboratory Colorado Springs', ['old photo', 'electricity', 'technology'], 2), ('Euclid Elements diagram manuscript', ['geometry', 'mathematics'], 3),
    ('astrolabe', ['astronomy', 'instruments', 'science'], 3), ('celestial map 17th century', ['cosmos', 'maps'], 4),
    ('Camille Flammarion Astronomie populaire illustration', ['astronomy', 'cosmos'], 4), ('Gustave Doré Don Quixote', ['literature', 'illustration'], 5),
    ('John Tenniel Alice illustration', ['literature', 'illustration', 'absurd'], 6), ('Louis Wain cat', ['cats', 'illustration'], 6),
    ('Bayeux Tapestry', ['medieval', 'history'], 4), ('Hieronymus Bosch Garden detail', ['absurd', 'surreal'], 0),
    ('Akademie der Wissenschaften engraving 18th century', ['science', 'academy'], 2), ('Encyclopédie Diderot plate', ['science', 'technology', 'work'], 8),
    ('Great Wave Kanagawa', ['japanese print', 'sea'], 1), ('Mount Fuji Hokusai', ['japanese print', 'mountains'], 3),
    ('Lascaux', ['prehistoric', 'animals'], 2), ('Parthenon 19th century photograph', ['greece', 'ruins', 'old photo'], 3),
    ('Pompeii excavation photograph', ['ruins', 'rome', 'old photo'], 3), ('Stonehenge painting', ['ruins', 'prehistoric'], 2),
]:
    if n: q('commons', query, themes, n)

# ---------------------------------------------------------------- filters
BLOCK = re.compile(r"\b(nud(e|es|ity)|naked|undress\w*|bath(er|ers|ing)|venus|leda|odalisque|susanna|erotic\w*|nymph\w*|satyr\w*|bacchan\w*|"
                   r"crucifi\w*|martyr\w*|execut\w*|massacre|slaughter\w*|behead\w*|decapitat\w*|judith|holofernes|corpse\w*|cadaver\w*|"
                   r"lamentation|piet[aà]|entombment|deposition|blood\w*|wound\w*|hang(ed|ing man)|gallows|tortur\w*|skeleton\w*|skull\w*|"
                   r"death|dead|dying|suicide|murder\w*|rape|abduction|sabine|slave\w*|lynch\w*|hell|inferno|demon\w*|devil\w*|disasters? of war|"
                   r"whip\w*|flagellat\w*|anatom\w*|dissect\w*|butcher\w*|kill\w*|hunt\w*|game piece|adam and eve|\beve\b|diana|dana[eë]|andromeda|"
                   r"psyche|bacchus|graces|judgment of paris|lucretia|cleopatra|cupid|amor|bather|toilette|harem|lynching|gun|pistol|rifle|"
                   r"breast\w*|bust of a woman nude|sex\w*|lover\w*|kiss\w*|bed|boudoir|seduct\w*|temptation|sin|witch\w*|sabbat|"
                   r"saint sebastian|st\. sebastian|beggar|cripple\w*|leper|plague|famine|war victim|wounded|hospital|surgery|asylum|"
                   r"prison|guillotine|tomb|grave|funeral|mourn\w*|burial|coffin|vanitas|memento mori|scalp\w*|caricature of a (jew|negro)|"
                   r"negro|blackface|minstrel|savage|indian chief|squaw|coolie|chinaman|mammy)\b", re.I)
AIC_TYPES = {'Painting', 'Print', 'Drawing and Watercolor', 'Photograph'}
MET_CLASSES = re.compile(r'^(Paintings|Prints|Drawings|Photographs|Codices|Manuscripts and Illuminations|Woodblock prints|Albums|Books)', re.I)


def http(url, tries=4, binary=False):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': '*/*'})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
                return data if binary else json.loads(data)
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1) + (10 if '429' in str(e) else 0))


def slug(s, n=44):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()
    s = re.sub(r'[^a-z0-9]+', '-', s).strip('-')
    return s[:n].rstrip('-') or 'art'


def year_of(*vals):
    for v in vals:
        if isinstance(v, int) and v:
            return v
        m = re.search(r'(\d{3,4})', str(v or ''))
        if m:
            y = int(m.group(1))
            if 'BCE' in str(v) or 'B.C' in str(v):
                y = -y
            return y
    return None


def strip_html(s):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', str(s or ''))).strip()


# ---------------------------------------------------------------- collect
def collect_aic(query, themes, n):
    fields = 'id,title,artist_title,artist_display,date_display,date_end,image_id,thumbnail,subject_titles,term_titles,classification_titles,artwork_type_title,medium_display,is_public_domain'
    url = ('https://api.artic.edu/api/v1/artworks/search?' + urllib.parse.urlencode({'q': query, 'fields': fields, 'limit': min(100, n * 4)})
           + '&query[term][is_public_domain]=true')
    out = []
    for d in http(url).get('data', []):
        t = d.get('thumbnail') or {}
        if not d.get('image_id') or not d.get('is_public_domain') or d.get('artwork_type_title') not in AIC_TYPES:
            continue
        if max(t.get('width') or 0, t.get('height') or 0) < 700:
            continue
        w, h = t.get('width') or 1, t.get('height') or 1
        if max(w, h) / min(w, h) > 2.6:
            continue
        out.append({
            'key': f"aic{d['id']}", 'source': 'Art Institute of Chicago', 'source_url': f"https://www.artic.edu/artworks/{d['id']}",
            'license': 'CC0 (public-domain work, AIC open access)', 'title': d.get('title') or 'Untitled',
            'artist': d.get('artist_title') or (d.get('artist_display') or 'Unknown').split('\n')[0], 'date': d.get('date_display') or '',
            'year': d.get('date_end'), 'medium': (d.get('artwork_type_title') or '').lower(), 'medium_display': d.get('medium_display') or '',
            'subjects': (d.get('subject_titles') or []) + [x for x in (d.get('term_titles') or []) if x in (d.get('subject_titles') or [])],
            'img': f"https://www.artic.edu/iiif/2/{d['image_id']}/full/1200,/0/default.jpg" if w >= h else f"https://www.artic.edu/iiif/2/{d['image_id']}/full/,1200/0/default.jpg",
            'w': w, 'h': h,
        })
    return out


def collect_met(query, themes, n):
    ids = http('https://collectionapi.metmuseum.org/public/collection/v1.1/search?' + urllib.parse.urlencode(
        {'q': query, 'hasImages': 'true', 'isPublicDomain': 'true', 'limit': min(80, n * 5)})).get('objectIDs') or []
    out = []
    def one(i):
        try:
            return http(f'https://collectionapi.metmuseum.org/public/collection/v1/objects/{i}')
        except Exception:  # noqa: BLE001
            return None
    for i in ids:
        if True:
            o = one(i)
            time.sleep(0.6)
            if not o or not o.get('isPublicDomain') or not (o.get('primaryImageSmall') or o.get('primaryImage')):
                continue
            if not MET_CLASSES.match(o.get('classification') or '') and o.get('department') not in ('European Paintings', 'Photographs', 'Drawings and Prints', 'Asian Art', 'The American Wing', 'Islamic Art'):
                continue
            out.append({
                'key': f"met{o['objectID']}", 'source': 'The Metropolitan Museum of Art', 'source_url': o.get('objectURL'),
                'license': 'CC0 (Met Open Access)', 'title': o.get('title') or 'Untitled', 'artist': o.get('artistDisplayName') or o.get('culture') or 'Unknown',
                'date': o.get('objectDate') or '', 'year': o.get('objectEndDate'), 'medium': (o.get('classification') or '').lower(),
                'medium_display': o.get('medium') or '', 'subjects': [t['term'] for t in (o.get('tags') or []) if t.get('term')],
                'img': o.get('primaryImageSmall') or o.get('primaryImage'), 'img_full': o.get('primaryImage'),
            })
    return out


def collect_commons(query, themes, n):
    url = 'https://commons.wikimedia.org/w/api.php?' + urllib.parse.urlencode({
        'action': 'query', 'format': 'json', 'generator': 'search', 'gsrnamespace': 6, 'gsrlimit': min(50, n * 6),
        'gsrsearch': f'{query} filetype:bitmap -stamp -coin -medal -banknote -signature -logo -statue -grave -tomb', 'prop': 'imageinfo',
        'iiprop': 'url|extmetadata|size|mime', 'iiurlwidth': 1280,
        'iiextmetadatafilter': 'LicenseShortName|Artist|DateTimeOriginal|ObjectName|ImageDescription|Categories|Copyrighted'})
    pages = sorted((http(url).get('query') or {}).get('pages', {}).values(), key=lambda p: p.get('index', 0))
    out = []
    for p in pages:
        ii = (p.get('imageinfo') or [{}])[0]
        m = ii.get('extmetadata') or {}
        lic = (m.get('LicenseShortName') or {}).get('value', '')
        if not (lic.lower().startswith('public domain') or lic.lower() in ('cc0', 'pd') or lic.lower().startswith('pd')):
            continue
        if ii.get('mime') not in ('image/jpeg', 'image/png', 'image/tiff') or max(ii.get('width', 0), ii.get('height', 0)) < 600:
            continue
        w, h = ii.get('width', 1), ii.get('height', 1)
        if max(w, h) / min(w, h) > 2.6:
            continue
        title = (m.get('ObjectName') or {}).get('value') or re.sub(r'^File:|\.\w+$', '', p['title'])
        out.append({
            'key': 'wc' + slug(p['title'], 60), 'source': 'Wikimedia Commons', 'source_url': ii.get('descriptionurl'), 'license': lic,
            'title': strip_html(title)[:140], 'artist': strip_html((m.get('Artist') or {}).get('value') or 'Unknown')[:120],
            'date': strip_html((m.get('DateTimeOriginal') or {}).get('value') or '')[:60],
            'year': year_of(strip_html((m.get('DateTimeOriginal') or {}).get('value'))), 'medium': '',
            'medium_display': '', 'subjects': [c for c in ((m.get('Categories') or {}).get('value') or '').split('|') if c][:12],
            'description': strip_html((m.get('ImageDescription') or {}).get('value'))[:300],
            'img': ii.get('thumburl') if w > 1280 or h > 1280 else ii.get('url'), 'w': w, 'h': h,
        })
    return out


def collect():
    cache_file = os.path.join(WORK, 'queries.json')
    cache = json.load(open(cache_file, encoding='utf8')) if os.path.exists(cache_file) else {}
    fn = {'aic': collect_aic, 'met': collect_met, 'commons': collect_commons}
    for entry in Q:
        src, query, themes, n = entry[:4]
        k = f'{src}:{query}'
        if k in cache or (src == 'met' and os.environ.get('SKIP_MET')):
            continue
        try:
            cache[k] = fn[src](query, themes, n)
            print(f'{k}: {len(cache[k])}', flush=True)
        except Exception as e:  # noqa: BLE001
            print(f'! {k}: {e}', flush=True)
        json.dump(cache, open(cache_file, 'w', encoding='utf8'))
        time.sleep(0.4 if src != 'commons' else 1.0)


# ---------------------------------------------------------------- tags / alt
ERA = [(500, 'ancient'), (1400, 'medieval'), (1600, 'renaissance'), (1750, 'baroque'), (1800, '18th century'), (1900, '19th century'), (9999, 'early 20th century')]
MOOD = {
    'cats': ['playful', 'aloof', 'cozy'], 'dogs': ['loyal', 'playful'], 'birds': ['free', 'light'], 'owls': ['wise', 'watchful'],
    'landscape': ['calm', 'awe'], 'mountains': ['awe', 'sublime'], 'sea': ['calm', 'vast'], 'storm': ['turmoil', 'drama'],
    'winter': ['cold', 'quiet'], 'night': ['contemplative', 'mysterious'], 'moon': ['dreamy', 'contemplative'], 'sunset': ['wistful', 'warm'],
    'ruins': ['melancholy', 'nostalgia', 'impermanence'], 'crowd': ['chaotic', 'social'], 'festival': ['festive', 'joy'],
    'feast': ['festive', 'indulgent'], 'dance': ['joy', 'festive'], 'battle': ['conflict', 'drama'], 'soldiers': ['conflict', 'duty'],
    'caricature': ['satire', 'mocking', 'absurd'], 'satire': ['satire', 'mocking'], 'laughing': ['joy', 'lol'], 'sleep': ['tired', 'bored'],
    'reading': ['studious', 'quiet'], 'scholar': ['studious', 'thinking'], 'philosophy': ['thinking', 'serious'], 'portrait': ['serious'],
    'old photo': ['nostalgia', 'documentary'], 'science': ['curious', 'wonder'], 'astronomy': ['wonder', 'curious'], 'cosmos': ['awe', 'wonder'],
    'city': ['busy', 'urban'], 'everyday life': ['ordinary', 'relatable'], 'work': ['labor', 'grind'], 'music': ['joy', 'harmony'],
    'children': ['innocent', 'playful'], 'garden': ['peaceful'], 'flowers': ['gentle'], 'fog': ['uncertain', 'mysterious'],
    'technology': ['progress', 'curious'], 'absurd': ['absurd', 'whimsical'], 'waiting': ['bored', 'patience'], 'rain': ['gloomy'],
}
WORD_MOOD = {r'laugh|merry|jolly|amus': 'joy', r'sleep|nap|dream|rest': 'tired', r'storm|tempest|wreck': 'turmoil',
             r'quarrel|argu|dispute|debate': 'argument', r'think|reflect|medit|contempl|melanchol': 'thinking',
             r'surpris|astonish': 'surprised', r'angry|anger|rage': 'angry', r'lazy|idle|bore': 'bored'}
THEME_WORDS = {'cat|kitten': 'cats', r'\bdogs?\b|puppy|hound|spaniel|terrier|poodle': 'dogs', 'bird|parrot|owl|crow|raven|sparrow|duck|heron|peacock|eagle': 'birds',
               'horse': 'horses', 'sea|ocean|coast|beach|wave': 'sea', 'mountain|alps': 'mountains', 'snow|winter': 'winter',
               'moon|night|nocturne': 'night', 'ruin': 'ruins', 'street|boulevard|avenue': 'street', 'book|reading|reader': 'reading',
               'letter': 'letters', 'philosoph': 'philosophy', 'astronom|star|planet|comet|celestial': 'astronomy', 'map': 'maps',
               'music|violin|guitar|lute|piano|singer|concert': 'music', 'child|boy|girl': 'children', 'garden|flower': 'garden',
               'ship|boat|harbor|harbour': 'ships', 'train|railway|locomotive': 'trains', 'market': 'market', 'church|cathedral': 'architecture'}
NAMES = None


def names():
    global NAMES
    if NAMES is None:
        NAMES = []
        pdir = os.path.join(ROOT, 'sites', 'taiku', 'personas')
        for f in os.listdir(pdir):
            j = json.load(open(os.path.join(pdir, f), encoding='utf8'))
            if j.get('kind') != 'thinker':
                continue
            nm = re.sub(r'\s*\(.*?\)', '', j['name'])
            last = nm.split()[-1]
            pats = {nm, last if len(last) > 4 and last not in ('Smith', 'James', 'Truth', 'Shelley', 'Franklin', 'Douglass', 'Wilde', 'Weil') else nm}
            alias = re.findall(r'\((.*?)\)', j['name'])
            pats |= set(alias)
            NAMES.append((j['id'], [p for p in pats if p]))
        NAMES += [('plato', ['Plato']), ('pythagoras', ['Pythagoras']), ('homer', ['Homer']), ('seneca', ['Seneca']), ('euclid', ['Euclid']),
                  ('kepler', ['Kepler']), ('copernicus', ['Copernicus']), ('voltaire', ['Voltaire']), ('rousseau', ['Rousseau']),
                  ('dante', ['Dante']), ('goethe', ['Goethe']), ('napoleon', ['Napoleon']), ('don-quixote', ['Don Quixote', 'Quixote'])]
    return NAMES


def people_in(text):
    out = []
    for pid, pats in names():
        for p in pats:
            if re.search(r'(?<![A-Za-z])' + re.escape(p) + r'(?![a-z])', text):
                out.append(pid)
                break
    return sorted(set(out))


def build_tags(c):
    text = f"{c['title']} {' '.join(c.get('subjects') or [])} {c.get('description') or ''}"
    themes = list(dict.fromkeys(c['themes']))
    for pat, th in THEME_WORDS.items():
        if re.search(pat, text, re.I) and th not in themes:
            themes.append(th)
    for s in (c.get('subjects') or [])[:8]:
        s2 = s.lower().strip()
        if c['source'] != 'Wikimedia Commons' and 2 < len(s2) < 28 and s2 not in themes and not BLOCK.search(s2):
            themes.append(s2)
    mood = []
    for th in themes:
        mood += MOOD.get(th, [])
    for pat, m in WORD_MOOD.items():
        if re.search(pat, text, re.I):
            mood.append(m)
    y = c.get('year') or year_of(c.get('date'))
    era = next((e for lim, e in ERA if y is not None and y < lim), None) if y is not None else None
    # people = who is depicted: only names in the title (a query hit or a description mention isn't enough)
    people = people_in(c['title'])
    return {'themes': themes[:12], 'mood': list(dict.fromkeys(mood))[:6] or ['neutral'], 'era': era or 'unknown', 'people': people}


def medium_word(c):
    m = (c.get('medium') or '').lower()
    md = (c.get('medium_display') or '').lower()
    if 'photo' in m or 'albumen' in md or 'gelatin' in md or 'daguerreotype' in md or 'old photo' in c['themes']:
        return 'photograph'
    if 'woodblock' in md or 'japanese print' in c['themes']:
        return 'woodblock print'
    if 'lithograph' in md:
        return 'lithograph'
    if 'etching' in md:
        return 'etching'
    if 'engraving' in md or 'engraving' in c['themes']:
        return 'engraving'
    if 'watercolor' in md:
        return 'watercolor'
    if 'drawing' in m or 'drawing' in md:
        return 'drawing'
    if 'print' in m:
        return 'print'
    if 'oil' in md or 'painting' in m:
        return 'painting'
    if 'portrait' in c['themes']:
        return 'portrait'
    return 'picture'


def build_alt(c, tags):
    artist = c['artist'] if c['artist'] and c['artist'].lower() not in ('unknown', 'anonymous') else None
    date = re.sub(r'\s+', ' ', c.get('date') or '').strip()
    med = medium_word(c)
    s = f"{c['title'].rstrip('.')} — {'an' if med[0] in 'aeiou' else 'a'} {med}"
    if artist:
        s += f' by {artist}'
    if date and len(date) < 30:
        s += f' ({date})'
    subj = [t for t in tags['themes'] if t not in ('portrait', 'thinkers', 'old photo', 'japanese print', 'engraving', 'etching', 'illustration', 'print', 'painting')][:3]
    if subj:
        s += '; shows ' + ', '.join(subj)
    return s[:300]


# ---------------------------------------------------------------- fetch
def load_manifest():
    if os.path.exists(MANIFEST):
        return json.load(open(MANIFEST, encoding='utf8'))
    return {'_note': '', 'items': []}


def save_manifest(man):
    man['_note'] = ('Public-domain / CC0 art library for `image` media (built by scripts/harvest-art.py). Each item: '
                    'src (max 1200px WebP) + src_600 (600px WebP), size, title, artist, date, source + source_url, license, alt, '
                    'tags {themes, mood, era, people}. Every item may be used by at most one post (src/lib/art-select.mjs).')
    man['items'].sort(key=lambda x: x['id'])
    with open(MANIFEST, 'w', encoding='utf8', newline='\n') as f:
        f.write('{\n  "_note": ' + json.dumps(man['_note'], ensure_ascii=False) + ',\n  "items": [\n')
        f.write(',\n'.join('    ' + json.dumps(i, ensure_ascii=False) for i in man['items']))
        f.write('\n  ]\n}\n')


def norm_title(c):
    return slug(f"{c['title']}", 40) + '|' + slug(c['artist'] or '', 16)


RAW = os.path.join(WORK, 'raw')


def process(c):
    # artic.edu sits behind a bot check that rejects Python's TLS client: pre-download those with
    # `python scripts/harvest-art.py todo` + any other HTTP client into <work>/raw/<key>.jpg.
    raw = os.path.join(RAW, c['key'] + '.jpg')
    if os.path.exists(raw) and os.path.getsize(raw) > 2000:
        data = open(raw, 'rb').read()
    elif c['source'] == 'Art Institute of Chicago':
        raise LookupError('not pre-downloaded')
    else:
        data = http(c['img'], binary=True)
    im = Image.open(io.BytesIO(data))
    im.load()
    if im.mode not in ('RGB', 'L'):
        bg = Image.new('RGB', im.size, (255, 255, 255))
        im2 = im.convert('RGBA')
        bg.paste(im2, mask=im2.split()[-1])
        im = bg
    im = im.convert('RGB')
    if max(im.size) < 560:
        raise ValueError(f'too small {im.size}')
    big = im.copy()
    big.thumbnail((LONG, LONG), Image.LANCZOS)
    sm = im.copy()
    sm.thumbnail((SMALL, SMALL), Image.LANCZOS)
    p1, p2 = os.path.join(OUT, c['id'] + '.webp'), os.path.join(OUT_SM, c['id'] + '.webp')
    big.save(p1, 'WEBP', quality=Q_LONG, method=6)
    sm.save(p2, 'WEBP', quality=Q_SMALL, method=6)
    return big.size, sm.size, os.path.getsize(p1) + os.path.getsize(p2)


def fetch():
    os.makedirs(OUT_SM, exist_ok=True)
    cache = json.load(open(os.path.join(WORK, 'queries.json'), encoding='utf8'))
    rejects_file = os.path.join(WORK, 'rejected.json')
    rejected = set(json.load(open(rejects_file))) if os.path.exists(rejects_file) else set()
    man = load_manifest()
    have_keys = {i['key'] for i in man['items']}
    have_titles = {norm_title(i) for i in man['items']}
    lib = json.load(open(os.path.join(ROOT, 'media', 'library.json'), encoding='utf8'))
    have_titles |= {slug(a['title'], 40) + '|' + slug(a['artist'], 16) for a in lib['art']}
    ids = {i['id'] for i in man['items']} | {a['id'] for a in lib['art']}
    todo = []
    for entry in Q:
        src, query, themes, n = entry[:4]
        people = entry[4] if len(entry) > 4 else []
        got = sum(1 for i in man['items'] if f'{src}:{query}' in i.get('queries', []))
        for c in cache.get(f'{src}:{query}', []):
            if got >= n:
                break
            text = f"{c['title']} {' '.join(c.get('subjects') or [])} {c.get('description') or ''}"
            if c['key'] in have_keys or c['key'] in rejected or BLOCK.search(text) or norm_title(c) in have_titles:
                continue
            if src == 'commons' and people and not people_in(c['title'] + ' ' + (c.get('description') or '')) and not any(
                    w.lower() in (c['title'] + c['source_url']).lower() for w in query.strip('"').split()[-1:]):
                continue
            c = dict(c, themes=list(themes), people=list(people), queries=[f'{src}:{query}'])
            base = slug(c['title'], 40)
            cid = base if base not in ids else f"{base}-{slug(c['key'], 14)}"
            while cid in ids:
                cid += 'x'
            ids.add(cid)
            c['id'] = cid
            have_keys.add(c['key'])
            have_titles.add(norm_title(c))
            todo.append(c)
            got += 1
    print(f'{len(todo)} to fetch', flush=True)
    json.dump([{'key': c['key'], 'url': c['img']} for c in todo if c['source'] == 'Art Institute of Chicago'],
              open(os.path.join(WORK, 'todo-aic.json'), 'w'))
    if os.environ.get('TODO_ONLY'):
        return
    total = 0
    def work(c):
        try:
            return c, process(c), None
        except Exception as e:  # noqa: BLE001
            return c, None, e
    with cf.ThreadPoolExecutor(4) as ex:
        for k, (c, res, err) in enumerate(ex.map(work, todo)):
            if err:
                print(f'✗ {c["id"]}: {err}', flush=True)
                if 'HTTP Error' not in str(err) and not isinstance(err, LookupError):
                    rejected.add(c['key'])
                continue
            (bw, bh), _, size = res
            total += size
            tags = build_tags(c)
            man['items'].append({
                'id': c['id'], 'src': f"/media/art/{c['id']}.webp", 'src_600': f"/media/art/600/{c['id']}.webp", 'width': bw, 'height': bh,
                'title': c['title'], 'artist': c['artist'], 'date': c.get('date') or '', 'source': c['source'], 'source_url': c['source_url'],
                'license': c['license'], 'alt': build_alt(c, tags), 'tags': tags, 'key': c['key'], 'queries': c['queries'],
            })
            if k % 25 == 0:
                print(f'{k}/{len(todo)} {total / 1e6:.1f} MB', flush=True)
                save_manifest(man)
    save_manifest(man)
    json.dump(sorted(rejected), open(rejects_file, 'w'))
    print(f'done: {len(man["items"])} items, +{total / 1e6:.1f} MB')


def sheets():
    man = load_manifest()
    d = os.path.join(WORK, 'sheets')
    os.makedirs(d, exist_ok=True)
    items = man['items']
    per, cols, cell = 48, 8, 150
    for s in range(0, len(items), per):
        chunk = items[s:s + per]
        rows = (len(chunk) + cols - 1) // cols
        sheet = Image.new('RGB', (cols * cell, rows * (cell + 14)), 'white')
        dr = ImageDraw.Draw(sheet)
        for k, it in enumerate(chunk):
            im = Image.open(os.path.join(OUT_SM, it['id'] + '.webp'))
            im.thumbnail((cell - 4, cell - 4))
            x, y = (k % cols) * cell, (k // cols) * (cell + 14)
            sheet.paste(im, (x + 2, y + 2))
            dr.text((x + 2, y + cell), f'{s + k}', fill='red')
        sheet.save(os.path.join(d, f'sheet-{s // per:02d}.jpg'), quality=80)
    print(f'{(len(items) + per - 1) // per} sheets in {d}')


def drop(idxs):
    man = load_manifest()
    items = man['items']
    rejects_file = os.path.join(WORK, 'rejected.json')
    rejected = set(json.load(open(rejects_file))) if os.path.exists(rejects_file) else set()
    kill = set()
    for x in idxs:
        kill.add(items[int(x)]['id'] if x.isdigit() else x)
    keep = []
    for it in items:
        if it['id'] in kill:
            rejected.add(it['key'])
            for p in (os.path.join(OUT, it['id'] + '.webp'), os.path.join(OUT_SM, it['id'] + '.webp')):
                if os.path.exists(p):
                    os.remove(p)
        else:
            keep.append(it)
    man['items'] = keep
    save_manifest(man)
    json.dump(sorted(rejected), open(rejects_file, 'w'))
    print(f'dropped {len(items) - len(keep)}; {len(keep)} left')


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'collect':
        collect()
    elif cmd == 'fetch':
        fetch()
    elif cmd == 'sheets':
        sheets()
    elif cmd == 'drop':
        drop(sys.argv[2:])
    else:
        print(__doc__)
