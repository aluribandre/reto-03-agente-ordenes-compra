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
import { z } from "zod"
import { renderArchivoEvidencia } from "../src/domain/evidencia"
import type { SapAdapter } from "../src/sap/adapter"
import { MockSapAdapter } from "../src/sap/mock"
import {
  DataConstruirPayload,
  DataCrear,
  DataEvidencia,
  DataLeerPaquete,
  DataValidar,
  Ejecucion,
  ErrorTool,
  LineaLog,
  OrdenCompra,
  OrdenRegistrada,
  PayloadSellado,
  Trazabilidad,
  esquemaResultado,
  type Autorizacion,
  type FilaControl,
  type Proveedor,
} from "../src/schemas"
import { crearHerramientasOc, registroOc, type HerramientasOc } from "../src/tools/oc"
import { ejecutarTool, type ContextoTool, type Herramienta } from "../src/tools/runner"
import { CASOS_REALES, FIXTURES_REALES, crearRaizTemporal, huellaArbol } from "./helpers"

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

// ===========================================================================
// F6: tools + runner (raíces temporales con copia de fixtures/)
// ===========================================================================

const SESION = "sesion-test"
const TURNO = "turno-1"

async function raizConCasos(): Promise<string> {
  const t = await crearRaizTemporal(CASOS_REALES)
  raices.push(t.raiz)
  return t.raiz
}

function ctxDe(raiz: string, extra: Partial<ContextoTool> = {}): ContextoTool {
  return { directory: raiz, sessionId: SESION, turnoId: TURNO, reloj: crearReloj(FECHA_REFERENCIA_DEMO), ...extra }
}

function llamar(raiz: string, nombre: string, args: unknown, extra: Partial<ContextoTool> = {}, registro = registroOc()): Promise<string> {
  const herramienta = registro[nombre]
  if (herramienta === undefined) throw new Error(`tool desconocida: ${nombre}`)
  return ejecutarTool(nombre, herramienta, args, ctxDe(raiz, extra), { cronometro: () => 0 })
}

const Fallo = z.object({ ok: z.literal(false), error: ErrorTool })
const Exito = z.object({ ok: z.literal(true), data: z.unknown() })

async function ok<S extends z.ZodType>(esquema: S, salida: Promise<string>): Promise<z.output<S>> {
  const crudo: unknown = JSON.parse(await salida)
  const f = Fallo.safeParse(crudo)
  if (f.success) throw new Error(`se esperaba ok: ${f.data.error.codigo} — ${f.data.error.mensaje}`)
  return esquema.parse(Exito.parse(crudo).data)
}

async function falla(salida: Promise<string>): Promise<ErrorTool> {
  const crudo: unknown = JSON.parse(await salida)
  return Fallo.parse(crudo).error
}

async function prepararCaso(raiz: string, caso: string): Promise<string> {
  await ok(DataEvidencia, llamar(raiz, "oc_generar_evidencia", { caso }))
  return (await ok(DataConstruirPayload, llamar(raiz, "oc_construir_payload", { caso }))).payload_sha
}

function autorizacion(caso: string, payload_sha: string, extra: Partial<Autorizacion> = {}): Autorizacion {
  return {
    id: "aut-1",
    accion: "crear_oc",
    caso,
    payload_sha,
    session_id: SESION,
    turno_id: TURNO,
    actor: `analista@sesion:${SESION}`,
    origen: "boton",
    otorgada_en: FECHA_REFERENCIA_DEMO,
    consumida: false,
    ...extra,
  }
}

const ordenesDe = (raiz: string) => leerJsonl(raiz, "sap/ordenes.jsonl", OrdenRegistrada)
const logDe = (raiz: string) => leerJsonl(raiz, "log.jsonl", LineaLog)
const leerJsonOut = async <S extends z.ZodType>(raiz: string, rel: string, esquema: S): Promise<z.infer<S>> =>
  esquema.parse(JSON.parse(await leerCrudo(raiz, rel)))

