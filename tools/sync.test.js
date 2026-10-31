const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, 'sync.js'), 'utf8');
function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
  const readme = '# Frozen title\n\n## 📰 最新更新\n\n## Body\nFrozen body\n';
  fs.writeFileSync(path.join(repo, 'README.md'), readme);
  const input = path.join(repo, 'input.md');
  fs.writeFileSync(input, '# Article');
  return { repo, readme, input };
}
function invoke(f, articles, dryRun = false, dirty = '') {
  const manifest = path.join(f.repo, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ date: '2026-10-11', articles }));
  const calls = [];
  let exit = null;
  try {
    vm.runInNewContext(source, {
      require(name) { return name === 'child_process' ? { execFileSync(binary, args) { assert.equal(binary, 'git'); calls.push(Array.from(args)); return Buffer.from(args[0] === 'status' ? dirty : args[0] === 'rev-list' ? '0 0' : args[0] === 'ls-files' ? (f.untrackedDocs ? '' : args[args.length - 1]) : ''); } } : require(name); },
      __dirname: path.join(f.repo, 'tools'),
      process: { argv: ['node', 'sync.js', manifest, ...(dryRun ? ['--dry-run'] : [])], exit(code) { exit = code; throw new Error('EXIT'); } },
      console: { log() {}, error() {} },
    });
  } catch (error) { if (error.message !== 'EXIT' || exit === null) throw error; }
  return { calls, exit };
}
test('rejects traversal and missing later input before any output', () => {
  for (const invalid of [{ slug: '../../escape', title: 'x', mdPath: 'missing.md' }, { slug: 'second', title: 'x', mdPath: 'missing.md' }]) {
    const f = fixture();
    const result = invoke(f, [{ slug: 'first', title: 'A', mdPath: f.input }, invalid]);
    assert.equal(result.exit, 1);
    assert.equal(fs.existsSync(path.join(f.repo, 'articles')), false);
    assert.equal(fs.readFileSync(path.join(f.repo, 'README.md'), 'utf8'), f.readme);
    assert.equal(result.calls.length, 0);
  }
});
test('dry-run writes nothing and only reads git state', () => {
  const f = fixture();
  const result = invoke(f, [{ slug: 'first', title: 'A', mdPath: f.input }], true);
  assert.equal(result.exit, 0);
  assert.deepEqual(result.calls.map(a => a[0]), ['status', 'rev-list']);
  assert.equal(fs.existsSync(path.join(f.repo, 'articles')), false);
  assert.equal(fs.readFileSync(path.join(f.repo, 'README.md'), 'utf8'), f.readme);
});
test('stages explicit files, preserves frozen body and is idempotent', () => {
  const f = fixture();
  const articles = [{ slug: 'first', title: 'A', mdPath: f.input }];
  const first = invoke(f, articles);
  assert.deepEqual(first.calls.find(a => a[0] === 'add').slice(0, 2), ['add', '--']);
  const staged = first.calls.find(a => a[0] === 'add').slice(2).map(p => p.replaceAll('\\', '/'));
  assert.deepEqual(staged, ['articles/2026-10-11-first.md', 'README.md']);
  assert.ok(fs.readFileSync(path.join(f.repo, 'README.md'), 'utf8').endsWith('## Body\nFrozen body\n'));
  const second = invoke(f, articles);
  assert.equal(second.exit, 0);
  assert.equal(second.calls.length, 2);
});
test('dirty workspace blocks before writes', () => {
  const f = fixture();
  const result = invoke(f, [{ slug: 'first', title: 'A', mdPath: f.input }], false, ' M unrelated.txt');
  assert.equal(result.exit, 1);
  assert.equal(fs.existsSync(path.join(f.repo, 'articles')), false);
});

