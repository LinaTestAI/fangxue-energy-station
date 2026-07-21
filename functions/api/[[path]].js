/**
 * Cloudflare Pages Function（catch-all）
 *
 * 捕获所有 /api/* 请求。
 * Cloudflare Pages Functions 使用 Fetch API 风格（Request → Response），
 * 与 Vercel 的 Node.js req/res 不同，需适配 Workers 运行时。
 *
 * 静态资源（public/）由 Cloudflare CDN 直接托管，不经过此函数。
 */

/* ============ 内存数据（单实例内有效） ============ */
const DB =
  globalThis.__fx_db ||
  (globalThis.__fx_db = {
    tokens: {},
    homework: {},
    history: {},
    settings: {},
  });

// 预置示例历史
if (!DB.history['openid_demo']) {
  DB.history['openid_demo'] = [
    { id: 201, subj: '数学', title: '计算每日一练', min: 15 },
    { id: 202, subj: '语文', title: '阅读理解一篇', min: 20 },
    { id: 203, subj: '英语', title: '朗读课文 Unit2', min: 10 },
  ];
}

/* ============ 工具函数 ============ */

/** SHA-1 哈希（使用 Web Crypto API，兼容 Cloudflare Workers 运行时） */
async function hash(s) {
  const buf = await crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(s)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

async function issueToken(openid) {
  return await hash(openid + ':' + Date.now());
}

/** 解析 cookie 字符串为对象 */
function parseCookies(cookieStr) {
  const out = {};
  if (!cookieStr) return out;
  cookieStr.split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > -1)
      out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

function openidFromToken(token) {
  return DB.tokens[token] ? DB.tokens[token].openid : null;
}

/** code -> openid：真实环境应请求微信接口换取 */
async function exchangeCode(code) {
  if (!USE_MOCK) {
    // 真实环境请求微信接口：
    // const r = await fetch(`https://api.weixin.qq.com/sns/oauth2/...`);
    // return (await r.json()).openid;
  }
  return 'openid_' + (await hash(code));
}

/** 构建 JSON 响应 */
function jsonRes(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

/** 读取 POST body */
async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

/* ============ 主入口（Cloudflare Pages Function 标准签名） ============ */
export async function onRequest(context) {
  const { request, env } = context;

  // 微信配置（从 Cloudflare 环境变量读取，不使用 Node.js 的 process）
  const WECHAT = {
    appId: (env && env.WX_APPID) || 'YOUR_APPID',
    appSecret: (env && env.WX_SECRET) || 'YOUR_SECRET',
  };
  const USE_MOCK = WECHAT.appId === 'YOUR_APPID';

  const url = new URL(request.url);
  const p = url.pathname;

  // 从 request 获取 cookie
  const cookies = parseCookies(request.headers.get('cookie') || '');
  const token = cookies.fx_token;

  function openid() {
    return openidFromToken(token);
  }

  // ── 1. 发起微信网页授权 ──
  if (p === '/api/wechat/auth') {
    let cb =
      url.searchParams.get('redirect_uri') ||
      `${url.origin}/api/wechat/callback`;
    if (USE_MOCK) {
      cb += `?code=mock_${await hash(String(Date.now()))}`;
      return new Response(null, { status: 302, headers: { Location: cb } });
    }
    const wxUrl =
      `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${
        WECHAT.appId
      }&redirect_uri=${encodeURIComponent(
        cb
      )}&response_type=code&scope=snsapi_base&state=fx#wechat_redirect`;
    return new Response(null, { status: 302, headers: { Location: wxUrl } });
  }

  // ── 2. 微信授权回调：code -> openid -> token cookie -> 回首页 ──
  if (p === '/api/wechat/callback') {
    const code = url.searchParams.get('code');
    if (!code) return jsonRes({ error: 'missing code' }, 400);

    const oid = await exchangeCode(code);
    const t = await issueToken(oid);
    DB.tokens[t] = { openid: oid };
    if (!DB.homework[oid]) DB.homework[oid] = [];
    if (!DB.history[oid])
      DB.history[oid] =
        oid === 'openid_demo' ? DB.history['openid_demo'] || [] : [];
    if (!DB.settings[oid]) DB.settings[oid] = null;

    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': `fx_token=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
      },
    });
  }

  // ── 3. 模拟登录（调试 / 演示用，支持 uid 切换账号）──
  if (p === '/api/wechat/mock-login' && request.method === 'POST') {
    const body = await readBody(request);
    const uid = body && body.uid;
    const oid = uid
      ? 'openid_' + (await hash(String(uid)))
      : 'openid_demo';
    const t = await issueToken(oid);
    DB.tokens[t] = { openid: oid };
    if (!DB.homework[oid]) DB.homework[oid] = [];
    if (!DB.history[oid])
      DB.history[oid] =
        oid === 'openid_demo' ? DB.history['openid_demo'] || [] : [];
    if (!DB.settings[oid]) DB.settings[oid] = null;

    return jsonRes({ token: t, openid: oid }, 200, {
      'Set-Cookie': `fx_token=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
    });
  }

  // ── 4. 当前用户 ──
  if (p === '/api/user') {
    const oid = openid();
    if (!oid) return jsonRes({ error: 'unauthorized' }, 401);
    return jsonRes({ openid: oid, nickname: '同学' });
  }

  // ── 5. 作业读写 ──
  if (p === '/api/homework') {
    const oid = openid();
    if (!oid) return jsonRes({ error: 'unauthorized' }, 401);
    if (request.method === 'GET') return jsonRes(DB.homework[oid] || []);
    if (request.method === 'POST') {
      const body = await readBody(request);
      DB.homework[oid] = Array.isArray(body) ? body : [];
      return jsonRes(DB.homework[oid]);
    }
  }

  // ── 6. 历史记录读写 ──
  if (p === '/api/history') {
    const oid = openid();
    if (!oid) return jsonRes({ error: 'unauthorized' }, 401);
    if (request.method === 'GET') return jsonRes(DB.history[oid] || []);
    if (request.method === 'POST') {
      const body = await readBody(request);
      DB.history[oid] = Array.isArray(body) ? body : [];
      return jsonRes(DB.history[oid]);
    }
  }

  // ── 7. 设置读写 ──
  if (p === '/api/settings') {
    const oid = openid();
    if (!oid) return jsonRes({ error: 'unauthorized' }, 401);
    if (request.method === 'GET')
      return jsonRes(DB.settings[oid] || null);
    if (request.method === 'POST') {
      const body = await readBody(request);
      DB.settings[oid] = body || {};
      return jsonRes(DB.settings[oid]);
    }
  }

  // 兜底 404
  return jsonRes({ error: 'not found' }, 404);
}
