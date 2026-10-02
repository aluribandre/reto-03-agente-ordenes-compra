// Normalizaciones puras del dominio canónico. Sin E/S, sin reloj, deterministas.
import { Fecha } from "../schemas"

// Unicode NFC, saltos de línea LF y sin BOM inicial.
export function normalizarTexto(texto: string): string {
  return texto.replace(/^﻿/, "").replace(/\r\n?/g, "\n").normalize("NFC")
}

// Solo dígitos; si el NIT trae dígito de verificación separado por guion ("900.555.111-2"), se descarta.
export function normalizarNit(nit: string): string {
  return nit.trim().replace(/-\s*\d\s*$/, "").replace(/\D/g, "")
}

// Minúsculas, sin tildes, sin puntuación, espacios colapsados. No elimina sufijos societarios.
export function normalizarNombre(nombre: string): string {
  return normalizarTexto(nombre)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[.,']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

// trim + minúsculas; conserva caracteres Unicode (p. ej. "natalia.ríos@...") en forma NFC.
export function normalizarEmail(email: string): string {
  return normalizarTexto(email).trim().toLowerCase()
}

// Parte YYYY-MM-DD tal como viene escrita (sin convertir zonas horarias). null si no es una fecha válida.
export function fechaDe(valor: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(valor.trim())
  const fecha = m?.[1]
  return fecha !== undefined && Fecha.safeParse(fecha).success ? fecha : null
}

// Aritmética de calendario sobre YYYY-MM-DD. Date.UTC solo como calculadora: sin zona horaria local.
export function sumarDias(fecha: string, dias: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha)
  if (!m || !Number.isInteger(dias)) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + dias)
  return new Date(ms).toISOString().slice(0, 10)
}
