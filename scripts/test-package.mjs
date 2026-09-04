import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const directory = await mkdtemp(path.join(tmpdir(), 'inkwell-sdk-package-'));
const run = (command, args, cwd = directory) =>
  execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const metadata = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], root));
  // npm 11 returns an array; npm 12 keys the result by package name.
  const packed = Array.isArray(metadata) ? metadata[0] : metadata[pkg.name];
  assert.equal(packed?.name, pkg.name);
  assert.equal(path.basename(packed.filename), packed.filename);
  assert.equal(packed.version, pkg.version);
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--offline', path.join(directory, packed.filename)]);
  const entries = Object.entries(pkg.exports).filter(([, target]) => typeof target !== 'string');
  const imports = entries.map(([name], index) =>
    `import * as surface${index} from ${JSON.stringify(pkg.name + (name === '.' ? '' : name.slice(1)))}; void surface${index};`).join('\n');
  await writeFile(path.join(directory, 'consumer.mjs'), `${imports}
import assert from 'node:assert/strict';
import { Inkwell } from '@silicon-jungle/inkwell-sdk';
import { createServerChat } from '@silicon-jungle/inkwell-sdk/chat';
for (const name of ['backend', 'chat', 'player', 'stats', 'leaderboards', 'achievements', 'invites', 'performance', 'presence']) assert.ok(Inkwell[name]);
assert.equal(typeof Inkwell.chat.setDefaultPanelVisible, 'function');
assert.equal(typeof Inkwell.invites.onAccepted, 'function');
assert.equal('setDefaultPanelVisible' in createServerChat(async () => { throw new Error('No network allowed'); }), false);
`);
  run(process.execPath, ['consumer.mjs']);
  await writeFile(path.join(directory, 'consumer.mts'), `${imports}
import { Inkwell } from '@silicon-jungle/inkwell-sdk';
import { createServerChat } from '@silicon-jungle/inkwell-sdk/chat';
void Inkwell.stats.aggregate({ names: ['coins'], startDate: '2024-02-28', endDate: '2024-03-01' });
void Inkwell.chat.setDefaultPanelVisible(false);
// @ts-expect-error A date range cannot be mixed with historyDays.
void Inkwell.stats.aggregate({ historyDays: 3, startDate: '2024-02-28', endDate: '2024-03-01' });
// @ts-expect-error Backend code cannot control a player's default chat panel.
void createServerChat(async () => { throw new Error('No network allowed'); }).setDefaultPanelVisible(false);
`);
  run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--typeRoots', path.join(root, 'node_modules/@types'), 'consumer.mts']);
  const bundle = await readFile(path.join(directory, 'node_modules', pkg.name, pkg.exports['./browser']), 'utf8');
  assert.ok(bundle.includes('Inkwell'), 'Browser bundle must be included in the published package.');
  console.log(`Verified packed ${pkg.name}@${pkg.version}: ${entries.length} ESM subpaths, consumer declarations, browser asset and browser/backend boundaries.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
