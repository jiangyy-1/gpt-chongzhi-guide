#!/usr/bin/env node
/**
 * 每日文章同步脚本
 * 用法: node tools/sync.js <manifest.json>
 * manifest 格式: { "date": "YYYY-MM-DD", "articles": [ { "mdPath": "本地md文件", "slug": "文章slug", "title": "文章标题", "url": "可选：已发布的自有站文章地址；同篇URL写法保持一致" } ] }
 *
 * 功能:
 *  1. 把每篇 md 副本存入 articles/YYYY-MM-DD-<slug>.md
 *  2. README.md「最新更新」板块顶部插入当天记录(链接指向独立站), 最多保留 5 条
 *  2b. 超出 5 条的旧条目归档到 CHANGELOG.md(不丢弃)
 *  3. git add / commit ("Auto-update: YYYY-MM-DD") / push
 *
 * 注意: README「最新更新」板块位于文件末尾, 核心词正文与「热门指南」在前。
 * 不要把该板块移回顶部 —— 2026-11-23 排查显示顶部堆积自有站链接与主仓
 * 商业词排名下滑同期发生, 证据见 E:/新的网站/.seo-runs/2026-11-23/。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { URL } = require('url');

const SITE = 'https://gptpro20x.com';
const REPO = path.join(__dirname, '..');
const README = path.join(REPO, 'README.md');
const SECTION = '## 📰 最新更新';
const CHANGELOG = path.join(REPO, 'CHANGELOG.md');
const NOTE = '> 更早的更新条目见 [CHANGELOG.md](CHANGELOG.md)。';
// 2026-11-23: 由 10 收紧到 5。README 顶部堆积自有站链接会稀释正文核心词，
// 溢出条目不再丢弃，改为归档到 CHANGELOG.md。
const MAX_ENTRIES = 5;

// Keep the legacy default, but accept exact published paths for the five owned sites.
function articleUrl(article) {
  if (article.url === undefined) return `${SITE}/blog/${article.slug}/`;
  if (typeof article.url !== 'string' || /[?#]/.test(article.url)) fail('Invalid article URL');
  let url;
  try { url = new URL(article.url); } catch { fail('Invalid article URL'); }
  const prefix = {
    'gptpro20x.com': '/blog/', 'gptcz.pro': '/blog/',
    'chatgpt20x.com': '/', 'gptpro5x.com': '/', 'aiczz.com': '/',
  }[url.hostname];
  if (url.protocol !== 'https:' || !prefix || url.username || url.password || url.port ||
      url.search || url.hash || url.href !== article.url ||
      ![`${prefix}${article.slug}`, `${prefix}${article.slug}/`].includes(url.pathname)) {
    fail('Article URL must be an exact HTTPS article path on an owned site');
  }
  return url.href;
}

function safeDocsLink(target) {
  if (!/^docs\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(target)) return false;
  const file = path.join(REPO, target);
  try {
    // Do not admit missing files, directories or symlinks that escape the repository.
    const docsRoot = path.join(fs.realpathSync(REPO), 'docs');
    if (!fs.statSync(file).isFile() || path.dirname(fs.realpathSync(file)) !== docsRoot) return false;
    // An ignored or untracked local file will not exist on GitHub after the push.
    return run(['ls-files', '--error-unmatch', '--', target]).split('\n').includes(target);
  } catch { return false; }
}

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
  a.publishedUrl = articleUrl(a);
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
  if (previewLines[i].trim()) {
    if (previewLines[i].trim() === NOTE) continue;
    const entry = /^- \d{4}-\d{2}-\d{2} \[[^\r\n]+\]\((https?:\/\/[^\s)]+|docs\/[^\s)]+)\)$/.exec(previewLines[i].trim());
    if (!entry || (entry[1].startsWith('docs/') && !safeDocsLink(entry[1]))) {
      fail('Latest-updates section contains non-entry text or an unsafe docs link; preserve and review it manually');
    }
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
const newLines = articles.map(a => `- ${date} [${a.title}](${a.publishedUrl})`);
let overflow = [];

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
  const urls = articles.map(a => `](${a.publishedUrl})`);
  const all = [...newLines, ...old.filter(l => !urls.some(url => l.includes(url)))];
  const merged = all.slice(0, MAX_ENTRIES);
  overflow = all.slice(MAX_ENTRIES);
  lines.splice(start, end - start, SECTION, '', ...merged, '', NOTE, '');
  readme = lines.join('\n');
}

// 2b. 溢出条目归档到 CHANGELOG.md，不丢弃
if (overflow.length) {
  let log;
  try { log = fs.readFileSync(CHANGELOG, 'utf8'); }
  catch { fail('Cannot read CHANGELOG.md; archive target must exist before syncing'); }
  const logLines = log.split('\n');
  const firstEntry = logLines.findIndex(l => /^- \d{4}-\d{2}-\d{2} /.test(l.trim()));
  if (firstEntry === -1) fail('CHANGELOG.md has no existing entry anchor; inspect it manually');
  const already = new Set(logLines.map(l => l.trim()));
  const add = overflow.filter(l => !already.has(l.trim()));
  if (add.length) {
    logLines.splice(firstEntry, 0, ...add);
    const next = logLines.join('\n');
    if (next !== log) {
      changed.push('CHANGELOG.md');
      if (!dryRun) fs.writeFileSync(CHANGELOG, next);
      console.log('[sync] CHANGELOG.md 已归档 ' + add.length + ' 条溢出条目');
    }
  }
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
