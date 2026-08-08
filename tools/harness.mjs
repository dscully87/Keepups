import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const IPHONE_VIEWPORT = { width: 390, height: 844 };

export async function openGame({ headless = true, viewport = IPHONE_VIEWPORT } = {}) {
  const server = await startServer(0);
  const browser = await chromium.launch({
    headless,
    args: [
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(`${server.url}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__KICKUP__, null, { timeout: 20000 });

  return {
    page,
    errors,
    async close() {
      await browser.close();
      server.close();
    },
  };
}

const results = [];

export function check(name, passed, detail = '') {
  results.push({ name, passed: !!passed, detail });
  const mark = passed ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? `  — ${detail}` : ''}`);
  return !!passed;
}

export function report(phase) {
  const failed = results.filter((r) => !r.passed);
  console.log('');
  if (failed.length === 0) {
    console.log(`GATE ${phase}: PASS (${results.length}/${results.length})`);
    return 0;
  }
  console.log(`GATE ${phase}: FAIL (${results.length - failed.length}/${results.length})`);
  for (const f of failed) console.log(`   failed: ${f.name} ${f.detail}`);
  return 1;
}

/** Waits n animation frames inside the page. */
export async function frames(page, n = 1) {
  await page.evaluate(
    (count) =>
      new Promise((resolve) => {
        let i = 0;
        const tick = () => (++i >= count ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );
}
