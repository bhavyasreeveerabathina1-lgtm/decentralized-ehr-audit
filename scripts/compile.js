import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileContract } from '../src/system.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = await compileContract();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
await writeFile(path.join(root, 'artifacts/EHRAudit.json'), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`Compiled EHRAudit.sol -> ${path.join(root, 'artifacts/EHRAudit.json')}`);
