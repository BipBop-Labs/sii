// Facade tests for the MIPYME factura surface. No real SII: the fake session scripts the
// observed wire shapes (docs/sii-contract/factura.md, captured 2026-09-08). Synthetic,
// Mod-11-valid RUTs only — never real PII.
import { describe, expect, it } from 'vitest';
import { FakePortalSession } from '../adapters/fake/index.js';
import { FacturaError } from '../errors/index.js';
import { Rut } from '../rut/index.js';
import {
  fetchBorradores,
  fetchEmpresas,
  fetchPreviewPdf,
  fillFactura,
  grabaBorrador,
  loadBorrador,
  resolveAndSelectEmpresa,
} from './factura.js';
import type { FacturaEmpresa } from './factura.js';

/** The `RUT_EMP` select exactly as SII serves it: unclosed `<option>`, label repeats the RUT. */
const EMPRESAS_HTML = `<form name="fPrmEmpPOP" method="post">
  <select class="form-control" name="RUT_EMP">
    <optgroup label="Seleccione una opcion">
      <option value="76192083-9">ACME REPUESTOS SPA 76192083-9
      <option value="77111222-6">TALLER DEL SUR LTDA 77111222-6
    </optgroup>
  </select></form>`;

const EMPRESA: FacturaEmpresa = { rut: '76192083-9', nombre: 'ACME REPUESTOS SPA' };

const INPUT = {
  empresa: '76192083-9',
  tipoDte: 33 as const,
  fechaEmision: '2026-09-08',
  ciudadEmisor: 'SANTIAGO',
  receptor: {
    rut: '64000001',
    dv: '5',
    razonSocial: 'CLIENTE DE PRUEBA SPA',
    direccion: 'Calle Falsa 123',
    comuna: 'Arica',
    ciudad: 'Arica',
    giro: 'Comercio',
  },
  items: [{ nombre: 'Servicio', cantidad: 1, precioUnitario: 1000 }],
  formaPago: 'credito' as const,
};

/** A fill that SII's own validator accepted. */
const okFill = () => ({
  ok: true,
  msgs: [],
  missing: [],
  fields: { EFXP_NMB_01: 'Servicio', EFXP_MNT_TOTAL: '1190' },
  totales: { neto: 1000, iva: 190, total: 1190 },
});

describe('fetchEmpresas', () => {
  it('parses the authorized list and strips the RUT repeated in the label', async () => {
    const s = new FakePortalSession({ requestForm: () => EMPRESAS_HTML });
    await expect(fetchEmpresas(s, 33)).resolves.toEqual([
      { rut: '76192083-9', nombre: 'ACME REPUESTOS SPA' },
      { rut: '77111222-6', nombre: 'TALLER DEL SUR LTDA' },
    ]);
  });

  it('fails loudly when the select is gone (scraper roto)', async () => {
    const s = new FakePortalSession({ requestForm: () => '<html>mantención</html>' });
    await expect(fetchEmpresas(s, 33)).rejects.toBeInstanceOf(FacturaError);
  });
});

describe('resolveAndSelectEmpresa', () => {
  it('selects a RUT that is in the list', async () => {
    const s = new FakePortalSession({
      requestForm: (url) => (url.includes('?') ? EMPRESAS_HTML : '<html>formulario</html>'),
    });
    await expect(resolveAndSelectEmpresa(s, Rut.parse('76192083-9'), 33)).resolves.toEqual(EMPRESA);
  });

  it('rejects a RUT outside the MIPYME list and names the available ones', async () => {
    const s = new FakePortalSession({ requestForm: () => EMPRESAS_HTML });
    await expect(resolveAndSelectEmpresa(s, Rut.parse('77777777-7'), 33)).rejects.toThrow(
      /no está en tus empresas.*76192083-9/s,
    );
  });

  it('rejects when SII bounces back to the chooser', async () => {
    const s = new FakePortalSession({ requestForm: () => EMPRESAS_HTML }); // POST returns the form again
    await expect(resolveAndSelectEmpresa(s, Rut.parse('76192083-9'), 33)).rejects.toThrow(
      /no aceptó la empresa/,
    );
  });
});

describe('fillFactura', () => {
  it('navigates to the blank form and returns SII-computed totals', async () => {
    const s = new FakePortalSession({ evaluate: okFill });
    const r = await fillFactura(s, EMPRESA, INPUT);
    expect(r.totales).toEqual({ neto: 1000, iva: 190, total: 1190 });
    expect(s.gotos[0]).toContain('mipeGenFacEx.cgi?PTDC_CODIGO=33');
    expect(s.gotos[0]).not.toContain('ES_BORR');
  });

  it('navigates to the borrador URL when updating one', async () => {
    const s = new FakePortalSession({ evaluate: okFill });
    await fillFactura(s, EMPRESA, { ...INPUT, borradorId: '5000001' });
    expect(s.gotos[0]).toContain('ES_BORR=TRUE&VALOR=5000001');
    expect(s.gotos[0]).toContain('RUT=76192083&DV=9');
  });

  it("passes SII's own validation message through verbatim", async () => {
    const s = new FakePortalSession({
      evaluate: () => ({ ok: false, msgs: ['Debe ingresar Ciudad del contribuyente emisor'] }),
    });
    await expect(fillFactura(s, EMPRESA, INPUT)).rejects.toThrow(
      'Debe ingresar Ciudad del contribuyente emisor',
    );
  });

  it('fails loudly when the form lost a field (scraper roto)', async () => {
    const s = new FakePortalSession({ evaluate: () => ({ ok: true, missing: ['EFXP_NMB_01'] }) });
    await expect(fillFactura(s, EMPRESA, INPUT)).rejects.toThrow(/cambió de forma.*EFXP_NMB_01/);
  });

  it('rejects a login-wall / wrong landing', async () => {
    const s = new FakePortalSession({ landingUrl: 'https://zeusr.sii.cl/AUT2000/' });
    await expect(fillFactura(s, EMPRESA, INPUT)).rejects.toThrow(/no entregó el formulario/);
  });
});

