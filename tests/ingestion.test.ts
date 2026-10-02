import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { RAIZ_PROYECTO } from "../src/config"
import { fechaDe, normalizarEmail, normalizarNit, normalizarNombre, normalizarTexto, sumarDias } from "../src/domain/normalizar"
import { cargarMaestros } from "../src/ingestion/cargar"
import { contieneAprobado, parseCotizacion, parseFactura, parseMonto } from "../src/ingestion/parsers"
import {
  CASOS_REALES,
  FIXTURES_REALES,
  cargarError,
  cargarOk,
  convertirACrlf,
  crearRaizTemporal,
  huellaArbol,
} from "./helpers"

const DIR_OUT = join(RAIZ_PROYECTO, "out")
let huellaInicialFixtures = ""
let outExistiaAlInicio = false

beforeAll(async () => {
  huellaInicialFixtures = await huellaArbol(FIXTURES_REALES)
  outExistiaAlInicio = existsSync(DIR_OUT)
})

// ---------------------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------------------

describe("normalizar", () => {
  test("normalizarNit: solo dígitos y sin dígito de verificación separado por guion", () => {
    expect(normalizarNit("900.555.111-2")).toBe("900555111")
    expect(normalizarNit(" 830.111.222-8 ")).toBe("830111222")
    expect(normalizarNit("900555111")).toBe("900555111")
    expect(normalizarNit("1790012345001")).toBe("1790012345001")
    expect(normalizarNit("NIT sin dígitos")).toBe("")
  })

  test("normalizarNombre: minúsculas, sin tildes ni puntuación, conserva sufijos societarios", () => {
    expect(normalizarNombre("TecnoSuministros S.A.S.")).toBe("tecnosuministros sas")
    expect(normalizarNombre("Papelería Central Ltda.")).toBe("papeleria central ltda")
    expect(normalizarNombre("  Mobiliario   Andino  S.A. ")).toBe("mobiliario andino sa")
    expect(normalizarNombre("TECNOSUMINISTROS S.A.S")).toBe(normalizarNombre("TecnoSuministros S.A.S."))
  })

  test("normalizarEmail: trim, minúsculas y Unicode en NFC", () => {
    expect(normalizarEmail("  MLopez@Periferia-Ficticia.com ")).toBe("mlopez@periferia-ficticia.com")
    const descompuesto = "natalia.ri\u0301os@periferia-ficticia.com"
    expect(normalizarEmail(descompuesto)).toBe("natalia.ríos@periferia-ficticia.com")
  })

  test("normalizarTexto: CRLF→LF, CR→LF, NFC y sin BOM", () => {
    expect(normalizarTexto("a\r\nb\rc")).toBe("a\nb\nc")
    expect(normalizarTexto("\uFEFFhola")).toBe("hola")
    expect(normalizarTexto("Cotizacio\u0301n")).toBe("Cotización")
  })

  test("fechaDe: parte YYYY-MM-DD tal como viene escrita, sin convertir a UTC", () => {
    expect(fechaDe("2026-08-26T18:45:00-05:00")).toBe("2026-08-26")
    // 20:00 -05:00 es el día siguiente en UTC; la fecha de negocio no cambia.
    expect(fechaDe("2026-08-26T20:00:00-05:00")).toBe("2026-08-26")
    expect(fechaDe("2026-08-10")).toBe("2026-08-10")
    expect(fechaDe("2026-02-30")).toBeNull()
    expect(fechaDe("10/08/2026")).toBeNull()
  })

  test("sumarDias: aritmética de calendario sin zona horaria", () => {
    expect(sumarDias("2026-08-18", 30)).toBe("2026-09-17")
    expect(sumarDias("2026-08-20", 45)).toBe("2026-10-04")
    expect(sumarDias("2026-12-31", 1)).toBe("2027-01-01")
  })
})

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

