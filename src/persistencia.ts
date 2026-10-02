// Persistencia en out/: único módulo que escribe en disco. Importarlo no escribe nada.
// - Archivos completos (payload, trazabilidad, evidencia, ejecución): temporal + fsync + rename.
// - JSONL y CSV: líneas completas, escritas bajo candado.
// El candado es en proceso: válido para una sola instancia (no hay locking distribuido).
// Las rutas que se devuelven son relativas a la raíz del proyecto ("out/..."), nunca absolutas.
import { randomUUID } from "node:crypto"
import { appendFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import type { ZodType } from "zod"
import { Caso, Ejecucion, FilaControl, LineaLog, PayloadSellado, Trazabilidad } from "./schemas"

export class ErrorPersistencia extends Error {}

export const ARCHIVOS = {
  ordenes: "sap/ordenes.jsonl",
  control: "control.csv",
  log: "log.jsonl",
  payload: "payload.json",
  trazabilidad: "trazabilidad.json",
  evidencia: "aprobacion.txt",
  ejecucion: "ejecucion.json",
} as const

// Columnas exactas de PRD HU-5.
export const ENCABEZADO_CONTROL = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts"

// ---------------------------------------------------------------------------
// Candado en proceso (cola de promesas por clave)
// ---------------------------------------------------------------------------

const colas = new Map<string, Promise<unknown>>()

export async function conCandado<T>(clave: string, tarea: () => Promise<T>): Promise<T> {
  const anterior = colas.get(clave) ?? Promise.resolve()
  const actual = anterior.then(tarea)
  const cola = actual.catch(() => undefined)
  colas.set(clave, cola)
  try {
    return await actual
  } finally {
    if (colas.get(clave) === cola) colas.delete(clave)
  }
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

export function dirOut(raiz: string): string {
  return resolve(raiz, "out")
}

// Ruta absoluta dentro de out/. Cualquier intento de salir de out/ es un error.
export function rutaEnOut(raiz: string, relativa: string): string {
  const out = dirOut(raiz)
  const absoluta = resolve(out, relativa)
  const rel = relative(out, absoluta)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new ErrorPersistencia(`ruta fuera de out/: ${relativa}`)
  return absoluta
}

function rutaPublica(relativa: string): string {
  return `out/${relativa}`
}

function relativaCaso(caso: string, archivo: string): string {
  const r = Caso.safeParse(caso)
  if (!r.success) throw new ErrorPersistencia("caso inválido para persistir")
  return `${r.data}/${archivo}`
}

function esNoEncontrado(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT"
}

// ---------------------------------------------------------------------------
// Primitivas
// ---------------------------------------------------------------------------

// Un fallo de escritura del sistema de archivos se reporta como ErrorPersistencia (ruta relativa,
// sin detalles del SO), para que las tools lo traten como ERROR_ESCRITURA y no como error interno.
async function escribiendo<T>(relativa: string, accion: () => Promise<T>): Promise<T> {
  try {
    return await accion()
  } catch (e) {
    if (e instanceof ErrorPersistencia) throw e
    throw new ErrorPersistencia(`no se pudo escribir out/${relativa}`)
  }
}

export async function escribirAtomico(raiz: string, relativa: string, contenido: string): Promise<string> {
  const destino = rutaEnOut(raiz, relativa)
  const temporal = join(dirname(destino), `.${basename(destino)}.${randomUUID()}.tmp`)
  await escribiendo(relativa, async () => {
    await mkdir(dirname(destino), { recursive: true })
    try {
      const archivo = await open(temporal, "w")
      try {
        await archivo.writeFile(contenido, "utf8")
        await archivo.sync()
      } finally {
        await archivo.close()
      }
      await rename(temporal, destino)
    } catch (e) {
      await rm(temporal, { force: true })
      throw e
    }
  })
  return rutaPublica(relativa)
}

export async function leerTextoOut(raiz: string, relativa: string): Promise<string | null> {
  try {
    return await readFile(rutaEnOut(raiz, relativa), "utf8")
  } catch (e) {
    if (esNoEncontrado(e)) return null
    throw e
  }
}

async function escribirJson(raiz: string, relativa: string, valor: unknown): Promise<string> {
  return escribirAtomico(raiz, relativa, `${JSON.stringify(valor, null, 2)}\n`)
}

async function leerJson<T>(raiz: string, relativa: string, esquema: ZodType<T>): Promise<T | null> {
  const texto = await leerTextoOut(raiz, relativa)
  if (texto === null) return null
  let crudo: unknown
  try {
    crudo = JSON.parse(texto)
  } catch {
    throw new ErrorPersistencia(`out/${relativa} no es JSON válido`)
  }
  const r = esquema.safeParse(crudo)
  if (!r.success) throw new ErrorPersistencia(`out/${relativa} no cumple su esquema`)
  return r.data
}

function validar<T>(esquema: ZodType<T>, valor: unknown, que: string): T {
  const r = esquema.safeParse(valor)
  if (!r.success) throw new ErrorPersistencia(`${que} no cumple su esquema`)
  return r.data
}

// Una línea completa por llamada, bajo el candado del archivo.
export async function appendJsonl(raiz: string, relativa: string, valor: unknown): Promise<string> {
  const destino = rutaEnOut(raiz, relativa)
  await conCandado(destino, () =>
    escribiendo(relativa, async () => {
      await mkdir(dirname(destino), { recursive: true })
      await appendFile(destino, `${JSON.stringify(valor)}\n`, "utf8")
    }),
  )
  return rutaPublica(relativa)
}

export async function leerJsonl<T>(raiz: string, relativa: string, esquema: ZodType<T>): Promise<T[]> {
  const destino = rutaEnOut(raiz, relativa)
  const texto = await conCandado(destino, () => leerTextoOut(raiz, relativa))
  if (texto === null) return []
  return texto
    .split("\n")
    .filter((linea) => linea.trim() !== "")
    .map((linea, i) => {
      let crudo: unknown
      try {
        crudo = JSON.parse(linea)
      } catch {
        throw new ErrorPersistencia(`out/${relativa}: línea ${i + 1} no es JSON válido`)
      }
      return validar(esquema, crudo, `out/${relativa}: línea ${i + 1}`)
    })
}

// ---------------------------------------------------------------------------
// Artefactos sellados por caso: out/<caso>/... (WRITE-ONCE)
// Inexistente → se escribe. Mismo sello → se reutiliza sin reescribir.
// Sello distinto (o archivo ilegible) → conflicto: nunca se sobrescribe.
// ---------------------------------------------------------------------------

export type ResultadoSellado =
  | { estado: "escrito" | "reutilizado"; ruta: string }
  | { estado: "conflicto"; ruta: string; detalle: Record<string, string> }

async function sellarJson<T extends { payload_sha: string }>(
  raiz: string,
  relativa: string,
  esquema: ZodType<T>,
  valor: T,
): Promise<ResultadoSellado> {
  const nuevo = validar(esquema, valor, `out/${relativa}`)
  const destino = rutaEnOut(raiz, relativa)
  return conCandado(`sello:${destino}`, async (): Promise<ResultadoSellado> => {
    let existente: T | null
    try {
      existente = await leerJson(raiz, relativa, esquema)
    } catch {
      return { estado: "conflicto", ruta: rutaPublica(relativa), detalle: { motivo: "archivo_sellado_ilegible" } }
    }
    if (existente === null) return { estado: "escrito", ruta: await escribirJson(raiz, relativa, nuevo) }
    if (existente.payload_sha === nuevo.payload_sha) return { estado: "reutilizado", ruta: rutaPublica(relativa) }
    return {
      estado: "conflicto",
      ruta: rutaPublica(relativa),
      detalle: { motivo: "sello_distinto", payload_sha_sellado: existente.payload_sha, payload_sha_nuevo: nuevo.payload_sha },
    }
  })
}

async function sellarTexto(raiz: string, relativa: string, contenido: string): Promise<ResultadoSellado> {
  const destino = rutaEnOut(raiz, relativa)
  return conCandado(`sello:${destino}`, async (): Promise<ResultadoSellado> => {
    const existente = await leerTextoOut(raiz, relativa)
    if (existente === null) return { estado: "escrito", ruta: await escribirAtomico(raiz, relativa, contenido) }
    if (existente === contenido) return { estado: "reutilizado", ruta: rutaPublica(relativa) }
    return { estado: "conflicto", ruta: rutaPublica(relativa), detalle: { motivo: "contenido_distinto" } }
  })
}

function exigirSinConflicto(r: ResultadoSellado): string {
  if (r.estado === "conflicto") throw new ErrorPersistencia(`${r.ruta} ya está sellado con otro contenido`)
  return r.ruta
}

export async function sellarPayload(raiz: string, caso: string, sellado: PayloadSellado): Promise<ResultadoSellado> {
  return sellarJson(raiz, relativaCaso(caso, ARCHIVOS.payload), PayloadSellado, sellado)
}

export async function sellarTrazabilidad(raiz: string, caso: string, trazabilidad: Trazabilidad): Promise<ResultadoSellado> {
  return sellarJson(raiz, relativaCaso(caso, ARCHIVOS.trazabilidad), Trazabilidad, trazabilidad)
}

export async function sellarEvidencia(raiz: string, caso: string, texto: string): Promise<ResultadoSellado> {
  return sellarTexto(raiz, relativaCaso(caso, ARCHIVOS.evidencia), texto)
}

// Variantes que lanzan ErrorPersistencia ante conflicto (no existe ningún camino de sobrescritura).
export async function escribirPayloadSellado(raiz: string, caso: string, sellado: PayloadSellado): Promise<string> {
  return exigirSinConflicto(await sellarPayload(raiz, caso, sellado))
}

export async function leerPayloadSellado(raiz: string, caso: string): Promise<PayloadSellado | null> {
  return leerJson(raiz, relativaCaso(caso, ARCHIVOS.payload), PayloadSellado)
}

export async function escribirTrazabilidad(raiz: string, caso: string, trazabilidad: Trazabilidad): Promise<string> {
  return exigirSinConflicto(await sellarTrazabilidad(raiz, caso, trazabilidad))
}

export async function leerTrazabilidad(raiz: string, caso: string): Promise<Trazabilidad | null> {
  return leerJson(raiz, relativaCaso(caso, ARCHIVOS.trazabilidad), Trazabilidad)
}

export async function escribirEvidencia(raiz: string, caso: string, texto: string): Promise<string> {
  return exigirSinConflicto(await sellarEvidencia(raiz, caso, texto))
}

export async function leerEvidencia(raiz: string, caso: string): Promise<string | null> {
  return leerTextoOut(raiz, relativaCaso(caso, ARCHIVOS.evidencia))
}

// Registro de ejecución, separado del payload sellado (que nunca se modifica para esto).
export async function escribirEjecucion(raiz: string, caso: string, ejecucion: Ejecucion): Promise<string> {
  return escribirJson(raiz, relativaCaso(caso, ARCHIVOS.ejecucion), validar(Ejecucion, ejecucion, "ejecución"))
}

export async function leerEjecucion(raiz: string, caso: string): Promise<Ejecucion | null> {
  return leerJson(raiz, relativaCaso(caso, ARCHIVOS.ejecucion), Ejecucion)
}

// ---------------------------------------------------------------------------
// control.csv y log.jsonl
// ---------------------------------------------------------------------------

function celdaCsv(valor: string): string {
  if (/[\r\n]/.test(valor)) throw new ErrorPersistencia("una celda de control.csv no puede contener saltos de línea")
  return /[",]/.test(valor) ? `"${valor.replaceAll('"', '""')}"` : valor
}

function filaCsv(f: FilaControl): string {
  return [f.solicitud_id, f.resultado, f.numero_oc, String(f.retroactiva), f.bloqueos.join(";"), f.confirmaciones.join(";"), f.ts]
    .map(celdaCsv)
    .join(",")
}

function parsearLineaCsv(linea: string): string[] {
  const celdas: string[] = []
  let actual = ""
  let entreComillas = false
  for (let i = 0; i < linea.length; i++) {
    const c = linea.charAt(i)
    if (entreComillas) {
      if (c === '"' && linea.charAt(i + 1) === '"') {
        actual += '"'
        i++
      } else if (c === '"') entreComillas = false
      else actual += c
    } else if (c === '"') entreComillas = true
    else if (c === ",") {
      celdas.push(actual)
      actual = ""
    } else actual += c
  }
  celdas.push(actual)
  return celdas
}

// Agrega una fila; el encabezado se escribe una sola vez, cuando el archivo no existe o está vacío.
export async function appendControl(raiz: string, fila: FilaControl): Promise<string> {
  const valida = validar(FilaControl, fila, "fila de control")
  const destino = rutaEnOut(raiz, ARCHIVOS.control)
  await conCandado(destino, () =>
    escribiendo(ARCHIVOS.control, async () => {
      await mkdir(dirname(destino), { recursive: true })
      const tamano = await stat(destino).then(
        (s) => s.size,
        (e: unknown) => {
          if (esNoEncontrado(e)) return 0
          throw e
        },
      )
      const encabezado = tamano === 0 ? `${ENCABEZADO_CONTROL}\n` : ""
      await appendFile(destino, `${encabezado}${filaCsv(valida)}\n`, "utf8")
    }),
  )
  return rutaPublica(ARCHIVOS.control)
}

export async function leerControl(raiz: string): Promise<FilaControl[]> {
  const destino = rutaEnOut(raiz, ARCHIVOS.control)
  const texto = await conCandado(destino, () => leerTextoOut(raiz, ARCHIVOS.control))
  if (texto === null) return []
  const [encabezado, ...lineas] = texto.split("\n").filter((l) => l !== "")
  if (encabezado !== ENCABEZADO_CONTROL) throw new ErrorPersistencia("out/control.csv: encabezado inesperado")
  return lineas.map((linea, i) => {
    const [solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts, ...sobrantes] = parsearLineaCsv(linea)
    if (sobrantes.length > 0) throw new ErrorPersistencia(`out/control.csv: fila ${i + 1} con columnas de más`)
    const lista = (v: string | undefined) => (v === undefined || v === "" ? [] : v.split(";"))
    return validar(
      FilaControl,
      { solicitud_id, resultado, numero_oc, retroactiva: retroactiva === "true", bloqueos: lista(bloqueos), confirmaciones: lista(confirmaciones), ts },
      `out/control.csv: fila ${i + 1}`,
    )
  })
}

export async function appendLog(raiz: string, linea: LineaLog): Promise<string> {
  return appendJsonl(raiz, ARCHIVOS.log, validar(LineaLog, linea, "línea de log"))
}

// ---------------------------------------------------------------------------
// Limpieza (solo demo.ts y tests; el servidor nunca la invoca)
// ---------------------------------------------------------------------------

export async function limpiarOut(raiz: string, objetivo: string = dirOut(raiz)): Promise<void> {
  const esperado = dirOut(raiz)
  if (resolve(objetivo) !== esperado) {
    throw new ErrorPersistencia("limpiarOut solo puede borrar el directorio out/ de la raíz indicada")
  }
  await rm(esperado, { recursive: true, force: true })
}