describe("F6 · tools de lectura y validación", () => {
  test("A. oc_leer_paquete: válido, inválido y error de ingestión", async () => {
    const raiz = await raizConCasos()
    const p = await ok(DataLeerPaquete, llamar(raiz, "oc_leer_paquete", { caso: "sol-001" }))
    expect(p.solicitud.solicitud_id).toBe("SOL-2026-001")
    expect(JSON.stringify(p)).not.toContain("nota_fixture")
    expect((await falla(llamar(raiz, "oc_leer_paquete", { caso: "../x" }))).codigo).toBe("ARGS_INVALIDOS")
    expect((await falla(llamar(raiz, "oc_leer_paquete", { caso: "sol-999" }))).codigo).toBe("CASO_INEXISTENTE")
    await writeFile(join(raiz, "fixtures", "reto-03", "solicitudes", "sol-002", "solicitud.json"), "{ roto")
    expect((await falla(llamar(raiz, "oc_leer_paquete", { caso: "sol-002" }))).codigo).toBe("JSON_MALFORMADO")
  })

  test("B. oc_validar: los 6 casos, sin escrituras salvo el log del runner", async () => {
    const raiz = await raizConCasos()
    const esperado: Record<string, [boolean, string[], string[]]> = {
      "sol-001": [true, [], []],
      "sol-002": [false, ["RC1"], []],
      "sol-003": [false, ["RC2"], []],
      "sol-004": [true, [], ["RC5"]],
      "sol-005": [true, [], ["RC8"]],
      "sol-006": [true, [], ["RC6"]],
    }
    for (const [caso, [apta, bloqueos, confirmaciones]] of Object.entries(esperado)) {
      const v = await ok(DataValidar, llamar(raiz, "oc_validar", { caso }))
      expect(v.apta).toBe(apta)
      expect(v.bloqueos.map((b): string => b.regla)).toEqual(bloqueos)
      expect(v.confirmaciones.map((c): string => c.regla)).toEqual(confirmaciones)
    }
    expect(await readdir(join(raiz, "out"))).toEqual(["log.jsonl"])
    expect(await logDe(raiz)).toHaveLength(6)
  })
})

describe("F6 · evidencia y payload", () => {
  test("C. oc_generar_evidencia: escribe, hash correcto, idempotente; bloqueado no genera archivo", async () => {
    const raiz = await raizConCasos()
    const e1 = await ok(DataEvidencia, llamar(raiz, "oc_generar_evidencia", { caso: "sol-001" }))
    expect(e1).toMatchObject({ ruta: "out/sol-001/aprobacion.txt", ruta_pdf: null, reutilizada: false })
    const archivo = await leerCrudo(raiz, "sol-001/aprobacion.txt")
    expect(archivo.endsWith(`\n---\nsha256: ${e1.sha256}\n`)).toBe(true)
    const contenido = archivo.slice(0, archivo.lastIndexOf("\n---\n"))
    expect(renderArchivoEvidencia({ contenido, sha256: e1.sha256 })).toBe(archivo)

    const e2 = await ok(DataEvidencia, llamar(raiz, "oc_generar_evidencia", { caso: "sol-001" }))
    expect(e2).toMatchObject({ sha256: e1.sha256, reutilizada: true })

    await writeFile(join(raiz, "out", "sol-001", "aprobacion.txt"), "alterado")
    expect((await falla(llamar(raiz, "oc_generar_evidencia", { caso: "sol-001" }))).codigo).toBe("EVIDENCIA_INCONSISTENTE")
    expect(await leerCrudo(raiz, "sol-001/aprobacion.txt")).toBe("alterado")

    expect((await falla(llamar(raiz, "oc_generar_evidencia", { caso: "sol-002" }))).codigo).toBe("CASO_BLOQUEADO")
    expect(existsSync(join(raiz, "out", "sol-002"))).toBe(false)
  })

  test("D. oc_construir_payload: sol-001, sol-004, write-once y trazabilidad correspondiente", async () => {
    const raiz = await raizConCasos()
    expect((await falla(llamar(raiz, "oc_construir_payload", { caso: "sol-001" }))).codigo).toBe("FALTA_EVIDENCIA")

    await ok(DataEvidencia, llamar(raiz, "oc_generar_evidencia", { caso: "sol-001" }))
    const p1 = await ok(DataConstruirPayload, llamar(raiz, "oc_construir_payload", { caso: "sol-001" }))
    expect(p1).toMatchObject({ requiere_confirmacion: false, ruta_payload: "out/sol-001/payload.json", ruta_trazabilidad: "out/sol-001/trazabilidad.json" })

    await ok(DataEvidencia, llamar(raiz, "oc_generar_evidencia", { caso: "sol-004" }))
    const p4 = await ok(DataConstruirPayload, llamar(raiz, "oc_construir_payload", { caso: "sol-004" }))
    expect(p4.requiere_confirmacion).toBe(true)
    expect(p4.confirmaciones.map((c) => c.regla)).toEqual(["RC5"])
    expect(p4.payload.posiciones[0]).toMatchObject({ cantidad: 100, precio_unitario: 250_000 })

    // Write-once, mismo hash: se reutiliza sin reescribir (aunque el reloj cambie).
    const antes = await leerCrudo(raiz, "sol-004/payload.json")
    const otraVez = await ok(DataConstruirPayload, llamar(raiz, "oc_construir_payload", { caso: "sol-004" }, { reloj: crearReloj("2026-09-10T00:00:00-05:00") }))
    expect(otraVez.payload_sha).toBe(p4.payload_sha)
    expect(await leerCrudo(raiz, "sol-004/payload.json")).toBe(antes)

    // Intento de overwrite con otro payload (la solicitud cambió tras sellar): rechazado, sin sobrescribir.
    const rutaSolicitud = join(raiz, "fixtures", "reto-03", "solicitudes", "sol-004", "solicitud.json")
    const solicitud = await readFile(rutaSolicitud, "utf8")
    await writeFile(rutaSolicitud, solicitud.replace("Bolsa de 100 horas", "Paquete de 100 horas"))
    const conflicto = await falla(llamar(raiz, "oc_construir_payload", { caso: "sol-004" }))
    expect(conflicto.codigo).toBe("PAYLOAD_NO_COINCIDE")
    expect(conflicto.detalle).toMatchObject({ motivo: "sello_distinto", payload_sha_sellado: p4.payload_sha })
    expect(await leerCrudo(raiz, "sol-004/payload.json")).toBe(antes)

    const sellado = await leerJsonOut(raiz, "sol-004/payload.json", PayloadSellado)
    const traza = await leerJsonOut(raiz, "sol-004/trazabilidad.json", Trazabilidad)
    expect(traza.payload_sha).toBe(sellado.payload_sha)
  })
})