describe("parsers", () => {
  test("parseMonto: formato COP de los fixtures, enteros", () => {
    expect(parseMonto("COP 11.400.000")).toEqual({ moneda: "COP", valor: 11_400_000 })
    expect(parseMonto("COP 3.200.000")).toEqual({ moneda: "COP", valor: 3_200_000 })
    expect(parseMonto("COP 950")).toEqual({ moneda: "COP", valor: 950 })
    expect(parseMonto("COP 11,400,000")).toBeNull()
    expect(parseMonto("COP 1.2345")).toBeNull()
    expect(parseMonto("once millones")).toBeNull()
  })

  test("parseCotizacion: ignora el NIT del cliente y toma el del proveedor", async () => {
    const r = parseCotizacion(await readFile(join(FIXTURES_REALES, "solicitudes", "sol-001", "cotizacion.txt"), "utf8"))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.valor.nit).toBe("900555111")
    expect(r.valor.numero).toBe("COT-TS-2026-0451")
    expect(r.valor.moneda).toBe("COP")
    expect(r.valor.texto).not.toContain("\r")
  })

  test("parseFactura: número, fecha y total de sol-005", async () => {
    const r = parseFactura(await readFile(join(FIXTURES_REALES, "solicitudes", "sol-005", "factura.txt"), "utf8"))
    expect(r).toEqual({ ok: true, valor: { numero: "FC-88231", fecha: "2026-08-10", total: 3_200_000 } })
  })

  test("contieneAprobado: 'Aprobado' sin distinguir mayúsculas (regla literal, sin negaciones)", () => {
    expect(contieneAprobado("Aprobado.\n\nMariana López")).toBe(true)
    expect(contieneAprobado("APROBADO")).toBe(true)
    expect(contieneAprobado("aprobado por 25 millones")).toBe(true)
    expect(contieneAprobado("Revisado, pendiente.")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Los 6 fixtures reales
// ---------------------------------------------------------------------------

const ESPERADO = {
  "sol-001": { total: 11_400_000, numero: "COT-TS-2026-0451", nit: "900555111", proveedor: "TecnoSuministros S.A.S.", validez: "2026-09-17", aprobador: "mlopez@periferia-ficticia.com" },
  "sol-002": { total: 8_500_000, numero: "SDN-0093", nit: "901999000", proveedor: "Soluciones Digitales del Norte S.A.S.", validez: "2026-09-05", aprobador: "mlopez@periferia-ficticia.com" },
  "sol-003": { total: 74_000_000, numero: "MA-2026-1177", nit: "830111222", proveedor: "Mobiliario Andino S.A.", validez: "2026-10-04", aprobador: "fvargas@periferia-ficticia.com" },
  "sol-004": { total: 26_500_000, numero: "CA-2026-0310", nit: "901222333", proveedor: "Cloud Andina S.A.S.", validez: "2026-09-14", aprobador: "dgarcia@periferia-ficticia.com" },
  "sol-005": { total: 3_200_000, numero: "PC-5520", nit: "800444555", proveedor: "Papelería Central Ltda.", validez: "2026-09-04", aprobador: "rtorres@periferia-ficticia.com" },
  "sol-006": { total: 5_400_000, numero: "COT-TS-2026-0468", nit: "900555111", proveedor: "TecnoSuministros S.A.S.", validez: "2026-09-27", aprobador: "mlopez@periferia-ficticia.com" },
} as const

describe("fixtures reales", () => {
  for (const [caso, e] of Object.entries(ESPERADO)) {
    test(`${caso}: paquete canónico`, async () => {
      const p = await cargarOk(caso)
      expect(p.cotizacion).toMatchObject({ total: e.total, moneda: "COP", numero: e.numero, nit: e.nit, proveedor: e.proveedor, validez_hasta: e.validez })
      expect(p.aprobacion).toMatchObject({ de: e.aprobador, aprobado: true })
      expect(p.solicitud.solicitud_id).toBe(`SOL-2026-${caso.slice(-3)}`)
      expect(p.correo.id).toBe(`${caso}-correo`)
      expect(p.faltantes).toEqual([])
      // nota_fixture y el cuerpo del correo de solicitud no llegan al dominio.
      expect(Object.keys(p.correo).sort()).toEqual(["asunto", "de", "fecha", "id"])
      const serializado = JSON.stringify(p)
      expect(serializado).not.toContain("nota_fixture")
      expect(serializado).not.toContain("se entregan normalizados")
      expect(serializado).not.toContain("Hola Camila")
    })
  }

  test("sol-005: factura con fecha 2026-08-10", async () => {
    const p = await cargarOk("sol-005")
    expect(p.factura).toEqual({ numero: "FC-88231", fecha: "2026-08-10", total: 3_200_000 })
  })

  test("solo sol-005 trae factura", async () => {
    for (const caso of CASOS_REALES.filter((c) => c !== "sol-005")) {
      expect((await cargarOk(caso)).factura).toBeNull()
    }
  })

  test("sol-006: sin NIT, sin indicador de IVA y sin condiciones de pago en la solicitud", async () => {
    const p = await cargarOk("sol-006")
    expect("proveedor_nit" in p.solicitud).toBe(false)
    expect("indicador_iva" in p.solicitud).toBe(false)
    expect("condiciones_pago" in p.solicitud).toBe(false)
  })

  test("maestros reales: tipados y completos", async () => {
    const r = await cargarMaestros()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.proveedores).toHaveLength(5)
    expect(r.data.centros_costo).toHaveLength(3)
    expect(r.data.indicadores_iva).toHaveLength(3)
    expect(r.data.condiciones_pago).toHaveLength(4)
  })

  test("la carga es determinista", async () => {
    for (const caso of CASOS_REALES) {
      expect(await cargarOk(caso)).toEqual(await cargarOk(caso))
    }
  })
})

// ---------------------------------------------------------------------------
// Sintéticos A–F (directorios temporales fuera de fixtures/)
// ---------------------------------------------------------------------------

describe("sintéticos de ingestión", () => {
  test("A. cotización ausente → null + faltante archivo_ausente (no es error)", async () => {
    const t = await crearRaizTemporal()
    try {
      await t.borrar("sol-001", "cotizacion.txt")
      const p = await cargarOk("sol-001", t.raiz)
      expect(p.cotizacion).toBeNull()
      expect(p.faltantes).toEqual([{ pieza: "cotizacion", archivo: "cotizacion.pdf", motivo: "archivo_ausente" }])
    } finally {
      await t.limpiar()
    }
  })

  test("B. cotización presente pero ilegible → INSUMO_ILEGIBLE", async () => {
    const t = await crearRaizTemporal()
    try {
      const original = await t.leer("sol-001", "cotizacion.txt")
      await t.escribir("sol-001", "cotizacion.txt", original.replace(/^TOTAL.*$/m, ""))
      const sinTotal = await cargarError("sol-001", t.raiz)
      expect(sinTotal.codigo).toBe("INSUMO_ILEGIBLE")
      expect(sinTotal.detalle?.["archivo"]).toBe("solicitudes/sol-001/cotizacion.txt")

      await t.escribir("sol-001", "cotizacion.txt", original.replace(/^TOTAL.*$/m, "TOTAL (IVA incluido): once millones"))
      expect((await cargarError("sol-001", t.raiz)).codigo).toBe("INSUMO_ILEGIBLE")
    } finally {
      await t.limpiar()
    }
  })

  test("C. JSON malformado → JSON_MALFORMADO", async () => {
    const t = await crearRaizTemporal()
    try {
      const original = await t.leer("sol-001", "solicitud.json")
      await t.escribir("sol-001", "solicitud.json", original.slice(0, original.length / 2))
      const e = await cargarError("sol-001", t.raiz)
      expect(e.codigo).toBe("JSON_MALFORMADO")
      expect(e.detalle?.["archivo"]).toBe("solicitudes/sol-001/solicitud.json")
    } finally {
      await t.limpiar()
    }
  })

  test("D. monto no numérico → MONTO_NO_NUMERICO", async () => {
    const t = await crearRaizTemporal()
    try {
      const original = await t.leer("sol-001", "solicitud.json")
      await t.escribir("sol-001", "solicitud.json", original.replace('"valor_total": 11400000', '"valor_total": "11.400.000"'))
      const e = await cargarError("sol-001", t.raiz)
      expect(e.codigo).toBe("MONTO_NO_NUMERICO")
      expect(e.detalle?.["campos"]).toEqual(["valor_total"])
    } finally {
      await t.limpiar()
    }
  })

  test("E. path traversal y casos inválidos → CASO_INVALIDO", async () => {
    const intentos = ["../algo", "..", "../maestros", "sol-001/../../x", "sol-001\\..\\..", "/etc/passwd", "C:\\Windows", "SOL-001", ""]
    for (const caso of intentos) {
      expect((await cargarError(caso)).codigo).toBe("CASO_INVALIDO")
    }
  })

  test("F. CRLF produce el mismo paquete canónico que LF", async () => {
    const t = await crearRaizTemporal(["sol-001", "sol-005"])
    try {
      await convertirACrlf(join(t.raiz, "fixtures"))
      expect(await t.leer("sol-005", "factura.txt")).toContain("\r\n")
      for (const caso of ["sol-001", "sol-005"]) {
        expect(await cargarOk(caso, t.raiz)).toEqual(await cargarOk(caso))
      }
    } finally {
      await t.limpiar()
    }
  })
})

// ---------------------------------------------------------------------------
// Invariantes de seguridad
// ---------------------------------------------------------------------------

describe("invariantes de seguridad", () => {
  test("caso inexistente → CASO_INEXISTENTE con los casos disponibles (sin rutas)", async () => {
    const e = await cargarError("sol-999")
    expect(e.codigo).toBe("CASO_INEXISTENTE")
    expect(e.detalle?.["casos_disponibles"]).toEqual([...CASOS_REALES])
  })

  test("ninguna excepción sale de cargarCaso ni de cargarMaestros", async () => {
    for (const entrada of [123, null, undefined, {}, ["sol-001"]]) {
      expect((await cargarError(entrada)).codigo).toBe("CASO_INVALIDO")
    }
    const raizInexistente = join(RAIZ_PROYECTO, "no-existe-esta-raiz")
    expect((await cargarError("sol-001", raizInexistente)).codigo).toBe("CASO_INEXISTENTE")
    const maestros = await cargarMaestros({ raiz: raizInexistente })
    expect(maestros.ok ? null : maestros.error.codigo).toBe("MAESTRO_INVALIDO")
  })

  test("rutas absolutas no aparecen en paquetes ni en errores", async () => {
    const prohibidas = [RAIZ_PROYECTO, RAIZ_PROYECTO.replaceAll("\\", "/")]
    const t = await crearRaizTemporal()
    try {
      await t.escribir("sol-001", "solicitud.json", "{")
      const salidas: unknown[] = [await cargarError("sol-001", t.raiz), await cargarError("sol-999"), await cargarError("../x")]
      for (const caso of CASOS_REALES) salidas.push(await cargarOk(caso))
      for (const salida of salidas) {
        const s = JSON.stringify(salida)
        for (const ruta of [...prohibidas, t.raiz, t.raiz.replaceAll("\\", "/")]) expect(s).not.toContain(ruta)
      }
    } finally {
      await t.limpiar()
    }
  })

  test("el texto con instrucciones se conserva como dato, sin efectos", async () => {
    // La aprobación real de sol-005 pide "crear la OC": es contenido, no una orden.
    const p = await cargarOk("sol-005")
    expect(p.aprobacion?.texto).toContain("por favor crear la OC")
    expect(p.aprobacion?.aprobado).toBe(true)
    expect(existsSync(DIR_OUT)).toBe(outExistiaAlInicio)
  })

  test("la carga no escribe en out/ ni en las raíces temporales", async () => {
    const t = await crearRaizTemporal(CASOS_REALES)
    try {
      for (const caso of CASOS_REALES) await cargarOk(caso, t.raiz)
      expect(existsSync(join(t.raiz, "out"))).toBe(false)
      expect(existsSync(DIR_OUT)).toBe(outExistiaAlInicio)
    } finally {
      await t.limpiar()
    }
  })

  // Debe ejecutarse al final del archivo (bun ejecuta los tests en orden).
  test("fixtures/ no fue modificado por la suite", async () => {
    expect(await huellaArbol(FIXTURES_REALES)).toBe(huellaInicialFixtures)
  })
})
