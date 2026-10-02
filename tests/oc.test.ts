// F5: infraestructura (SAP simulado + persistencia). Todo se escribe en raíces temporales del SO.
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FECHA_REFERENCIA_DEMO, RAIZ_PROYECTO, crearReloj, type Reloj } from "../src/config"
import { cargarMaestros } from "../src/ingestion/cargar"
import {
  ENCABEZADO_CONTROL,
  ErrorPersistencia,
  appendControl,
  appendJsonl,
  escribirEjecucion,
  escribirPayloadSellado,
  leerControl,
  leerEjecucion,
  leerJsonl,
  leerPayloadSellado,
  limpiarOut,
} from "../src/persistencia"
import { MockSapAdapter } from "../src/sap/mock"
import { OrdenCompra, OrdenRegistrada, type FilaControl, type Proveedor } from "../src/schemas"
import { FIXTURES_REALES, huellaArbol } from "./helpers"

const DIR_OUT_REAL = join(RAIZ_PROYECTO, "out")
let proveedores: Proveedor[] = []
let huellaInicialFixtures = ""
let outRealExistia = false
const raices: string[] = []

beforeAll(async () => {
  huellaInicialFixtures = await huellaArbol(FIXTURES_REALES)
  outRealExistia = existsSync(DIR_OUT_REAL)
  const m = await cargarMaestros()
  if (!m.ok) throw new Error(`maestros: ${m.error.codigo}`)
  proveedores = m.data.proveedores
})

afterEach(async () => {
  for (const raiz of raices.splice(0)) await rm(raiz, { recursive: true, force: true })
})

async function nuevaRaiz(): Promise<string> {
  const raiz = await mkdtemp(join(tmpdir(), "reto03-oc-"))
  raices.push(raiz)
  return raiz
}

function mock(raiz: string, reloj: Reloj = crearReloj(FECHA_REFERENCIA_DEMO)): MockSapAdapter {
  return new MockSapAdapter({ raiz, reloj, proveedores })
}

function orden(solicitudId: string): OrdenCompra {
  return OrdenCompra.parse({
    referencia: { solicitud_id: solicitudId, correo_id: "correo-prueba", cotizacion_ref: null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: "100234", nit: "900555111", nombre: "TecnoSuministros S.A.S." },
    moneda: "COP",
    condiciones_pago: "Z030",
    aprobador: { email: "mlopez@periferia-ficticia.com", fecha_aprobacion: "2026-08-21", evidencia_sha256: "a".repeat(64) },
    posiciones: [
      { numero: 10, descripcion: "Prueba", cantidad: 1, unidad: "UN", precio_unitario: 1000, centro_costo: "CC-1010", subarea: "Soporte", indicador_iva: "C1" },
    ],
    excepciones: [],
  })
}

const leerOrdenes = (raiz: string) => leerJsonl(raiz, "sap/ordenes.jsonl", OrdenRegistrada)
const leerCrudo = (raiz: string, relativa: string) => readFile(join(raiz, "out", relativa), "utf8")

function fila(solicitud_id: string, resultado: FilaControl["resultado"], extra: Partial<FilaControl> = {}): FilaControl {
  return { solicitud_id, resultado, numero_oc: "", retroactiva: false, bloqueos: [], confirmaciones: [], ts: FECHA_REFERENCIA_DEMO, ...extra }
}

// ---------------------------------------------------------------------------

