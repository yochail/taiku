// Minimal, dependency-free JSON Schema (draft 2020-12 subset) validator.
// Supports: type, enum, const, required, properties, additionalProperties, items,
// minItems/maxItems, minLength/maxLength, minimum/maximum, pattern, format (date-time, https-uri),
// $ref ("#/$defs/name"), anyOf.
import fs from 'node:fs';
import path from 'node:path';

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const typeOk = (v, t) => typeOf(v) === t || (t === 'number' && typeof v === 'number');

export function validateSchema(value, schema, root = schema, at = '$', errors = []) {
  if (schema.$ref) {
    const name = schema.$ref.replace('#/$defs/', '');
    const def = root.$defs?.[name];
    if (!def) throw new Error(`schema: unknown $ref ${schema.$ref}`);
    return validateSchema(value, def, root, at, errors);
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => validateSchema(value, s, root, at, []).length === 0);
    if (!ok) errors.push(`${at}: does not match any allowed shape`);
    return errors;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(value, t))) {
      errors.push(`${at}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: must be one of ${schema.enum.join(', ')}`);
  if ('const' in schema && value !== schema.const) errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (typeof value === 'string') {
    const n = [...value].length;
    if (schema.minLength != null && n < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && n > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
    if (schema.format === 'date-time' && (Number.isNaN(Date.parse(value)) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(value)))
      errors.push(`${at}: not an ISO date-time`);
    if (schema.format === 'https-uri') {
      try {
        if (new URL(value).protocol !== 'https:') errors.push(`${at}: must be https`);
      } catch {
        errors.push(`${at}: invalid URL`);
      }
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${at}: < ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${at}: > ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => validateSchema(v, schema.items, root, `${at}[${i}]`, errors));
  }
  if (typeOf(value) === 'object') {
    for (const k of schema.required ?? []) if (value[k] === undefined) errors.push(`${at}: missing "${k}"`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('_')) continue; // runtime-only fields (e.g. _file)
      if (props[k]) validateSchema(v, props[k], root, `${at}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property "${k}"`);
      else if (typeof schema.additionalProperties === 'object') validateSchema(v, schema.additionalProperties, root, `${at}.${k}`, errors);
    }
  }
  return errors;
}

const cache = new Map();
export function loadSchema(root, name) {
  if (!cache.has(name)) cache.set(name, JSON.parse(fs.readFileSync(path.join(root, 'schemas', `${name}.schema.json`), 'utf8')));
  return cache.get(name);
}
