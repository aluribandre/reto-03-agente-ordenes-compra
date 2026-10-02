// F11: regresión de extremo a extremo. API HTTP real (crearApp, sin puerto) + runtime + tools +
// persistencia, con un LLM determinista basado en reglas (sin red ni API key) sobre raíces temporales.
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { cargarSistema } from "../src/agent/loop"
import { FECHA_REFERENCIA_DEMO, RAIZ_PROYECTO, crearReloj } from "../src/config"
import type { DefinicionTool, LlmAdapter, Mensaje, RespuestaLlm } from "../src/llm/adapter"
import { leerControl, leerEjecucion, leerJsonl } from "../src/persistencia"
import { payloadSha } from "../src/domain/sello"
import { LineaLog, OrdenCompra, OrdenRegistrada, PayloadSellado } from "../src/schemas"
import { crearApp } from "../src/server"
import { registroOc } from "../src/tools/oc"
import { CASOS_REALES, FIXTURES_REALES, crearRaizTemporal, dataDe, huellaArbol, type RaizTemporal } from "./helpers"

// ---------------------------------------------------------------------------
// LLM determinista por reglas: sigue el flujo esperado del agente a partir del último mensaje.
// ---------------------------------------------------------------------------

const USO = { entrada: 10, salida: 5, cacheEscritura: 0, cacheLectura: 0 }
const Salida = z
  .object({
    ok: z.boolean(),
    data: z.record(z.string(), z.unknown()).optional(),
    error: z.object({ codigo: z.string(), mensaje: z.string(), detalle: z.record(z.string(), z.unknown()).optional() }).loose().optional(),
  })
  .loose()

class LlmReglas implements LlmAdapter {
  readonly proveedor = "reglas"
  readonly modelo = "reglas-1"
  #n = 0

  #tool(nombre: string, argumentos: Record<string, unknown>): RespuestaLlm {
    return { texto: "", llamadas: [{ id: `toolu_r${++this.#n}`, nombre, argumentos }], motivo: "uso_tool", uso: USO, crudo: undefined }
  }
  #texto(texto: string): RespuestaLlm {
    return { texto, llamadas: [], motivo: "fin_turno", uso: USO, crudo: undefined }
  }

  async enviar(mensajes: readonly Mensaje[], _h: readonly DefinicionTool[], _s: string): Promise<RespuestaLlm> {
    const ultimo = mensajes.at(-1)
    if (ultimo?.rol === "usuario") {
      const nota = /caso=(sol-\d{3}) y payload_sha=([a-f0-9]{64})/.exec(ultimo.texto)
      if (nota?.[1] !== undefined && nota[2] !== undefined) {
        // Retransmite el payload de oc_construir_payload, que debe ser el de la nota del runtime.
        const payload = dataDe(mensajes, "oc_construir_payload")["payload"]
        if (payloadSha(OrdenCompra.parse(payload)) !== nota[2]) return this.#texto("El payload no coincide con la confirmación.")
        return this.#tool("oc_crear", { caso: nota[1], payload, confirmado: true })
      }
      const caso = /sol-\d{3}/i.exec(ultimo.texto)?.[0]?.toLowerCase()
      return caso === undefined ? this.#texto("¿Qué caso proceso?") : this.#tool("oc_leer_paquete", { caso })
    }
    const previo = mensajes.at(-2)
    const llamada = previo?.rol === "asistente" ? previo.llamadas[0] : undefined
    const contenido = ultimo?.rol === "resultados" ? (ultimo.resultados[0]?.contenido ?? "{}") : "{}"
    const r = Salida.parse(JSON.parse(contenido))
    const caso = String(z.object({ caso: z.string() }).loose().safeParse(llamada?.argumentos).data?.caso ?? "")
    const err = r.error
    switch (llamada?.nombre) {
      case "oc_leer_paquete":
        return r.ok ? this.#tool("oc_validar", { caso, paquete: r.data }) : this.#texto(`No pude leer ${caso}: ${err?.mensaje ?? ""}`)
      case "oc_validar":
        return r.data?.["apta"] === true ? this.#tool("oc_generar_evidencia", { caso }) : this.#tool("oc_crear", { caso, payload: null })
      case "oc_generar_evidencia":
        return r.ok
          ? this.#tool("oc_construir_payload", { caso, paquete: dataDe(mensajes, "oc_leer_paquete"), derivados: dataDe(mensajes, "oc_validar")["derivados"] })
          : this.#texto(`Error: ${err?.codigo ?? ""}`)
      case "oc_construir_payload":
        return r.ok ? this.#tool("oc_crear", { caso, payload: r.data?.["payload"] }) : this.#texto(`Error: ${err?.codigo ?? ""}`)
      case "oc_crear":
        if (r.ok) return this.#texto(`OC ${String(r.data?.["numero_oc"])} creada para ${caso}.`)
        if (err?.codigo === "CONFIRMACION_REQUERIDA") return this.#texto(`La OC de ${caso} requiere confirmación. ¿Confirmas crearla?`)
        if (err?.codigo === "CASO_BLOQUEADO") {
          return this.#texto(`No se creó la OC de ${caso}: bloqueos ${JSON.stringify(err.detalle?.["bloqueos"])}; no evaluables ${JSON.stringify(err.detalle?.["no_evaluables"])}.`)
        }
        return this.#texto(`No se creó la OC: ${err?.codigo ?? ""}`)
      default:
        return this.#texto("Listo.")
    }
  }
}

