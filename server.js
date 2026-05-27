const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'Brand Audit Server is running' });
});

app.post('/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--no-first-run',
        '--disable-gpu',
        '--window-size=1440,900'
      ]
    });

    const page = await browser.newPage();

    // Hide automation signals
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1440, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // Navigate
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for page to settle
    await new Promise(r => setTimeout(r, 3000));

    // Try clicking through walls multiple times
    for (let attempt = 0; attempt < 3; attempt++) {
      await clickThroughWalls(page);
      await new Promise(r => setTimeout(r, 1500));
    }

    // Wait for any post-click rendering
    await new Promise(r => setTimeout(r, 2000));

    const brandData = await page.evaluate(() => {
      const results = { title: document.title, metaDescription: '', colors: [], fonts: [], images: [] };

      results.metaDescription = document.querySelector('meta[name="description"]')?.content || '';

      // Colors
      const colorMap = {};
      document.querySelectorAll('*').forEach(el => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const area = rect.width * rect.height;

        const collectColor = (colorStr) => {
          if (!colorStr) return;
          const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          if (!match) return;
          const r = parseInt(match[1]), g = parseInt(match[2]), b = parseInt(match[3]);
          if (r > 248 && g > 248 && b > 248) return;
          if (r < 8 && g < 8 && b < 8) return;
          const hex = '#' + [r,g,b].map(x => x.toString(16).padStart(2,'0')).join('');
          colorMap[hex] = (colorMap[hex] || 0) + Math.max(area, 1);
        };

        collectColor(style.backgroundColor);
        collectColor(style.color);
        collectColor(style.borderColor);
      });

      // SVG colors
      document.querySelectorAll('[fill],[stroke]').forEach(el => {
        ['fill','stroke'].forEach(attr => {
          const val = el.getAttribute(attr);
          if (val && val.startsWith('#')) {
            let hex = val.length === 4
              ? '#' + val[1]+val[1]+val[2]+val[2]+val[3]+val[3]
              : val;
            colorMap[hex] = (colorMap[hex] || 0) + 500;
          }
        });
      });

      const sorted = Object.entries(colorMap).sort((a,b) => b[1]-a[1]).slice(0,12);
      const total = sorted.reduce((s,[,v]) => s+v, 0);
      results.colors = sorted.map(([hex, area]) => ({
        hex,
        dominance: Math.round((area/total)*100)/100
      }));

      // Fonts
      const fontSet = new Set();
      const skip = new Set(['serif','sans-serif','monospace','cursive','fantasy','system-ui','-apple-system','BlinkMacSystemFont']);
      document.querySelectorAll('*').forEach(el => {
        const ff = window.getComputedStyle(el).fontFamily;
        if (ff) ff.split(',').forEach(f => {
          const clean = f.trim().replace(/['"]/g,'');
          if (clean && !skip.has(clean)) fontSet.add(clean);
        });
      });
      results.fonts = [...fontSet].slice(0,6);

      // Images
      results.images = [...document.querySelectorAll('img')]
        .filter(img => img.naturalWidth > 80 && img.naturalHeight > 80)
        .slice(0,8).map(img => img.src);

      return results;
    });

    await browser.close();
    res.json({ success: true, url, ...brandData });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Scrape error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function clickThroughWalls(page) {
  const selectors = [
    '#onetrust-accept-btn-handler',
    '.onetrust-accept-btn-handler',
    'button[id*="accept"]',
    'button[class*="accept"]',
    'button[class*="agree"]',
    'button[class*="confirm"]',
    'button[class*="hcp"]',
    'a[class*="hcp"]',
    'button[class*="continue"]',
    '[data-testid*="accept"]',
    '[aria-label*="accept"]',
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); await new Promise(r => setTimeout(r, 800)); return; }
    } catch(e) {}
  }

  // Text-based button search
  const phrases = [
    'i am a healthcare','hcp','confirm','i agree','accept all',
    'accept cookies','yes, i am','continue','i understand',
    'acknowledge','i certify','healthcare professional','proceed'
  ];

  try {
    const buttons = await page.$$('button, a[role="button"], input[type="button"], input[type="submit"], a');
    for (const btn of buttons) {
      const text = await page.evaluate(el => el.textContent?.toLowerCase().trim() || '', btn);
      if (phrases.some(p => text.includes(p))) {
        await btn.click();
        await new Promise(r => setTimeout(r, 800));
        return;
      }
    }
  } catch(e) {}
}

app.listen(PORT, () => console.log(`Brand Audit Server running on port ${PORT}`));
