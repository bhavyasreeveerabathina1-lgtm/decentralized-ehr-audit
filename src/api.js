import express from 'express';
import { randomBytes } from 'node:crypto';
import { keccak256, toUtf8Bytes } from 'ethers';
import { contentHash, decryptRecord, deriveKey, encryptRecord, envelopeHash, patientPseudonym } from './crypto.js';

const ROLES = ['patient', 'doctor', 'insurer'];
const MAX_EXPIRY_SECONDS = 30 * 24 * 60 * 60;
const recordIdFrom = (value) => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) throw new HttpError(400, 'recordId must be a 32-byte hex value');
  return value.toLowerCase();
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function validatePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON request body is required');
  if (body.synthetic !== true) throw new HttpError(400, 'synthetic must be true; this prototype accepts synthetic data only');
  if (typeof body.patientRef !== 'string' || !/^[a-z0-9-]{3,48}$/i.test(body.patientRef)) throw new HttpError(400, 'patientRef must be a synthetic pseudonymous alias (3–48 letters, digits, or hyphens)');
  const payload = body.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(400, 'payload object is required');
  const allowed = new Set(['recordType', 'date', 'provider', 'diagnosisCode', 'summary']);
  if (Object.keys(payload).some((key) => !allowed.has(key))) throw new HttpError(400, 'payload contains unsupported fields; use only the documented synthetic schema');
  if (!['encounter', 'lab', 'claim'].includes(payload.recordType)) throw new HttpError(400, 'recordType must be encounter, lab, or claim');
  const dateTimestamp = typeof payload.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(payload.date) ? Date.parse(`${payload.date}T00:00:00Z`) : NaN;
  if (!Number.isFinite(dateTimestamp) || new Date(dateTimestamp).toISOString().slice(0, 10) !== payload.date) throw new HttpError(400, 'date must be a valid calendar date in YYYY-MM-DD format');
  for (const field of ['provider', 'diagnosisCode', 'summary']) {
    if (typeof payload[field] !== 'string' || payload[field].length < 1 || payload[field].length > 240) throw new HttpError(400, `${field} must be a string of 1–240 characters`);
  }
  return { patientRef: body.patientRef, payload: { ...payload } };
}

async function parseRecord(contract, recordId) {
  const result = await contract.getRecord(recordId);
  return { patient: result[0], patientId: result[1], dataHash: result[2], encryptedBlobHash: result[3] };
}

async function verifyStoredRecord({ contract, store, recordId, key }) {
  const onChain = await parseRecord(contract, recordId);
  const envelope = await store.get(recordId);
  if (envelopeHash(envelope).toLowerCase() !== onChain.encryptedBlobHash.toLowerCase()) throw new HttpError(409, 'encrypted blob integrity check failed');
  let bundle;
  try { bundle = decryptRecord(envelope, key); }
  catch { throw new HttpError(409, 'encrypted blob could not be authenticated or decrypted'); }
  if (contentHash(bundle).toLowerCase() !== onChain.dataHash.toLowerCase()) throw new HttpError(409, 'plaintext content commitment does not match the ledger');
  return { onChain, bundle, payload: bundle.payload };
}

