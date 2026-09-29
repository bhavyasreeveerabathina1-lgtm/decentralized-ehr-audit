import test from 'node:test';
import assert from 'node:assert/strict';
import { contentHash, decryptRecord, encryptRecord, patientPseudonym } from '../src/crypto.js';

test('canonical content hashing ignores object key order', () => {
  assert.equal(contentHash({ a: 1, b: { c: 2 } }), contentHash({ b: { c: 2 }, a: 1 }));
});

test('AES-256-GCM round-trips payloads and detects modifications', () => {
  const key = Buffer.alloc(32, 7);
  const envelope = encryptRecord({ synthetic: true, summary: 'example' }, key);
  assert.deepEqual(decryptRecord(envelope, key), { summary: 'example', synthetic: true });
  assert.throws(() => decryptRecord({ ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}00` }, key));
});

test('keyed patient pseudonyms are stable for matching refs and differ across refs', () => {
  const key = Buffer.alloc(32, 9);
  const one = patientPseudonym('patient-demo-001', key);
  assert.equal(one, patientPseudonym('PATIENT-DEMO-001', key));
  assert.notEqual(one, patientPseudonym('patient-demo-002', key));
  assert.match(one, /^0x[0-9a-f]{64}$/);
  assert.equal(one.includes('patient-demo'), false);
});
