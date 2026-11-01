// Build side of the post-page pack (format: src/worker/posts.mjs). Keeps dist/ at a flat file count:
// /p/<id>/ pages become slot records in at most MAX_BUCKETS files instead of one file per post.
import fs from 'node:fs';
import path from 'node:path';
import { SLOT, assemble, bucketOf, readRecord } from '../worker/posts.mjs';

const TARGET_BUCKET_BYTES = 512 * 1024;
const MIN_BUCKETS = 64;
const MAX_BUCKETS = 512;

/** Static segments of a layout rendered with @@S<n>@@ sentinel args (JSON-LD wraps its sentinel in quotes). */
export function makeTemplate(sentinelHtml) {
  return sentinelHtml.replace(/"(@@S\d+@@)"/g, '$1').split(SLOT);
}

/** Slot record for a fully rendered page, or null if it doesn't fit the template exactly. */
export function splitPage(segs, html) {
  if (segs.length < 2 || !html.startsWith(segs[0])) return null;
  let pos = segs[0].length;
  const vals = [];
  for (let i = 1; i < segs.length; i++) {
    const last = i === segs.length - 1;
    if (!last && !segs[i]) return null;
    const end = last ? html.length - segs[i].length : html.indexOf(segs[i], pos);
    if (end < pos || (last && !html.endsWith(segs[i]))) return null;
    vals.push(html.slice(pos, end));
    pos = end + segs[i].length;
  }
  const s = [...new Set(vals)];
  const rec = { s, o: vals.map((v) => s.indexOf(v)) };
  return assemble(segs, rec) === html ? rec : null;
}

/** Headers that public/_headers assigns to `pathname` (later rules append, like Cloudflare). */
export function headersFor(headersText, pathname) {
  const out = {};
  let match = false;
  for (const line of headersText.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const re = new RegExp('^' + line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/:\w+/g, '[^/]+') + '$');
      match = re.test(pathname);
      continue;
    }
    if (!match) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    out[k] = out[k] ? `${out[k]}, ${v}` : v;
  }
  return out;
}

export class PostPack {
  constructor(outDir, sentinelHtml, build) {
    this.out = outDir;
    this.segs = makeTemplate(sentinelHtml);
    this.build = build;
    this.recs = new Map();
    this.bytes = 0;
  }

  /** true = packed (no file needed); false = caller writes the static page. */
  add(id, html) {
    const rec = splitPage(this.segs, html);
    if (!rec) return false;
    const json = JSON.stringify(rec);
    this.recs.set(id, json);
    this.bytes += Buffer.byteLength(json);
    return true;
  }

  finish() {
    let n = MIN_BUCKETS;
    while (n < MAX_BUCKETS && this.bytes / n > TARGET_BUCKET_BYTES) n *= 2;
    const buckets = Array.from({ length: n }, () => []);
    for (const [id, json] of this.recs) buckets[bucketOf(id, n)].push([id, json]);
    const dir = path.join(this.out, '_p');
    fs.mkdirSync(dir, { recursive: true });
    let files = 0;
    buckets.forEach((list, k) => {
      if (!list.length) return;
      list.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      const index = {};
      const parts = [];
      let off = 0;
      for (const [id, json] of list) {
        const buf = Buffer.from(json);
        index[id] = [off, buf.length];
        parts.push(buf);
        off += buf.length;
      }
      const header = Buffer.from(JSON.stringify(index));
      const len = Buffer.alloc(4);
      len.writeUInt32LE(header.length);
      fs.writeFileSync(path.join(dir, `${k}.bin`), Buffer.concat([len, header, ...parts]));
      files++;
    });
    const hfile = path.join(this.out, '_headers');
    const headers = fs.existsSync(hfile) ? headersFor(fs.readFileSync(hfile, 'utf8'), '/p/x/') : {};
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ v: 1, build: this.build, n, count: this.recs.size, segs: this.segs, headers }));
    return { count: this.recs.size, buckets: n, files: files + 1 };
  }
}

/** Node-side read of /p/<id>/ from a built dist (pack first, then a static fallback file); null if absent. */
export function readPostPage(dist, id) {
  const metaFile = path.join(dist, '_p', 'meta.json');
  if (fs.existsSync(metaFile)) {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const file = path.join(dist, '_p', `${bucketOf(id, meta.n)}.bin`);
    const rec = fs.existsSync(file) ? readRecord(new Uint8Array(fs.readFileSync(file)), id) : null;
    if (rec) return assemble(meta.segs, rec);
  }
  const file = path.join(dist, 'p', id, 'index.html');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}
