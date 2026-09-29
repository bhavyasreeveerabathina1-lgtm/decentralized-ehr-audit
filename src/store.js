import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class EncryptedBlobStore {
  constructor(directory) {
    this.directory = directory;
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  fileFor(recordId) {
    if (!/^0x[0-9a-f]{64}$/i.test(recordId)) throw new Error('invalid record identifier');
    return path.join(this.directory, `${recordId.slice(2).toLowerCase()}.json`);
  }

  async put(recordId, envelope) {
    await this.initialize();
    const file = this.fileFor(recordId);
    await writeFile(file, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    return file;
  }

  async get(recordId) {
    const raw = await readFile(this.fileFor(recordId), 'utf8');
    return JSON.parse(raw);
  }

  async delete(recordId) {
    await rm(this.fileFor(recordId), { force: true });
  }
}
