# ADR-023 — Factura electrónica (Portal MIPYME): borradores only, no emission

- **Status:** Accepted
- **Date:** 2026-09-08
- **Supersedes / relates to:** ADR-003 (seams), ADR-004 (guardrails), ADR-005 (identity),
  ADR-006 (secrets/PII), ADR-017 (write posture), ADR-022 (document downloads)

## Context

The SII runs a **free** facturación electrónica portal ("Sistema de facturación gratuito del
SII", `Portal001` CGIs on `www1.sii.cl`). It is the surface a small contribuyente actually uses
to issue facturas, and it supports a **borrador** (draft) lifecycle: save, list, re-open, preview
and delete a document before committing to it.

A live capture on 2026-09-08 (`docs/sii-contract/factura.md`) mapped the whole flow and surfaced
one decisive fact:

> **Signing is server-side.** The `Firmar` button posts to `mipeGenXMLFirma.cgi`; there is no
> applet, no browser certificate and no `.pfx`. **A Clave Tributaria session alone is sufficient
> to emit a legally-binding factura electrónica.**

That is a much lower bar than the DTE SOAP services (which do require a certificado digital and
are still Future in `ARCHITECTURE.md`). It means an automated surface here could, with one HTTP
POST, create a real tax document with legal and financial consequences for the taxpayer and a
third party — and unlike a BHE, a factura cannot simply be annulled.

The portal's authorization model is also its own: the working empresa is whichever RUT was last
POSTed to `mipeSelEmpresa.cgi`, chosen from the empresas that registered this user as *usuario
autorizado*. That list is **not** the operate pointer's operable set (ADR-005) and not the
session principal either.

## Decision

**1. Ship the borrador lifecycle; do not ship emission.**

The surface implements exactly: list authorized empresas, create/update a borrador, list
borradores, download the preview PDF, delete a borrador. `mipeGenXMLFirma.cgi` is never called
from this codebase. The emission path is documented in the wire contract solely so the boundary
is explicit and reviewable.

Rationale: everything a user needs to *prepare* a factura is reversible and carries no legal
weight — a borrador has no folio and is not a tax document. Emission is the one step that is
irreversible, legally binding, and (because it needs no certificate) trivially reachable by
accident or by a prompt-injected model. Splitting there puts the whole useful workflow behind
automation while leaving the consequential click to a human in SII's own UI, which is one
navigation away from any borrador this tool writes.

**2. A borrador is a write, but not a destructive one.**

Unlike `bte emit` (ADR-017), `factura_borrador_save` needs no double-entry confirm and no
`destructiveHint`: it is reversible and legally inert. **Deleting** a borrador is irreversible,
so it does get the gate — CLI `--confirm <id>` (double-entry of the id) and MCP
`destructiveHint: true` + an explicit `confirmar: true`.

**3. Empresa-keyed is a third authorization mode, resolved live.**

`--empresa` / `empresa` is validated against the portal's own list, fetched at call time from
`mipeSelEmpresa.cgi`, and every task selects the empresa before acting. An unknown RUT fails with
the available list. This joins body-RUT (RCV) and session-keyed (F22/F29/BHE) as a documented
mode in `CONVENTIONS.md`.

**4. Let SII validate, and pass its message through.**

The form's own `validaFacEx()` is run **in-page** before anything is POSTed. It produces exactly
the Spanish refusals SII would otherwise bounce, so the user gets the real message at zero cost
and an invalid document never reaches SII (a redirect loop was observed when posting past it).

**5. The preview PDF follows the ADR-022 document contract.**

`mipePreView.cgi` returns a real `application/pdf` stamped "VISTA PREVIA · DOCUMENTO NO VALIDO".
It is fetched with `requestBinary`, written through the `FileSink` seam, and the task returns a
**descriptor** — never the bytes. Success is decided by `content-type` + `%PDF` magic, never by
HTTP status. No new seam was needed.

**6. No `raw`, anywhere.**

A factura is both parties' identity end to end. Rows are curated; the audit receipt carries only
the empresa RUT, the borrador id, the DTE type and counts — never the receptor, the montos or the
item glosas (ADR-006).

## Consequences

- The user can draft, review and manage facturas entirely from the CLI/MCP, then emit in SII's UI.
- No tool in this codebase can create a legally-binding factura. This is a deliberate ceiling, and
  reversing it requires a new ADR — with, at minimum, the ADR-017 write posture (two-phase,
  confirm-gated, folio-only audit, live-validated against a real needed document).
- The form is JS-populated, so this facade depends on a real browser session (`goto`/`evaluate`),
  like BTE. A portal redesign breaks it loudly ("scraper roto"), never silently.
- Only DTE 33/34 are wired. The other MIPYME types (46 compra, 43 liquidación, 110 exportación)
  each carry extra fields and need their own live capture before being trusted.
