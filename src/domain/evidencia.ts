// Evidencia de aprobación (PRD HU-4, P0): texto canónico con encabezados y cuerpo + SHA-256.
// Puro: no lee ni escribe archivos. La compuerta "caso bloqueado" se aplica en la tool (F6).
import type { AprobacionFixture } from "../schemas"
import { normalizarTexto } from "./normalizar"
import { sha256Hex } from "./sello"

// Solo los campos de aprobacion.json definidos por el PRD 7.1 (de, para, fecha, asunto, cuerpo).
export type DatosEvidencia = Pick<AprobacionFixture, "de" | "para" | "fecha" | "asunto" | "cuerpo">
export type Evidencia = { contenido: string; sha256: string }

export const TITULO_EVIDENCIA = "EVIDENCIA DE APROBACIÓN"

// Encabezados en una sola línea: un salto de línea en un dato no puede fabricar otro encabezado.
function encabezado(valor: string): string {
  return normalizarTexto(valor).replace(/\s*\n\s*/g, " ").trim()
}

// El hash se calcula sobre `contenido`, que no incluye ninguna línea con el propio hash.
export function construirEvidencia(datos: DatosEvidencia): Evidencia {
  const contenido = [
    TITULO_EVIDENCIA,
    `De: ${encabezado(datos.de)}`,
    `Para: ${encabezado(datos.para)}`,
    `Fecha: ${encabezado(datos.fecha)}`,
    `Asunto: ${encabezado(datos.asunto)}`,
    "",
    normalizarTexto(datos.cuerpo),
  ].join("\n")
  return { contenido, sha256: sha256Hex(contenido) }
}

// Texto del archivo aprobacion.txt: contenido canónico seguido de la línea del hash.
export function renderArchivoEvidencia(evidencia: Evidencia): string {
  return `${evidencia.contenido}\n---\nsha256: ${evidencia.sha256}\n`
}
