/**
 * 放学能量站 · 请求路由（单一来源）
 * 同时被两种运行方式复用：
 *   - 本地：server/mock-server.js 用 http.createServer(handle).listen()
 *   - Vercel：api/[...slug].js 直接 module.exports = handle
 *
 * 能力：
 *  1. 静态资源托管（仅本地生效；Vercel 由 public/ 直接托管，不会进入本路由）
 *  2. 微信网页授权 OAuth2（snsapi_base 静默授权）回调：code -> openid
 *  3. 用户态（基于 token 的 cookie）
 *  4. 作业 / 历史 / 设置 的按用户读写
 *
 * 真实接入点（已用注释标注）：
 *  - WX_APPID / WX_SECRET：替换为公众号后台的 AppId / AppSecret
 *  - /api/wechat/callback 内 exchangeCode()：替换为对 api.weixin.qq.com 的真实请求
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public'); // Vercel 静态目录；本地也从此读

/* ============ 微信配置（占位，部署时替换） ============ */
const WECHAT = {
  appId: process.env.WX_APPID || 'YOUR_APPID',
  appSecret: process.env.WX_SECRET || 'YOUR_SECRET',
  // 真实部署需在公众号后台配置“网页授权域名”为本站域名（不含 http://）
};
const USE_MOCK = WECHAT.appId === 'YOUR_APPID'; // 无真实 AppId 时走本地模拟

/* ============ 内存数据（演示用；Vercel 下仅单实例内有效，冷启动清空） ============ */
const db = global.db || (global.db = { tokens: {}, homework: {}, history: {}, settings: {} });
// 预置一份示例历史记录（仅默认演示账号）
if (!db.history['openid_demo']) {
  db.history['openid_demo'] = [
    { id: 201, subj: '数学', title: '计算每日一练', min: 15 },
    { id: 202, subj: '语文', title: '阅读理解一篇', min: 20 },
    { id: 203, subj: '英语', title: '朗读课文 Unit2', min: 10 },
  ];
}

/* ============ 工具 ============ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const issueToken = (openid) => hash(openid + ':' + Date.now());
const parseCookies = (req) => {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > -1) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
};
const openidFromToken = (token) => (db.tokens[token] ? db.tokens[token].openid : null);
const openidFromReq = (req) => openidFromToken(parseCookies(req).fx_token);

/** code -> openid：真实环境应请求微信接口换取，此处模拟 */
function exchangeCode(code) {
  if (!USE_MOCK) {
    // TODO(真实接入):
    // const url = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${WECHAT.appId}&secret=${WECHAT.appSecret}&code=${code}&grant_type=authorization_code`;
    // const r = await fetch(url); const j = await r.json(); return j.openid;
  }
  return 'openid_' + hash(code);
}

function sendJson(res, code, obj, extraHeaders = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}
function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

/* ============ 路由处理（Vercel / 本地共用） ============ */
async function handle(req, res) {
  // 防御性兜底：Vercel / 本地在极端情况下可能缺失 host 头，避免 new URL 抛错导致整函数 500
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url, `http://${host}`);
  const p = url.pathname;

  // 1) 发起微信网页授权（前端在无登录态且处于微信内时调用）
  if (p === '/api/wechat/auth') {
    const cb = url.searchParams.get('redirect_uri') || (req.headers.origin + '/api/wechat/callback');
    if (USE_MOCK) {
      return res.writeHead(302, { Location: `${cb}?code=mock_${hash(String(Date.now()))}` }), res.end();
    }
    const wxUrl =
      `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${WECHAT.appId}` +
      `&redirect_uri=${encodeURIComponent(cb)}&response_type=code&scope=snsapi_base&state=fx#wechat_redirect`;
    return res.writeHead(302, { Location: wxUrl }), res.end();
  }

  // 2) 微信授权回调：code -> openid -> 下发 token cookie -> 回前端首页
  if (p === '/api/wechat/callback') {
    const code = url.searchParams.get('code');
    if (!code) return sendJson(res, 400, { error: 'missing code' });
    const openid = exchangeCode(code);
    const token = issueToken(openid);
    db.tokens[token] = { openid };
    if (!db.homework[openid]) db.homework[openid] = [];
    if (!db.history[openid]) db.history[openid] = (openid === 'openid_demo') ? (db.history['openid_demo'] || []) : [];
    if (!db.settings[openid]) db.settings[openid] = null;
    const cookie = `fx_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
    return res.writeHead(302, { Location: '/', 'Set-Cookie': cookie }), res.end();
  }

  // 3) 开发态模拟登录（非微信环境直接用，便于本地调试 / 演示切换账号）
  //    支持传入 uid 模拟不同微信号：openid = openid_<hash(uid)>
  if (p === '/api/wechat/mock-login' && req.method === 'POST') {
    const body = await readBody(req);
    const uid = body && body.uid;
    const openid = uid ? 'openid_' + hash(String(uid)) : 'openid_demo';
    const token = issueToken(openid);
    db.tokens[token] = { openid };
    if (!db.homework[openid]) db.homework[openid] = [];
    if (!db.history[openid]) db.history[openid] = (openid === 'openid_demo') ? (db.history['openid_demo'] || []) : [];
    if (!db.settings[openid]) db.settings[openid] = null;
    const cookie = `fx_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
    return sendJson(res, 200, { token, openid }, { 'Set-Cookie': cookie });
  }

  // 4) 当前用户
  if (p === '/api/user') {
    const openid = openidFromReq(req);
    if (!openid) return sendJson(res, 401, { error: 'unauthorized' });
    return sendJson(res, 200, { openid, nickname: '同学' });
  }

  // 5) 作业读写（按用户）
  if (p === '/api/homework') {
    const openid = openidFromReq(req);
    if (!openid) return sendJson(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET') return sendJson(res, 200, db.homework[openid] || []);
    if (req.method === 'POST') {
      const body = await readBody(req);
      db.homework[openid] = Array.isArray(body) ? body : [];
      return sendJson(res, 200, db.homework[openid]);
    }
  }

  // 6) 历史记录读写（按用户）
  if (p === '/api/history') {
    const openid = openidFromReq(req);
    if (!openid) return sendJson(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET') return sendJson(res, 200, db.history[openid] || []);
    if (req.method === 'POST') {
      const body = await readBody(req);
      db.history[openid] = Array.isArray(body) ? body : [];
      return sendJson(res, 200, db.history[openid]);
    }
  }

  // 7) 设置读写（按用户）：娱乐时长 + 自定义学科
  if (p === '/api/settings') {
    const openid = openidFromReq(req);
    if (!openid) return sendJson(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET') return sendJson(res, 200, db.settings[openid] || null);
    if (req.method === 'POST') {
      const body = await readBody(req);
      db.settings[openid] = body || {};
      return sendJson(res, 200, db.settings[openid]);
    }
  }

  // 兜底：本地静态资源（Vercel 下静态由 public/ 直接托管，不会进入此处）
  if (req.method === 'GET') return serveStatic(req, res, p);
  res.writeHead(404); res.end('not found');
}

module.exports = { handle, USE_MOCK };
