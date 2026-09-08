// MIPYME FACTURA (borradores) — the SII's FREE facturación electrónica portal, `Portal001`
// CGIs on www1.sii.cl. Wire contract captured live 2026-09-08 (own session, a real borrador
// created/listed/deleted end-to-end); see docs/sii-contract/factura.md. NOT a third-party
// library (ADR-004): every field, endpoint and selector below is first-hand-observed.
//
// BORRADORES ONLY (ADR-023). The portal's emisión path is `mipeDisplayPreView.cgi` →
// `mipeGenXMLFirma.cgi` (SII signs SERVER-SIDE — no certificado digital is involved, so the
// Clave alone would be enough to issue a legally-binding factura). This module deliberately
// stops at the borrador + preview: `mipeGenXMLFirma.cgi` is NEVER called from here.
//
// TWO WIRE SHAPES, like the BTE facade:
//   * the FORM (`mipeGenFacEx.cgi`) is an HTML skeleton whose emisor context (sucursal, giro,
//     domicilio, acteco) and detail grid are built CLIENT-SIDE by JS — the static HTML carries
//     EMPTY values. So it is driven through `PortalSession.goto` + `evaluate` (never a cold
//     `requestForm` GET, which would read blanks), exactly as the convention requires.
//   * the CGIs that consume the filled form (`mipeGrabaBorrador` / `mipeEliminaBorrador` /
//     `mipeDisplayPreView`) take `x-www-form-urlencoded` and return HTML ⇒ `requestForm`.
//   * the borrador LIST is a plain SPA JSON GET on www4 ⇒ `requestJson`.
//
// EMPRESA-KEYED (ADR-023): the working empresa is whichever RUT was last POSTed to
// `mipeSelEmpresa.cgi` — the MIPYME "usuario autorizado" list, which is its OWN value domain,
// distinct from the operate pointer's operable set. Every operation selects it first.
import { HOSTS } from '../config/index.js';
import { FacturaError } from '../errors/index.js';
import type { Rut } from '../rut/index.js';
import type { PortalSession } from '../seams/index.js';

const CGI = HOSTS.mipeCgi;
const SEL_EMPRESA_URL = `${CGI}/mipeSelEmpresa.cgi`;
const FORM_URL = `${CGI}/mipeGenFacEx.cgi`;
const GRABA_URL = `${CGI}/mipeGrabaBorrador.cgi`;
const ELIMINA_URL = `${CGI}/mipeEliminaBorrador.cgi`;
const PREVIEW_URL = `${CGI}/mipeDisplayPreView.cgi`;
/** Renders the (unsigned) document as a real `application/pdf` — the preview the portal embeds
 *  in its `framePdf` iframe. Takes the review page's `PreViewDTE` body (observed 2026-09-08). */
const PDF_URL = `${CGI}/mipePreView.cgi`;
/** The borradores list is served by the MIPYME SPA, not the CGIs (observed 2026-09-08). */
const LISTA_BORRADOR_URL = `${HOSTS.portalApi}/mipymeinternetui/services/data/borradorService/listaBorrador`;

/** `DESDE_DONDE_URL` — the post-selection destination `mipeSelEmpresa.cgi` forwards to. It is
 *  an unkeyed `OPCION=<tipo>&TIPO=4` pair (observed); `OPCION` is the DTE code. */
const desdeDonde = (tipoDte: number): string => `OPCION=${tipoDte}&TIPO=4`;

/** The DTE types the MIPYME portal exposes as their own `mipeLaunchPage` OPCION (observed
 *  2026-09-08 on sii.cl/servicios_online/1039-1183.html). Only 33/34 are wired here — the
 *  others need their own live capture before their extra fields can be trusted. */
export const TIPOS_DTE = {
  33: 'Factura electrónica',
  34: 'Factura no afecta o exenta electrónica',
} as const;
export type TipoDte = keyof typeof TIPOS_DTE;

export const isTipoDte = (n: number): n is TipoDte => n === 33 || n === 34;

/** SII's `EFXP_FMA_PAGO` codes (observed in the form's `<select>`). */
export const FORMA_PAGO = { contado: '1', credito: '2', sin_costo: '3' } as const;
export type FormaPago = keyof typeof FORMA_PAGO;

/** The grid's hard ceiling — the form's own `cantTotCol` (observed). */
export const MAX_ITEMS = 10;