test('real git: exact commit scope, frozen README, idempotence, rejected push and retry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-integration-'));
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  fs.mkdirSync(repo);
  const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '--bare', remote], root);
  git(['init']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  fs.mkdirSync(path.join(repo, 'tools'));
  fs.writeFileSync(path.join(repo, 'tools', 'sync.js'), source);
  const before = '# Frozen title\n\n## 📰 最新更新\n\n- 2026-10-10 [Existing guide](docs/paid-still-free.md)\n\n## Body\nFrozen body\n';
  fs.writeFileSync(path.join(repo, 'README.md'), before);
  fs.mkdirSync(path.join(repo, 'docs'));
  fs.writeFileSync(path.join(repo, 'docs', 'paid-still-free.md'), '# Existing guide');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'private.env\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-u', 'origin', 'HEAD']);
  fs.writeFileSync(path.join(repo, 'private.env'), 'not-a-real-secret');
  const input = path.join(root, 'input.md');
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(input, '# Article');
  const writeManifest = slug => fs.writeFileSync(manifest, JSON.stringify({ date: '2026-10-11', articles: [{ slug, title: 'A', mdPath: input, url: `https://chatgpt20x.com/${slug}` }] }));
  const run = (...args) => spawnSync(process.execPath, [path.join(repo, 'tools', 'sync.js'), ...args], { encoding: 'utf8' });
  writeManifest('first');
  const initialHead = git(['rev-parse', 'HEAD']);
  assert.equal(run('--dry-run', manifest).status, 0);
  assert.equal(git(['rev-parse', 'HEAD']), initialHead);
  assert.equal(fs.existsSync(path.join(repo, 'articles')), false);
  let result = run(manifest);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n').sort(), ['README.md', 'articles/2026-10-11-first.md']);
  const updated = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
  assert.ok(updated.startsWith('# Frozen title\n\n'));
  assert.ok(updated.endsWith('## Body\nFrozen body\n'));
  assert.ok(updated.includes('- 2026-10-11 [A](https://chatgpt20x.com/first)'));
  assert.ok(updated.includes('- 2026-10-10 [Existing guide](docs/paid-still-free.md)'));
  assert.equal(git(['rev-parse', 'HEAD']), git(['rev-parse', 'HEAD'], remote));
  const head = git(['rev-parse', 'HEAD']);
  assert.equal(run(manifest).status, 0);
  assert.equal(git(['rev-parse', 'HEAD']), head);
  // Bare receive policy rejects updates, simulating push failure without network.
  git(['config', 'receive.denyNonFastForwards', 'true'], remote);
  fs.writeFileSync(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeManifest('second');
  result = run(manifest);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /commit exists locally/);
  const pending = git(['rev-parse', 'HEAD']);
  assert.notEqual(pending, head);
  result = run(manifest);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ahead of upstream/);
  assert.equal(git(['rev-parse', 'HEAD']), pending);
  assert.equal(git(['rev-parse', 'HEAD'], remote), head);
  assert.equal(git(['status', '--porcelain=v1']), '');
});

test('controlled failure for invalid README sections and unsafe title', () => {
  for (const readme of ['# No section\n', '## 📰 最新更新\n## 📰 最新更新\n']) {
    const f = fixture();
    fs.writeFileSync(path.join(f.repo, 'README.md'), readme);
    assert.equal(invoke(f, [{ slug: 'first', title: 'A', mdPath: f.input }]).exit, 1);
    assert.equal(fs.existsSync(path.join(f.repo, 'articles')), false);
  }
  const f = fixture();
  assert.equal(invoke(f, [{ slug: 'first', title: 'bad]', mdPath: f.input }]).exit, 1);
});

test('non-markdown sources and manual latest-update notes are preserved before any write', () => {
  const f = fixture();
  const nonMarkdown = path.join(f.repo, 'source.env');
  fs.writeFileSync(nonMarkdown, 'non-markdown content');
  assert.equal(invoke(f, [{ slug: 'first', title: 'A', mdPath: nonMarkdown }]).exit, 1);
  assert.equal(fs.existsSync(path.join(f.repo, 'articles')), false);
  const withNote = f.readme.replace('## 📰 最新更新\n\n', '## 📰 最新更新\n\nManual note to preserve\n\n');
  fs.writeFileSync(path.join(f.repo, 'README.md'), withNote);
  const result = invoke(f, [{ slug: 'first', title: 'A', mdPath: f.input }]);
  assert.equal(result.exit, 1);
  assert.equal(fs.existsSync(path.join(f.repo, 'articles')), false);
  assert.equal(fs.readFileSync(path.join(f.repo, 'README.md'), 'utf8'), withNote);
  assert.equal(result.calls.some(a => ['add', 'commit', 'push'].includes(a[0])), false);
});

test('existing repository docs link survives sync and repeated sync is idempotent', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.repo, 'docs'));
  fs.writeFileSync(path.join(f.repo, 'docs', 'paid-still-free.md'), '# Existing guide');
  const entry = '- 2026-10-10 [Existing guide](docs/paid-still-free.md)';
  fs.writeFileSync(path.join(f.repo, 'README.md'), f.readme.replace('## 📰 最新更新\n\n', `## 📰 最新更新\n\n${entry}\n\n`));
  const articles = [{ slug: 'first', title: 'A', mdPath: f.input }];
  assert.equal(invoke(f, articles).exit, null);
  const updated = fs.readFileSync(path.join(f.repo, 'README.md'), 'utf8');
  assert.ok(updated.includes(entry));
  assert.ok(updated.endsWith('## Body\nFrozen body\n'));
  assert.equal(invoke(f, articles).exit, 0);
  assert.equal(fs.readFileSync(path.join(f.repo, 'README.md'), 'utf8'), updated);
});

test('unsafe, missing and non-Markdown relative README targets block before output', () => {
  for (const target of ['docs/missing.md', 'docs/../README.md', 'docs/%2e%2e/README.md', 'docs/file.env', 'docs/nested/file.md', './docs/file.md', '//example.invalid/a.md', 'javascript:alert(1)']) {
    const f = fixture();
    const before = f.readme.replace('## 📰 最新更新\n\n', `## 📰 最新更新\n\n- 2026-10-10 [Existing](${target})\n\n`);
    fs.writeFileSync(path.join(f.repo, 'README.md'), before);
    const result = invoke(f, [{ slug: 'first', title: 'A', mdPath: f.input }]);
    assert.equal(result.exit, 1, target);
    assert.equal(fs.existsSync(path.join(f.repo, 'articles')), false);
    assert.equal(fs.readFileSync(path.join(f.repo, 'README.md'), 'utf8'), before);
    assert.equal(result.calls.some(a => ['add', 'commit', 'push'].includes(a[0])), false);
  }
});

