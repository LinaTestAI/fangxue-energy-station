/**
 * Vercel Serverless Function（catch-all）
 * 捕获所有 /api/* 请求，转交给共享路由 server/router.js 处理。
 * 静态资源（public/）由 Vercel 直接托管，不经过此函数。
 */
module.exports = require('../../server/router').handle;