/** An empresa the authenticated user may invoice for, as offered by `mipeSelEmpresa.cgi`. */
export interface FacturaEmpresa {
  readonly rut: string; // canonical `<body>-<dv>` exactly as SII serves it
  readonly nombre: string;
}

export interface FacturaReceptor {
  readonly rut: string; // body digits, no DV
  readonly dv: string;
  readonly razonSocial: string;
  readonly direccion: string;
  readonly comuna: string;
  readonly ciudad: string;
  readonly giro: string;
  readonly contacto?: string;
}

export interface FacturaItem {
  readonly nombre: string;
  readonly descripcion?: string;
  readonly cantidad: number;
  readonly unidad?: string;
  readonly precioUnitario: number;
  readonly descuentoPct?: number;
}

/** Everything the caller supplies. The EMISOR block (razón social, giro, domicilio, acteco,
 *  sucursal) is read from the live form — except `ciudadEmisor`, which SII leaves BLANK yet
 *  its own validation demands, so the caller must provide it (observed 2026-09-08). */
export interface FacturaBorradorInput {
  readonly empresa: string; // emisor RUT, from the MIPYME authorized list
  readonly tipoDte: TipoDte;
  readonly fechaEmision: string; // YYYY-MM-DD
  readonly ciudadEmisor: string;
  readonly receptor: FacturaReceptor;
  readonly items: readonly FacturaItem[];
  readonly formaPago: FormaPago;
  /** Set to UPDATE an existing borrador in place; omit to create a new one. */
  readonly borradorId?: string;
}

/** Server-side totals, computed by the form's own JS (so the arithmetic is SII's, not ours). */
export interface FacturaTotales {
  readonly neto: number;
  readonly iva: number;
  readonly total: number;
}

/** One row of the borradores list — CURATED. */
export interface FacturaBorradorRow {
  readonly id: string; // ehdr_CODIGO
  readonly tipoDte: number;
  readonly tipoDteDesc: string;
  readonly fecha: string | null;
  readonly receptorRut: string | null;
  readonly receptorNombre: string | null;
  readonly emisorNombre: string | null;
  readonly iva: number | null;
  readonly total: number | null;
}

// --- HTML parsing (in-house, no third-party lib — ADR-004) ------------------------

/** Read the `<option value="RUT">NOMBRE RUT` rows of the `RUT_EMP` select. SII closes neither
 *  the `<option>` nor quotes the label, so match up to the next `<` or newline (observed). */
function parseEmpresas(html: string): FacturaEmpresa[] {
  const select = /<select[^>]*name="RUT_EMP"[\s\S]*?<\/select>/i.exec(html)?.[0];
  if (!select) {
    throw new FacturaError(
      'El SII no entregó la lista de empresas del Portal MIPYME (mipeSelEmpresa.cgi). ' +
        'Verifica que estés registrado como usuario autorizado de alguna empresa.',
    );
  }
  const out: FacturaEmpresa[] = [];
  const re = /<option\s+value="([^"]+)"\s*>([^<\n]*)/gi;
  for (let m = re.exec(select); m; m = re.exec(select)) {
    const rut = (m[1] ?? '').trim();
    // The label repeats the RUT ("RAZON SOCIAL 76192083-9") — strip it for a clean name.
    const nombre = (m[2] ?? '')
      .trim()
      .replace(new RegExp(`\\s*${rut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`), '')
      .trim();
    if (rut) out.push({ rut, nombre });
  }
  if (out.length === 0) throw new FacturaError('El Portal MIPYME no ofrece ninguna empresa.');
  return out;
}

/** SII answers 200 with a human message on both success and refusal, so decide on the text.
 *  The success wording is observed 2026-09-08; anything else is surfaced VERBATIM (ADR-004). */
function assertCgiOk(html: string, step: string): void {
  if (/ha sido grabado|ha sido eliminado|con éxito|con exito/i.test(html)) return;
  const msg = /<(?:p|div|td|span|h\d)[^>]*>\s*([^<]{15,300}?)\s*<\//i.exec(
    html.replace(/<script[\s\S]*?<\/script>/gi, ''),
  )?.[1];
  throw new FacturaError(
    `El SII no confirmó la operación de borrador (paso: ${step}).` +
      (msg ? ` Respuesta: ${msg.replace(/\s+/g, ' ').trim()}` : ''),
  );
}

