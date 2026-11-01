// Post-page pack format, shared by the build (src/lib/postpack.mjs) and the Worker (src/worker/index.mjs).
// Pure ESM, no Node APIs. /p/<id>/ pages are not emitted as files: build.mjs renders each one with layout(),
// then stores only the slot values that differ from one shared layout template (dist/_p/meta.json "segs"),
// hash-bucketed into dist/_p/<k>.bin. The Worker reassembles the identical bytes on request.
//
// <k>.bin = u32le(headerLength) + header JSON {"<id>": [offset, length]} + payload (record JSON per post).
// record = { s: unique slot strings, o: slot index -> s index }.

export const SLOT = /@@S\d+@@/g;

/** FNV-1a 32-bit over UTF-16 code units. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const bucketOf = (id, n) => fnv1a(id) % n;

export function assemble(segs, rec) {
  let out = segs[0];
  for (let i = 0; i < rec.o.length; i++) out += rec.s[rec.o[i]] + segs[i + 1];
  return out;
}

const dec = new TextDecoder();

/** Record for `id` from a bucket file's bytes, or null. Only the header and that record are decoded. */
export function readRecord(bytes, id) {
  if (bytes.byteLength < 4) return null;
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  const index = JSON.parse(dec.decode(bytes.subarray(4, 4 + headerLength)));
  if (!Object.hasOwn(index, id)) return null;
  const [offset, length] = index[id];
  const start = 4 + headerLength + offset;
  return JSON.parse(dec.decode(bytes.subarray(start, start + length)));
}