describe("F6 · oc_crear", () => {
  test("E–F. sol-001: crea sin autorización; el segundo intento es idempotente", async () => {
    const raiz = await raizConCasos()
    const sha = await prepararCaso(raiz, "sol-001")
    const c1 = await ok(DataCrear, llamar(raiz, "oc_crear", { caso: "sol-001", payload_sha: sha }))
    expect(c1).toMatchObject({ numero_oc: "4500000001", fecha: "2026-09-03", idempotente: false, autorizacion_id: null, retroactiva: false })
    expect(await leerJsonOut(raiz, "sol-001/ejecucion.json", Ejecucion)).toMatchObject({ numero_oc: "4500000001", idempotente: false, autorizacion: null })

    const c2 = await ok(DataCrear, llamar(raiz, "oc_crear", { caso: "sol-001", payload_sha: sha }))
    expect(c2).toMatchObject({ numero_oc: "4500000001", idempotente: true })
    expect(await ordenesDe(raiz)).toHaveLength(1)
    expect((await leerControl(raiz)).map((f) => [f.resultado, f.numero_oc])).toEqual([
      ["exitoso", "4500000001"],
      ["exitoso", "4500000001"],
    ])
  })

  test("G. sol-002: bloqueado, fila de control 'bloqueado', sin OC", async () => {
    const raiz = await raizConCasos()
    const e = await falla(llamar(raiz, "oc_crear", { caso: "sol-002" }))
    expect(e.codigo).toBe("CASO_BLOQUEADO")
    expect(await leerControl(raiz)).toEqual([
      { solicitud_id: "SOL-2026-002", resultado: "bloqueado", numero_oc: "", retroactiva: false, bloqueos: ["RC1"], confirmaciones: [], ts: FECHA_REFERENCIA_DEMO },
    ])
    expect(await ordenesDe(raiz)).toEqual([])
  })

  test("H–I. sol-004: sin autorización queda pendiente; con autorización válida se crea por 25.000.000", async () => {
    const raiz = await raizConCasos()
    const sha = await prepararCaso(raiz, "sol-004")
    const pendiente = await falla(llamar(raiz, "oc_crear", { caso: "sol-004", payload_sha: sha }))
    expect(pendiente.codigo).toBe("CONFIRMACION_REQUERIDA")
    expect(await ordenesDe(raiz)).toEqual([])

    const payloadAntes = await leerCrudo(raiz, "sol-004/payload.json")
    const creada = await ok(DataCrear, llamar(raiz, "oc_crear", { caso: "sol-004", payload_sha: sha }, { autorizacion: autorizacion("sol-004", sha) }))
    expect(creada).toMatchObject({ numero_oc: "4500000001", idempotente: false, autorizacion_id: "aut-1" })
    const [registrada] = await ordenesDe(raiz)
    const pos = registrada?.orden.posiciones[0]
    expect((pos?.cantidad ?? 0) * (pos?.precio_unitario ?? 0)).toBe(25_000_000)
    expect(registrada?.orden.excepciones).toEqual([expect.objectContaining({ codigo: "RC5", confirmado_por: null })])
    // La autorización vive en ejecucion.json; el payload sellado no se modificó.
    expect((await leerJsonOut(raiz, "sol-004/ejecucion.json", Ejecucion)).autorizacion?.id).toBe("aut-1")
    expect(await leerCrudo(raiz, "sol-004/payload.json")).toBe(payloadAntes)
    expect((await leerControl(raiz)).map((f) => [f.resultado, f.confirmaciones.join(";")])).toEqual([
      ["pendiente", "RC5"],
      ["exitoso", "RC5"],
    ])
  })

  test("J. autorización incorrecta (otro payload, sesión, turno, caso o consumida) → sin OC", async () => {
    const raiz = await raizConCasos()
    const sha = await prepararCaso(raiz, "sol-004")
    const variantes: [Autorizacion, string][] = [
      [autorizacion("sol-004", "c".repeat(64)), "payload_sha"],
      [autorizacion("sol-004", sha, { session_id: "otra-sesion" }), "session_id"],
      [autorizacion("sol-004", sha, { turno_id: "turno-0" }), "turno_id"],
      [autorizacion("sol-005", sha), "caso"],
      [autorizacion("sol-004", sha, { consumida: true }), "consumida"],
    ]
    for (const [aut, motivo] of variantes) {
      const e = await falla(llamar(raiz, "oc_crear", { caso: "sol-004", payload_sha: sha }, { autorizacion: aut }))
      expect([e.codigo, e.detalle?.["motivo"]]).toEqual(["AUTORIZACION_INVALIDA", motivo])
    }
    expect(await ordenesDe(raiz)).toEqual([])
    expect((await leerControl(raiz)).every((f) => f.resultado === "pendiente")).toBe(true)
  })

  test("K. payload manipulado o payload_sha ajeno → PAYLOAD_NO_COINCIDE, sin OC", async () => {
    const raiz = await raizConCasos()
    const sha = await prepararCaso(raiz, "sol-001")
    expect((await falla(llamar(raiz, "oc_crear", { caso: "sol-001", payload_sha: "d".repeat(64) }))).detalle?.["motivo"]).toBe("payload_sha_distinto")

    const ruta = join(raiz, "out", "sol-001", "payload.json")
    await writeFile(ruta, (await readFile(ruta, "utf8")).replace('"precio_unitario": 95000', '"precio_unitario": 1'))
    const e = await falla(llamar(raiz, "oc_crear", { caso: "sol-001", payload_sha: sha }))
    expect([e.codigo, e.detalle?.["motivo"]]).toEqual(["PAYLOAD_NO_COINCIDE", "hash_almacenado_no_coincide"])
    expect(await ordenesDe(raiz)).toEqual([])
  })

  test("L. SAP que falla → SAP_ERROR sin fila exitosa; el reintento posterior crea la OC", async () => {
    const raiz = await raizConCasos()
    const sha = await prepararCaso(raiz, "sol-001")
    const sapQueFalla: SapAdapter = {
      consultarProveedor: async () => null,
      buscarOrdenPorReferencia: async () => null,
      crearOrden: async () => {
        throw new Error("timeout simulado")
      },
    }
    const conFalla = registroOc(crearHerramientasOc({ crearSap: () => sapQueFalla }))
    const e = await falla(llamar(raiz, "oc_crear", { caso: "sol-001", payload_sha: sha }, {}, conFalla))
    expect(e.codigo).toBe("SAP_ERROR")
    expect(JSON.stringify(e)).not.toContain("timeout simulado")
    expect(await ordenesDe(raiz)).toEqual([])
    expect((await leerControl(raiz)).filter((f) => f.resultado === "exitoso")).toEqual([])

    const reintento = await ok(DataCrear, llamar(raiz, "oc_crear", { caso: "sol-001", payload_sha: sha }))
    expect(reintento).toMatchObject({ numero_oc: "4500000001", idempotente: false })
  })

  test("Flujo de los 6 casos (sección 13)", async () => {
    const raiz = await raizConCasos()
    const resultados: Record<string, string> = {}
    for (const caso of CASOS_REALES) {
      const v = await ok(DataValidar, llamar(raiz, "oc_validar", { caso }))
      if (!v.apta) {
        resultados[caso] = (await falla(llamar(raiz, "oc_crear", { caso }))).codigo
        continue
      }
      const sha = await prepararCaso(raiz, caso)
      const sinAut = esquemaResultado(DataCrear).parse(JSON.parse(await llamar(raiz, "oc_crear", { caso, payload_sha: sha })))
      if (sinAut.ok) {
        resultados[caso] = `OC ${sinAut.data.numero_oc}`
        continue
      }
      resultados[caso] = sinAut.error.codigo
      if (caso === "sol-004" || caso === "sol-005") {
        const c = await ok(DataCrear, llamar(raiz, "oc_crear", { caso, payload_sha: sha }, { autorizacion: autorizacion(caso, sha) }))
        resultados[caso] += ` → OC ${c.numero_oc}${c.retroactiva ? " retroactiva" : ""}`
      }
    }
    expect(resultados).toEqual({
      "sol-001": "OC 4500000001",
      "sol-002": "CASO_BLOQUEADO",
      "sol-003": "CASO_BLOQUEADO",
      "sol-004": "CONFIRMACION_REQUERIDA → OC 4500000002",
      "sol-005": "CONFIRMACION_REQUERIDA → OC 4500000003 retroactiva",
      "sol-006": "CONFIRMACION_REQUERIDA",
    })
    expect(await ordenesDe(raiz)).toHaveLength(3)
    const control = await leerControl(raiz)
    expect(control.map((f) => `${f.solicitud_id}:${f.resultado}`)).toEqual([
      "SOL-2026-001:exitoso",
      "SOL-2026-002:bloqueado",
      "SOL-2026-003:bloqueado",
      "SOL-2026-004:pendiente",
      "SOL-2026-004:exitoso",
      "SOL-2026-005:pendiente",
      "SOL-2026-005:exitoso",
      "SOL-2026-006:pendiente",
    ])
    expect(control.filter((f) => f.solicitud_id === "SOL-2026-005").every((f) => f.retroactiva)).toBe(true)
  })
})

