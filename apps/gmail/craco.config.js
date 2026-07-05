/**
 * CRA override: the @vendoai/* workspace dists are strict ESM with
 * extensionless relative imports (tsc output). webpack 5 requires fully
 * specified requests inside ESM packages — relax that for node_modules JS so
 * the packages resolve exactly as they do under Next/Vite.
 */
module.exports = {
  webpack: {
    configure: (config) => {
      // NOTE: no `include: /node_modules/` — pnpm workspace symlinks resolve
      // to the real packages/* paths, which the include would miss.
      config.module.rules.push({
        test: /\.m?js$/,
        resolve: { fullySpecified: false },
      });
      return config;
    },
  },
};
