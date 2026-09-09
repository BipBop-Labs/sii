// Composition subpath `@albertomarturelo/sii-core/node` (ADR-016): the Node default
// adapters plus the composition root. Kept OFF the main barrel so importing the
// library's tasks/primitives never evaluates node:* or playwright — a consumer
// that injects its own seams (ADR-003) stays free of them entirely.
import {
  FileAuditSink,
  FileKeyValueStore,
  NodeFileSink,
  SystemClock,
} from './adapters/node/index.js';
import { KeyringSecretStore } from './adapters/node/keyring.js';
import { PlaywrightPortalDriver } from './adapters/node/portal.js';
import type { Runtime } from './seams/index.js';

export {
  DOCUMENTOS_DIR,
  FileAuditSink,
  FileKeyValueStore,
  NodeFileSink,
  SII_DIR,
  SystemClock,
} from './adapters/node/index.js';
export { KEYRING_SERVICE, KeyringSecretStore } from './adapters/node/keyring.js';
export { PlaywrightPortalDriver } from './adapters/node/portal.js';

/** Composition root: the Node default adapters, any seam replaceable (ADR-016).
 *  e.g. `createNodeRuntime({ audit: myAuditSink })` keeps the other three defaults.
 *  The default portal is the Playwright driver — its `playwright` OPTIONAL peer is
 *  loaded lazily on first use, so composing (or overriding `portal`) never needs it.
 *  `secrets` is the OS keyring (ADR-025), lazy in the same way and read by exactly one
 *  CLI-only task (`keyringLogin`) — nothing else ever touches it. */
export function createNodeRuntime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    clock: new SystemClock(),
    audit: new FileAuditSink(),
    store: new FileKeyValueStore(),
    portal: new PlaywrightPortalDriver(),
    files: new NodeFileSink(),
    secrets: new KeyringSecretStore(),
    ...overrides,
  };
}
