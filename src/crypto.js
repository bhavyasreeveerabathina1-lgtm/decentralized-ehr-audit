import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { keccak256, toUtf8Bytes } from 'ethers';

export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function contentHash(value) {
  return keccak256(toUtf8Bytes(canonicalize(value)));
}

const developmentMasterKey = 'DEMO-ONLY-NOT-A-SECRET-change-before-any-deployment';
export function deriveKey(masterKey = process.env.EHR_MASTER_KEY || developmentMasterKey, purpose = 'record-encryption-v1') {
  // Domain-separated subkeys ensure the encryption and patient pseudonym keys differ.
  return createHmac('sha256', masterKey).update(`ehr-audit:${purpose}`).digest();
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
