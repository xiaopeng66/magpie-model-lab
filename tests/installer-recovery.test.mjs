import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const ps51 = join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const shells = process.platform === 'win32' ? [ps51, execFileSync(ps51, ['-NoProfile', '-Command', '(Get-Command pwsh.exe -ErrorAction Stop).Source'], { encoding: 'utf8', windowsHide: true }).trim()] : [];

function run(shell, dir, mode, checkpoint = '', layout = 'same') {
  const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-File', join(source, 'tests/installer-crash-fixture.ps1'), '-FixtureRoot', dir, '-SourceRoot', source, '-Mode', mode, '-Checkpoint', checkpoint, '-Layout', layout], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', bytes => { out += bytes; }); child.stderr.on('data', bytes => { err += bytes; });
  const exited = new Promise((resolve, reject) => { child.once('exit', code => resolve({ code, out, err })); child.once('error', reject); });
  return { child, exited, output: () => out, errors: () => err };
}

async function cut(shell, dir, stage, mode = 'install', layout = 'same') {
  const service = run(shell, dir, mode, stage, layout), deadline = Date.now() + 20000;
  try {
    while (!service.output().includes('UPDATE_CHECKPOINT ' + stage)) {
      assert.equal(service.child.exitCode, null, service.errors() + service.output());
      assert.ok(Date.now() < deadline, 'Isolated child did not reach ' + stage);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } finally { service.child.kill('SIGKILL'); await service.exited; }
}

for (const [index, shell] of shells.entries()) {
  for (const stage of ['after-preparation', 'after-backup', 'after-first-install', 'before-second-install']) test(`PowerShell ${index ? '7' : '5.1'} recovers both directories after a real kill at ${stage}`, { timeout: 30000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'magpie-installer-proof-')); t.after(() => rm(dir, { recursive: true, force: true }));
    await cut(shell, dir, stage);
    const recovered = await run(shell, dir, 'recover').exited;
    assert.equal(recovered.code, 0, recovered.err + recovered.out);
    for (const name of ['first-target', 'second-target']) {
      assert.equal(await readFile(join(dir, name, 'index.mjs'), 'utf8'), 'old-version');
      assert.equal(await readFile(join(dir, name, 'extra.txt'), 'utf8'), 'unchanged-extra');
    }
    const second = await run(shell, dir, 'recover').exited; assert.equal(second.code, 0, second.err);
    assert.ok(!(await readFile(join(dir, 'cli.log'), 'utf8')).includes('on'), 'Recovery must keep the plugin stopped until a new full install is verified');
    const installed = await run(shell, dir, 'install').exited; assert.equal(installed.code, 0, installed.err + installed.out);
    for (const name of ['first-target', 'second-target']) assert.equal(await readFile(join(dir, name, 'index.mjs'), 'utf8'), 'new-version');
    assert.equal((await readdir(dir)).filter(name => /^\.magpie-model-lab-update-.*\.json$/.test(name)).length, 0);
  });

  test(`PowerShell ${index ? '7' : '5.1'} can resume recovery itself after another process kill`, { timeout: 30000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'magpie-installer-proof-')); t.after(() => rm(dir, { recursive: true, force: true }));
    await cut(shell, dir, 'after-first-install'); await cut(shell, dir, 'during-recovery', 'recover');
    const result = await run(shell, dir, 'recover').exited; assert.equal(result.code, 0, result.err + result.out);
    for (const name of ['first-target', 'second-target']) assert.equal(await readFile(join(dir, name, 'index.mjs'), 'utf8'), 'old-version');
  });

  for (const stage of ['before-activation', 'after-activation']) test(`PowerShell ${index ? '7' : '5.1'} preserves verified new files after interruption at ${stage}`, { timeout: 30000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'magpie-installer-proof-')); t.after(() => rm(dir, { recursive: true, force: true }));
    await cut(shell, dir, stage);
    const result = await run(shell, dir, 'recover').exited; assert.equal(result.code, 0, result.err + result.out);
    for (const name of ['first-target', 'second-target']) assert.equal(await readFile(join(dir, name, 'index.mjs'), 'utf8'), 'new-version');
    assert.equal(await readFile(join(dir, 'cli.log'), 'utf8'), stage === 'after-activation' ? 'off\r\non\r\noff\r\n' : 'off\r\noff\r\n');
  });

  test(`PowerShell ${index ? '7' : '5.1'} rejects journal paths outside its exact recorded targets`, { timeout: 30000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'magpie-installer-proof-')); t.after(() => rm(dir, { recursive: true, force: true }));
    await cut(shell, dir, 'after-first-install');
    const journalFile = (await readdir(dir)).find(name => /^\.magpie-model-lab-update-.*\.json$/.test(name));
    const journal = JSON.parse(await readFile(join(dir, journalFile), 'utf8'));
    journal.entries[0].backup = join(dir, 'foreign-directory');
    await writeFile(join(dir, journalFile), JSON.stringify(journal));
    const before = await readFile(join(dir, 'cli.log'));
    const result = await run(shell, dir, 'recover').exited; assert.notEqual(result.code, 0);
    assert.deepEqual(await readFile(join(dir, 'cli.log')), before, 'An invalid journal is refused before plugin commands');
    assert.equal(await readFile(join(dir, 'first-target/index.mjs'), 'utf8'), 'new-version');
    assert.equal(await readFile(join(dir, 'second-target/index.mjs'), 'utf8'), 'old-version');
  });

  test(`PowerShell ${index ? '7' : '5.1'} recovers an activated reinstall with identical old and new bytes`, { timeout: 30000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'magpie-installer-proof-')); t.after(() => rm(dir, { recursive: true, force: true }));
    await cut(shell, dir, 'after-activation', 'install', 'identical');
    const result = await run(shell, dir, 'recover', '', 'identical').exited; assert.equal(result.code, 0, result.err + result.out);
    for (const name of ['first-target', 'second-target']) assert.equal(await readFile(join(dir, name, 'index.mjs'), 'utf8'), 'new-version');
  });

  test(`PowerShell ${index ? '7' : '5.1'} protects a pending multi-parent update from subset and unrelated replacements`, { timeout: 30000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'magpie-installer-proof-')); t.after(() => rm(dir, { recursive: true, force: true }));
    await cut(shell, dir, 'after-first-install', 'install', 'split');
    const before = await readFile(join(dir, 'cli.log'));
    for (const mode of ['subset-install', 'other-install']) {
      const result = await run(shell, dir, mode, '', 'split').exited; assert.notEqual(result.code, 0, 'Pending recovery must be resolved with its complete original target set');
      assert.deepEqual(await readFile(join(dir, 'cli.log')), before, 'An unrelated install cannot activate or prune unresolved backups');
    }
    const recovered = await run(shell, dir, 'recover', '', 'split').exited; assert.equal(recovered.code, 0, recovered.err + recovered.out);
    assert.equal(await readFile(join(dir, 'first-target/index.mjs'), 'utf8'), 'old-version');
    assert.equal(await readFile(join(dir, 'second-parent/second-target/index.mjs'), 'utf8'), 'old-version');
    const installed = await run(shell, dir, 'other-install', '', 'split').exited; assert.equal(installed.code, 0, installed.err + installed.out);
  });

  test(`PowerShell ${index ? '7' : '5.1'} refuses a missing journal or a changed durable reference before plugin commands`, { timeout: 30000 }, async t => {
    for (const fault of ['missing-journal', 'changed-reference']) {
      const dir = await mkdtemp(join(tmpdir(), 'magpie-installer-proof-')); t.after(() => rm(dir, { recursive: true, force: true }));
      await cut(shell, dir, 'after-first-install');
      if (fault === 'missing-journal') {
        const file = (await readdir(dir)).find(name => /^\.magpie-model-lab-update-.*\.json$/.test(name)); await rm(join(dir, file));
      } else {
        const file = join(dir, '.magpie-model-lab-update.pending.json'), reference = JSON.parse(await readFile(file, 'utf8'));
        reference.journal = join(dir, '.magpie-model-lab-update-' + '0'.repeat(64) + '.json'); await writeFile(file, JSON.stringify(reference));
      }
      const before = await readFile(join(dir, 'cli.log')), result = await run(shell, dir, 'recover').exited;
      assert.notEqual(result.code, 0); assert.deepEqual(await readFile(join(dir, 'cli.log')), before);
      assert.equal(await readFile(join(dir, 'first-target/index.mjs'), 'utf8'), 'new-version');
      assert.equal(await readFile(join(dir, 'second-target/index.mjs'), 'utf8'), 'old-version');
    }
  });

  test(`PowerShell ${index ? '7' : '5.1'} validates every backup before moving the first recovery directory`, { timeout: 30000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'magpie-installer-proof-')); t.after(() => rm(dir, { recursive: true, force: true }));
    await cut(shell, dir, 'before-second-install');
    const file = (await readdir(dir)).find(name => /^\.magpie-model-lab-update-.*\.json$/.test(name)), journal = JSON.parse(await readFile(join(dir, file), 'utf8'));
    await writeFile(join(journal.entries[0].backup, 'index.mjs'), 'external-backup-change');
    const result = await run(shell, dir, 'recover').exited; assert.notEqual(result.code, 0);
    assert.equal(await readFile(join(dir, 'first-target/index.mjs'), 'utf8'), 'new-version');
    await assert.rejects(readFile(join(dir, 'second-target/index.mjs')), { code: 'ENOENT' });
    assert.equal(await readFile(join(journal.entries[0].backup, 'index.mjs'), 'utf8'), 'external-backup-change');
  });

  test(`PowerShell ${index ? '7' : '5.1'} refuses concurrent replacement and preserves external edits during recovery`, { timeout: 30000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'magpie-installer-proof-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const writer = run(shell, dir, 'install', 'after-first-install'), deadline = Date.now() + 15000;
    try {
      while (!writer.output().includes('UPDATE_CHECKPOINT')) { assert.equal(writer.child.exitCode, null, writer.errors()); assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20)); }
      const competitor = await run(shell, dir, 'install').exited; assert.notEqual(competitor.code, 0); assert.match(competitor.err, /进行中|正在|locked|in progress/i);
    } finally { writer.child.kill('SIGKILL'); await writer.exited; }
    await writeFile(join(dir, 'first-target/index.mjs'), 'external-change');
    const result = await run(shell, dir, 'recover').exited; assert.notEqual(result.code, 0);
    assert.equal(await readFile(join(dir, 'first-target/index.mjs'), 'utf8'), 'external-change');
    assert.equal(await readFile(join(dir, 'second-target/index.mjs'), 'utf8'), 'old-version');
    assert.ok(!(await readFile(join(dir, 'cli.log'), 'utf8')).includes('on'));
  });
}