/** Read a form's `<input type="hidden" name="X" value="Y">` pairs. SII's preview page carries
 *  the whole document that way (uniform markup, double-quoted, observed 2026-09-08). */
function parseHiddenInputs(html: string, formName: string): Record<string, string> {
  const form = new RegExp(`<form[^>]*name="${formName}"[\\s\\S]*?</form>`, 'i').exec(html)?.[0];
  if (!form) return {};
  const out: Record<string, string> = {};
  const re = /<input[^>]*type="hidden"[^>]*>/gi;
  for (let m = re.exec(form); m; m = re.exec(form)) {
    const tag = m[0];
    const name = /name="([^"]*)"/i.exec(tag)?.[1];
    if (!name) continue;
    out[name] = unescapeHtml(/value="([^"]*)"/i.exec(tag)?.[1] ?? '');
  }
  return out;
}

/** The five predefined XML entities — enough for SII's form values (no numeric refs observed). */
const unescapeHtml = (v: string): string =>
  v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

// --- The in-page fill script -------------------------------------------------------

/** Build the expression evaluated INSIDE the loaded form page. It grows the detail grid, sets
 *  the fields, runs SII's OWN validator (`validaFacEx`) so the user sees SII's message
 *  verbatim, and returns the serialized form exactly as a browser would submit it.
 *
 *  Two observed hazards it works around:
 *   * firing `change` on `EFXP_RUT_RECEP` triggers the portal's receptor-autofill round trip,
 *     which RELOADS the page and wipes the detail grid — so the receptor fields are assigned
 *     WITHOUT events; only the numeric item fields need `change` to drive the total recompute.
 *   * `DESCRIP_nn` is a checkbox whose `onclick` DRAWS the `EFXP_DSC_ITEM_nn` textarea; the
 *     textarea does not exist until it is clicked. */
function fillScript(payload: unknown): string {
  return `(() => {
  const P = ${JSON.stringify(payload)};
  const f = document.forms['VIEW_EFXP'];
  if (!f) return { scraper: 'no se encontró el formulario VIEW_EFXP' };
  const missing = [];
  const put = (n, v, fire) => {
    const e = f.elements[n];
    if (!e) { missing.push(n); return; }
    e.value = v;
    if (fire) e.dispatchEvent(new Event('change', { bubbles: true }));
  };
  while (Number(f.elements['CANT_DET'].value || 1) < P.items.length) {
    modCantLineaDet(f.elements['AGREGA_DETALLE']);
  }
  put('EFXP_CIUDAD_ORIGEN', P.ciudadEmisor);
  put('EFXP_FCH_EMIS', P.fechaEmision);
  put('EFXP_FMA_PAGO', P.formaPago);
  put('EFXP_RUT_RECEP', P.receptor.rut);
  put('EFXP_DV_RECEP', P.receptor.dv);
  put('EFXP_RZN_SOC_RECEP', P.receptor.razonSocial);
  put('EFXP_DIR_RECEP', P.receptor.direccion);
  put('EFXP_CMNA_RECEP', P.receptor.comuna);
  put('EFXP_CIUDAD_RECEP', P.receptor.ciudad);
  put('EFXP_GIRO_RECEP', P.receptor.giro);
  put('EFXP_CONTACTO', P.receptor.contacto);
  if (P.borradorId) { f.elements['EHDR_CODIGO'].value = P.borradorId; }
  P.items.forEach((it, i) => {
    const s = String(i + 1).padStart(2, '0');
    if (it.descripcion) { const c = f.elements['DESCRIP_' + s]; c.checked = true; c.onclick(); }
    put('EFXP_NMB_' + s, it.nombre);
    put('EFXP_UNMD_' + s, it.unidad);
    if (it.descripcion) put('EFXP_DSC_ITEM_' + s, it.descripcion);
    if (it.descuentoPct) put('EFXP_PCTD_' + s, it.descuentoPct, true);
    put('EFXP_QTY_' + s, it.cantidad, true);
    put('EFXP_PRC_' + s, it.precioUnitario, true);
  });
  const msgs = [];
  const prev = window.alert;
  window.alert = (m) => msgs.push(String(m).trim());
  let ok = false;
  try { ok = !!validaFacEx(f.elements['Button_Update']); }
  catch (e) { window.alert = prev; return { scraper: String(e && e.message || e) }; }
  window.alert = prev;
  const fields = {};
  for (const e of f.elements) {
    if (!e.name || e.type === 'button' || e.type === 'submit') continue;
    if ((e.type === 'checkbox' || e.type === 'radio') && !e.checked) continue;
    fields[e.name] = e.value;
  }
  return {
    ok, msgs, missing, fields,
    totales: {
      neto: Number(f.elements['EFXP_MNT_NETO'].value || 0),
      iva: Number(f.elements['EFXP_IVA'].value || 0),
      total: Number(f.elements['EFXP_MNT_TOTAL'].value || 0),
    },
  };
})()`;
}

