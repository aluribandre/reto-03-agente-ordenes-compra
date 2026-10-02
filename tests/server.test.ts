// F10: API HTTP sobre el runtime real, con un LLM guionado (sin red, sin puerto: app.fetch en memoria).
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { cargarSistema } from "../src/agent/loop"
import { FECHA_REFERENCIA_DEMO, RAIZ_PROYECTO, crearReloj } from "../src/config"
import type { DefinicionTool, LlamadaTool, LlmAdapter, Mensaje, RespuestaLlm, ResultadoLlamada } from "../src/llm/adapter"
import { leerJsonl } from "../src/persistencia"
import { payloadSha } from "../src/domain/sello"
import { OrdenCompra, OrdenRegistrada } from "../src/schemas"
import { crearApp } from "../src/server"
import { registroOc } from "../src/tools/oc"
import { CASOS_REALES, FIXTURES_REALES, cargarOk, crearRaizTemporal, dataDe, huellaArbol, type RaizTemporal } from "./helpers"

// ---------------------------------------------------------------------------
// LLM guionado
// ---------------------------------------------------------------------------

type Paso = RespuestaLlm | ((mensajes: readonly Mensaje[]) => RespuestaLlm)

class LlmGuionado implements LlmAdapter {
  readonly proveedor = "guion"
  readonly modelo = "guion-1"
  readonly #pasos: Paso[]
  constructor(pasos: Paso[]) {
    this.#pasos = [...pasos]
  }
  async enviar(mensajes: readonly Mensaje[], _h: readonly DefinicionTool[], _s: string): Promise<RespuestaLlm> {
    const paso = this.#pasos.shift()
    if (paso === undefined) throw new Error("guion agotado")
    return typeof paso === "function" ? paso(mensajes) : paso
  }
}

const USO = { entrada: 10, salida: 5, cacheEscritura: 0, cacheLectura: 0 }
let secuencia = 0
const llamada = (nombre: string, argumentos: unknown): LlamadaTool => ({ id: `toolu_${++secuencia}`, nombre, argumentos })
const pideTools = (...llamadas: LlamadaTool[]): RespuestaLlm => ({ texto: "", llamadas, motivo: "uso_tool", uso: USO, crudo: undefined })
const responde = (texto: string): RespuestaLlm => ({ texto, llamadas: [], motivo: "fin_turno", uso: USO, crudo: undefined })

function ultimo(mensajes: readonly Mensaje[]): ResultadoLlamada | undefined {
  const m = mensajes.at(-1)
  return m?.rol === "resultados" ? m.resultados[0] : undefined
}
function dato(r: ResultadoLlamada | undefined, campo: string): string {
  const crudo: unknown = JSON.parse(r?.contenido ?? "{}")
  const data = typeof crudo === "object" && crudo !== null && "data" in crudo ? crudo.data : undefined
  const valor: unknown = typeof data === "object" && data !== null ? Reflect.get(data, campo) : undefined
  return String(valor)
}
function shaDeNota(mensajes: readonly Mensaje[]): string {
  const u = [...mensajes].reverse().find((m) => m.rol === "usuario")
  return (u?.rol === "usuario" ? /payload_sha=([a-f0-9]{64})/.exec(u.texto)?.[1] : undefined) ?? ""
}

const flujo = (caso: string, cierre: string): Paso[] => [
  pideTools(llamada("oc_leer_paquete", { caso })),
  (m) => pideTools(llamada("oc_validar", { caso, paquete: dataDe(m, "oc_leer_paquete") })),
  pideTools(llamada("oc_generar_evidencia", { caso })),
  (m) => pideTools(llamada("oc_construir_payload", { caso, paquete: dataDe(m, "oc_leer_paquete"), derivados: dataDe(m, "oc_validar")["derivados"] })),
  (m) => pideTools(llamada("oc_crear", { caso, payload: dataDe(m, "oc_construir_payload")["payload"] })),
  (m) => responde(cierre.replace("{OC}", dato(ultimo(m), "numero_oc"))),
]
const crearConfirmado = (caso: string): Paso[] => [
  (m) => {
    const payload = dataDe(m, "oc_construir_payload")["payload"]
    if (payloadSha(OrdenCompra.parse(payload)) !== shaDeNota(m)) throw new Error("el payload no corresponde a la nota del runtime")
    return pideTools(llamada("oc_crear", { caso, payload, confirmado: true }))
  },
  (m) => responde(`OC ${dato(ultimo(m), "numero_oc")} creada.`),
]

