# ADR-025: Keyring `SecretStore` — the Clave from the OS keyring, explicit login only

## Status

Accepted — 2026-09-09. Resolves the `SecretStore` backend left TBD by ADR-006 and
deferred by ADR-008; a third INPUT METHOD alongside ADR-010's console login, for the
same cookies-only session. Lineage: sii-py ADR-019 (only login mints).

## Context

Both login paths in place (headed browser ADR-006, console ADR-010) require the user
to type the Clave for every new session, and the SII cookie jar dies on its own
server-side schedule — in practice a re-type several times a week, which is friction
for a CLI meant to be scripted. ADR-006 already sanctions the OS keyring as the one
place a Clave may rest, but named no library and shipped no adapter. The user's
machine now runs a freedesktop Secret Service provider (gnome-keyring) holding the
Clave, and asked the CLI to read from it.

## Decision

- **Add `KeyringSecretStore`, the default `SecretStore` adapter** under
  `adapters/node/` (the `./node` composition subpath — the pure barrel stays Node-free,
  ADR-016). `Runtime.secrets` stays OPTIONAL: an embedded consumer that injects nothing
  gets no keyring, and a task that needs one raises an actionable error.
- **Library: `@napi-rs/keyring`** — a prebuilt N-API binding over the platform store
  (Secret Service on Linux, Keychain on macOS), no Python/node-gyp build step. It is
  general-purpose infrastructure, not SII code (ADR-004 untouched).
- **Lookup key: service `sii`, username = the RUT.** The RUT is normalized before the
  lookup and tried in the renderings a human plausibly stored (canonical `12345678-9`,
  dotted `12.345.678-9`, body-only, upper-case `K`); the FIRST hit wins. Rationale: the
  keyring is populated by hand (`secret-tool`, Seahorse), so the code adapts to the
  human, not the reverse.
- **Explicit login only.** The keyring is read by ONE verb — `sii auth login --keyring`
  — which makes exactly ONE attempt and then behaves like ADR-010's console login
  (headless `credentialLogin`, Clave discarded from memory, cookies-only persisted).
  **No automatic re-login**: a task that meets `SessionExpiredError` still fails with
  "ejecuta `sii auth login`" and NEVER re-mints (ADR-019 lineage — authentication is an
  explicit verb).
- **CLI-only, like `consoleLogin`.** The task is exported from the `@albertomarturelo/sii-core/cli`
  subpath, never the main barrel, so the MCP server cannot wire it (ADR-006). The MCP
  surface gains nothing: no tool, no argument, no keyring read.
- **The Clave never lands anywhere else**: not in the audit log (the receipt records
  `reason: 'keyring_login'` and the RUT only), not in an error message, not on disk.
  The CLI never WRITES to the keyring — storing the Clave is the user's own act with
  their own tool, so we never own that secret's lifecycle.

## Alternatives Considered

1. **Automatic re-login on `SessionExpiredError`** (the ergonomic maximum) — rejected
   by the user, and it is the riskiest shape available: a stale keyring entry turns
   every subsequent task into a failed login attempt, and SII locks the account after a
   few (ADR-004). The explicit verb keeps the blast radius at one attempt the user
   asked for.
2. **Shell out to `secret-tool` / `security`** — the laziest path and zero dependencies,
   but Linux-only (the dev machine is macOS, STACK.md), it puts a secret through a
   child process's stdout, and it fails opaquely when the binary is absent. Rejected.
3. **`keytar`** — the historically obvious pick, but it is archived/unmaintained and
   needs a native build. Rejected in favour of `@napi-rs/keyring`.
4. **Our own encrypted file under `~/.sii/`** — re-implements a keyring badly and puts
   a Clave-derived blob on disk, which ADR-006 forbids outright. Rejected.

## Consequences

- A scripted `sii` run is a single unattended command again, on any machine whose
  keyring holds the Clave — and stays a no-op for everyone else: no keyring, no
  behaviour change, `--keyring` simply errors that it found no entry.
- A NEW risk the other login paths do not carry: the Clave now rests somewhere a
  process running as the user can read. That is a deliberate trade the user made, and
  it is bounded by the keyring's own unlock (a locked keyring prompts), by CLI-only
  exposure, and by the one-attempt rule that keeps a stale entry from locking the
  account.
- `Runtime.secrets` becomes real for the first time, so the seam finally has a Node
  default (it was interface-only since ADR-003). Tests keep injecting the in-memory
  fake and never touch the real keyring.
- Obligation: the CLI must state the keyring lookup in `--help` (which service/user it
  reads) so the user can populate it without reading the source.