interface FillResult {
  readonly scraper?: string;
  readonly ok?: boolean;
  readonly msgs?: string[];
  readonly missing?: string[];
  readonly fields?: Record<string, string>;
  readonly totales?: FacturaTotales;
}

/** A filled, SII-validated form: the exact body to POST plus the totals SII computed. */
export interface FacturaFilled {
  readonly fields: Record<string, string>;
  readonly totales: FacturaTotales;
}

// --- Operations ---------------------------------------------------------------------

/** The empresas the authenticated user may invoice for. This is the MIPYME "usuario
 *  autorizado" list — its own value domain, NOT the operate pointer's operable set. */
export async function fetchEmpresas(
  session: PortalSession,
  tipoDte: TipoDte,
): Promise<FacturaEmpresa[]> {
  const res = await session.requestForm(
    `${SEL_EMPRESA_URL}?DESDE_DONDE_URL=${encodeURIComponent(desdeDonde(tipoDte))}`,
    { method: 'GET' },
  );
  return parseEmpresas(res.body);
}

/** Point the MIPYME session at `empresa`. EVERY other operation depends on this having run:
 *  the form, the borrador CRUD and the borradores list are all scoped to it (observed). */
async function selectEmpresa(
  session: PortalSession,
  empresa: FacturaEmpresa,
  tipoDte: TipoDte,
): Promise<void> {
  const res = await session.requestForm(SEL_EMPRESA_URL, {
    form: { DESDE_DONDE_URL: desdeDonde(tipoDte), RUT_EMP: empresa.rut },
  });
  // The redirect target IS the factura form; a bounce back to the chooser means SII refused.
  if (/name="RUT_EMP"/i.test(res.body)) {
    throw new FacturaError(
      `El SII no aceptó la empresa ${empresa.rut} en el Portal MIPYME. ` +
        'Verifica que sigas siendo usuario autorizado de esa empresa.',
    );
  }
}

/** Resolve `rut` against the live authorized list and select it. Returns the matched empresa so
 *  callers can echo SII's own razón social. An unknown RUT fails with the list (ADR-005 style). */
export async function resolveAndSelectEmpresa(
  session: PortalSession,
  rut: Rut,
  tipoDte: TipoDte,
): Promise<FacturaEmpresa> {
  const empresas = await fetchEmpresas(session, tipoDte);
  const match = empresas.find((e) => e.rut.split('-')[0] === String(rut.body));
  if (!match) {
    throw new FacturaError(
      `${rut.formatted} no está en tus empresas del Portal MIPYME. Disponibles: ` +
        empresas.map((e) => `${e.rut} (${e.nombre})`).join(', ') +
        '.',
    );
  }
  await selectEmpresa(session, match, tipoDte);
  return match;
}

/** Load the factura form for `empresa` (a fresh one, or an existing borrador) and fill it with
 *  `input`, letting SII's own client-side validator pass judgement. Returns the POST-ready body
 *  + SII's computed totals, which every downstream CGI (graba / elimina / preview) consumes. */