// ---------------------------------------------------------------------------
// Esquemas de respuesta (estrictos: verifican que no se filtren campos internos)
// ---------------------------------------------------------------------------

const Turno = z
  .object({
    sessionId: z.string(),
    respuesta: z.string(),
    estado: z.string(),
    eventos: z.array(
      z
        .object({
          tipo: z.literal("tool"),
          herramienta: z.string(),
          caso: z.string().nullable(),
          argumentos: z.record(z.string(), z.unknown()),
          ok: z.boolean(),
          codigo_error: z.string().nullable(),
          resumen: z.string(),
        })
        .strict(),
    ),
    needsConfirmation: z.boolean(),
    pendingConfirmation: z.object({ caso: z.string(), payload_sha: z.string(), reglas: z.array(z.string()) }).strict().nullable(),
    autorizacion: z.object({ id: z.string(), origen: z.string(), consumida: z.boolean() }).strict().nullable(),
  })
  .strict()
const RespTurno = z.object({ ok: z.literal(true), data: Turno }).strict()
const RespError = z.object({ ok: z.literal(false), error: z.object({ codigo: z.string(), mensaje: z.string() }).strict() }).strict()

// ---------------------------------------------------------------------------

const DIR_OUT_REAL = join(RAIZ_PROYECTO, "out")
let sistema = ""
let huellaInicialFixtures = ""
let outRealExistia = false
const raices: RaizTemporal[] = []
const textos: string[] = [] // todo lo que devolvió la API (para el test de rutas absolutas)

beforeAll(async () => {
  sistema = await cargarSistema(RAIZ_PROYECTO)
  huellaInicialFixtures = await huellaArbol(FIXTURES_REALES)
  outRealExistia = existsSync(DIR_OUT_REAL)
})
afterEach(async () => {
  for (const r of raices.splice(0)) await r.limpiar()
})

async function app(pasos: Paso[] | null, raiz?: string) {
  let directorio = raiz
  if (directorio === undefined) {
    const t = await crearRaizTemporal(CASOS_REALES)
    raices.push(t)
    directorio = t.raiz
  }
  const a = crearApp({
    raiz: directorio,
    llm: pasos === null ? null : new LlmGuionado(pasos),
    herramientas: registroOc(),
    sistema,
    reloj: crearReloj(FECHA_REFERENCIA_DEMO),
    maxIteraciones: 25,
    maxTokensSesion: 1_000_000,
    version: "0.1.0-test",
    cronometro: () => 0,
  })
  return { a, raiz: directorio }
}

type App = Awaited<ReturnType<typeof app>>["a"]

async function pedir(a: App, ruta: string, init?: RequestInit): Promise<{ status: number; cuerpo: unknown; texto: string; tipo: string }> {
  const res = await a.fetch(new Request(`http://local${ruta}`, init))
  const texto = await res.text()
  textos.push(texto)
  let cuerpo: unknown = null
  try {
    cuerpo = JSON.parse(texto)
  } catch {}
  return { status: res.status, cuerpo, texto, tipo: res.headers.get("content-type") ?? "" }
}
const post = (a: App, ruta: string, cuerpo: unknown) =>
  pedir(a, ruta, { method: "POST", headers: { "content-type": "application/json" }, body: typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo) })

