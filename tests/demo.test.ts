// F7: demo determinista. Se ejecuta dos veces en raíces temporales (A y B) con copia de fixtures/.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { ejecutarDemo, type ResultadoDemo } from "../demo"
import { RAIZ_PROYECTO } from "../src/config"
import { ENCABEZADO_CONTROL, leerControl, leerJsonl, leerPayloadSellado, leerTrazabilidad } from "../src/persistencia"
import { OrdenRegistrada } from "../src/schemas"
import { CASOS_REALES, FIXTURES_REALES, crearRaizTemporal, huellaArbol, type RaizTemporal } from "./helpers"

const DIR_OUT_REAL = join(RAIZ_PROYECTO, "out")
let huellaInicialFixtures = ""
let outRealExistia = false
let a: RaizTemporal
let b: RaizTemporal
let demoA: ResultadoDemo
let demoB: ResultadoDemo

async function listar(dir: string): Promise<string[]> {
  const salida: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const ruta = join(dir, e.name)
    if (e.isDirectory()) salida.push(...(await listar(ruta)))
    else salida.push(ruta)
  }
  return salida.sort()
}

// Archivos de out/ como [ruta relativa con "/", contenido].
async function capturarOut(raiz: string): Promise<[string, Buffer][]> {
  const out = join(raiz, "out")
  const archivos = await listar(out)
  return Promise.all(archivos.map(async (f): Promise<[string, Buffer]> => [relative(out, f).replaceAll("\\", "/"), await readFile(f)]))
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex")
const paso = (r: ResultadoDemo, n: number) => {
  const p = r.pasos[n - 1]
  if (p === undefined) throw new Error(`no existe el paso ${n}`)
  return p
}

beforeAll(async () => {
  huellaInicialFixtures = await huellaArbol(FIXTURES_REALES)
  outRealExistia = existsSync(DIR_OUT_REAL)
  a = await crearRaizTemporal(CASOS_REALES)
  b = await crearRaizTemporal(CASOS_REALES)
  demoA = await ejecutarDemo(a.raiz)
  demoB = await ejecutarDemo(b.raiz)
})

afterAll(async () => {
  await a.limpiar()
  await b.limpiar()
})

describe("demo determinista", () => {
  test("A. la demo completa termina: 9 pasos y resumen esperado", () => {
    expect(demoA.pasos.map((p) => `${p.caso}:${p.resultado}`)).toEqual([
      "sol-001:exitoso",
      "sol-001:exitoso",
      "sol-002:bloqueado",
      "sol-003:bloqueado",
      "sol-004:pendiente",
      "sol-004:exitoso",
      "sol-005:pendiente",
      "sol-005:exitoso",
      "sol-006:pendiente",
    ])
    expect(demoA.resumen).toEqual({ ocs_creadas: 3, pendientes_finales: 1, bloqueados: 2, intentos_registrados: 9 })
    expect(paso(demoA, 3)).toMatchObject({ apta: false, bloqueos: ["RC1"], numero_oc: null })
    expect(paso(demoA, 4)).toMatchObject({ apta: false, bloqueos: ["RC2"], no_evaluables: ["RC3"], numero_oc: null })
  })

  test("B. control.csv: encabezado correcto, 9 filas y secuencia exacta", async () => {
    const crudo = await readFile(join(a.raiz, "out", "control.csv"), "utf8")
    expect(crudo.split("\n")[0]).toBe(ENCABEZADO_CONTROL)
    expect(crudo.trimEnd().split("\n")).toHaveLength(10)
    const control = await leerControl(a.raiz)
    expect(control.map((f) => `${f.solicitud_id}:${f.resultado}:${f.numero_oc || "—"}`)).toEqual([
      "SOL-2026-001:exitoso:4500000001",
      "SOL-2026-001:exitoso:4500000001",
      "SOL-2026-002:bloqueado:—",
      "SOL-2026-003:bloqueado:—",
      "SOL-2026-004:pendiente:—",
      "SOL-2026-004:exitoso:4500000002",
      "SOL-2026-005:pendiente:—",
      "SOL-2026-005:exitoso:4500000003",
      "SOL-2026-006:pendiente:—",
    ])
  })

  test("C. ordenes.jsonl: 3 líneas con IDs y números correctos", async () => {
    const ordenes = await leerJsonl(a.raiz, "sap/ordenes.jsonl", OrdenRegistrada)
    expect(ordenes.map((o) => [o.orden.referencia.solicitud_id, o.numero_oc, o.fecha])).toEqual([
      ["SOL-2026-001", "4500000001", "2026-09-03"],
      ["SOL-2026-004", "4500000002", "2026-09-03"],
      ["SOL-2026-005", "4500000003", "2026-09-03"],
    ])
  })

  test("D. sol-001: la segunda respuesta es idempotente y hay una sola OC persistida", async () => {
    expect(paso(demoA, 1)).toMatchObject({ numero_oc: "4500000001", idempotente: false })
    expect(paso(demoA, 2)).toMatchObject({ numero_oc: "4500000001", idempotente: true })
    const ordenes = await leerJsonl(a.raiz, "sap/ordenes.jsonl", OrdenRegistrada)
    expect(ordenes.filter((o) => o.orden.referencia.solicitud_id === "SOL-2026-001")).toHaveLength(1)
  })

  test("E. sol-004: pendiente (RC5) → exitosa con autorización; total 25.000.000", async () => {
    expect(paso(demoA, 5)).toMatchObject({ resultado: "pendiente", codigo: "CONFIRMACION_REQUERIDA", confirmaciones: ["RC5"], autorizado: false })
    expect(paso(demoA, 6)).toMatchObject({ resultado: "exitoso", numero_oc: "4500000002", autorizado: true })
    const ordenes = await leerJsonl(a.raiz, "sap/ordenes.jsonl", OrdenRegistrada)
    const pos = ordenes.find((o) => o.orden.referencia.solicitud_id === "SOL-2026-004")?.orden.posiciones[0]
    expect((pos?.cantidad ?? 0) * (pos?.precio_unitario ?? 0)).toBe(25_000_000)
  })

  test("F. sol-005: pendiente (RC8) → exitosa con autorización; retroactiva=true", async () => {
    expect(paso(demoA, 7)).toMatchObject({ resultado: "pendiente", confirmaciones: ["RC8"], retroactiva: true })
    expect(paso(demoA, 8)).toMatchObject({ resultado: "exitoso", numero_oc: "4500000003", retroactiva: true })
    const filas = (await leerControl(a.raiz)).filter((f) => f.solicitud_id === "SOL-2026-005")
    expect(filas.map((f) => [f.resultado, f.retroactiva])).toEqual([
      ["pendiente", true],
      ["exitoso", true],
    ])
  })

  test("G. sol-006: pendiente, sin OC; payload con C1 y Z030 derivados", async () => {
    expect(paso(demoA, 9)).toMatchObject({ resultado: "pendiente", confirmaciones: ["RC6"], numero_oc: null })
    expect(paso(demoA, 9).derivados).toMatchObject({ indicador_iva: { valor: "C1" }, condiciones_pago: { valor: "Z030" } })
    const sellado = await leerPayloadSellado(a.raiz, "sol-006")
    expect(sellado?.payload.posiciones[0]?.indicador_iva).toBe("C1")
    expect(sellado?.payload.condiciones_pago).toBe("Z030")
    const traza = await leerTrazabilidad(a.raiz, "sol-006")
    expect(traza?.campos.find((c) => c.ruta === "condiciones_pago")?.fuente).toBe("derivado")
    const ordenes = await leerJsonl(a.raiz, "sap/ordenes.jsonl", OrdenRegistrada)
    expect(ordenes.some((o) => o.orden.referencia.solicitud_id === "SOL-2026-006")).toBe(false)
  })

  test("H. artefactos correctos por caso", async () => {
    const archivos = (await capturarOut(a.raiz)).map(([ruta]) => ruta)
    const completo = ["aprobacion.txt", "ejecucion.json", "payload.json", "trazabilidad.json"]
    expect(archivos).toEqual(
      [
        "control.csv",
        "log.jsonl",
        "sap/ordenes.jsonl",
        ...completo.map((f) => `sol-001/${f}`),
        ...completo.map((f) => `sol-004/${f}`),
        ...completo.map((f) => `sol-005/${f}`),
        "sol-006/aprobacion.txt",
        "sol-006/payload.json",
        "sol-006/trazabilidad.json",
      ].sort(),
    )
    expect(existsSync(join(a.raiz, "out", "sol-002"))).toBe(false)
    expect(existsSync(join(a.raiz, "out", "sol-003"))).toBe(false)
  })

  test("I. dos ejecuciones producen artefactos y consola idénticos byte a byte", async () => {
    const outA = await capturarOut(a.raiz)
    const outB = await capturarOut(b.raiz)
    expect(outB.map(([ruta]) => ruta)).toEqual(outA.map(([ruta]) => ruta))
    for (const [i, [ruta, contenido]] of outA.entries()) {
      const otro = outB[i]?.[1]
      expect(otro !== undefined && Buffer.compare(contenido, otro) === 0).toBe(true)
      expect(sha(otro ?? Buffer.alloc(0))).toBe(sha(contenido))
      expect(ruta).toBe(outB[i]?.[0] ?? "")
    }
    expect(demoB.lineas).toEqual(demoA.lineas)
    expect(demoB.pasos).toEqual(demoA.pasos)
    // La consola no expone rutas absolutas.
    const consola = demoA.lineas.join("\n")
    for (const ruta of [a.raiz, a.raiz.replaceAll("\\", "/"), RAIZ_PROYECTO]) expect(consola).not.toContain(ruta)
  })

  test("J. fixtures/ intacto y out/ real sin modificar", async () => {
    expect(await huellaArbol(FIXTURES_REALES)).toBe(huellaInicialFixtures)
    expect(existsSync(DIR_OUT_REAL)).toBe(outRealExistia)
  })
})
