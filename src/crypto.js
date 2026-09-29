import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { keccak256, toUtf8Bytes } from 'ethers';

export function canonicalize(value) {
  const ancestors = new WeakSet();
  function visit(current) {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current);
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('canonical JSON does not support non-finite numbers');
      return JSON.stringify(current);
    }
    if (Array.isArray(current)) {
      if (ancestors.has(current)) throw new TypeError('canonical JSON does not support circular values');
      ancestors.add(current);
      const result = `[${current.map(visit).join(',')}]`;
      ancestors.delete(current);
      return result;
    }
    if (current && typeof current === 'object') {
      if (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) throw new TypeError('canonical JSON supports only plain objects');
      if (ancestors.has(current)) throw new TypeError('canonical JSON does not support circular values');
      ancestors.add(current);
      const result = `{${Object.keys(current).sort().map((key) => `${JSON.stringify(key)}:${visit(current[key])}`).join(',')}}`;
      ancestors.delete(current);
      return result;
    }
    throw new TypeError(`canonical JSON does not support ${typeof current}`);
  }
  return visit(value);
}

export function contentHash(value) {
  return keccak256(toUtf8Bytes(canonicalize(value)));
}

export function deriveKey(masterKey = process.env.EHR_MASTER_KEY, purpose = 'record-encryption-v1') {
  if (typeof masterKey !== 'string' || !/^[0-9a-f]{64}$/i.test(masterKey)) {
    throw new Error('EHR_MASTER_KEY must be configured as exactly 64 hexadecimal characters (32 random bytes); no default key is provided');
  }
  // Domain-separated subkeys ensure the encryption and patient pseudonym keys differ.
  return createHmac('sha256', Buffer.from(masterKey, 'hex')).update(`ehr-audit:${purpose}`).digest();
}

export function patientPseudonym(patientRef, key = deriveKey(undefined, 'patient-pseudonym-v1')) {
  return `0x${createHmac('sha256', key).update(patientRef.toLowerCase(), 'utf8').digest('hex')}`;
}

export function encryptRecord(payload, key = deriveKey()) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(canonicalize(payload), 'utf8'), cipher.final()]);
  return {
    version: 1,
    algorithm: 'AES-256-GCM',
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex')
  };
}

export function decryptRecord(envelope, key = deriveKey()) {
  if (envelope?.version !== 1 || envelope?.algorithm !== 'AES-256-GCM') throw new Error('unsupported encrypted record format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'hex')),
    decipher.final()
  ]).toString('utf8');
  return JSON.parse(plaintext);
}

export function envelopeHash(envelope) {
  return keccak256(toUtf8Bytes(canonicalize(envelope)));
}
