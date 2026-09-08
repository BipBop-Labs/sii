# Wire contract — Factura electrónica (Portal MIPYME)

The SII's **free** facturación electrónica portal ("Sistema de facturación gratuito del SII",
`www.sii.cl/servicios_online/1039-1183.html`). All CGIs live under
`https://www1.sii.cl/cgi-bin/Portal001/`; the borradores listing is served by the MIPYME SPA on
`www4.sii.cl`. The `.sii.cl` Clave-Tributaria session cookie SSO-carries to both.

**Observed first-hand 2026-09-08** (own session, DTE 33, a real borrador created → listed →
previewed → deleted). No third-party source (ADR-004).

> **Scope: borradores only (ADR-023).** The emission path is documented here so the boundary is
> unambiguous, but `mipeGenXMLFirma.cgi` is NEVER called by this codebase.

## Authorization model — empresa-keyed

Not body-RUT (RCV) and not session-keyed (F22/F29/BHE). The portal has its **own** authorization
list: the empresas that registered the authenticated user as *usuario autorizado*. The working
empresa is whatever RUT was last POSTed to `mipeSelEmpresa.cgi`, and it scopes the form, the
borrador CRUD **and** the borradores listing. Every operation therefore selects the empresa first.

## 1. Empresa chooser

```
GET  /cgi-bin/Portal001/mipeSelEmpresa.cgi?DESDE_DONDE_URL=OPCION%3D33%26TIPO%3D4
POST /cgi-bin/Portal001/mipeSelEmpresa.cgi   { DESDE_DONDE_URL: "OPCION=33&TIPO=4", RUT_EMP: "76192083-9" }
```

`Content-Type: text/html; charset=ISO-8859-1`. The GET returns the chooser; the options are
**unclosed** and repeat the RUT in the label:

```html
<select class="form-control" name="RUT_EMP">
  <optgroup label="Seleccione una opción">
    <option value="77111222-6">TALLER DEL SUR LTDA 77111222-6
    <option value="76192083-9">ACME REPUESTOS SPA 76192083-9
  </optgroup>
</select>
```

The POST forwards to the factura form. Getting the chooser **back** means SII refused the empresa.

`DESDE_DONDE_URL` is an unkeyed `OPCION=<tipo DTE>&TIPO=4` pair; `OPCION` is the DTE code
(33 factura, 34 exenta, 46 factura de compra, 43 liquidación, 110 exportación).

## 2. The factura form — `mipeGenFacEx.cgi`

```
GET /cgi-bin/Portal001/mipeGenFacEx.cgi?PTDC_CODIGO=33                       # blank
GET /cgi-bin/Portal001/mipeGenFacEx.cgi?PTDC_CODIGO=33&ES_BORR=TRUE&VALOR=<id>
      &IGUAL=CODIGO&RUT=<body>&DV=<dv>&TPO_DOC_GEN=33                        # an existing borrador
```

**The static HTML carries EMPTY values.** The emisor context (`EFXP_CDG_SII_SUCUR`,
`EFXP_DIR_ORIGEN`, `EFXP_GIRO_EMIS`, `EFXP_ACTECO`, `EFXP_EMAIL_EMISOR`) and the whole detail
grid are populated **client-side** by the page's JS (`datosArray`, `dibujaDetalles`). A cold
`requestForm` GET therefore reads blanks — the form must be driven through
`PortalSession.goto` + `evaluate`, like the BTE inline-JS-map facade (CONVENTIONS).

Form name: `VIEW_EFXP`. Its default action is `mipeDisplayPreView.cgi`.

### Fields that matter

| Field | Notes |
| --- | --- |
| `PTDC_CODIGO` | DTE type (33). |
| `CANT_DET` | Number of detail rows. Grow it with `modCantLineaDet(btn)`; ceiling `cantTotCol = 10`. |
| `ES_BORR` | `FALSE` on the emisión path, `TRUE` for borrador operations. |
| `EHDR_CODIGO` | Borrador id — empty = create, set = update. |
| `EFXP_CDG_SII_SUCUR` | Sucursal, JS-populated. |
| `EFXP_FCH_EMIS` | `YYYY-MM-DD` (`<input type=date>`). |
| `EFXP_CIUDAD_ORIGEN` | **Emisor ciudad. SII leaves it BLANK but its own validator demands it** — the caller must supply it. It also does NOT survive the *Corregir* round trip. |
| `EFXP_RUT_RECEP` / `EFXP_DV_RECEP` | Receptor RUT, split. |
| `EFXP_RZN_SOC_RECEP`, `EFXP_DIR_RECEP`, `EFXP_CMNA_RECEP`, `EFXP_CIUDAD_RECEP`, `EFXP_GIRO_RECEP`, `EFXP_CONTACTO` | Receptor block. Comuna/ciudad are FREE TEXT — no código lookup (unlike BHE). |
| `EFXP_NMB_nn` | Item name (`nn` = `01`…`10`). |
| `DESCRIP_nn` | Checkbox whose `onclick` **draws** the `EFXP_DSC_ITEM_nn` textarea. The textarea does not exist until it is clicked. |
| `EFXP_QTY_nn`, `EFXP_UNMD_nn`, `EFXP_PRC_nn`, `EFXP_PCTD_nn` | Cantidad, unidad, precio unitario, % descuento. |
| `EFXP_SUBT_nn` | Line subtotal — computed by the page's JS on `change`. |
| `EFXP_FMA_PAGO` | `1` contado, `2` crédito, `3` sin costo. |
| `EFXP_MNT_NETO`, `EFXP_TASA_IVA` (19), `EFXP_IVA`, `EFXP_MNT_TOTAL` | Totals, JS-computed (`IVA = round(neto × 0.19)`). |

