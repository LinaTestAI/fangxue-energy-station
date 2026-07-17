/**
 * 放学能量站 · 本地开发服务
 * 仅用于本地开发 / 演示：用 Node 原生 http 跑共享路由（server/router.js）。
 * Vercel 部署不需要本文件，见 api/[...slug].js。
 */
const http = require('http');
const { handle, USE_MOCK } = require('./router');

const PORT = process.env.PORT || 3000;

http.createServer(handle).listen(PORT, () => {
  console.log(`放学能量站 H5 运行于 http://localhost:${PORT}  (USE_MOCK=${USE_MOCK})`);
  if (USE_MOCK) console.log('提示：当前为本地模拟登录，微信内真实授权请配置 WX_APPID / WX_SECRET');
});
