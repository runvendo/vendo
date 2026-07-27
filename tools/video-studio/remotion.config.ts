import {Config} from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);

// The studio imports @vendoai/ui from SOURCE rather than dist, because the
// thread internals it films (ThreadMessage, ThreadPart, TurnCitations,
// ThreadAppCard, ensureChromeStyles) are not in the package's public exports
// map. packages/ui/e2e/harness does the same thing for the same reason.
//
// That source is ESM TypeScript: it imports siblings with explicit ".js"
// specifiers that only exist as ".ts"/".tsx" on disk. Webpack needs to be told
// how to map them back, which is what extensionAlias does. Without it the
// bundle fails with "packages/ui/src/context.js doesn't exist".
Config.overrideWebpackConfig((config) => ({
  ...config,
  resolve: {
    ...config.resolve,
    extensionAlias: {
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    },
  },
}));
