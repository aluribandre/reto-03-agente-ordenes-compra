import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { FECHA_REFERENCIA_DEMO, RAIZ_PROYECTO } from "../src/config"
import { evaluarControles } from "../src/domain/controles"
import { construirEvidencia, renderArchivoEvidencia, type DatosEvidencia } from "../src/domain/evidencia"
import { construirPayload, truncarDescripcion, type PayloadConstruido } from "../src/domain/payload"
import { jsonCanonico, payloadSha, sha256Hex } from "../src/domain/sello"
import { cargarMaestros } from "../src/ingestion/cargar"
import { AprobacionFixture, OrdenCompra, type ErrorTool, type Maestros, type Paquete, type ResultadoTool } from "../src/schemas"
import { CASOS_REALES, FIXTURES_REALES, cargarOk, huellaArbol } from "./helpers"

const DIR_OUT = join(RAIZ_PROYECTO, "out")
let maestros: Maestros
const paquetes = new Map<string, Paquete>()
const aprobaciones = new Map<string, DatosEvidencia>()
let huellaInicialFixtures = ""
let outExistiaAlInicio = false

beforeAll(async () => {
  huellaInicialFixtures = await huellaArbol(FIXTURES_REALES)
  outExistiaAlInicio = existsSync(DIR_OUT)
  const m = await cargarMaestros()
  if (!m.ok) throw new Error(`maestros: ${m.error.codigo}`)
  maestros = m.data
  for (const caso of CASOS_REALES) {
    paquetes.set(caso, await cargarOk(caso))
    const crudo: unknown = JSON.parse(await readFile(join(FIXTURES_REALES, "solicitudes", caso, "aprobacion.json"), "utf8"))
    aprobaciones.set(caso, AprobacionFixture.parse(crudo))
  }
})

function obtener<T>(mapa: Map<string, T>, caso: string): T {
  const v = mapa.get(caso)
  if (v === undefined) throw new Error(`no cargado: ${caso}`)
  return v
}

function variante(base: Paquete, cambio: (p: Paquete) => void): Paquete {
  const copia = structuredClone(base)
  cambio(copia)
  return copia
}

function construir(caso: string, ajuste?: (p: Paquete) => void): ResultadoTool<PayloadConstruido> {
  const base = obtener(paquetes, caso)
  const paquete = ajuste === undefined ? base : variante(base, ajuste)
  const evidencia = construirEvidencia(obtener(aprobaciones, caso))
  return construirPayload({
    paquete,
    maestros,
    evaluacion: evaluarControles(paquete, maestros),
    evidenciaSha256: evidencia.sha256,
    generadoEn: FECHA_REFERENCIA_DEMO,
  })
}

function ok(r: ResultadoTool<PayloadConstruido>): PayloadConstruido {
  if (!r.ok) throw new Error(`se esperaba ok: ${r.error.codigo} — ${r.error.mensaje}`)
  return r.data
}

function error(r: ResultadoTool<PayloadConstruido>): ErrorTool {
  if (r.ok) throw new Error("se esperaba error")
  return r.error
}

// Rutas de todas las hojas de un objeto, con el mismo formato que la trazabilidad.
function hojas(valor: unknown, ruta = ""): string[] {
  if (Array.isArray(valor)) return valor.flatMap((v: unknown, i) => hojas(v, `${ruta}[${i}]`))
  if (typeof valor === "object" && valor !== null) {
    return Object.entries(valor).flatMap(([k, v]) => hojas(v, ruta === "" ? k : `${ruta}.${k}`))
  }
  return [ruta]
}

// Nombres de todas las claves de objeto, a cualquier profundidad.
function claves(valor: unknown, acumulado = new Set<string>()): Set<string> {
  if (Array.isArray(valor)) for (const v of valor) claves(v, acumulado)
  else if (typeof valor === "object" && valor !== null) {
    for (const [k, v] of Object.entries(valor)) {
      acumulado.add(k)
      claves(v, acumulado)
    }
  }
  return acumulado
}

function reordenarClaves(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(reordenarClaves)
  if (typeof valor === "object" && valor !== null) {
    return Object.fromEntries(Object.entries(valor).reverse().map(([k, v]) => [k, reordenarClaves(v)]))
  }
  return valor
}

const FUENTES = new Set(["solicitud", "cotizacion", "derivado"])

// ---------------------------------------------------------------------------
// Casos reales
// ---------------------------------------------------------------------------

