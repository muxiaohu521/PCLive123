/**
 * 央视频 API 探测脚本 — 找出正确的 API 端点和数据结构
 */
const https = require('https');

function get(url, ref) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': ref || 'https://www.yangshipin.cn/tv/home',
      },
      rejectUnauthorized: false,
      timeout: 10000,
    };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c.toString());
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function main() {
  // 1. Get full HTML
  console.log('=== 1. 获取 HTML ===');
  const r1 = await get('https://www.yangshipin.cn/tv/home');
  console.log('Status:', r1.status, 'Length:', r1.body.length);

  // Search for window.__DATA__ or similar
  const initStateMatch = r1.body.match(/window\.__INITIAL_STATE__\s*=\s*([\s\S]*?);/);
  if (initStateMatch) console.log('FOUND __INITIAL_STATE__:', initStateMatch[1].substring(0, 500));

  // Search for API paths in HTML
  const apiRefs = r1.body.match(/api\/[a-zA-Z0-9_\/]+/gi);
  if (apiRefs) console.log('API refs:', [...new Set(apiRefs)]);

  // Search for pid patterns
  const pidRefs = r1.body.match(/["']pid["']\s*:\s*["']([^"']+)["']/gi);
  if (pidRefs) console.log('PID refs:', [...new Set(pidRefs)].slice(0, 10));

  // Search for script src URLs (to find the main JS bundle)
  const scriptSrcs = r1.body.match(/<script[^>]*src=["']([^"']+)["']/gi);
  if (scriptSrcs) {
    const urls = scriptSrcs.map(s => s.match(/src=["']([^"']+)["']/)[1]);
    console.log('Script URLs:', urls);
  }

  console.log('');

  // 2. Try common yangshipin API endpoints
  console.log('=== 2. 探测 API 端点 ===');
  const apis = [
    'https://www.yangshipin.cn/api/v1/live/list',
    'https://www.yangshipin.cn/api/v1/live/channel_list',
    'https://www.yangshipin.cn/api/v1/tv/channel_list',
    'https://www.yangshipin.cn/api/v1/channel/list',
    'https://www.yangshipin.cn/api/v2/live/list',
    'https://www.yangshipin.cn/api/live/list',
    'https://www.yangshipin.cn/api/v1/live/category_list',
  ];

  for (const api of apis) {
    try {
      const r = await get(api, 'https://www.yangshipin.cn/tv/home');
      console.log(`  ${api}: HTTP ${r.status}, Body length ${r.body.length}`);
      if (r.body.length > 50 && r.body.length < 5000) {
        console.log('    Body:', r.body.substring(0, 500));
      }
    } catch (e) {
      console.log(`  ${api}: ERROR - ${e.message}`);
    }
  }

  console.log('');

  // 3. Try CCTV API with test pid
  console.log('=== 3. 探测 CCTV API (央视频底层可能复用) ===');
  const testPids = ['CCTV1', 'cctv1', 'cctv1hd'];
  for (const pid of testPids) {
    const cctvApi = `https://vdnad.apps.cntv.cn/api/getHttpStream?pid=${pid}`;
    try {
      const r = await get(cctvApi);
      console.log(`  ${cctvApi}: HTTP ${r.status}, Body ${r.body.substring(0, 300)}`);
    } catch (e) {
      console.log(`  ${cctvApi}: ERROR - ${e.message}`);
    }
  }
}

main().catch(console.error);