const SA = "sesion-aaaa-0001"
const SB = "sesion-bbbb-0002"
const ordenes = (raiz: string) => leerJsonl(raiz, "sap/ordenes.jsonl", OrdenRegistrada)

// ---------------------------------------------------------------------------

describe("salud y validación", () => {
  test("A/L. /api/health funciona sin LLM y no expone secretos, entorno ni rutas", async () => {
    const anterior = process.env["ANTHROPIC_API_KEY"]
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-secreto-de-prueba"
    try {
      const { a } = await app(null, RAIZ_PROYECTO)
      const r = await pedir(a, "/api/health")
      expect(r.status).toBe(200)
      expect(r.cuerpo).toEqual({ ok: true, servicio: "oc-agent", version: "0.1.0-test", llmConfigured: false })
      for (const prohibido of ["sk-ant", "ANTHROPIC", RAIZ_PROYECTO, RAIZ_PROYECTO.replaceAll("\\", "/"), "claude-"]) expect(r.texto).not.toContain(prohibido)
      const conLlm = await app([], RAIZ_PROYECTO)
      expect((await pedir(conLlm.a, "/api/health")).cuerpo).toMatchObject({ llmConfigured: true })
    } finally {
      if (anterior === undefined) delete process.env["ANTHROPIC_API_KEY"]
      else process.env["ANTHROPIC_API_KEY"] = anterior
    }
  })

  test("B. /api/chat con entrada inválida → 400/413/415 saneados", async () => {
    const { a } = await app([])
    for (const cuerpo of [{}, { sessionId: SA }, { sessionId: SA, message: "" }, { sessionId: SA, message: "x".repeat(2001) }, { sessionId: SA, message: "hola", extra: 1 }]) {
      const r = await post(a, "/api/chat", cuerpo)
      expect(r.status).toBe(400)
      expect(RespError.parse(r.cuerpo).error.codigo).toBe("ENTRADA_INVALIDA")
    }
    expect((await post(a, "/api/chat", "{ roto")).status).toBe(400)
    expect((await pedir(a, "/api/chat", { method: "POST", headers: { "content-type": "text/plain" }, body: "hola" })).status).toBe(415)
    expect((await post(a, "/api/chat", { sessionId: SA, message: "x".repeat(20_000) })).status).toBe(413)
    expect((await pedir(a, "/api/chat")).status).toBe(405)
  })

  test("C. sessionId inválido → 400", async () => {
    const { a } = await app([])
    for (const sessionId of ["../x", "corto", "a".repeat(65), "sesion con espacios", "sesion/../../x"]) {
      expect((await post(a, "/api/chat", { sessionId, message: "hola" })).status).toBe(400)
    }
    expect((await pedir(a, "/api/sessions/..%2F..%2Fx")).status).toBe(400)
  })
})