### Two observed hazards

1. **Receptor autofill.** Firing a `change`/`blur` on `EFXP_RUT_RECEP` makes the portal re-POST
   the form to look the RUT up in SII's registry — it comes back with `EFXP_RZN_SOC_RECEP`,
   `EFXP_DIR_RECEP`, `EFXP_CMNA_RECEP`, `EFXP_CIUDAD_RECEP` and `EFXP_GIRO_RECEP` filled from the
   registry, but the **page reloads and the detail grid is wiped**. Assign the receptor fields
   *without* dispatching events.
2. **Client-side validation is authoritative.** `validaFacEx(btn)` (in
   `Portal001/JS/validaFacEx.js`) `alert()`s the exact refusals SII would otherwise bounce
   ("Debe ingresar Ciudad del contribuyente emisor", "Debe ingresar el campo : Giro del
   contribuyente receptor"). Run it in-page and surface its message verbatim — posting an
   invalid document instead just gets redirected back to the form with the same alert.

## 3. Borrador CRUD

Both take the **whole `VIEW_EFXP` body** with `ES_BORR=TRUE`, and answer `200` with an HTML
confirmation page (so success is decided by the TEXT, not the status):

```
POST /cgi-bin/Portal001/mipeGrabaBorrador.cgi     → "Su documento borrador ha sido grabado/actualizado con éxito"
POST /cgi-bin/Portal001/mipeEliminaBorrador.cgi   → "... ha sido eliminado ..."
```

Create vs update is decided by `EHDR_CODIGO`. **`mipeGrabaBorrador.cgi` does not return the new
id** — re-read the listing and diff.

Observed in the page (`Button_Update_Borrador` / `Button_Delete_Borrador` onclick):

```js
VIEW_EFXP.action='/cgi-bin/Portal001/mipeGrabaBorrador.cgi';   document.getElementById('ES_BORR').value='TRUE';
VIEW_EFXP.action='/cgi-bin/Portal001/mipeEliminaBorrador.cgi'; document.getElementById('ES_BORR').value='TRUE';
```

## 4. Borradores listing (SPA JSON)

```
GET https://www4.sii.cl/mipymeinternetui/services/data/borradorService/listaBorrador
```

`application/json;charset=ISO-8859-1`. A **bare JSON array** — *not* the SDI `respEstado`
envelope, so no zod envelope parse applies. Each row carries ~250 form columns, almost all
`null`; only these are populated for a listing:

| Key | Meaning |
| --- | --- |
| `ehdr_CODIGO` | Borrador id |
| `ptdc_CODIGO` / `ptdc_CODIGO_DESC` | `"33"` / `"Factura Electronica"` |
| `efxp_FCH_EMIS` | `"2026-09-08 15:49:20"` |
| `efxp_RUT_RECEP` / `efxp_DV_RECEP` | Receptor RUT |
| `efxp_RZN_SOC_RECEP` | Receptor razón social |
| `efxp_RZN_SOC` | Emisor razón social |
| `efxp_IVA`, `efxp_MNT_TOTAL` | Montos, as digit strings |

Scoped to the empresa selected in step 1. Max 100 borradores (stated on the page).

Related endpoints on the same service: `rutEmpresa` (current empresa), `getProperty/<key>`.

## 5. Preview PDF — "Validar y visualizar"

Two hops. `Button_Update` ("Validar y visualizar") posts `VIEW_EFXP` to:

```
POST /cgi-bin/Portal001/mipeDisplayPreView.cgi     → text/html, the review page
```

The review page ("REVISIÓN DE DOCUMENTO TRIBUTARIO ELECTRÓNICO") carries the document as ~245
**hidden inputs** in a form named `PreViewDTE`, plus an iframe `framePdf`
(`/Portal001/PreViewFrame.html`) which posts that same body to:

```
POST /cgi-bin/Portal001/mipePreView.cgi            → application/pdf
                                                     content-disposition: inline; filename=<rut>-<n>.pdf
```

That is the real PDF, stamped **"VISTA PREVIA · DOCUMENTO NO VALIDO"** with *"FOLIO NO ASIGNADO"*.
The hidden inputs are uniform and double-quoted:

```html
<input type="hidden" name="EFXP_RZN_SOC" value="ACME SPA" maxlength="110" size="50">
```

Success is decided by `content-type` + the `%PDF` magic, never by HTTP status (ADR-022).

## 6. Emission — OUT OF SCOPE (documented for the boundary only)

The review page's `Firmar` button:

```js
function goSignDTE(btn) { document.forms["PreViewDTE"].action = "/cgi-bin/Portal001/mipeGenXMLFirma.cgi";
                          document.forms["PreViewDTE"].submit(); }
```

**Notable:** signing is **server-side**. There is no applet, no browser certificate, no
`.pfx` — the Clave Tributaria session alone is enough for SII to sign and emit a legally-binding
factura. That is precisely why this codebase stops at the borrador (ADR-023).
