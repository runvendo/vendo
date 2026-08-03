/**
 * Tailwind runs in genui-bench for ONE reason: compiling each demo host's own
 * stylesheet for its `/embed/<host>` document (app/embed/<host>/host.css), so
 * the Vendo pane renders host components with the host's real utilities and
 * brand tokens. The cockpit chrome (app/globals.css) is hand-rolled CSS and
 * uses no utilities — it never sees Tailwind output.
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