describe("flujos de negocio por la API", () => {
  test("D. chat sol-001 → OC creada; eventos para tool cards sin argumentos ni crudo", async () => {
    const { a, raiz } = await app(flujo("sol-001", "OC {OC} creada."))
    const r = await post(a, "/api/chat", { sessionId: SA, message: "Procesa sol-001" })
    expect(r.status).toBe(200)
    const d = RespTurno.parse(r.cuerpo).data
    expect(d).toMatchObject({ estado: "completado", respuesta: "OC 4500000001 creada.", needsConfirmation: false, pendingConfirmation: null })
    expect(d.eventos.map((e) => [e.herramienta, e.caso, e.ok])).toEqual([
      ["oc_leer_paquete", "sol-001", true],
      ["oc_validar", "sol-001", true],
      ["oc_generar_evidencia", "sol-001", true],
      ["oc_construir_payload", "sol-001", true],
      ["oc_crear", "sol-001", true],
    ])
    expect(await ordenes(raiz)).toHaveLength(1)
  })

  test("E/F/M. sol-004 → needsConfirmation; /api/confirm → OC; GET /api/sessions recupera el estado", async () => {
    const { a, raiz } = await app([...flujo("sol-004", "¿Confirmas crear la OC?"), ...crearConfirmado("sol-004")])
    const t1 = RespTurno.parse((await post(a, "/api/chat", { sessionId: SA, message: "Procesa sol-004" })).cuerpo).data
    expect(t1).toMatchObject({ needsConfirmation: true, pendingConfirmation: { caso: "sol-004", reglas: ["RC5"] } })
    expect(t1.eventos.at(-1)).toMatchObject({ herramienta: "oc_crear", ok: false, codigo_error: "CONFIRMACION_REQUERIDA" })

    const sesion = await pedir(a, `/api/sessions/${SA}`)
    expect(sesion.status).toBe(200)
    expect(sesion.cuerpo).toMatchObject({ ok: true, data: { sessionId: SA, needsConfirmation: true, pendingConfirmation: { caso: "sol-004" }, ultimoEstado: "completado" } })
    expect(sesion.texto).not.toContain("[Runtime]")

    const sha = t1.pendingConfirmation?.payload_sha ?? ""
    const t2 = await post(a, "/api/confirm", { sessionId: SA, action: "confirm", caso: "sol-004", payload_sha: sha })
    expect(t2.status).toBe(200)
    expect(RespTurno.parse(t2.cuerpo).data).toMatchObject({
      estado: "completado",
      respuesta: "OC 4500000001 creada.",
      needsConfirmation: false,
      autorizacion: { origen: "boton", consumida: true },
    })
    expect(await ordenes(raiz)).toHaveLength(1)
    expect((await pedir(a, `/api/sessions/${SA}`)).cuerpo).toMatchObject({ data: { needsConfirmation: false, pendingConfirmation: null } })
    expect((await pedir(a, "/api/sessions/sesion-que-no-existe")).status).toBe(404)
  })

  test("G/H. confirm desde otra sesión o con otro payload → rechazado, sin OC", async () => {
    const { a, raiz } = await app([...flujo("sol-004", "¿Confirmas?"), responde("Hola.")])
    const t1 = RespTurno.parse((await post(a, "/api/chat", { sessionId: SA, message: "Procesa sol-004" })).cuerpo).data
    const sha = t1.pendingConfirmation?.payload_sha ?? ""
    expect((await post(a, "/api/confirm", { sessionId: SB, action: "confirm", caso: "sol-004", payload_sha: sha })).status).toBe(404)
    await post(a, "/api/chat", { sessionId: SB, message: "hola" })
    const otra = RespTurno.parse((await post(a, "/api/confirm", { sessionId: SB, action: "confirm", caso: "sol-004", payload_sha: sha })).cuerpo).data
    expect(otra.estado).toBe("confirmacion_invalida")
    const malo = RespTurno.parse((await post(a, "/api/confirm", { sessionId: SA, action: "confirm", caso: "sol-004", payload_sha: "c".repeat(64) })).cuerpo).data
    expect(malo.estado).toBe("confirmacion_invalida")
    expect(await ordenes(raiz)).toEqual([])
  })

  test("I. doble confirm concurrente → una sola OC", async () => {
    const { a, raiz } = await app([...flujo("sol-004", "¿Confirmas?"), ...crearConfirmado("sol-004")])
    const t1 = RespTurno.parse((await post(a, "/api/chat", { sessionId: SA, message: "Procesa sol-004" })).cuerpo).data
    const evento = { sessionId: SA, action: "confirm", caso: "sol-004", payload_sha: t1.pendingConfirmation?.payload_sha ?? "" }
    const [x, y] = await Promise.all([post(a, "/api/confirm", evento), post(a, "/api/confirm", evento)])
    const estados = [x, y].map((r) => RespTurno.parse(r.cuerpo).data.estado).sort()
    expect(estados).toEqual(["completado", "confirmacion_invalida"])
    expect(await ordenes(raiz)).toHaveLength(1)
  })

  test("K. tool cards: cada evento trae nombre, argumentos recibidos (forma segura) y resultado resumido", async () => {
    const { a } = await app([...flujo("sol-004", "¿Confirmas?"), ...crearConfirmado("sol-004")])
    const t1 = RespTurno.parse((await post(a, "/api/chat", { sessionId: SA, message: "Procesa sol-004" })).cuerpo).data
    const sha = t1.pendingConfirmation?.payload_sha ?? ""
    const resumenPaquete = { solicitud_id: "SOL-2026-004", valor_total: 25_000_000, moneda: "COP" }
    expect(t1.eventos.map((e) => [e.herramienta, e.argumentos])).toEqual([
      ["oc_leer_paquete", { caso: "sol-004" }],
      ["oc_validar", { caso: "sol-004", paquete: expect.objectContaining(resumenPaquete) }],
      ["oc_generar_evidencia", { caso: "sol-004" }],
      ["oc_construir_payload", { caso: "sol-004", paquete: expect.objectContaining(resumenPaquete), derivados: {} }],
      ["oc_crear", { caso: "sol-004", payload: { payload_sha: sha } }],
    ])
    expect(t1.eventos.every((e) => e.resumen.length > 0)).toBe(true)
    const t2 = RespTurno.parse((await post(a, "/api/confirm", { sessionId: SA, action: "confirm", caso: "sol-004", payload_sha: sha })).cuerpo).data
    expect(t2.eventos.map((e) => e.argumentos)).toEqual([{ caso: "sol-004", payload: { payload_sha: sha }, confirmado: true }])
  })

  test("L. tool cards nunca incluyen textos de documentos, payload completo, rutas ni claves arbitrarias", async () => {
    const { a, raiz } = await app([
      ...flujo("sol-006", "¿Confirmas?"),
      (m) => pideTools(llamada("oc_validar", { caso: "sol-006", paquete: dataDe(m, "oc_leer_paquete"), "<img src=x>": "inyección" })),
      pideTools(llamada("oc_validar", { caso: "sol-006", paquete: "no es un paquete" })),
      responde("Listo."),
    ])
    const t1 = RespTurno.parse((await post(a, "/api/chat", { sessionId: SA, message: "Procesa sol-006" })).cuerpo).data
    const deriv = t1.eventos.find((e) => e.herramienta === "oc_construir_payload")?.argumentos["derivados"]
    expect(deriv).toEqual({ indicador_iva: "C1", condiciones_pago: "Z030", proveedor_por_nombre: "100234" })
    const t2 = RespTurno.parse((await post(a, "/api/chat", { sessionId: SA, message: "otra vez" })).cuerpo).data
    expect(t2.eventos.map((e) => [e.codigo_error, e.argumentos])).toEqual([
      ["ARGS_INVALIDOS", { caso: "sol-006", paquete: expect.objectContaining({ solicitud_id: "SOL-2026-006" }), "(clave no válida)": "(argumento no admitido)" }],
      ["ARGS_INVALIDOS", { caso: "sol-006", paquete: "(no válido)" }],
    ])
    const paquete = await cargarOk("sol-006", raiz)
    const sesion = await pedir(a, `/api/sessions/${SA}`)
    for (const texto of [JSON.stringify(t1.eventos), JSON.stringify(t2.eventos), JSON.stringify(Reflect.get(Reflect.get(sesion.cuerpo as object, "data") as object, "eventos"))]) {
      for (const prohibido of [paquete.aprobacion?.texto ?? "<sin aprobación>", paquete.cotizacion?.texto ?? "<sin cotización>", "posiciones", "descripcion", "evidencia_sha256", "<img", "inyección", raiz]) {
        expect(texto).not.toContain(prohibido)
      }
    }
  })

  test("J. proveedor no configurado → 503 controlado y el servidor sigue vivo", async () => {
    const { a } = await app(null)
    const r = await post(a, "/api/chat", { sessionId: SA, message: "Procesa sol-001" })
    expect(r.status).toBe(503)
    expect(RespError.parse(r.cuerpo).error).toEqual({ codigo: "LLM_NO_CONFIGURADO", mensaje: "El proveedor LLM no está configurado." })
    expect((await pedir(a, "/api/health")).status).toBe(200)
  })
})

