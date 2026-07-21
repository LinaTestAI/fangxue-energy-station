/**
 * Cloudflare Pages Function（catch-all）
 *
 * 捕获所有 /api/* 请求。
 * 使用 Fetch API 风格（Request → Response），适配 Workers 运行时。
 * 静态资源（public/）由 Cloudflare CDN 直接托管，不经过此函数。
 *
 * 关键设计（适配 Serverless 多实例）：
 *  1. Token 自包含：openid 经 HMAC 签名后编码进 token，
 *     不依赖服务端内存会话表，任意实例均可独立校验 → 不会登录死循环。
 *  2. 用户数据持久化：若绑定了 KV 命名空间（env.FX_KV），按 openid 存 KV；
 *     未绑定时回退到内存（演示用，冷启动清空）。
 */

/* ============ 常量 / 密钥 ============ */
const SECRET = 'fx-station-demo-secret'; // 生产可改为 env.JWT_SECRET

/* ============ HMAC 密钥（缓存到 globalThis，避免重复 import） ============ */
async function getKey() {
  if (!globalThis.__fx_key) {
    globalThis.__fx_key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify']
    );
  }
  return globalThis.__fx_key;
}

function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 生成自包含 token：b64url(openid).HMAC(openid) */
async function makeToken(openid) {
  const key = await getKey();
  const payload = b64url(new TextEncoder().encode(openid));
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return payload + '.' + b64url(sig);
}

/** 校验 token，返回 openid 或 null */
async function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const key = await getKey();
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    b64urlDecode(sig),
    new TextEncoder().encode(payload)
  );
  if (!ok) return null;
  try {
    return new TextDecoder().decode(b64urlDecode(payload));
  } catch {
    return null;
  }
}

/* ============ 用户数据存储（KV 优先，内存兜底） ============ */
const MEM = globalThis.__fx_mem || (globalThis.__fx_mem = {});

const SEED_HISTORY = [
  { id: 201, subj: '数学', title: '计算每日一练', min: 15 },
  { id: 202, subj: '语文', title: '阅读理解一篇', min: 20 },
  { id: 203, subj: '英语', title: '朗读课文 Unit2', min: 10 },
];

async function loadUser(openid, kv) {
  if (kv) {
    const raw = await kv.get('u:' + openid);
    if (raw) return JSON.parse(raw);
  }
  if (MEM[openid]) return MEM[openid];
  const fresh = {
    homework: [],
    history: openid === 'openid_demo' ? SEED_HISTORY : [],
    settings: null,
  };
  MEM[openid] = fresh;
  return fresh;
}

async function saveUser(openid, data, kv) {
  MEM[openid] = data;
  if (kv) await kv.put('u:' + openid, JSON.stringify(data));
}

/* ============ 工具函数 ============ */
function parseCookies(cookieStr) {
  const out = {};
  if (!cookieStr) return out;
  cookieStr.split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > -1) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

function jsonRes(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function cookieHeader(token) {
  return `fx_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
}

/* ============ 主入口 ============ */
export async function onRequest(context) {
  const { request, env } = context;
  const kv = env && env.FX_KV ? env.FX_KV : null;

  // 微信配置（不使用 Node.js 的 process）
  const WECHAT = {
    appId: (env && env.WX_APPID) || 'YOUR_APPID',
    appSecret: (env && env.WX_SECRET) || 'YOUR_SECRET',
  };
  const USE_MOCK = WECHAT.appId === 'YOUR_APPID';

  const url = new URL(request.url);
  const p = url.pathname;

  const cookies = parseCookies(request.headers.get('cookie') || '');
  const openid = await verifyToken(cookies.fx_token); // 自包含校验，无需服务端会话表

  // ── 1. 发起微信网页授权 ──
  if (p === '/api/wechat/auth') {
    let cb = url.searchParams.get('redirect_uri') || `${url.origin}/api/wechat/callback`;
    if (USE_MOCK) {
      cb += `?code=mock_${b64url(new TextEncoder().encode(String(Date.now())))}`;
      return new Response(null, { status: 302, headers: { Location: cb } });
    }
    const wxUrl =
      `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${
        WECHAT.appId
      }&redirect_uri=${encodeURIComponent(cb)}&response_type=code&scope=snsapi_base&state=fx#wechat_redirect`;
    return new Response(null, { status: 302, headers: { Location: wxUrl } });
  }

  // ── 2. 微信授权回调：code -> openid -> token cookie -> 回首页 ──
  if (p === '/api/wechat/callback') {
    const code = url.searchParams.get('code');
    if (!code) return jsonRes({ error: 'missing code' }, 400);
    // 真实环境应请求微信换取 openid；此处用 code 派生稳定 openid
    const oid = 'openid_' + b64url(new TextEncoder().encode(code)).slice(0, 12);
    const t = await makeToken(oid);
    return new Response(null, {
      status: 302,
      headers: { Location: '/', 'Set-Cookie': cookieHeader(t) },
    });
  }

  // ── 3. 模拟登录（调试/演示，支持 uid 切换账号）──
  if (p === '/api/wechat/mock-login' && request.method === 'POST') {
    const body = await readBody(request);
    const uid = body && body.uid;
    const oid = uid ? 'openid_' + b64url(new TextEncoder().encode(String(uid))).slice(0, 12) : 'openid_demo';
    const t = await makeToken(oid);
    // 预初始化用户数据（确保 KV/内存中存在）
    const u = await loadUser(oid, kv);
    await saveUser(oid, u, kv);
    return jsonRes({ token: t, openid: oid }, 200, { 'Set-Cookie': cookieHeader(t) });
  }

  // 以下接口均需登录 ──
  function needAuth() {
    if (!openid) return jsonRes({ error: 'unauthorized' }, 401);
    return null;
  }

  // ── 4. 当前用户 ──
  if (p === '/api/user') {
    const no = needAuth();
    if (no) return no;
    return jsonRes({ openid, nickname: '同学', kvBound: !!kv });
  }

  // ── 5. 作业读写 ──
  if (p === '/api/homework') {
    const no = needAuth();
    if (no) return no;
    const u = await loadUser(openid, kv);
    if (request.method === 'GET') return jsonRes(u.homework || []);
    if (request.method === 'POST') {
      const body = await readBody(request);
      u.homework = Array.isArray(body) ? body : [];
      await saveUser(openid, u, kv);
      return jsonRes(u.homework);
    }
  }

  // ── 6. 历史记录读写 ──
  if (p === '/api/history') {
    const no = needAuth();
    if (no) return no;
    const u = await loadUser(openid, kv);
    if (request.method === 'GET') return jsonRes(u.history || []);
    if (request.method === 'POST') {
      const body = await readBody(request);
      u.history = Array.isArray(body) ? body : [];
      await saveUser(openid, u, kv);
      return jsonRes(u.history);
    }
  }

  // ── 7. 设置读写 ──
  if (p === '/api/settings') {
    const no = needAuth();
    if (no) return no;
    const u = await loadUser(openid, kv);
    if (request.method === 'GET') return jsonRes(u.settings || null);
    if (request.method === 'POST') {
      const body = await readBody(request);
      u.settings = body || {};
      await saveUser(openid, u, kv);
      return jsonRes(u.settings);
    }
  }

  // 兜底 404
  return jsonRes({ error: 'not found' }, 404);
}
