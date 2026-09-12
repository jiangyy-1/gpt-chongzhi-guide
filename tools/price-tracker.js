#!/usr/bin/env node
/**
 * price-tracker.js — 抓取各 AI 订阅充值平台的公开价格页，输出结构化价格快照
 *
 * 用法：node tools/price-tracker.js
 * 产物：data/prices.json（机器可读）、data/prices.md（README 引用的对照表）
 *
 * 只抓公开页面上写明的人民币价格，不登录、不下单、不绕过任何防护；
 * 抓不到的档位记为 null，不做猜测。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const SOURCES = [
  { name: 'gptpro20x.com', url: 'https://gptpro20x.com/chatgpt/' },
  { name: 'gptpro5x.com', url: 'https://gptpro5x.com/' },
  { name: 'gptcz.pro', url: 'https://gptcz.pro/plus' },
  { name: 'aichongzhi.org', url: 'https://aichongzhi.org/' },
  { name: 'getgpt.pro', url: 'https://getgpt.pro/plus-price' },
  { name: 'payforchat.com', url: 'https://www.payforchat.com/' },
];

// 档位 → 在页面文本里的识别模式（按出现顺序取第一个紧随其后的人民币价格）
const TIERS = [
  { key: 'go', label: 'GO', re: /ChatGPT\s*GO\b|\bGO\s*(档|套餐|会员)/g },
  { key: 'plus', label: 'Plus', re: /ChatGPT\s*Plus|\bPlus\b(?!\s*\/)/g },
  { key: 'pro5x', label: 'Pro 5X', re: /Pro\s*5\s*[xX×]/g },
  { key: 'pro20x', label: 'Pro 20X', re: /Pro\s*20\s*[xX×]/g },
];
const PRICE_RE = /[¥￥]\s?(\d{2,4})(?:\.\d+)?/;

function fetchText(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; price-tracker/1.0)' },
      timeout: 20000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchText(new URL(res.headers.location, url).href));
      }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

function extractPrices(text) {
  const out = {};
  for (const tier of TIERS) {
    out[tier.key] = null;
    tier.re.lastIndex = 0;
    let m;
    // 遍历该档位名的每一次出现，取第一个在其后 45 字符内紧跟价格的；
    // 窗口内若先出现了别的档位名则跳过，避免串价
    while ((m = tier.re.exec(text))) {
      const window = text.slice(m.index + m[0].length, m.index + m[0].length + 45);
      const other = TIERS.some((t) => t !== tier && new RegExp(t.re.source).test(window.split(/[¥￥]/)[0]));
      const p = PRICE_RE.exec(window);
      if (p && !other) { out[tier.key] = Number(p[1]); break; }
    }
  }
  return out;
}

async function main() {
  const snapshot = { collectedAt: new Date().toISOString().slice(0, 10), platforms: [] };
  for (const src of SOURCES) {
    const html = await fetchText(src.url);
    const prices = html ? extractPrices(stripHtml(html)) : Object.fromEntries(TIERS.map((t) => [t.key, null]));
    snapshot.platforms.push({ name: src.name, source: src.url, ...prices });
    console.log(`${src.name}: ${TIERS.map((t) => `${t.label}=${prices[t.key] ?? '-'}`).join(' ')}`);
  }

  const dataDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'prices.json'), JSON.stringify(snapshot, null, 2));

  const header = `| 平台 | ${TIERS.map((t) => t.label).join(' | ')} | 来源 |`;
  const sep = `|---|${TIERS.map(() => '---').join('|')}|---|`;
  const rows = snapshot.platforms.map((p) =>
    `| ${p.name} | ${TIERS.map((t) => (p[t.key] == null ? '—' : `¥${p[t.key]}`)).join(' | ')} | [页面](${p.source}) |`
  );
  fs.writeFileSync(
    path.join(dataDir, 'prices.md'),
    `<!-- 由 tools/price-tracker.js 自动生成，采集日 ${snapshot.collectedAt}；单位：人民币/月 -->\n${[header, sep, ...rows].join('\n')}\n`
  );
  console.log(`written data/prices.json + data/prices.md (${snapshot.collectedAt})`);
}

main();