describe("payload de casos reales", () => {
  for (const caso of ["sol-001", "sol-004", "sol-005", "sol-006"]) {
    test(`${caso}: válido, trazado por completo, sin datos de ejecución`, () => {
      const r = ok(construir(caso))
      expect(OrdenCompra.safeParse(r.orden).success).toBe(true)
      expect(r.payload_sha).toBe(payloadSha(r.orden))
      expect(r.trazabilidad.payload_sha).toBe(r.payload_sha)
      expect(r.orden.sociedad).toBe("1000")
      expect(r.orden.organizacion_compras).toBe("1000")
      expect(r.orden.posiciones[0]?.descripcion.length).toBeLessThanOrEqual(40)
      expect(r.orden.excepciones.every((x) => x.confirmado_por === null)).toBe(true)
      // Cada hoja del payload tiene su entrada de trazabilidad, con una fuente permitida.
      expect(r.trazabilidad.campos.map((c) => c.ruta).sort()).toEqual(hojas(r.orden).sort())
      for (const c of r.trazabilidad.campos) expect(FUENTES.has(c.fuente) || /^maestro\.[a-z-]+$/.test(c.fuente)).toBe(true)
      expect(r.trazabilidad.controles).toHaveLength(10)
      // El payload no lleva claves de ejecución ni de runtime (los textos de detalle sí pueden mencionarlas).
      const presentes = claves(r.orden)
      for (const clave of ["numero_oc", "sessionId", "session_id", "turno_id", "autorizacion", "retroactiva", "generado_en", "ts", "fecha_creacion"]) {
        expect(presentes.has(clave)).toBe(false)
      }
      expect(JSON.stringify(r.trazabilidad)).not.toContain(RAIZ_PROYECTO.replaceAll("\\", "/"))
      expect(JSON.stringify(r.trazabilidad)).not.toContain(RAIZ_PROYECTO.replaceAll("\\", "\\\\"))
    })
  }

  test("sol-001: sin excepciones, datos del maestro y hash estable", () => {
    const a = ok(construir("sol-001"))
    expect(a.orden.excepciones).toEqual([])
    expect(a.confirmaciones).toEqual([])
    expect(a.orden.proveedor).toEqual({ codigo_sap: "100234", nit: "900555111", nombre: "TecnoSuministros S.A.S." })
    expect(a.orden.condiciones_pago).toBe("Z030")
    expect(a.orden.aprobador).toMatchObject({ email: "mlopez@periferia-ficticia.com", fecha_aprobacion: "2026-08-21" })
    expect(a.orden.posiciones[0]).toMatchObject({ numero: 10, unidad: "UN", cantidad: 120, precio_unitario: 95_000, indicador_iva: "C1", descripcion: "Renovación licencias antivirus" })
    expect(a.orden.referencia).toEqual({ solicitud_id: "SOL-2026-001", correo_id: "sol-001-correo", cotizacion_ref: "COT-TS-2026-0451" })
    expect(ok(construir("sol-001")).payload_sha).toBe(a.payload_sha)
  })

  test("sol-004: OC por COP 25.000.000 (no 26.500.000), RC5 sin confirmar, unidad H", () => {
    const r = ok(construir("sol-004"))
    const pos = r.orden.posiciones[0]
    expect(pos).toMatchObject({ cantidad: 100, precio_unitario: 250_000, unidad: "H", descripcion: "Bolsa de 100 horas de arquitectura de" })
    expect((pos?.cantidad ?? 0) * (pos?.precio_unitario ?? 0)).toBe(25_000_000)
    expect(pos?.precio_unitario).not.toBe(265_000)
    expect(r.orden.excepciones).toHaveLength(1)
    expect(r.orden.excepciones[0]).toMatchObject({ codigo: "RC5", confirmado_por: null })
    expect(r.confirmaciones).toEqual(["RC5"])
    expect(r.orden.condiciones_pago).toBe("Z000")
  })

  test("sol-005: excepción RC8; la marca retroactiva no forma parte de la OrdenCompra", () => {
    const r = ok(construir("sol-005"))
    expect(r.orden.excepciones.map((x) => x.codigo)).toEqual(["RC8"])
    expect("retroactiva" in r.orden).toBe(false)
    expect(r.orden.posiciones[0]).toMatchObject({ unidad: "UN", subarea: "Compras", centro_costo: "CC-2020" })
  })

  test("sol-006: IVA C1 y pago Z030 derivados; proveedor resuelto por nombre desde el maestro", () => {
    const r = ok(construir("sol-006"))
    expect(r.orden.proveedor).toEqual({ codigo_sap: "100234", nit: "900555111", nombre: "TecnoSuministros S.A.S." })
    expect(r.orden.posiciones[0]?.indicador_iva).toBe("C1")
    expect(r.orden.condiciones_pago).toBe("Z030")
    expect(r.orden.excepciones.map((x) => x.codigo)).toEqual(["RC6"])
    const traza = (ruta: string) => r.trazabilidad.campos.find((c) => c.ruta === ruta)
    expect(traza("posiciones[0].indicador_iva")).toMatchObject({ valor: "C1", fuente: "derivado" })
    expect(traza("condiciones_pago")).toMatchObject({ valor: "Z030", fuente: "derivado" })
    expect(traza("proveedor.codigo_sap")).toMatchObject({ fuente: "maestro.proveedores" })
    expect(traza("proveedor.codigo_sap")?.detalle).toContain("nombre")
  })
})