export function createApp({ contract, signers, store, key = deriveKey(), patientIdKey = deriveKey(undefined, 'patient-pseudonym-v1') }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb', strict: true }));

  const accountAddresses = {};
  const signerByRole = {};
  for (let i = 0; i < ROLES.length; i += 1) {
    signerByRole[ROLES[i]] = signers[i];
    accountAddresses[ROLES[i]] = null;
  }

  const withActor = async (req, _res, next) => {
    const role = req.get('x-demo-actor');
    if (!ROLES.includes(role)) return next(new HttpError(401, 'set x-demo-actor to patient, doctor, or insurer (demo identities only)'));
    req.actorRole = role;
    req.actor = signerByRole[role];
    try { req.actorAddress = await req.actor.getAddress(); next(); }
    catch (error) { next(error); }
  };

  app.get('/health', (_req, res) => res.json({ status: 'ok', mode: 'educational-demo', chain: 'local-hardhat-evm' }));
  app.get('/api/demo/accounts', async (_req, res, next) => {
    try {
      const accounts = {};
      for (const role of ROLES) accounts[role] = await signerByRole[role].getAddress();
      res.json({ warning: 'Local demo keys and role headers are not authentication.', accounts });
    } catch (error) { next(error); }
  });

  app.post('/api/records', withActor, async (req, res, next) => {
    let recordId;
    try {
      if (req.actorRole !== 'patient') throw new HttpError(403, 'only the patient demo identity can create a record');
      const { patientRef, payload } = validatePayload(req.body);
      recordId = keccak256(toUtf8Bytes(`${randomBytes(32).toString('hex')}:${Date.now()}`));
      const patientId = patientPseudonym(patientRef, patientIdKey);
      const bundle = { payload, commitmentSalt: randomBytes(32).toString('hex') };
      const envelope = encryptRecord(bundle, key);
      const dataHash = contentHash(bundle);
      const encryptedBlobHash = envelopeHash(envelope);
      await store.put(recordId, envelope);
      try {
        const tx = await contract.connect(req.actor).createRecord(recordId, patientId, dataHash, encryptedBlobHash);
        await tx.wait();
      } catch (error) {
        throw new HttpError(502, `ledger transaction failed: ${error.shortMessage || error.message}`);
      }
      res.status(201).json({ recordId, patientId, dataHash, encryptedBlobHash, storedOffChainEncrypted: true });
    } catch (error) { next(error); }
  });

  app.post('/api/records/:recordId/consent', withActor, async (req, res, next) => {
    try {
      if (req.actorRole !== 'patient') throw new HttpError(403, 'only the patient demo identity can grant consent');
      const recordId = recordIdFrom(req.params.recordId);
      const target = req.body?.grantee;
      if (!['doctor', 'insurer'].includes(target)) throw new HttpError(400, 'grantee must be doctor or insurer');
      const seconds = Number(req.body?.expiresInSeconds);
      if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > MAX_EXPIRY_SECONDS) throw new HttpError(400, 'expiresInSeconds must be from 60 seconds to 30 days');
      const grantee = await signerByRole[target].getAddress();
      const block = await req.actor.provider.getBlock('latest');
      const expiresAt = Math.floor(Number(block.timestamp)) + seconds;
      const tx = await contract.connect(req.actor).grantAccess(recordId, grantee, expiresAt);
      const receipt = await tx.wait();
      res.json({ recordId, granteeRole: target, grantee, expiresAt, transactionHash: receipt.hash });
    } catch (error) { next(error); }
  });

  app.post('/api/records/:recordId/revoke/:grantee', withActor, async (req, res, next) => {
    try {
      if (req.actorRole !== 'patient') throw new HttpError(403, 'only the patient demo identity can revoke consent');
      const recordId = recordIdFrom(req.params.recordId);
      const target = req.params.grantee;
      if (!['doctor', 'insurer'].includes(target)) throw new HttpError(400, 'grantee must be doctor or insurer');
      const grantee = await signerByRole[target].getAddress();
      const tx = await contract.connect(req.actor).revokeAccess(recordId, grantee);
      const receipt = await tx.wait();
      res.json({ recordId, revokedRole: target, transactionHash: receipt.hash });
    } catch (error) { next(error); }
  });

  app.get('/api/records/:recordId/verify', withActor, async (req, res, next) => {
    try {
      const recordId = recordIdFrom(req.params.recordId);
      if (!(await contract.hasAccess(recordId, req.actorAddress))) throw new HttpError(403, 'no active consent for this identity');
      const { onChain, bundle } = await verifyStoredRecord({ contract, store, recordId, key });
      const tx = await contract.connect(req.actor).recordAccess(recordId);
      const receipt = await tx.wait();
      res.json({ recordId, integrity: 'verified', patientId: onChain.patientId, commitmentSalt: bundle.commitmentSalt, transactionHash: receipt.hash, dataReturned: false });
    } catch (error) { next(error); }
  });

  app.get('/api/records/:recordId/access', withActor, async (req, res, next) => {
    try {
      const recordId = recordIdFrom(req.params.recordId);
      if (!(await contract.hasAccess(recordId, req.actorAddress))) throw new HttpError(403, 'no active consent for this identity');
      const { payload, bundle, onChain } = await verifyStoredRecord({ contract, store, recordId, key });
      const tx = await contract.connect(req.actor).recordAccess(recordId);
      const receipt = await tx.wait();
      res.json({ recordId, integrity: 'verified', payload, commitmentSalt: bundle.commitmentSalt, auditTransaction: receipt.hash, patientId: onChain.patientId });
    } catch (error) { next(error); }
  });

  app.get('/api/records/:recordId/audit', async (req, res, next) => {
    try {
      const recordId = recordIdFrom(req.params.recordId);
      await parseRecord(contract, recordId);
      const latest = Number(BigInt(await contract.runner.provider.send('eth_blockNumber', [])));
      const [created, granted, revoked, accessed] = await Promise.all([
        contract.queryFilter(contract.filters.RecordCreated(recordId), 0, latest),
        contract.queryFilter(contract.filters.AccessGranted(recordId), 0, latest),
        contract.queryFilter(contract.filters.AccessRevoked(recordId), 0, latest),
        contract.queryFilter(contract.filters.RecordAccessed(recordId), 0, latest)
      ]);
      const events = [...created, ...granted, ...revoked, ...accessed].sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
      res.json({ recordId, events: events.map((event) => ({
        type: event.fragment.name,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        args: event.args.toArray().map((arg) => typeof arg === 'bigint' ? arg.toString() : arg)
      })) });
    } catch (error) { next(error); }
  });

  app.use((error, _req, res, _next) => {
    const status = error instanceof HttpError ? error.status : (error.status === 400 ? 400 : 500);
    res.status(status).json({ error: status === 500 ? 'internal server error' : error.message });
  });
  return app;
}