describe("F6 · runner", () => {
  test("M. args inválidos, excepción interna, una línea de log por llamada, log saneado y no fatal", async () => {
    const raiz = await raizConCasos()
    const args1 = await falla(llamar(raiz, "oc_validar", {}))
    const args2 = await falla(llamar(raiz, "oc_validar", { caso: 5 }))
    expect([args1.codigo, args2.codigo]).toEqual(["ARGS_INVALIDOS", "ARGS_INVALIDOS"])

    const explota: Herramienta<{ caso: string }> = {
      description: "tool de prueba que lanza",
      args: { caso: z.string() },
      execute: async () => {
        throw new Error(`fallo con ruta ${raiz}`)
      },
    }
    const salida = await ejecutarTool("prueba_explota", explota, { caso: "sol-001" }, ctxDe(raiz), { cronometro: () => 0 })
    expect((await falla(Promise.resolve(salida))).codigo).toBe("ERROR_INTERNO")
    expect(salida).not.toContain(raiz.replaceAll("\\", "\\\\"))
    expect(salida).not.toContain("fallo con ruta")

    await ok(DataEvidencia, llamar(raiz, "oc_generar_evidencia", { caso: "sol-001" }))
    const log = await logDe(raiz)
    expect(log.map((l) => [l.herramienta, l.caso, l.ok, l.codigo_error ?? null])).toEqual([
      ["oc_validar", null, false, "ARGS_INVALIDOS"],
      ["oc_validar", null, false, "ARGS_INVALIDOS"],
      ["prueba_explota", "sol-001", false, "ERROR_INTERNO"],
      ["oc_generar_evidencia", "sol-001", true, null],
    ])
    const crudo = await leerCrudo(raiz, "log.jsonl")
    for (const prohibido of [raiz, raiz.replaceAll("\\", "/"), raiz.replaceAll("\\", "\\\\"), "Aprobado, proceder", "Mariana López", "fallo con ruta"]) {
      expect(crudo).not.toContain(prohibido)
    }

    // Si el log no se puede escribir, el resultado principal se conserva.
    await rm(join(raiz, "out", "log.jsonl"))
    await mkdir(join(raiz, "out", "log.jsonl"))
    const v = await ok(DataValidar, llamar(raiz, "oc_validar", { caso: "sol-001" }))
    expect(v.apta).toBe(true)
  })

  test("los nombres que ve el modelo siguen <archivo>_<export>", () => {
    const registro: HerramientasOc = crearHerramientasOc()
    expect(Object.keys(registroOc(registro)).sort()).toEqual(["oc_construir_payload", "oc_crear", "oc_generar_evidencia", "oc_leer_paquete", "oc_validar"])
  })
})

describe("cierre", () => {
  test("N. fixtures/ intacto y out/ real sin crear", async () => {
    expect(await huellaArbol(FIXTURES_REALES)).toBe(huellaInicialFixtures)
    expect(existsSync(DIR_OUT_REAL)).toBe(outRealExistia)
  })
})
