/**
 * 央视频 API 深度探测 - 追踪 JavaScript SDK 里的真实 API 端点
 */
const https = require('https');

function get(url, ref, extraHeaders = {}) {
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
        ...extraHeaders,
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

function getJson(url, ref) {
  return get(url, ref, {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
  });
}

async function main() {
  // 1. 分析 cctvh5-openapi SDK 查找真实 API 域名
  console.log('=== 1. 分析 CCTV H5 OpenAPI SDK ===');
  try {
    const sdk = await get('https://s.yangshipin.cn/CCTVVideo/cctvh5-openapi/cctvh5-openapi.min.js?ver=24722');
    console.log('SDK Status:', sdk.status, 'Length:', sdk.body.length);
    
    // 搜索 API 域名/端点
    const apiUrls = sdk.body.match(/https?:\/\/[a-zA-Z0-9._-]+\.(?:cntv|yangshipin|y\.shpin)\.(?:cn|com)[^"')\s,]*/gi);
    if (apiUrls) {
      const unique = [...new Set(apiUrls)];
      console.log('SDK 中的 API URLs:', unique.slice(0, 30));
    }

    // 搜索 api 路径
    const apiPaths = sdk.body.match(/["'`](\/api\/[^"'`]+)["'`]/gi);
    if (apiPaths) {
      const unique = [...new Set(apiPaths.map(p => p.replace(/["'`]/g, '')))];
      console.log('SDK 中的 API 路径:', unique.slice(0, 30));
    }
  } catch (e) {
    console.log('SDK fetch error:', e.message);
  }

  console.log('');

  // 2. 尝试 yangshipin APIs (带 JSON Accept)
  console.log('=== 2. 尝试 JSON API ===');
  const jsonApis = [
    'https://www.yangshipin.cn/api/v1/live/list',
    'https://www.yangshipin.cn/api/v1/tv/channel_list',
    'https://www.yangshipin.cn/api/v1/channel/list',
  ];
  for (const api of jsonApis) {
    try {
      const r = await getJson(api);
      console.log(`  ${api}: HTTP ${r.status}, Length ${r.body.length}`);
      if (r.body.length < 5000 && r.body.length > 10) {
        console.log('    Body:', r.body.substring(0, 800));
      }
    } catch (e) {
      console.log(`  ${api}: ERROR - ${e.message}`);
    }
  }

  console.log('');

  // 3. 尝试 m.yangshipin.cn (移动端API)
  console.log('=== 3. 移动端 API ===');
  const mobileApis = [
    'https://m.yangshipin.cn/api/v1/live/list',
    'https://m.yangshipin.cn/api/v1/tv/channel_list',
    'https://m.yangshipin.cn/static/api/v1/live/list',
  ];
  for (const api of mobileApis) {
    try {
      const r = await getJson(api);
      console.log(`  ${api}: HTTP ${r.status}, Length ${r.body.length}`);
      if (r.body.length < 5000 && r.body.length > 10) {
        console.log('    Body:', r.body.substring(0, 800));
      }
    } catch (e) {
      console.log(`  ${api}: ERROR - ${e.message}`);
    }
  }

  console.log('');

  // 4. 尝试 CNTV/央视频 底层API域名
  console.log('=== 4. CNTV 底层 API ===');
  const cntvApis = [
    'https://api.cntv.cn/NewLive/getLiveStream?pid=CCTV1',
    'https://api.cntv.cn/video/videoinfoByGuid?serviceId=tvcctv&guid=CCTV1',
    'https://vdn.apps.cntv.cn/api/getLiveSource?pid=CCTV1',
    'https://vdnad.apps.cntv.cn/api/getHttpStream?pid=CCTV1',
    // 央视频特有域名
    'https://y.shpin.com.cn/api/live/list',
    'https://api.yangshipin.cn/api/v1/live/list',
  ];
  for (const api of cntvApis) {
    try {
      const r = await get(api, 'https://www.yangshipin.cn/tv/home');
      console.log(`  ${api}: HTTP ${r.status}, Length ${r.body.length}`);
      if (r.body.length < 3000 && r.body.length > 10) {
        console.log('    Body:', r.body.substring(0, 500));
      }
    } catch (e) {
      console.log(`  ${api}: ERROR - ${e.message}`);
    }
  }

  console.log('');

  // 5. 分析主页 player/vr/index.js 找直播数据加载逻辑
  console.log('=== 5. 播放器 JS ===');
  try {
    const playerJs = await get('https://m.yangshipin.cn/static/project/test/player/vr/index.js?t=210');
    console.log('Player JS Status:', playerJs.status, 'Length:', playerJs.body.length);
    
    // 搜索 key API 调用模式
    const liveApiPatterns = playerJs.body.match(/["'`](https?:\/\/[^"'`]*?(?:live|stream|pid|channel)[^"'`]*)["'`]/gi);
    if (liveApiPatterns) {
      const unique = [...new Set(liveApiPatterns.map(p => p.replace(/["'`]/g, '')))];
      console.log('Player 中的直播相关URL:', unique.slice(0, 20));
    }

    const apiPaths2 = playerJs.body.match(/["'`](\/[^"'`]*(?:api|live|stream|pid)[^"'`]*)["'`]/gi);
    if (apiPaths2) {
      const unique = [...new Set(apiPaths2.map(p => p.replace(/["'`]/g, '')))];
      console.log('Player 中的API路径:', unique.slice(0, 20));
    }
  } catch (e) {
    console.log('Player JS error:', e.message);
  }

  console.log('');

  // 6. 尝试 yangshipin.cn 的 GraphQL 或者新版API
  console.log('=== 6. 新版API尝试 ===');
  const newApis = [
    'https://www.yangshipin.cn/api/v1/page?url=/tv/home',
    'https://www.yangshipin.cn/api/ssr/tv/home',
    'https://www.yangshipin.cn/_api/tv/home',
  ];
  for (const api of newApis) {
    try {
      const r = await getJson(api);
      console.log(`  ${api}: HTTP ${r.status}, Length ${r.body.length}`);
      if (r.body.length < 5000 && r.body.length > 10) {
        console.log('    Body:', r.body.substring(0, 800));
      }
    } catch (e) {
      console.log(`  ${api}: ERROR - ${e.message}`);
    }
  }
}

main().catch(console.error);