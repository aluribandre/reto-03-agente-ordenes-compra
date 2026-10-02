// Carga de un caso de fixtures/reto-03 al Paquete canónico (PRD 7.2) y de los maestros.
// Solo lectura: nunca escribe. Nunca lanza: devuelve { ok, data } | { ok: false, error } (capa A).
// Los mensajes usan rutas relativas a fixtures/reto-03; nunca exponen rutas absolutas.
import { readdir, readFile, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import type { ZodError } from "zod"
import { RAIZ_PROYECTO } from "../config"
import type { DatosEvidencia } from "../domain/evidencia"
import { normalizarEmail, normalizarTexto } from "../domain/normalizar"
import {
  AprobacionFixture,
  Caso,
  CorreoFixture,
  Maestros,
  Paquete,
  Solicitud,
  type CodigoError,
  type ErrorTool,
  type ResultadoTool,
} from "../schemas"
import { contieneAprobado, parseCotizacion, parseFactura } from "./parsers"

export type OpcionesCarga = { raiz?: string }

// Equivalencias declaradas por nota_fixture (adjunto real → archivo normalizado del fixture).
// Solo sirven para localizar archivos: nota_fixture nunca entra al dominio.
export const EQUIVALENCIAS = {
  solicitud: { adjunto: "solicitud.xlsx", archivo: "solicitud.json" },
  cotizacion: { adjunto: "cotizacion.pdf", archivo: "cotizacion.txt" },
  aprobacion: { adjunto: "aprobacion.eml", archivo: "aprobacion.json" },
  factura: { adjunto: "factura.pdf", archivo: "factura.txt" },
} as const

const ARCHIVO_CORREO = "correo.json"

const ARCHIVOS_MAESTROS = {
  proveedores: "proveedores.json",
  centros_costo: "centros-costo.json",
  indicadores_iva: "indicadores-iva.json",
  condiciones_pago: "condiciones-pago.json",
} as const

const CAMPOS_MONTO = new Set(["cantidad", "valor_unitario", "valor_total"])

type Faltantes = Paquete["faltantes"]

// ---------------------------------------------------------------------------
// Errores controlados
// ---------------------------------------------------------------------------

class FalloIngestion extends Error {
  constructor(readonly error: ErrorTool) {
    super(error.mensaje)
  }
}

function fallar(codigo: CodigoError, mensaje: string, sugerencia: string, detalle?: Record<string, unknown>): never {
  throw new FalloIngestion(detalle ? { codigo, mensaje, sugerencia, detalle } : { codigo, mensaje, sugerencia })
}

const ERROR_INTERNO: ErrorTool = {
  codigo: "ERROR_INTERNO",
  mensaje: "Error interno al leer los fixtures.",
  sugerencia: "Reintentar; si persiste, revisar el registro del servidor.",
}

function comoError(e: unknown): { ok: false; error: ErrorTool } {
  return { ok: false, error: e instanceof FalloIngestion ? e.error : ERROR_INTERNO }
}

function camposConError(error: ZodError): string[] {
  return error.issues.map((i) => (i.path.length > 0 ? i.path.map(String).join(".") : "(raíz)"))
}

// ---------------------------------------------------------------------------
// Lectura segura
// ---------------------------------------------------------------------------

function dirFixtures(raiz: string): string {
  return resolve(raiz, "fixtures", "reto-03")
}

function esNoEncontrado(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT"
}

async function leerSiExiste(ruta: string): Promise<string | null> {
  try {
    return normalizarTexto(await readFile(ruta, "utf8"))
  } catch (e) {
    if (esNoEncontrado(e)) return null
    throw e
  }
}

function parsearJson(texto: string, rutaRelativa: string): unknown {
  try {
    return JSON.parse(texto)
  } catch {
    fallar("JSON_MALFORMADO", `${rutaRelativa} no es JSON válido.`, "Pedir el reenvío del archivo; no se puede interpretar.", {
      archivo: rutaRelativa,
    })
  }
}

async function casosDisponibles(base: string): Promise<string[]> {
  try {
    const entradas = await readdir(base, { withFileTypes: true })
    return entradas.filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch {
    return []
  }
}

// La ruta del caso debe quedar exactamente en fixtures/reto-03/solicitudes/<caso>.
async function resolverDirCaso(raiz: string, caso: string): Promise<string> {
  const base = resolve(dirFixtures(raiz), "solicitudes")
  const dir = resolve(base, caso)
  const rel = relative(base, dir)
  if (rel !== caso || rel.startsWith("..") || isAbsolute(rel)) {
    fallar("CASO_INVALIDO", "El identificador de caso no es válido.", "Usar el nombre de la carpeta del caso, p. ej. sol-004.")
  }
  const info = await stat(dir).catch((e: unknown) => {
    if (esNoEncontrado(e)) return null
    throw e
  })
  if (info === null || !info.isDirectory()) {
    fallar("CASO_INEXISTENTE", `No existe el caso "${caso}".`, "Usar uno de los casos disponibles.", {
      casos_disponibles: await casosDisponibles(base),
    })
  }
  return dir
}

// ---------------------------------------------------------------------------
// Piezas del paquete
// ---------------------------------------------------------------------------

async function leerCorreo(dir: string, caso: string): Promise<CorreoFixture> {
  const rel = `solicitudes/${caso}/${ARCHIVO_CORREO}`
  const texto = await leerSiExiste(join(dir, ARCHIVO_CORREO))
  if (texto === null) {
    fallar("CORREO_FALTANTE", `Falta ${rel}.`, "Pedir el reenvío del correo de solicitud.", { archivo: rel })
  }
  const r = CorreoFixture.safeParse(parsearJson(texto, rel))
  if (!r.success) {
    fallar("INSUMO_ILEGIBLE", `${rel} no tiene la estructura de correo esperada.`, "Pedir el reenvío del correo de solicitud.", {
      archivo: rel,
      campos: camposConError(r.error),
    })
  }
  return r.data
}

async function leerSolicitud(dir: string, caso: string): Promise<Solicitud> {
  const { adjunto, archivo } = EQUIVALENCIAS.solicitud
  const rel = `solicitudes/${caso}/${archivo}`
  const texto = await leerSiExiste(join(dir, archivo))
  if (texto === null) {
    fallar("SOLICITUD_FALTANTE", `Falta la solicitud (${adjunto}).`, `Pedir al solicitante el Excel de solicitud (${adjunto}).`, {
      archivo: rel,
    })
  }
  const r = Solicitud.safeParse(parsearJson(texto, rel))
  if (!r.success) {
    const campos = camposConError(r.error)
    const montos = campos.filter((c) => CAMPOS_MONTO.has(c))
    if (montos.length > 0) {
      fallar(
        "MONTO_NO_NUMERICO",
        `La solicitud tiene montos no numéricos o no positivos: ${montos.join(", ")}.`,
        "Pedir al solicitante corregir cantidad, valor unitario y valor total en el Excel de solicitud.",
        { archivo: rel, campos: montos },
      )
    }
    fallar("SOLICITUD_INVALIDA", `La solicitud no tiene los campos requeridos: ${campos.join(", ")}.`, "Pedir al solicitante el Excel de solicitud completo.", {
      archivo: rel,
      campos,
    })
  }
  return r.data
}

async function leerCotizacion(dir: string, caso: string, faltantes: Faltantes): Promise<Paquete["cotizacion"]> {
  const { adjunto, archivo } = EQUIVALENCIAS.cotizacion
  const texto = await leerSiExiste(join(dir, archivo))
  if (texto === null) {
    faltantes.push({ pieza: "cotizacion", archivo: adjunto, motivo: "archivo_ausente" })
    return null
  }
  const r = parseCotizacion(texto)
  if (!r.ok) {
    const rel = `solicitudes/${caso}/${archivo}`
    fallar("INSUMO_ILEGIBLE", `La cotización no se puede leer: ${r.motivo}.`, "Pedir al solicitante una cotización legible con proveedor y total.", {
      archivo: rel,
      motivo: r.motivo,
    })
  }
  return r.valor
}

async function leerAprobacion(dir: string, caso: string, faltantes: Faltantes): Promise<Paquete["aprobacion"]> {
  const { adjunto, archivo } = EQUIVALENCIAS.aprobacion
  const rel = `solicitudes/${caso}/${archivo}`
  const texto = await leerSiExiste(join(dir, archivo))
  if (texto === null) {
    faltantes.push({ pieza: "aprobacion", archivo: adjunto, motivo: "archivo_ausente" })
    return null
  }
  const r = AprobacionFixture.safeParse(parsearJson(texto, rel))
  if (!r.success) {
    fallar("INSUMO_ILEGIBLE", `${rel} no tiene la estructura de aprobación esperada.`, "Pedir el reenvío del correo de aprobación del líder.", {
      archivo: rel,
      campos: camposConError(r.error),
    })
  }
  return {
    de: normalizarEmail(r.data.de),
    fecha: r.data.fecha,
    aprobado: contieneAprobado(r.data.cuerpo),
    texto: normalizarTexto(r.data.cuerpo),
  }
}

async function leerFactura(dir: string, caso: string, declarada: boolean, faltantes: Faltantes): Promise<Paquete["factura"]> {
  const { adjunto, archivo } = EQUIVALENCIAS.factura
  const texto = await leerSiExiste(join(dir, archivo))
  if (texto === null) {
    if (declarada) faltantes.push({ pieza: "factura", archivo: adjunto, motivo: "archivo_ausente" })
    return null
  }
  const r = parseFactura(texto)
  if (!r.ok) {
    fallar("INSUMO_ILEGIBLE", `La factura no se puede leer: ${r.motivo}.`, "Pedir una copia legible de la factura.", {
      archivo: `solicitudes/${caso}/${archivo}`,
      motivo: r.motivo,
    })
  }
  return r.valor
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

export async function cargarCaso(caso: unknown, opciones: OpcionesCarga = {}): Promise<ResultadoTool<Paquete>> {
  try {
    const valido = Caso.safeParse(caso)
    if (!valido.success) {
      fallar("CASO_INVALIDO", "El identificador de caso no es válido.", "Usar el nombre de la carpeta del caso, p. ej. sol-004.")
    }
    const nombre = valido.data
    const dir = await resolverDirCaso(opciones.raiz ?? RAIZ_PROYECTO, nombre)

    const correo = await leerCorreo(dir, nombre)
    const solicitud = await leerSolicitud(dir, nombre)
    const faltantes: Faltantes = []
    const cotizacion = await leerCotizacion(dir, nombre, faltantes)
    const aprobacion = await leerAprobacion(dir, nombre, faltantes)
    const facturaDeclarada = correo.adjuntos.some((a) => {
      const n = a.trim().toLowerCase()
      return n === EQUIVALENCIAS.factura.adjunto || n === EQUIVALENCIAS.factura.archivo
    })
    const factura = await leerFactura(dir, nombre, facturaDeclarada, faltantes)

    // El cuerpo del correo de solicitud y nota_fixture no forman parte del Paquete.
    const paquete = Paquete.safeParse({
      correo: { id: correo.id, de: normalizarEmail(correo.de), asunto: correo.asunto, fecha: correo.fecha },
      solicitud,
      cotizacion,
      aprobacion,
      factura,
      faltantes,
    })
    if (!paquete.success) return { ok: false, error: ERROR_INTERNO }
    return { ok: true, data: paquete.data }
  } catch (e) {
    return comoError(e)
  }
}

// Campos de aprobacion.json que necesita la evidencia (PRD 7.1: de, para, fecha, asunto, cuerpo).
// null si el caso no trae aprobación. Sin nota_fixture, sin cc, sin rutas, sin lógica de negocio.
export async function cargarAprobacionFuente(caso: unknown, opciones: OpcionesCarga = {}): Promise<ResultadoTool<DatosEvidencia | null>> {
  try {
    const valido = Caso.safeParse(caso)
    if (!valido.success) {
      fallar("CASO_INVALIDO", "El identificador de caso no es válido.", "Usar el nombre de la carpeta del caso, p. ej. sol-004.")
    }
    const nombre = valido.data
    const dir = await resolverDirCaso(opciones.raiz ?? RAIZ_PROYECTO, nombre)
    const { archivo } = EQUIVALENCIAS.aprobacion
    const rel = `solicitudes/${nombre}/${archivo}`
    const texto = await leerSiExiste(join(dir, archivo))
    if (texto === null) return { ok: true, data: null }
    const r = AprobacionFixture.safeParse(parsearJson(texto, rel))
    if (!r.success) {
      fallar("INSUMO_ILEGIBLE", `${rel} no tiene la estructura de aprobación esperada.`, "Pedir el reenvío del correo de aprobación del líder.", {
        archivo: rel,
        campos: camposConError(r.error),
      })
    }
    const { de, para, fecha, asunto, cuerpo } = r.data
    return { ok: true, data: { de, para, fecha, asunto, cuerpo } }
  } catch (e) {
    return comoError(e)
  }
}

export async function cargarMaestros(opciones: OpcionesCarga = {}): Promise<ResultadoTool<Maestros>> {
  try {
    const dir = join(dirFixtures(opciones.raiz ?? RAIZ_PROYECTO), "maestros")
    const datos: Record<string, unknown> = {}
    for (const [clave, archivo] of Object.entries(ARCHIVOS_MAESTROS)) {
      const rel = `maestros/${archivo}`
      const texto = await leerSiExiste(join(dir, archivo))
      if (texto === null) {
        fallar("MAESTRO_INVALIDO", `Falta el maestro ${rel}.`, "Restaurar los maestros de fixtures/reto-03/maestros.", { archivo: rel })
      }
      try {
        datos[clave] = JSON.parse(texto)
      } catch {
        fallar("MAESTRO_INVALIDO", `${rel} no es JSON válido.`, "Restaurar los maestros de fixtures/reto-03/maestros.", { archivo: rel })
      }
    }
    const r = Maestros.safeParse(datos)
    if (!r.success) {
      fallar("MAESTRO_INVALIDO", "Un maestro no tiene la estructura esperada.", "Restaurar los maestros de fixtures/reto-03/maestros.", {
        campos: camposConError(r.error),
      })
    }
    return { ok: true, data: r.data }
  } catch (e) {
    return comoError(e)
  }
}