// ---------------------------------------------------------------------------

const Turno = z
  .object({
    sessionId: z.string(),
    respuesta: z.string(),
    estado: z.string(),
    eventos: z.array(z.object({ herramienta: z.string(), caso: z.string().nullable(), ok: z.boolean(), codigo_error: z.string().nullable() }).loose()),
    needsConfirmation: z.boolean(),
    pendingConfirmation: z.object({ caso: z.string(), payload_sha: z.string(), reglas: z.array(z.string()) }).nullable(),
    autorizacion: z.object({ id: z.string(), origen: z.string(), consumida: z.boolean() }).nullable(),
  })
  .strict()
const RespTurno = z.object({ ok: z.literal(true), data: Turno })

const DIR_OUT_REAL = join(RAIZ_PROYECTO, "out")
let sistema = ""
let huellaInicialFixtures = ""
let outRealExistia = false
const raices: RaizTemporal[] = []

beforeAll(async () => {
  sistema = await cargarSistema(RAIZ_PROYECTO)
  huellaInicialFixtures = await huellaArbol(FIXTURES_REALES)
  outRealExistia = existsSync(DIR_OUT_REAL)
})
afterEach(async () => {
  for (const r of raices.splice(0)) await r.limpiar()
})

async function nuevaRaiz(): Promise<string> {
  const t = await crearRaizTemporal(CASOS_REALES)
  raices.push(t)
  return t.raiz
}

function servidor(raiz: string) {
  return crearApp({
    raiz,
    llm: new LlmReglas(),
    herramientas: registroOc(),
    sistema,
    reloj: crearReloj(FECHA_REFERENCIA_DEMO),
    maxIteraciones: 25,
    maxTokensSesion: 1_000_000,
    version: "0.1.0-test",
    cronometro: () => 0,
  })
}
type App = ReturnType<typeof servidor>