describe("SAP simulado", () => {
  test("A. numeración: primera OC 4500000001, siguiente 4500000002", async () => {
    const sap = mock(await nuevaRaiz())
    expect(await sap.crearOrden(orden("SOL-A-1"))).toEqual({ numero_oc: "4500000001", fecha: "2026-09-03" })
    expect(await sap.crearOrden(orden("SOL-A-2"))).toEqual({ numero_oc: "4500000002", fecha: "2026-09-03" })
  })

  test("B. búsqueda por referencia: encuentra la solicitud registrada", async () => {
    const sap = mock(await nuevaRaiz())
    expect(await sap.buscarOrdenPorReferencia("SOL-B-1")).toBeNull()
    await sap.crearOrden(orden("SOL-B-1"))
    expect(await sap.buscarOrdenPorReferencia("SOL-B-1")).toEqual({ numero_oc: "4500000001" })
    expect(await sap.buscarOrdenPorReferencia("SOL-B-2")).toBeNull()
  })

  test("consultarProveedor: datos del maestro, sin inventar", async () => {
    const sap = mock(await nuevaRaiz())
    expect(await sap.consultarProveedor("900.555.111-2")).toEqual({ codigo_sap: "100234", activo: true })
    expect(await sap.consultarProveedor("901777888")).toEqual({ codigo_sap: "100402", activo: false })
    expect(await sap.consultarProveedor("901999000")).toBeNull()
  })

  test("C. idempotencia secuencial: mismo solicitud_id → una línea, mismo número", async () => {
    const raiz = await nuevaRaiz()
    const sap = mock(raiz)
    const primera = await sap.crearOrden(orden("SOL-C-1"))
    const segunda = await sap.crearOrden(orden("SOL-C-1"))
    expect(segunda).toEqual(primera)
    expect(await leerOrdenes(raiz)).toHaveLength(1)
    // Una instancia nueva del mock (p. ej. tras reiniciar) ve el mismo estado.
    expect(await mock(raiz).crearOrden(orden("SOL-C-1"))).toEqual(primera)
    expect(await leerOrdenes(raiz)).toHaveLength(1)
  })

  test("D. doble intento concurrente: una sola OC, mismo número en ambas respuestas", async () => {
    const raiz = await nuevaRaiz()
    const [a, b] = await Promise.all([mock(raiz).crearOrden(orden("SOL-D-1")), mock(raiz).crearOrden(orden("SOL-D-1"))])
    expect(a).toEqual(b)
    expect(a?.numero_oc).toBe("4500000001")
    const registradas = await leerOrdenes(raiz)
    expect(registradas).toHaveLength(1)
    // Concurrencia con solicitudes distintas: números únicos y consecutivos.
    const varias = await Promise.all(["SOL-D-2", "SOL-D-3", "SOL-D-4", "SOL-D-2"].map((id) => mock(raiz).crearOrden(orden(id))))
    expect(new Set(varias.map((r) => r.numero_oc))).toEqual(new Set(["4500000002", "4500000003", "4500000004"]))
    expect(await leerOrdenes(raiz)).toHaveLength(4)
  })

  test("E. reloj inyectado: fecha reproducible, sin Date.now()", async () => {
    const r1 = await mock(await nuevaRaiz()).crearOrden(orden("SOL-E-1"))
    const r2 = await mock(await nuevaRaiz()).crearOrden(orden("SOL-E-1"))
    expect(r1).toEqual(r2)
    expect(r1.fecha).toBe("2026-09-03")
    const otra = await mock(await nuevaRaiz(), crearReloj("2027-01-15T10:00:00-05:00")).crearOrden(orden("SOL-E-1"))
    expect(otra.fecha).toBe("2027-01-15")
  })
})

