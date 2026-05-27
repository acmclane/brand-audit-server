const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Brand Audit Server is running' });
});

// Main scrape endpoint
app.post('/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();

    // Set a real browser user agent so sites don't block us
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Set viewport
    await page.setViewport({ width: 1440, height: 900 });

    // Navigate to URL, wait for the page to fully load
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // If there's an HCP wall or cookie banner, try to click through it
    await clickThroughWalls(page);

    // Wait a moment for any animations/lazy loads
    await new Promise(r => setTimeout(r, 2000));

    // Extract all brand data from the rendered page
    const brandData = await page.evaluate(() => {
      const results = {
        title: document.title,
        metaDescription: document.querySelector('meta[name="description"]')?.content || '',
        colors: [],
        fonts: [],
        images: []
      };

      // ── COLORS ──
      // Walk every element and collect computed background-color and color
      const colorMap = {};
      const allElements = document.querySelectorAll('*');

      allElements.forEach(el => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const area = rect.width * rect.height;

        const collectColor = (colorStr) => {
          if (!colorStr) return;
          const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
          if (!match) return;
          const r = parseInt(match[1]), g = parseInt(match[2]), b = parseInt(match[3]);
          // Skip pure white and pure black and transparent
          if ((r > 248 && g > 248 && b > 248)) return;
          if ((r < 8 && g < 8 && b < 8)) return;
          const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
          colorMap[hex] = (colorMap[hex] || 0) + Math.max(area, 1);
        };

        collectColor(style.backgroundColor);
        collectColor(style.color);
        collectColor(style.borderColor);
      });

      // Also scan inline SVG fill/stroke attributes
      document.querySelectorAll('[fill],[stroke]').forEach(el => {
        ['fill', 'stroke'].forEach(attr => {
          const val = el.getAttribute(attr);
          if (val && val.startsWith('#') && val.length >= 4) {
            let hex = val;
            if (hex.length === 4) {
              hex = '#' + hex[1]+hex[1]+hex[2]+hex[2]+hex[3]+hex[3];
            }
            colorMap[hex] = (colorMap[hex] || 0) + 500;
          }
        });
      });

      // Sort by area weight and return top colors
      const sortedColors = Object.entries(colorMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12);

      const totalArea = sortedColors.reduce((s, [, v]) => s + v, 0);
      results.colors = sortedColors.map(([hex, area]) => ({
        hex,
        dominance: Math.round((area / totalArea) * 100) / 100
      }));

      // ── FONTS ──
      const fontSet = new Set();
      allElements.forEach(el => {
        const ff = window.getComputedStyle(el).fontFamily;
        if (ff) {
          ff.split(',').forEach(f => {
            const clean = f.trim().replace(/['"]/g, '');
            if (
              clean &&
              !['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', '-apple-system', 'BlinkMacSystemFont'].includes(clean)
            ) {
              fontSet.add(clean);
            }
          });
        }
      });
      results.fonts = [...fontSet].slice(0, 6);

      // ── IMAGES ──
      const imgs = [...document.querySelectorAll('img')]
        .filter(img => img.naturalWidth > 80 && img.naturalHeight > 80)
        .slice(0, 8)
        .map(img => img.src);
      results.images = imgs;

      return results;
    });

    await browser.close();

    res.json({
      success: true,
      url,
      title: brandData.title,
      metaDescription: brandData.metaDescription,
      colors: brandData.colors,
      fonts: brandData.fonts,
      images: brandData.images
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Scrape error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Try to click through common walls: cookie banners, HCP gates, age gates
async function clickThroughWalls(page) {
  const clickTargets = [
    // HCP confirmation buttons
    'button[class*="hcp"]',
    'button[class*="confirm"]',
    'button[class*="agree"]',
    'a[class*="hcp"]',
    // Cookie banners
    'button[id*="accept"]',
    'button[class*="accept"]',
    'button[id*="cookie"]',
    '#onetrust-accept-btn-handler',
    '.onetrust-accept-btn-handler',
    'button[aria-label*="accept"]',
    // Age gates
    'button[class*="age"]',
    'input[value="Yes"]',
  ];

  // Also look for buttons with relevant text
  const textPhrases = [
    'i am a healthcare', 'hcp', 'confirm', 'i agree', 'accept all',
    'accept cookies', 'yes, i am', 'continue', 'i understand', 'acknowledge'
  ];

  for (const selector of clickTargets) {
    try {
      const el = await page.$(selector);
      if (el) {
        await el.click();
        await new Promise(r => setTimeout(r, 1000));
        return;
      }
    } catch (e) {}
  }

  // Text-based search for confirmation buttons
  try {
    const buttons = await page.$$('button, a[role="button"], input[type="button"], input[type="submit"]');
    for (const btn of buttons) {
      const text = await page.evaluate(el => el.textContent?.toLowerCase() || '', btn);
      if (textPhrases.some(phrase => text.includes(phrase))) {
        await btn.click();
        await new Promise(r => setTimeout(r, 1000));
        return;
      }
    }
  } catch (e) {}
}

app.listen(PORT, () => {
  console.log(`Brand Audit Server running on port ${PORT}`);
});
