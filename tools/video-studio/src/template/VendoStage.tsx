import React from 'react';
import type {VendoClient} from '../../../../packages/ui/src/client';
import {VendoProvider} from '../../../../packages/ui/src/context';
import {
  ChromeRoot,
  ensureChromeStyles,
} from '../../../../packages/ui/src/chrome/chrome-root';
import {videoVendoTheme} from './vendo-theme';

/**
 * A VendoClient that cannot reach the network. Every wire method throws, which
 * turns "the compositions make no network calls" from a claim into something
 * the renderer would fail loudly on. Nothing on camera needs the wire: the
 * scenes hand the real components their state as props.
 */
const offlineClient = new Proxy(
  {baseUrl: 'video-studio:offline', headers: {}},
  {
    get(target, key: string) {
      if (key in target) return (target as Record<string, unknown>)[key];
      return new Proxy(
        {},
        {
          get(_group, method: string) {
            return () => {
              throw new Error(
                `video-studio renders offline: refusing client.${key}.${method}()`,
              );
            };
          },
        },
      );
    },
  },
) as unknown as VendoClient;

// Injected at module scope rather than in ChromeRoot's effect, so the very
// first frame of a render is already styled (an effect lands a frame late,
// which on camera is one unstyled flash).
ensureChromeStyles();

/**
 * The mount every real @vendoai/ui component on camera sits inside: the real
 * provider and the real chrome boundary, themed with the brand tokens.
 *
 * `automaticPolicyNotice={false}` matters — the notice subscribes to
 * useVendoStatus, which calls client.status() on mount. The film has no wire,
 * and the notice is host-configuration chrome that has no place in the film.
 *
 * `onPin` is the host seam that makes the app card's REAL keep affordance
 * render: `ThreadAppCard` shows `.fl-barpin` "Pin to dashboard" on the card bar
 * only when a host has wired `onPin` (packages/ui/src/chrome/thread/parts.tsx).
 * That button is the one the film's cursor clicks — the film draws no button of
 * its own. The handler itself is inert: the pin's consequence (the card landing
 * on the dashboard) is the next scene, not a state change.
 */
export const VendoStage: React.FC<{children: React.ReactNode}> = ({
  children,
}) => (
  <VendoProvider
    client={offlineClient}
    theme={videoVendoTheme}
    onPin={() => undefined}
  >
    <ChromeRoot automaticPolicyNotice={false}>{children}</ChromeRoot>
  </VendoProvider>
);