export async function fillFactura(
  session: PortalSession,
  empresa: FacturaEmpresa,
  input: FacturaBorradorInput,
): Promise<FacturaFilled> {
  const [body, dv] = empresa.rut.split('-');
  const url = input.borradorId
    ? `${FORM_URL}?PTDC_CODIGO=${input.tipoDte}&ES_BORR=TRUE&VALOR=${input.borradorId}` +
      `&IGUAL=CODIGO&RUT=${body}&DV=${dv}&TPO_DOC_GEN=${input.tipoDte}`
    : `${FORM_URL}?PTDC_CODIGO=${input.tipoDte}`;
  const landed = await session.goto(url);
  if (!landed.includes('mipeGenFacEx.cgi')) {
    throw new FacturaError(
      `El SII no entregó el formulario de factura (llegamos a ${landed}). ` +
        'Puede que la empresa no esté autorizada a emitir este tipo de documento.',
    );
  }
  const r = await session.evaluate<FillResult>(
    fillScript({
      ciudadEmisor: input.ciudadEmisor,
      fechaEmision: input.fechaEmision,
      formaPago: FORMA_PAGO[input.formaPago],
      receptor: { ...input.receptor, contacto: input.receptor.contacto ?? '' },
      items: input.items.map((it) => ({
        nombre: it.nombre,
        descripcion: it.descripcion ?? '',
        cantidad: String(it.cantidad),
        unidad: it.unidad ?? '',
        precioUnitario: String(it.precioUnitario),
        descuentoPct: it.descuentoPct ? String(it.descuentoPct) : '',
      })),
      borradorId: input.borradorId ?? '',
    }),
  );
  if (r.scraper) {
    throw new FacturaError(`Formulario de factura del SII no reconocido (${r.scraper}).`);
  }
  if (r.missing && r.missing.length > 0) {
    throw new FacturaError(
      `El formulario del SII cambió de forma: faltan los campos ${r.missing.join(', ')}.`,
    );
  }
  // SII's own validator refused — pass its Spanish message through UNCHANGED (ADR-004).
  if (!r.ok) throw new FacturaError((r.msgs ?? []).join(' ') || 'El SII rechazó el documento.');
  if (!r.fields || !r.totales) throw new FacturaError('El formulario del SII no entregó datos.');
  return { fields: r.fields, totales: r.totales };
}

/** Serialize an EXISTING borrador's form without changing it — the body `mipeEliminaBorrador`
 *  needs (the CGI takes the whole form back, keyed by `EHDR_CODIGO`). Totals come from the
 *  form as SII rendered it. */
export async function loadBorrador(
  session: PortalSession,
  empresa: FacturaEmpresa,
  tipoDte: TipoDte,
  borradorId: string,
): Promise<FacturaFilled> {
  const [body, dv] = empresa.rut.split('-');
  const landed = await session.goto(
    `${FORM_URL}?PTDC_CODIGO=${tipoDte}&ES_BORR=TRUE&VALOR=${borradorId}` +
      `&IGUAL=CODIGO&RUT=${body}&DV=${dv}&TPO_DOC_GEN=${tipoDte}`,
  );
  if (!landed.includes('mipeGenFacEx.cgi')) {
    throw new FacturaError(`El SII no entregó el borrador ${borradorId} (llegamos a ${landed}).`);
  }
  const r = await session.evaluate<FillResult>(`(() => {
    const f = document.forms['VIEW_EFXP'];
    if (!f) return { scraper: 'no se encontró el formulario VIEW_EFXP' };
    if (f.elements['EHDR_CODIGO'].value !== ${JSON.stringify(borradorId)}) {
      return { scraper: 'el SII devolvió otro borrador (' + f.elements['EHDR_CODIGO'].value + ')' };
    }
    const fields = {};
    for (const e of f.elements) {
      if (!e.name || e.type === 'button' || e.type === 'submit') continue;
      if ((e.type === 'checkbox' || e.type === 'radio') && !e.checked) continue;
      fields[e.name] = e.value;
    }
    return { ok: true, fields, totales: {
      neto: Number(f.elements['EFXP_MNT_NETO'].value || 0),
      iva: Number(f.elements['EFXP_IVA'].value || 0),
      total: Number(f.elements['EFXP_MNT_TOTAL'].value || 0),
    } };
  })()`);
  if (r.scraper) throw new FacturaError(`No se pudo leer el borrador ${borradorId}: ${r.scraper}.`);
  if (!r.fields || !r.totales) throw new FacturaError(`El borrador ${borradorId} llegó vacío.`);
  return { fields: r.fields, totales: r.totales };
}

/** Persist the filled form as a borrador (create, or update when `EHDR_CODIGO` is set).
 *  `ES_BORR=TRUE` is what tells the CGI this is a draft, not a document to sign (observed). */
export async function grabaBorrador(session: PortalSession, filled: FacturaFilled): Promise<void> {
  const res = await session.requestForm(GRABA_URL, {
    form: { ...filled.fields, ES_BORR: 'TRUE' },
  });
  assertCgiOk(res.body, 'grabaBorrador');
}

