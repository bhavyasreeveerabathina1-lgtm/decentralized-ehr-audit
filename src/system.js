import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import solc from 'solc';
import { ContractFactory, JsonRpcProvider } from 'ethers';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const contractPath = path.resolve(root, 'contracts/EHRAudit.sol');
const hardhatCli = path.resolve(root, 'node_modules/hardhat/dist/src/cli.js');

export async function compileContract() {
  const source = await fs.readFile(contractPath, 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'EHRAudit.sol': { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((entry) => entry.severity === 'error');
  if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join('\n'));
  const artifact = output.contracts['EHRAudit.sol'].EHRAudit;
  return { abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` };
}

async function getFreePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function startLocalChain() {
  const port = await getFreePort();
  const child = spawn(process.execPath, [hardhatCli, 'node', '--hostname', '127.0.0.1', '--port', String(port), '--chain-id', '31337'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, HARDHAT_DISABLE_TELEMETRY_PROMPT: 'true' }
  });
  const rpcUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Hardhat node exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      if (response.ok) { ready = true; break; }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!ready) {
    child.kill('SIGTERM');
    throw new Error('Timed out while waiting for the local Hardhat node');
  }
  const provider = new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true });
  return {
    provider,
    async disconnect() {
      provider.destroy();
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve) => {
        const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => { clearTimeout(timeout); resolve(); });
        child.kill('SIGTERM');
      });
    }
  };
}

export async function createSystem() {
  const chain = await startLocalChain();
  const { provider } = chain;
  const signers = await Promise.all([0, 1, 2].map((index) => provider.getSigner(index)));
  const artifact = await compileContract();
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, signers[0]);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  return { chain, provider, signers, contract, contractAddress: await contract.getAddress() };
}