test('explicit published URL supports site-specific article paths without changing defaults', () => {
  for (const url of ['https://gptcz.pro/blog/first', 'https://chatgpt20x.com/first', 'https://gptpro20x.com/blog/first/', 'https://gptpro5x.com/first', 'https://aiczz.com/first']) {
    const f = fixture();
    const articles = [{ slug: 'first', title: 'A', mdPath: f.input, url }];
    assert.equal(invoke(f, articles).exit, null, url);
    const readme = fs.readFileSync(path.join(f.repo, 'README.md'), 'utf8');
    assert.ok(readme.includes(`](${url})`));
    assert.ok(readme.endsWith('## Body\nFrozen body\n'));
    assert.equal(invoke(f, articles).exit, 0);
  }
});

test('unsafe or mismatched article URLs reject the whole batch before any write', () => {
  for (const url of ['http://gptcz.pro/blog/second', 'https://gptcz.pro.evil.invalid/blog/second', 'https://user:pass@gptcz.pro/blog/second', 'https://gptcz.pro:8443/blog/second', 'https://gptcz.pro/blog/wrong', 'https://gptcz.pro/blog/second?x=1', 'https://gptcz.pro/blog/second#anchor', 'https://gptcz.pro/blog/second?', 'https://gptcz.pro/blog/second#', 'https://gptcz.pro/blog/../blog/second', 'https://gptcz.pro/blog/%73econd', 'javascript:alert(1)', 42]) {
    const f = fixture();
    const result = invoke(f, [{ slug: 'first', title: 'A', mdPath: f.input }, { slug: 'second', title: 'B', mdPath: f.input, url }]);
    assert.equal(result.exit, 1, String(url));
    assert.equal(fs.existsSync(path.join(f.repo, 'articles')), false);
    assert.equal(fs.readFileSync(path.join(f.repo, 'README.md'), 'utf8'), f.readme);
    assert.equal(result.calls.length, 0);
  }
});

function docsFixture() {
  const f = fixture();
  fs.mkdirSync(path.join(f.repo, 'docs'));
  fs.writeFileSync(path.join(f.repo, 'README.md'), f.readme.replace('## 📰 最新更新\n\n', '## 📰 最新更新\n\n- 2026-10-10 [Existing](docs/existing.md)\n\n'));
  return f;
}

test('docs target directories and existing untracked files reject before output', () => {
  for (const directory of [false, true]) {
    const f = docsFixture();
    const target = path.join(f.repo, 'docs', 'existing.md');
    if (directory) fs.mkdirSync(target);
    else { fs.writeFileSync(target, '# Untracked'); f.untrackedDocs = true; }
    const before = fs.readFileSync(path.join(f.repo, 'README.md'), 'utf8');
    const result = invoke(f, [{ slug: 'first', title: 'A', mdPath: f.input }]);
    assert.equal(result.exit, 1);
    assert.equal(fs.existsSync(path.join(f.repo, 'articles')), false);
    assert.equal(fs.readFileSync(path.join(f.repo, 'README.md'), 'utf8'), before);
    assert.equal(result.calls.some(a => ['add', 'commit', 'push'].includes(a[0])), false);
  }
});

test('docs symlink escaping the repository rejects before output', t => {
  const f = docsFixture();
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-doc-outside-')), 'outside.md');
  fs.writeFileSync(outside, '# Outside');
  try { fs.symlinkSync(outside, path.join(f.repo, 'docs', 'existing.md'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Environment does not permit file symlinks'); throw error; }
  const before = fs.readFileSync(path.join(f.repo, 'README.md'), 'utf8');
  assert.equal(invoke(f, [{ slug: 'first', title: 'A', mdPath: f.input }]).exit, 1);
  assert.equal(fs.existsSync(path.join(f.repo, 'articles')), false);
  assert.equal(fs.readFileSync(path.join(f.repo, 'README.md'), 'utf8'), before);
});

test('repository junction or symlink root keeps legitimate tracked docs usable', t => {
  const f = docsFixture();
  fs.writeFileSync(path.join(f.repo, 'docs', 'existing.md'), '# Tracked guide');
  const alias = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-root-alias-')), 'repo');
  try { fs.symlinkSync(f.repo, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Environment does not permit directory aliases'); throw error; }
  f.repo = alias;
  assert.equal(invoke(f, [{ slug: 'first', title: 'A', mdPath: f.input }]).exit, null);
  assert.ok(fs.readFileSync(path.join(f.repo, 'README.md'), 'utf8').includes('](docs/existing.md)'));
});