/** Delete a borrador. SII takes the WHOLE form back, keyed by `EHDR_CODIGO` (observed). */
export async function eliminaBorrador(
  session: PortalSession,
  filled: FacturaFilled,
): Promise<void> {
  const res = await session.requestForm(ELIMINA_URL, {
    form: { ...filled.fields, ES_BORR: 'TRUE' },
  });
  assertCgiOk(res.body, 'eliminaBorrador');
}

/** The borradores of the CURRENTLY SELECTED empresa. A plain JSON array (no SDI `respEstado`
 *  envelope — observed), served ISO-8859-1; the seam decodes it. Rows carry ~250 mostly-null
 *  form columns; only the listing columns are curated (no `raw` — the row is receptor +
 *  emisor identity, i.e. PII, ADR-004). */
export async function fetchBorradores(session: PortalSession): Promise<FacturaBorradorRow[]> {
  const data = await session.requestJson(LISTA_BORRADOR_URL, { method: 'GET' });
  if (!Array.isArray(data)) {
    throw new FacturaError('El SII no entregó la lista de borradores en el formato esperado.');
  }
  const num = (v: unknown): number | null =>
    typeof v === 'string' && v.trim() !== '' ? Number(v) : null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  return data.map((r) => {
    const row = r as Record<string, unknown>;
    const body = str(row['efxp_RUT_RECEP']);
    const dv = str(row['efxp_DV_RECEP']);
    return {
      id: String(row['ehdr_CODIGO'] ?? ''),
      tipoDte: Number(row['ptdc_CODIGO'] ?? 0),
      tipoDteDesc: String(row['ptdc_CODIGO_DESC'] ?? ''),
      fecha: str(row['efxp_FCH_EMIS']),
      receptorRut: body && dv ? `${body}-${dv}` : null,
      receptorNombre: str(row['efxp_RZN_SOC_RECEP']),
      emisorNombre: str(row['efxp_RZN_SOC']),
      iva: num(row['efxp_IVA']),
      total: num(row['efxp_MNT_TOTAL']),
    };
  });
}

/** Fetch the PREVIEW PDF of a filled (unsigned) document — the "Validar y visualizar" path.
 *
 *  TWO hops, both first-hand-observed 2026-09-08:
 *    1. POST the VIEW_EFXP body to `mipeDisplayPreView.cgi` → the review page, whose
 *       `PreViewDTE` form carries the document as ~245 HIDDEN inputs.
 *    2. POST that `PreViewDTE` body to `mipePreView.cgi` → `application/pdf`.
 *
 *  Hop 2 is the PDF the portal embeds in its `framePdf` iframe: the document stamped
 *  "VISTA PREVIA / DOCUMENTO NO VALIDO", folio NOT assigned. Reaching the review page is NOT
 *  signing it — its `Firmar` button posts to `mipeGenXMLFirma.cgi`, which this module never
 *  calls (ADR-023).
 *
 *  Success is decided by `content-type` + the `%PDF` magic, NEVER by HTTP status — SII answers
 *  200 for its own error page and for the login-wall bounce too (the ADR-022 rule). */
export async function fetchPreviewPdf(
  session: PortalSession,
  filled: FacturaFilled,
): Promise<Uint8Array> {
  const review = await session.requestForm(PREVIEW_URL, { form: filled.fields });
  const fields = parseHiddenInputs(review.body, 'PreViewDTE');
  if (Object.keys(fields).length === 0) {
    throw new FacturaError(
      'El SII no entregó la vista previa del documento (no se encontró el formulario PreViewDTE). ' +
        'Puede que haya rechazado algún dato del documento.',
    );
  }
  const res = await session.requestBinary(PDF_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  const isPdf =
    (res.contentType ?? '').toLowerCase().includes('application/pdf') &&
    res.bytes.length > 4 &&
    res.bytes[0] === 0x25 && // %
    res.bytes[1] === 0x50 && // P
    res.bytes[2] === 0x44 && // D
    res.bytes[3] === 0x46; // F
  if (!isPdf) {
    throw new FacturaError(
      `El SII no devolvió un PDF de vista previa (content-type: ${res.contentType ?? 'desconocido'}).`,
    );
  }
  return res.bytes;
}
