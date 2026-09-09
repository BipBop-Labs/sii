// OS keyring `SecretStore` (ADR-025) — the Clave at rest lives HERE and nowhere else
// (ADR-006). Backed by `@napi-rs/keyring`, which talks to the platform store directly:
// the freedesktop Secret Service on Linux (gnome-keyring / kwallet), the Keychain on
// macOS. It is general-purpose infrastructure, not SII code (ADR-004).
//
// The binding is a native module, so it is imported LAZILY: composing a runtime — or
// running the MCP server, which never reads a secret — must not load it (ADR-016).
import type { SecretStore } from '../../seams/index.js';

/** The keyring "service" every entry of this tool lives under. The account (`username`
 *  in keyring terms) is the RUT — see `keyringLogin` for the renderings it tries. */
export const KEYRING_SERVICE = 'sii';

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}
type KeyringModule = { Entry: new (service: string, username: string) => KeyringEntry };

/** Reads the Clave from the OS keyring. Never used by the MCP surface (ADR-025):
 *  only the CLI-only `keyringLogin` task consumes it. */
export class KeyringSecretStore implements SecretStore {
  constructor(private readonly service: string = KEYRING_SERVICE) {}

  private async entry(account: string): Promise<KeyringEntry> {
    // ponytail: a plain dynamic import is the whole lazy-load — no cache, the module
    // registry already is one.
    const mod = (await import('@napi-rs/keyring')) as unknown as KeyringModule;
    return new mod.Entry(this.service, account);
  }

  async get(account: string): Promise<string | null> {
    // A missing entry, a locked keyring and an absent Secret Service all mean the same
    // to the caller: no credential here. The caller turns that into its own actionable
    // message (which service/username it looked for) — swallowing the platform's own
    // wording keeps a secret-store error from leaking anything about the entry.
    try {
      return (await this.entry(account)).getPassword();
    } catch {
      return null;
    }
  }

  async set(account: string, secret: string): Promise<void> {
    (await this.entry(account)).setPassword(secret);
  }

  async delete(account: string): Promise<void> {
    try {
      (await this.entry(account)).deletePassword();
    } catch {
      // already gone / no store — deleting nothing is success
    }
  }
}
