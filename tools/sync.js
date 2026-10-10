#!/usr/bin/env node
/**
 * 每日文章同步脚本
 * 用法: node tools/sync.js <manifest.json>
 * manifest 格式: { "date": "YYYY-MM-DD", "articles": [ { "mdPath": "本地md文件", "slug": "文章slug", "title": "文章标题" } ] }
 *
 * 功能:
 *  1. 把每篇 md 副本存入 articles/YYYY-MM-DD-<slug>.md
 *  2. README.md「最新更新」板块顶部插入当天记录(链接指向独立站), 最多保留 10 条
 *  3. git add / commit ("Auto-update: YYYY-MM-DD") / push
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SITE = 'https://gptpro20x.com';
const REPO = path.join(__dirname, '..');
const README = path.join(REPO, 'README.md');
const SECTION = '## 📰 最新更新';
const MAX_ENTRIES = 10;

function fail(msg) { console.error('[sync] ' + msg); process.exit(1); }

const args = process.argv.slice(2);
const positional = args.filter(a => a !== '--dry-run');
const manifestPath = positional[0];
const dryRun = args.includes('--dry-run');
if (positional.length !== 1 || manifestPath.startsWith('--')) fail('用法: node tools/sync.js <manifest.json> [--dry-run]');
let manifest;
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
catch { fail('Cannot read or parse manifest JSON'); }
if (!manifest || typeof manifest !== 'object') fail('Invalid manifest');
const { date, articles } = manifest;
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) fail('manifest.date 需为有效 YYYY-MM-DD');
if (!Array.isArray(articles) || !articles.length) fail('manifest.articles 为空');

// Validate every input before changing the working tree.
const seen = new Set();
for (const a of articles) {
  if (!a || typeof a.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(a.slug) || seen.has(a.slug)) fail('Invalid or duplicate slug');
  seen.add(a.slug);
  if (typeof a.title !== 'string' || !a.title.trim() || /[\r\n\[\]]/.test(a.title) || typeof a.mdPath !== 'string') fail('Invalid article');
  if (path.extname(a.mdPath).toLowerCase() !== '.md') fail('Article mdPath must be a .md file');
  try { a.content = fs.readFileSync(a.mdPath); }
  catch { fail('Cannot read article mdPath'); }
}
const run = args => {
  try { return execFileSync('git', args, { cwd: REPO, stdio: 'pipe' }).toString().trim(); }
  catch (error) { fail(`git ${args[0]} failed (status ${error.status ?? 'unknown'}); ${args[0] === 'push' ? 'commit exists locally; inspect upstream and local commits before retrying; no automatic retry push' : 'inspect local state before retrying'}`); }
};
if (run(['status', '--porcelain=v1'])) fail('Working tree must be clean before sync');
// Uses the last fetched upstream state; the operator must fetch and review before publishing.
// Never silently accept or push previously accumulated local commits.
const divergence = run(['rev-list', '--left-right', '--count', '@{upstream}...HEAD']).split(/\s+/).map(Number);
if (divergence.length !== 2 || divergence.some(n => !Number.isInteger(n))) fail('Cannot determine upstream state');
if (divergence[1]) fail('Local commits are ahead of upstream; inspect existing commits and remote state manually before retrying');
if (divergence[0]) fail('Local branch is behind upstream; reconcile manually before syncing');
const changed = [];
let readme;
try { readme = fs.readFileSync(README, 'utf8'); }
catch { fail('Cannot read README'); }
const originalReadme = readme;
if (readme.split('\n').filter(l => l.trim() === SECTION).length !== 1) fail('Expected exactly one latest-updates section');
const previewLines = readme.split('\n');
const previewStart = previewLines.findIndex(l => l.trim() === SECTION);
for (let i = previewStart + 1; i < previewLines.length && !/^## /.test(previewLines[i]); i++) {
  if (previewLines[i].trim() && !/^- \d{4}-\d{2}-\d{2} \[[^\r\n]+\]\(https?:\/\/[^\s)]+\)$/.test(previewLines[i].trim())) {
    fail('Latest-updates section contains non-entry text; preserve and review it manually');
  }
}

// 1. 保存 md 副本
const articlesDir = path.join(REPO, 'articles');
if (!dryRun) fs.mkdirSync(articlesDir, { recursive: true });
for (const a of articles) {
  const dest = path.join(articlesDir, `${date}-${a.slug}.md`);
  if (fs.existsSync(dest) && fs.readFileSync(dest).equals(a.content)) continue;
  changed.push(path.relative(REPO, dest).split(path.sep).join('/'));
  if (!dryRun) fs.writeFileSync(dest, a.content);
  console.log('[sync] 已保存 ' + path.relative(REPO, dest));
}

// 2. 更新 README「最新更新」板块
const newLines = articles.map(a => `- ${date} [${a.title}](${SITE}/blog/${a.slug}/)`);

{
  const lines = readme.split('\n');
  const start = lines.findIndex(l => l.trim() === SECTION);
  // 收集板块内已有条目(到下一个 ## 标题为止)
  let end = start + 1;
  const old = [];
  while (end < lines.length && !/^## /.test(lines[end])) {
    if (/^- \d{4}-\d{2}-\d{2} /.test(lines[end].trim())) old.push(lines[end].trim());
    end++;
  }
  const urls = articles.map(a => `](${SITE}/blog/${a.slug}/)`);
  const merged = [...newLines, ...old.filter(l => !urls.some(url => l.includes(url)))].slice(0, MAX_ENTRIES);
  lines.splice(start, end - start, SECTION, '', ...merged, '');
  readme = lines.join('\n');
}
if (readme !== originalReadme) {
  changed.push('README.md');
  if (!dryRun) fs.writeFileSync(README, readme);
}
if (dryRun) { console.log(JSON.stringify({ dryRun, changed })); process.exit(0); }
if (!changed.length) { console.log('[sync] No changes'); process.exit(0); }
console.log('[sync] README 最新更新板块已写入 ' + newLines.length + ' 条');

// 3. git 提交推送
run(['add', '--', ...changed]);
run(['-c', 'user.name=gptpro20x', '-c', 'user.email=support@gptpro20x.com', 'commit', '-m', `Auto-update: ${date}`, '--', ...changed]);
run(['push']);
console.log('[sync] 已推送: Auto-update: ' + date);
