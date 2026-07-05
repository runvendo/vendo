/**
 * CRA dev-server proxy: /api → the clone's Express backend (mail + Vendo).
 * The Vendo chat route streams; compression in webpack-dev-server buffers
 * streamed bodies, so the proxy strips accept-encoding and the backend's
 * responses pass through unbuffered.
 */
const { createProxyMiddleware } = require("http-proxy-middleware");

module.exports = function (app) {
  app.use(
    "/api",
    createProxyMiddleware({
      target: `http://localhost:${process.env.GMAIL_API_PORT || 3198}`,
      changeOrigin: false,
      // Keep streamed chat responses streaming: no gzip negotiation between
      // the dev server and the backend.
      onProxyReq: (proxyReq) => {
        proxyReq.setHeader("accept-encoding", "identity");
      },
    })
  );
};