describe("estáticos y saneamiento", () => {
  test("N. solo se sirven los estáticos de la lista blanca de web/", async () => {
    const { a } = await app(null, RAIZ_PROYECTO)
    const raiz = await pedir(a, "/")
    expect(raiz.status).toBe(200)
    expect(raiz.tipo).toContain("text/html")
    expect((await pedir(a, "/app.js")).tipo).toContain("javascript")
    expect((await pedir(a, "/styles.css")).tipo).toContain("text/css")
    for (const ruta of ["/../package.json", "/%2e%2e/package.json", "/web/app.js", "/package.json", "/src/server.ts", "/.env", "/fixtures/reto-03/maestros/proveedores.json"]) {
      const r = await pedir(a, ruta)
      expect([ruta, r.status]).toEqual([ruta, 404])
    }
    expect((await pedir(a, "/api/inexistente")).status).toBe(404)
  })

  test("K. ninguna respuesta de la API incluye rutas absolutas ni trazas", () => {
    expect(textos.length).toBeGreaterThan(20)
    const todo = textos.filter((t) => !t.startsWith("<!doctype") && !t.startsWith('"use strict"') && !t.startsWith(":root")).join("\n")
    const tmp = tmpdir()
    for (const prohibido of [RAIZ_PROYECTO, RAIZ_PROYECTO.replaceAll("\\", "/"), RAIZ_PROYECTO.replaceAll("\\", "\\\\"), tmp, tmp.replaceAll("\\", "\\\\"), "    at ", "Error:", "node_modules"]) {
      expect(todo).not.toContain(prohibido)
    }
  })

  test("fixtures/ intacto y out/ real sin modificar", async () => {
    expect(await huellaArbol(FIXTURES_REALES)).toBe(huellaInicialFixtures)
    expect(existsSync(DIR_OUT_REAL)).toBe(outRealExistia)
  })
})

