/**
 * Vercel Serverless Function（catch-all）
 *
 * 捕获所有 /api/* 请求。
 * 注意：Vercel 函数打包范围仅限 api/ 目录内文件，
 *       因此本文件必须自包含，不能 require 外部模块。
 * 静态资源（public/）由 Vercel CDN 直接托管，不经过此函数。
 *
 * 本地开发仍使用 server/router.js + server/mock-server.js（两者保持逻辑同步）。
 */
const crypto = require('crypto');

/* ============ 微信配置（占位，部署时替换） ============ */
const WECHAT = {
  appId: process.env.WX_APPID || 'YOUR_APPID',
  appSecret: process.env.WX_SECRET || 'YOUR_SECRET',
};
const USE_MOCK = WECHAT.appId === 'YOUR_APPID';

/* ============ 内存数据（Vercel 单实例内有效，冷启动清空） ============ */
const db =
  global.fx_db ||
  (global.fx_db = { tokens: {}, homework: {}, history: {}, settings: {} });
if (!db.history['openid_demo']) {
  db.history['openid_demo'] = [
    { id: 201, subj: '数学', title: '计算每日一练', min: 15 },
    { id: 202, subj: '语文', title: '阅读理解一篇', min: 20 },
    { id: 203, subj: '英语', title: '朗读课文 Unit2', min: 10 },
  ];
}

/* ============ 自包含 Token（HMAC 签名，避免 Serverless 内存会话不共享） ============ */
const SECRET = process.env.JWT_SECRET || 'fx-station-demo-secret';
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const b64urlDecode = (s) => Buffer.from(s, 'base64url');

function makeToken(openid) {
  const payload = b64url(Buffer.from(openid));
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest();
  return payload + '.' + b64url(sig);
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest();
  const got = b64urlDecode(sig);
  if (got.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(got, expected)) return null;
  try {
    return Buffer.from(b64urlDecode(payload)).toString('utf8');
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > -1)
      out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

function openidFromReq(req) {
  return verifyToken(parseCookies(req).fx_token);
}

// 由 code/uid 派生稳定的短 openid
const shortId = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

function exchangeCode(code) {
  if (!USE_MOCK) {
    // 真实环境应请求微信接口：
    // const url = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${WECHAT.appId}&secret=${WECHAT.appSecret}&code=${code}&grant_type=authorization_code`;
    // ... fetch -> json -> return j.openid;
  }
  return 'openid_' + shortId(code);
}

function sendJson(res, code, obj, extraHeaders = {}) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/* ============ 路由处理 ============ */
async function handle(req, res) {
  // Vercel 函数中 host 可能缺失，防御性兜底
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url, `http://${host}`);
  const p = url.pathname;

  // 1) 发起微信网页授权
  if (p === '/api/wechat/auth') {
    const cb =
      url.searchParams.get('redirect_uri') ||
      (req.headers.origin || '') + '/api/wechat/callback';
    if (USE_MOCK) {
      return (
        res.writeHead(302, {
          Location: `${cb}?code=mock_${shortId(String(Date.now()))}`,
        }), res.end()
      );
    }
    const wxUrl =
      `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${
        WECHAT.appId
      }&redirect_uri=${encodeURIComponent(
        cb
      )}&response_type=code&scope=snsapi_base&state=fx#wechat_redirect`;
    return res.writeHead(302, { Location: wxUrl }), res.end();
  }

  // 2) 微信授权回调：code -> openid -> token cookie -> 回首页
  if (p === '/api/wechat/callback') {
    const code = url.searchParams.get('code');
    if (!code) return sendJson(res, 400, { error: 'missing code' });
    const openid = exchangeCode(code);
    const token = makeToken(openid);
    if (!db.homework[openid]) db.homework[openid] = [];
    if (!db.history[openid])
      db.history[openid] =
        openid === 'openid_demo' ? db.history['openid_demo'] || [] : [];
    if (!db.settings[openid]) db.settings[openid] = null;
    const cookie = `fx_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
    return res.writeHead(302, { Location: '/', 'Set-Cookie': cookie }), res.end();
  }

  // 3) 模拟登录（调试/演示用，支持 uid 切换账号）
  if (p === '/api/wechat/mock-login' && req.method === 'POST') {
    const body = await readBody(req);
    const uid = body && body.uid;
    const openid = uid ? 'openid_' + shortId(String(uid)) : 'openid_demo';
    const token = makeToken(openid);
    if (!db.homework[openid]) db.homework[openid] = [];
    if (!db.history[openid])
      db.history[openid] =
        openid === 'openid_demo' ? db.history['openid_demo'] || [] : [];
    if (!db.settings[openid]) db.settings[openid] = null;
    const cookie = `fx_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
    return sendJson(
      res,
      200,
      { token, openid },
      { 'Set-Cookie': cookie }
    );
  }

  // 4) 当前用户
  if (p === '/api/user') {
    const openid = openidFromReq(req);
    if (!openid) return sendJson(res, 401, { error: 'unauthorized' });
    return sendJson(res, 200, { openid, nickname: '同学' });
  }

  // 5) 作业读写
  if (p === '/api/homework') {
    const openid = openidFromReq(req);
    if (!openid) return sendJson(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET')
      return sendJson(res, 200, db.homework[openid] || []);
    if (req.method === 'POST') {
      const body = await readBody(req);
      db.homework[openid] = Array.isArray(body) ? body : [];
      return sendJson(res, 200, db.homework[openid]);
    }
  }

  // 6) 历史记录读写
  if (p === '/api/history') {
    const openid = openidFromReq(req);
    if (!openid) return sendJson(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET')
      return sendJson(res, 200, db.history[openid] || []);
    if (req.method === 'POST') {
      const body = await readBody(req);
      db.history[openid] = Array.isArray(body) ? body : [];
      return sendJson(res, 200, db.history[openid]);
    }
  }

  // 7) 设置读写
  if (p === '/api/settings') {
    const openid = openidFromReq(req);
    if (!openid) return sendJson(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET')
      return sendJson(res, 200, db.settings[openid] || null);
    if (req.method === 'POST') {
      const body = await readBody(req);
      db.settings[openid] = body || {};
      return sendJson(res, 200, db.settings[openid]);
    }
  }

  // 兜底 404（静态资源由 Vercel CDN 托管，不会进入此函数）
  sendJson(res, 404, { error: 'not found' });
}

module.exports = handle;