async function enviar(a: App, ruta: string, cuerpo: unknown): Promise<z.infer<typeof Turno>> {
  const res = await a.fetch(new Request(`http://local${ruta}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cuerpo) }))
  expect(res.status).toBe(200)
  return RespTurno.parse(await res.json()).data
}
const chat = (a: App, sessionId: string, message: string) => enviar(a, "/api/chat", { sessionId, message })
const confirmar = (a: App, sessionId: string, caso: string, payload_sha: string) => enviar(a, "/api/confirm", { sessionId, action: "confirm", caso, payload_sha })

const ordenes = (raiz: string) => leerJsonl(raiz, "sap/ordenes.jsonl", OrdenRegistrada)
const herramientas = (t: z.infer<typeof Turno>) => t.eventos.map((e) => [e.herramienta, e.codigo_error])
const S1 = "regresion-sesion-1"
const S2 = "regresion-sesion-2"

const FLUJO_OK = [
  ["oc_leer_paquete", null],
  ["oc_validar", null],
  ["oc_generar_evidencia", null],
  ["oc_construir_payload", null],
  ["oc_crear", null],
]
const FLUJO_PENDIENTE = [...FLUJO_OK.slice(0, 4), ["oc_crear", "CONFIRMACION_REQUERIDA"]]

// ---------------------------------------------------------------------------

describe("F11 · regresión de extremo a extremo (API → runtime → tools → out/)", () => {
  test("1. caso limpio sol-001: OC sin confirmación y artefactos completos", async () => {
    const raiz = await nuevaRaiz()
    const a = servidor(raiz)
    const t = await chat(a, S1, "Procesa sol-001")
    expect(herramientas(t)).toEqual(FLUJO_OK)
    expect(t).toMatchObject({ estado: "completado", respuesta: "OC 4500000001 creada para sol-001.", needsConfirmation: false, autorizacion: null })
    for (const archivo of ["aprobacion.txt", "payload.json", "trazabilidad.json", "ejecucion.json"]) expect(existsSync(join(raiz, "out", "sol-001", archivo))).toBe(true)
    expect((await leerEjecucion(raiz, "sol-001"))?.autorizacion).toBeNull()
    expect((await leerControl(raiz)).map((f) => [f.solicitud_id, f.resultado, f.numero_oc])).toEqual([["SOL-2026-001", "exitoso", "4500000001"]])
    expect(await leerJsonl(raiz, "log.jsonl", LineaLog)).toHaveLength(5)
  })

  test("2. bloqueo sol-002 (RC1): sin evidencia, sin payload, sin OC", async () => {
    const raiz = await nuevaRaiz()
    const t = await chat(servidor(raiz), S1, "Procesa sol-002")
    expect(herramientas(t)).toEqual([
      ["oc_leer_paquete", null],
      ["oc_validar", null],
      ["oc_crear", "CASO_BLOQUEADO"],
    ])
    expect(t.respuesta).toContain('bloqueos ["RC1"]')
    expect(t.needsConfirmation).toBe(false)
    for (const archivo of ["aprobacion.txt", "payload.json", "trazabilidad.json", "ejecucion.json"]) expect(existsSync(join(raiz, "out", "sol-002", archivo))).toBe(false)
    expect(await ordenes(raiz)).toEqual([])
    expect((await leerControl(raiz)).map((f) => [f.resultado, f.bloqueos])).toEqual([["bloqueado", ["RC1"]]])
  })

  test("3. autoridad sol-003: bloqueo RC2 y RC3 NO_EVALUABLE (dependiente), sin OC", async () => {
    const raiz = await nuevaRaiz()
    const t = await chat(servidor(raiz), S1, "Procesa sol-003")
    expect(t.eventos.at(-1)).toMatchObject({ herramienta: "oc_crear", codigo_error: "CASO_BLOQUEADO" })
    expect(t.respuesta).toContain('bloqueos ["RC2"]; no evaluables ["RC3"]')
    expect(existsSync(join(raiz, "out", "sol-003", "payload.json"))).toBe(false)
    expect(await ordenes(raiz)).toEqual([])
    expect((await leerControl(raiz)).map((f) => [f.resultado, f.bloqueos])).toEqual([["bloqueado", ["RC2"]]])
  })

  test("4. confirmación sol-004 (RC5): pendiente → botón → OC por 25.000.000", async () => {
    const raiz = await nuevaRaiz()
    const a = servidor(raiz)
    const t1 = await chat(a, S1, "Procesa sol-004")
    expect(herramientas(t1)).toEqual(FLUJO_PENDIENTE)
    expect(t1).toMatchObject({ needsConfirmation: true, pendingConfirmation: { caso: "sol-004", reglas: ["RC5"] } })
    expect(await ordenes(raiz)).toEqual([])
    const t2 = await confirmar(a, S1, "sol-004", t1.pendingConfirmation?.payload_sha ?? "")
    expect(t2).toMatchObject({ estado: "completado", respuesta: "OC 4500000001 creada para sol-004.", autorizacion: { origen: "boton", consumida: true } })
    const [orden] = await ordenes(raiz)
    const pos = orden?.orden.posiciones[0]
    expect((pos?.cantidad ?? 0) * (pos?.precio_unitario ?? 0)).toBe(25_000_000)
    expect((await leerEjecucion(raiz, "sol-004"))?.autorizacion).toMatchObject({ origen: "boton", session_id: S1, caso: "sol-004" })
    expect((await leerControl(raiz)).map((f) => f.resultado)).toEqual(["pendiente", "exitoso"])
  })

  test("5. retroactiva sol-005 (RC8): 'confirmo' → OC marcada retroactiva", async () => {
    const raiz = await nuevaRaiz()
    const a = servidor(raiz)
    const t1 = await chat(a, S1, "Procesa sol-005")
    expect(t1.pendingConfirmation).toMatchObject({ caso: "sol-005", reglas: ["RC8"] })
    const t2 = await chat(a, S1, "confirmo")
    expect(t2).toMatchObject({ estado: "completado", autorizacion: { origen: "mensaje", consumida: true } })
    expect((await ordenes(raiz)).map((o) => o.orden.referencia.solicitud_id)).toEqual(["SOL-2026-005"])
    expect((await leerControl(raiz)).map((f) => [f.resultado, f.retroactiva])).toEqual([
      ["pendiente", true],
      ["exitoso", true],
    ])
  })

  test("6. derivación sol-006 (RC6/RC7): 'adelante' → OC con IVA C1 y pago Z030", async () => {
    const raiz = await nuevaRaiz()
    const a = servidor(raiz)
    const t1 = await chat(a, S1, "Procesa sol-006")
    expect(t1.pendingConfirmation).toMatchObject({ caso: "sol-006", reglas: ["RC6"] })
    await chat(a, S1, "Adelante")
    const [orden] = await ordenes(raiz)
    expect(orden?.orden.condiciones_pago).toBe("Z030")
    expect(orden?.orden.posiciones.map((p) => p.indicador_iva)).toEqual(["C1"])
  })

  test("7. idempotencia: reprocesar sol-001 devuelve la misma OC y no crea otra", async () => {
    const raiz = await nuevaRaiz()
    const a = servidor(raiz)
    await chat(a, S1, "Procesa sol-001")
    const t2 = await chat(a, S1, "Procesa sol-001 otra vez")
    expect(t2.respuesta).toBe("OC 4500000001 creada para sol-001.")
    expect(t2.eventos.every((e) => e.ok)).toBe(true)
    expect(await ordenes(raiz)).toHaveLength(1)
    expect((await leerControl(raiz)).map((f) => [f.resultado, f.numero_oc])).toEqual([
      ["exitoso", "4500000001"],
      ["exitoso", "4500000001"],
    ])
  })

  test("8. manipulación: payload alterado entre la pregunta y la confirmación → sin OC", async () => {
    const raiz = await nuevaRaiz()
    const a = servidor(raiz)
    const t1 = await chat(a, S1, "Procesa sol-004")
    const sha = t1.pendingConfirmation?.payload_sha ?? ""
    const ruta = join(raiz, "out", "sol-004", "payload.json")
    const sellado = PayloadSellado.parse(JSON.parse(await readFile(ruta, "utf8")))
    const [p0, ...resto] = sellado.payload.posiciones
    if (p0 === undefined) throw new Error("payload sin posiciones")
    const alterado = { ...sellado, payload: { ...sellado.payload, posiciones: [{ ...p0, precio_unitario: p0.precio_unitario + 1 }, ...resto] } }
    await writeFile(ruta, JSON.stringify(alterado, null, 2), "utf8")
    const t2 = await confirmar(a, S1, "sol-004", sha)
    expect(herramientas(t2)).toEqual([["oc_crear", "PAYLOAD_NO_COINCIDE"]])
    expect(t2.autorizacion).toMatchObject({ consumida: true }) // error de integridad: la autorización no se reutiliza
    expect(await ordenes(raiz)).toEqual([])
    expect((await confirmar(a, S1, "sol-004", sha)).estado).toBe("confirmacion_invalida")
  })

  test("9. aislamiento de sesiones: otra sesión no puede confirmar; la dueña sí", async () => {
    const raiz = await nuevaRaiz()
    const a = servidor(raiz)
    const t1 = await chat(a, S1, "Procesa sol-004")
    const sha = t1.pendingConfirmation?.payload_sha ?? ""
    expect((await chat(a, S2, "hola")).respuesta).toBe("¿Qué caso proceso?")
    expect((await confirmar(a, S2, "sol-004", sha)).estado).toBe("confirmacion_invalida")
    expect(await ordenes(raiz)).toEqual([])
    // El intento ajeno no tocó el pendiente de S1: sigue siendo su turno N+1.
    const t2 = await confirmar(a, S1, "sol-004", sha)
    expect(t2).toMatchObject({ estado: "completado", autorizacion: { origen: "boton", consumida: true } })
    expect(await ordenes(raiz)).toHaveLength(1)
  })

  test("10. reinicio del servidor: numeración continua, idempotencia preservada, sin sesiones previas", async () => {
    const raiz = await nuevaRaiz()
    const a1 = servidor(raiz)
    await chat(a1, S1, "Procesa sol-001")
    const t1 = await chat(a1, S1, "Procesa sol-006") // queda pendiente en la sesión del proceso anterior

    const a2 = servidor(raiz) // "reinicio": mismo out/, memoria nueva
    const res = await a2.fetch(new Request(`http://local/api/sessions/${S1}`))
    expect(res.status).toBe(404)
    const perdido = await a2.fetch(
      new Request("http://local/api/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: S1, action: "confirm", caso: "sol-006", payload_sha: t1.pendingConfirmation?.payload_sha ?? "" }) }),
    )
    expect(perdido.status).toBe(404) // los pendientes viven en memoria: un reinicio no hereda autorizaciones
    const r1 = await chat(a2, S2, "Procesa sol-001")
    expect(r1.respuesta).toBe("OC 4500000001 creada para sol-001.")
    const r2 = await chat(a2, S2, "Procesa sol-006")
    await confirmar(a2, S2, "sol-006", r2.pendingConfirmation?.payload_sha ?? "")
    expect((await ordenes(raiz)).map((o) => [o.numero_oc, o.orden.referencia.solicitud_id])).toEqual([
      ["4500000001", "SOL-2026-001"],
      ["4500000002", "SOL-2026-006"],
    ])
  })

  test("fixtures/ intacto y out/ real sin modificar", async () => {
    expect(await huellaArbol(FIXTURES_REALES)).toBe(huellaInicialFixtures)
    expect(existsSync(DIR_OUT_REAL)).toBe(outRealExistia)
  })
})