// ---------------------------------------------------------------------------
// Sintéticos A–F
// ---------------------------------------------------------------------------

describe("sintéticos de evidencia y payload", () => {
  test("A. orden distinto de claves → mismo payload_sha", () => {
    const r = ok(construir("sol-004"))
    const reordenado = reordenarClaves(r.orden)
    expect(JSON.stringify(reordenado)).not.toBe(JSON.stringify(r.orden))
    expect(jsonCanonico(reordenado)).toBe(jsonCanonico(r.orden))
    expect(payloadSha(OrdenCompra.parse(reordenado))).toBe(r.payload_sha)
  })

  test("B. misma evidencia → mismo hash; el hash cubre el contenido previo a la línea del hash", () => {
    const datos = obtener(aprobaciones, "sol-001")
    const a = construirEvidencia(datos)
    const b = construirEvidencia(structuredClone(datos))
    expect(b).toEqual(a)
    expect(a.sha256).toBe(sha256Hex(a.contenido))
    expect(construirEvidencia({ ...datos, cuerpo: datos.cuerpo.replaceAll("\n", "\r\n") }).sha256).toBe(a.sha256)
    expect(construirEvidencia({ ...datos, cuerpo: `${datos.cuerpo} ` }).sha256).not.toBe(a.sha256)
    expect(a.contenido).not.toContain("sha256")
    expect(renderArchivoEvidencia(a)).toBe(`${a.contenido}\n---\nsha256: ${a.sha256}\n`)
    expect(a.contenido.split("\n").slice(0, 5)).toEqual([
      "EVIDENCIA DE APROBACIÓN",
      "De: mlopez@periferia-ficticia.com",
      "Para: juan.camargo@periferia-ficticia.com",
      "Fecha: 2026-08-21T10:02:00-05:00",
      "Asunto: RE: Solicitud de orden de compra SOL-001",
    ])
  })

  test("C. descripción > 40 → truncado estable por palabra completa", () => {
    const larga = "Renovación licencias antivirus corporativo 120 puestos, vigencia 12 meses"
    expect(truncarDescripcion(larga)).toBe("Renovación licencias antivirus")
    expect(truncarDescripcion(larga)).toBe(truncarDescripcion(larga))
    expect(truncarDescripcion("Diademas con micrófono para la mesa de soporte")).toBe("Diademas con micrófono para la mesa de")
    expect(truncarDescripcion("Papelería y tóner para el trimestre")).toBe("Papelería y tóner para el trimestre")
    const palabra = "x".repeat(55)
    expect(truncarDescripcion(palabra)).toBe("x".repeat(40))
    expect(truncarDescripcion(`${"a".repeat(39)}, siguiente`)).toBe("a".repeat(39))
  })

  test("D. indicador de IVA inexistente → CATALOGO_INVALIDO", () => {
    const e = error(construir("sol-001", (p) => (p.solicitud.indicador_iva = "C9")))
    expect(e.codigo).toBe("CATALOGO_INVALIDO")
    expect(e.detalle).toEqual({ campo: "indicador_iva", valor: "C9", catalogo: "maestro.indicadores-iva" })
  })

  test("E. condición de pago inexistente → CATALOGO_INVALIDO", () => {
    const e = error(construir("sol-001", (p) => (p.solicitud.condiciones_pago = "Z999")))
    expect(e.codigo).toBe("CATALOGO_INVALIDO")
    expect(e.detalle).toEqual({ campo: "condiciones_pago", valor: "Z999", catalogo: "maestro.condiciones-pago" })
  })

  test("F. evaluación no apta → CASO_BLOQUEADO, sin payload", () => {
    const e2 = error(construir("sol-002"))
    expect(e2.codigo).toBe("CASO_BLOQUEADO")
    expect(e2.detalle).toEqual({ bloqueos: ["RC1"], no_evaluables: [] })
    const e3 = error(construir("sol-003"))
    expect(e3.codigo).toBe("CASO_BLOQUEADO")
    expect(e3.detalle).toEqual({ bloqueos: ["RC2"], no_evaluables: ["RC3"] })
  })
})

describe("invariantes", () => {
  test("fixtures/ intacto y sin escrituras en out/", async () => {
    expect(await huellaArbol(FIXTURES_REALES)).toBe(huellaInicialFixtures)
    expect(existsSync(DIR_OUT)).toBe(outExistiaAlInicio)
  })
})