// ===========================================================================
// F11: hardening HTTP
// ===========================================================================

// LLM que responde con eco del último mensaje del usuario tras una espera; mide concurrencia.
class LlmEco implements LlmAdapter {
  readonly proveedor = "eco"
  readonly modelo = "eco-1"
  enVuelo = 0
  maxEnVuelo = 0
  constructor(private readonly esperaMs: number) {}
  async enviar(mensajes: readonly Mensaje[], _h: readonly DefinicionTool[], _s: string): Promise<RespuestaLlm> {
    this.enVuelo++
    this.maxEnVuelo = Math.max(this.maxEnVuelo, this.enVuelo)
    await Bun.sleep(this.esperaMs)
    this.enVuelo--
    const u = mensajes.at(-1)
    return responde(`eco:${u?.rol === "usuario" ? u.texto : "?"}`)
  }
}

function appCon(llm: LlmAdapter) {
  return crearApp({
    raiz: RAIZ_PROYECTO, // solo lectura: estos tests no ejecutan tools
    llm,
    herramientas: registroOc(),
    sistema,
    reloj: crearReloj(FECHA_REFERENCIA_DEMO),
    maxIteraciones: 25,
    maxTokensSesion: 1_000_000,
    version: "0.1.0-test",
    cronometro: () => 0,
  })
}

const Historial = z.object({ ok: z.literal(true), data: z.object({ historial: z.array(z.object({ rol: z.string(), texto: z.string() })) }).loose() })