describe("persistencia", () => {
  test("F. append JSONL: líneas completas en orden estable, también con escrituras concurrentes", async () => {
    const raiz = await nuevaRaiz()
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendJsonl(raiz, "prueba.jsonl", { i, texto: `línea ${i}` })))
    const crudo = await leerCrudo(raiz, "prueba.jsonl")
    expect(crudo.endsWith("\n")).toBe(true)
    const lineas = crudo.trimEnd().split("\n")
    expect(lineas).toHaveLength(20)
    for (const l of lineas) expect(() => JSON.parse(l)).not.toThrow()
    // Orden estable: las escrituras secuenciales conservan su orden.
    for (const i of [100, 101, 102]) await appendJsonl(raiz, "secuencial.jsonl", { i })
    const secuencial = (await leerCrudo(raiz, "secuencial.jsonl")).trimEnd().split("\n").map((l) => JSON.parse(l))
    expect(secuencial).toEqual([{ i: 100 }, { i: 101 }, { i: 102 }])
  })

  test("G. control.csv: encabezado una sola vez y solo estados exitoso/bloqueado/pendiente", async () => {
    const raiz = await nuevaRaiz()
    const filas = [
      fila("SOL-2026-001", "exitoso", { numero_oc: "4500000001" }),
      fila("SOL-2026-002", "bloqueado", { bloqueos: ["RC1"] }),
      fila("SOL-2026-005", "pendiente", { retroactiva: true, confirmaciones: ["RC8"] }),
    ]
    for (const f of filas) await appendControl(raiz, f)
    const lineas = (await leerCrudo(raiz, "control.csv")).trimEnd().split("\n")
    expect(lineas[0]).toBe(ENCABEZADO_CONTROL)
    expect(lineas.filter((l) => l === ENCABEZADO_CONTROL)).toHaveLength(1)
    expect(lineas).toHaveLength(4)
    expect(await leerControl(raiz)).toEqual(filas)
    for (const invalido of ["idempotente", "error"]) {
      const f = { ...fila("SOL-X", "exitoso"), resultado: invalido } as unknown as FilaControl
      await expect(appendControl(raiz, f)).rejects.toBeInstanceOf(ErrorPersistencia)
    }
    expect((await leerCrudo(raiz, "control.csv")).trimEnd().split("\n")).toHaveLength(4)
  })

  test("H. escritura atómica: archivo final válido, sin temporales; rutas fuera de out/ rechazadas", async () => {
    const raiz = await nuevaRaiz()
    const sellado = { payload: orden("SOL-H-1"), payload_sha: "b".repeat(64), confirmaciones: [], construido_en: FECHA_REFERENCIA_DEMO }
    expect(await escribirPayloadSellado(raiz, "sol-001", sellado)).toBe("out/sol-001/payload.json")
    expect(await leerPayloadSellado(raiz, "sol-001")).toEqual(sellado)
    const ejecucion = { numero_oc: "4500000001", fecha: "2026-09-03", payload_sha: "b".repeat(64), idempotente: false, autorizacion: null }
    expect(await escribirEjecucion(raiz, "sol-001", ejecucion)).toBe("out/sol-001/ejecucion.json")
    await escribirEjecucion(raiz, "sol-001", { ...ejecucion, idempotente: true })
    expect(await leerEjecucion(raiz, "sol-001")).toEqual({ ...ejecucion, idempotente: true })
    // El payload sellado no se tocó al registrar la ejecución.
    expect(await leerPayloadSellado(raiz, "sol-001")).toEqual(sellado)
    expect((await readdir(join(raiz, "out", "sol-001"))).sort()).toEqual(["ejecucion.json", "payload.json"])
    await expect(escribirPayloadSellado(raiz, "../fuera", sellado)).rejects.toBeInstanceOf(ErrorPersistencia)
    await expect(appendJsonl(raiz, "../fuera.jsonl", {})).rejects.toBeInstanceOf(ErrorPersistencia)
    expect(existsSync(join(raiz, "fuera.jsonl"))).toBe(false)
  })

  test("I. limpiarOut: borra solo out/ y se niega ante una ruta ajena", async () => {
    const raiz = await nuevaRaiz()
    await mkdir(join(raiz, "out", "sap"), { recursive: true })
    await writeFile(join(raiz, "out", "sap", "ordenes.jsonl"), "{}\n")
    await mkdir(join(raiz, "fixtures"), { recursive: true })
    await writeFile(join(raiz, "fixtures", "intacto.txt"), "no borrar")
    await writeFile(join(raiz, "hermano.txt"), "no borrar")

    await expect(limpiarOut(raiz, join(raiz, "fixtures"))).rejects.toBeInstanceOf(ErrorPersistencia)
    await expect(limpiarOut(raiz, raiz)).rejects.toBeInstanceOf(ErrorPersistencia)
    await expect(limpiarOut(raiz, join(raiz, "out", "sap"))).rejects.toBeInstanceOf(ErrorPersistencia)
    expect(existsSync(join(raiz, "out", "sap", "ordenes.jsonl"))).toBe(true)

    await limpiarOut(raiz)
    expect(existsSync(join(raiz, "out"))).toBe(false)
    expect(await readFile(join(raiz, "fixtures", "intacto.txt"), "utf8")).toBe("no borrar")
    expect(await readFile(join(raiz, "hermano.txt"), "utf8")).toBe("no borrar")
  })

  test("J. fixtures/ intacto y out/ real sin crear", async () => {
    expect(await huellaArbol(FIXTURES_REALES)).toBe(huellaInicialFixtures)
    expect(existsSync(DIR_OUT_REAL)).toBe(outRealExistia)
  })
})
