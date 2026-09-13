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
const { execSync } = require('child_process');

const SITE = 'https://gptpro20x.com';
const REPO = path.join(__dirname, '..');
const README = path.join(REPO, 'README.md');
const SECTION = '## 📰 最新更新';
const MAX_ENTRIES = 10;

function fail(msg) { console.error('[sync] ' + msg); process.exit(1); }

const manifestPath = process.argv[2];
if (!manifestPath) fail('用法: node tools/sync.js <manifest.json>');
const { date, articles } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) fail('manifest.date 需为 YYYY-MM-DD');
if (!Array.isArray(articles) || !articles.length) fail('manifest.articles 为空');

// 1. 保存 md 副本
const articlesDir = path.join(REPO, 'articles');
fs.mkdirSync(articlesDir, { recursive: true });
for (const a of articles) {
  if (!a.mdPath || !a.slug || !a.title) fail('article 需含 mdPath/slug/title');
  const dest = path.join(articlesDir, `${date}-${a.slug}.md`);
  fs.copyFileSync(a.mdPath, dest);
  console.log('[sync] 已保存 ' + path.relative(REPO, dest));
}

// 2. 更新 README「最新更新」板块
let readme = fs.readFileSync(README, 'utf8');
const newLines = articles.map(a => `- ${date} [${a.title}](${SITE}/blog/${a.slug}/)`);

if (readme.includes(SECTION)) {
  const lines = readme.split('\n');
  const start = lines.findIndex(l => l.trim() === SECTION);
  // 收集板块内已有条目(到下一个 ## 标题为止)
  let end = start + 1;
  const old = [];
  while (end < lines.length && !/^## /.test(lines[end])) {
    if (/^- \d{4}-\d{2}-\d{2} /.test(lines[end].trim())) old.push(lines[end].trim());
    end++;
  }
  const merged = [...newLines, ...old.filter(l => !newLines.includes(l))].slice(0, MAX_ENTRIES);
  lines.splice(start, end - start, SECTION, '', ...merged, '');
  readme = lines.join('\n');
} else {
  // 板块不存在: 插到「## 目录」前
  const anchor = '## 目录';
  const block = `${SECTION}\n\n${newLines.join('\n')}\n\n`;
  readme = readme.includes(anchor) ? readme.replace(anchor, block + anchor) : readme + '\n' + block;
}
fs.writeFileSync(README, readme);
console.log('[sync] README 最新更新板块已写入 ' + newLines.length + ' 条');

// 3. git 提交推送
const run = cmd => execSync(cmd, { cwd: REPO, stdio: 'pipe' }).toString().trim();
run('git add .');
try {
  run(`git -c user.name=gptpro20x -c user.email=support@gptpro20x.com commit -m "Auto-update: ${date}"`);
} catch (e) {
  const out = (e.stdout || '').toString();
  if (out.includes('nothing to commit')) { console.log('[sync] 无变更, 跳过提交'); process.exit(0); }
  throw e;
}
run('git push');
console.log('[sync] 已推送: Auto-update: ' + date);