describe("F11 · hardening HTTP", () => {
  test("A. 413 por Content-Length declarado y por cuerpo real; 415 con y sin content-type", async () => {
    const { a } = await app([])
    const grande = JSON.stringify({ sessionId: SA, message: "x".repeat(17 * 1024) })
    expect((await post(a, "/api/chat", grande)).cuerpo).toMatchObject({ ok: false, error: { codigo: "CUERPO_DEMASIADO_GRANDE" } })
    const declarado = await pedir(a, "/api/chat", { method: "POST", headers: { "content-type": "application/json", "content-length": String(1024 * 1024) }, body: "{}" })
    expect(declarado.status).toBe(413)
    expect((await post(a, "/api/confirm", grande)).status).toBe(413)
    for (const tipo of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const r = await pedir(a, "/api/confirm", { method: "POST", headers: { "content-type": tipo }, body: "a=b" })
      expect([tipo, r.status, RespError.parse(r.cuerpo).error.codigo]).toEqual([tipo, 415, "CONTENT_TYPE_INVALIDO"])
    }
    expect((await pedir(a, "/api/chat", { method: "POST", body: new Uint8Array([1, 2, 3]) })).status).toBe(415)
  })

  test("B/C/D/E. JSON malformado, mensaje vacío o en blanco, mensaje y sessionId sobre el máximo → 400", async () => {
    const { a } = await app([])
    for (const crudo of ["{", "null", "[]", '"texto"', "123", "{\"sessionId\":"]) {
      const r = await post(a, "/api/chat", crudo)
      expect([crudo, r.status]).toEqual([crudo, 400])
      expect(RespError.safeParse(r.cuerpo).success).toBe(true)
    }
    for (const message of ["", "   ", "\n\t", "x".repeat(2001)]) {
      expect((await post(a, "/api/chat", { sessionId: SA, message })).status).toBe(400)
    }
    expect((await post(a, "/api/chat", { sessionId: SA, message: "x".repeat(2000) })).status).not.toBe(400) // el límite es inclusivo
    expect((await post(a, "/api/chat", { sessionId: "a".repeat(65), message: "hola" })).status).toBe(400)
    expect((await post(a, "/api/chat", { sessionId: "a".repeat(64), message: "hola" })).status).not.toBe(400)
    expect((await post(a, "/api/confirm", { sessionId: SA, action: "confirm", caso: "sol-004", payload_sha: "A".repeat(64) })).status).toBe(400)
    expect((await post(a, "/api/confirm", { sessionId: SA, action: "approve", caso: "sol-004", payload_sha: "a".repeat(64) })).status).toBe(400)
  })

  test("F. variantes de path traversal nunca sirven archivos fuera de web/", async () => {
    const { a } = await app(null, RAIZ_PROYECTO)
    const rutas = [
      "/../package.json",
      "/%2e%2e/package.json",
      "/%2e%2e%2fpackage.json",
      "/%252e%252e%252fpackage.json",
      "/..%2fpackage.json",
      "/..%5cpackage.json",
      "/%2e%2e%5cpackage.json",
      "/web/../package.json",
      "//package.json",
      "/./app.js/../../package.json",
      "/app.js%00.json",
      "/APP.JS",
      "/index.html/",
      "/.git/config",
      "/out/log.jsonl",
      "/node_modules/zod/package.json",
    ]
    for (const ruta of rutas) {
      const r = await pedir(a, ruta)
      expect([ruta, r.status]).toEqual([ruta, 404])
      expect(r.texto).not.toContain('"name"')
      expect(r.texto).not.toContain("reto-03-ordenes-compra") // "name" del package.json
    }
  })

  test("G. métodos no permitidos → 405 en todos los endpoints", async () => {
    const { a } = await app([])
    const casos: [string, string][] = [
      ["POST", "/api/health"],
      ["DELETE", "/api/health"],
      ["GET", "/api/chat"],
      ["PUT", "/api/chat"],
      ["GET", "/api/confirm"],
      ["PUT", "/api/confirm"],
      ["POST", `/api/sessions/${SA}`],
      ["DELETE", `/api/sessions/${SA}`],
      ["POST", "/"],
      ["PUT", "/app.js"],
    ]
    for (const [method, ruta] of casos) {
      const r = await pedir(a, ruta, { method })
      expect([method, ruta, r.status, RespError.parse(r.cuerpo).error.codigo]).toEqual([method, ruta, 405, "METODO_NO_PERMITIDO"])
    }
  })

  test("H. /api/chat concurrentes en la misma sesión se serializan; el historial queda alternado", async () => {
    const llm = new LlmEco(30)
    const a = appCon(llm)
    const mensajes = ["uno", "dos", "tres", "cuatro"]
    const respuestas = await Promise.all(mensajes.map((message) => post(a, "/api/chat", { sessionId: SA, message })))
    expect(llm.maxEnVuelo).toBe(1)
    expect(respuestas.map((r) => RespTurno.parse(r.cuerpo).data.respuesta).sort()).toEqual(mensajes.map((m) => `eco:${m}`).sort())
    const h = Historial.parse((await pedir(a, `/api/sessions/${SA}`)).cuerpo).data.historial
    expect(h).toHaveLength(8)
    h.forEach((m, i) => expect(m.rol).toBe(i % 2 === 0 ? "usuario" : "agente"))
    for (let i = 0; i < h.length; i += 2) expect(h[i + 1]?.texto).toBe(`eco:${h[i]?.texto}`) // cada respuesta sigue a su pregunta
  })

  test("I. sesiones distintas no comparten estado (y sí pueden correr en paralelo)", async () => {
    const llm = new LlmEco(30)
    const a = appCon(llm)
    await Promise.all([post(a, "/api/chat", { sessionId: SA, message: "soy A" }), post(a, "/api/chat", { sessionId: SB, message: "soy B" })])
    expect(llm.maxEnVuelo).toBe(2)
    const ha = Historial.parse((await pedir(a, `/api/sessions/${SA}`)).cuerpo).data.historial
    const hb = Historial.parse((await pedir(a, `/api/sessions/${SB}`)).cuerpo).data.historial
    expect(ha.map((m) => m.texto)).toEqual(["soy A", "eco:soy A"])
    expect(hb.map((m) => m.texto)).toEqual(["soy B", "eco:soy B"])
    expect(a.sesiones.obtener(SA)).not.toBe(a.sesiones.obtener(SB))
  })

  test("J. errores de negocio y de servidor no exponen rutas, entorno ni crudo", async () => {
    const { a } = await app([
      () => {
        throw new Error("boom C:\\secreto sk-ant-xyz")
      },
    ])
    const r = await post(a, "/api/chat", { sessionId: SA, message: "hola" })
    expect(r.status).toBe(503)
    for (const prohibido of ["boom", "secreto", "sk-ant", "crudo", "stack"]) expect(r.texto).not.toContain(prohibido)
    const ses = await pedir(a, `/api/sessions/${SA}`)
    expect(ses.texto).not.toContain("crudo")
    expect(ses.texto).not.toContain("argumentos")
  })

  test("K/L. contenido HTML/JS del modelo viaja como dato JSON escapado (nosniff) y la UI no usa innerHTML", async () => {
    const carga = '<script>alert(1)</script><img src=x onerror="alert(2)">'
    const { a } = await app([responde(carga)])
    const res = await a.fetch(new Request("http://local/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: SA, message: carga }) }))
    expect(res.headers.get("content-type")).toStartWith("application/json")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'")
    expect(RespTurno.parse(await res.json()).data.respuesta).toBe(carga) // texto literal, sin interpretar ni reescribir
    const appJs = await Bun.file(join(RAIZ_PROYECTO, "web", "app.js")).text()
    for (const sumidero of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval("]) expect(appJs).not.toContain(sumidero)
    expect(appJs).toContain("textContent")
  })
})