describe('grabaBorrador', () => {
  it('POSTs the filled form with ES_BORR=TRUE and accepts the confirmation', async () => {
    const s = new FakePortalSession({
      requestForm: () => 'Su documento borrador ha sido grabado/actualizado con éxito',
    });
    await grabaBorrador(s, {
      fields: { EFXP_NMB_01: 'x' },
      totales: { neto: 1, iva: 0, total: 1 },
    });
    expect(s.lastFormRequest?.url).toContain('mipeGrabaBorrador.cgi');
    expect(s.lastFormRequest?.options?.form?.['ES_BORR']).toBe('TRUE');
  });

  it('fails when SII does not confirm', async () => {
    const s = new FakePortalSession({ requestForm: () => '<p>La empresa no está autorizada</p>' });
    await expect(
      grabaBorrador(s, { fields: {}, totales: { neto: 0, iva: 0, total: 0 } }),
    ).rejects.toThrow(/no está autorizada/);
  });
});

describe('loadBorrador', () => {
  it('refuses a borrador SII substituted for another', async () => {
    const s = new FakePortalSession({
      evaluate: () => ({ scraper: 'el SII devolvió otro borrador (999)' }),
    });
    await expect(loadBorrador(s, EMPRESA, 33, '5000001')).rejects.toThrow(/otro borrador/);
  });
});

describe('fetchBorradores', () => {
  it('curates the listing columns and drops the ~250 null form columns', async () => {
    const s = new FakePortalSession({
      requestJson: () => [
        {
          ehdr_CODIGO: '5000001',
          ptdc_CODIGO: '33',
          ptdc_CODIGO_DESC: 'Factura Electronica',
          efxp_FCH_EMIS: '2026-09-08 15:49:20',
          efxp_RUT_RECEP: '64000001',
          efxp_DV_RECEP: '5',
          efxp_RZN_SOC_RECEP: 'CLIENTE DE PRUEBA SPA',
          efxp_RZN_SOC: 'ACME REPUESTOS SPA',
          efxp_IVA: '190000',
          efxp_MNT_TOTAL: '1190000',
          efxp_NMB_07: null,
        },
      ],
    });
    const rows = await fetchBorradores(s);
    expect(rows).toEqual([
      {
        id: '5000001',
        tipoDte: 33,
        tipoDteDesc: 'Factura Electronica',
        fecha: '2026-09-08 15:49:20',
        receptorRut: '64000001-5',
        receptorNombre: 'CLIENTE DE PRUEBA SPA',
        emisorNombre: 'ACME REPUESTOS SPA',
        iva: 190000,
        total: 1190000,
      },
    ]);
    // no `raw`: the row is receptor + emisor identity (ADR-004)
    expect(Object.keys(rows[0] ?? {})).not.toContain('raw');
  });

  it('treats an empty list as zero borradores, not an error', async () => {
    const s = new FakePortalSession({ requestJson: () => [] });
    await expect(fetchBorradores(s)).resolves.toEqual([]);
  });
});

describe('fetchPreviewPdf', () => {
  const REVIEW = `<form name="PreViewDTE" method="post" action="/cgi-bin/Portal001/mipeGenFacEx.cgi">
    <input type="hidden" name="PTDC_CODIGO" value="33">
    <input type="hidden" name="EFXP_RZN_SOC" value="ACME &amp; CIA" maxlength="110">
    </form>`;
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

  it('posts the PreViewDTE body to the PDF CGI and returns the bytes', async () => {
    const s = new FakePortalSession({
      requestForm: () => REVIEW,
      requestBinary: () => PDF,
    });
    await expect(
      fetchPreviewPdf(s, { fields: { A: '1' }, totales: { neto: 1, iva: 0, total: 1 } }),
    ).resolves.toEqual(PDF);
    expect(s.lastBinaryRequest?.url).toContain('mipePreView.cgi');
    // the review page's hidden inputs are forwarded, HTML-unescaped
    expect(s.lastBinaryRequest?.options?.body).toContain('EFXP_RZN_SOC=ACME+%26+CIA');
  });

  it('rejects when SII answers 200 with an error page instead of a PDF (ADR-022)', async () => {
    const s = new FakePortalSession({
      requestForm: () => REVIEW,
      requestBinary: () => ({
        status: 200,
        contentType: 'text/html',
        bytes: new Uint8Array([0x3c, 0x68, 0x74, 0x6d]),
      }),
    });
    await expect(
      fetchPreviewPdf(s, { fields: {}, totales: { neto: 0, iva: 0, total: 0 } }),
    ).rejects.toThrow(/no devolvió un PDF/);
  });

  it('rejects when the review page has no PreViewDTE form', async () => {
    const s = new FakePortalSession({ requestForm: () => '<html>error</html>' });
    await expect(
      fetchPreviewPdf(s, { fields: {}, totales: { neto: 0, iva: 0, total: 0 } }),
    ).rejects.toThrow(/no entregó la vista previa/);
  });
});
