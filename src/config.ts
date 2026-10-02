// Configuración de runtime y reloj inyectable.
// La clave del LLM NO pasa por aquí: la lee solo el adaptador del proveedor (F8),
// para que ningún objeto de configuración serializable pueda filtrarla.
import { resolve } from "node:path"
import { z } from "zod"
import { FechaHora } from "./schemas"

// Raíz del proyecto (reto-03/), independiente del directorio desde el que se ejecute.
export const RAIZ_PROYECTO = resolve(import.meta.dir, "..")

// Fecha de referencia fija para demo.ts y tests (decisión congelada).
export const FECHA_REFERENCIA_DEMO = "2026-09-03T00:00:00-05:00"

// Toda lógica temporal recibe un reloj; ninguna regla llama a Date.now().
export type Reloj = () => string

export function crearReloj(fechaReferencia?: string): Reloj {
  if (fechaReferencia === undefined) return () => new Date().toISOString()
  const fija = FechaHora.parse(fechaReferencia)
  return () => fija
}

const EsquemaEntorno = z.object({
  FECHA_REFERENCIA: FechaHora.optional(),
  LLM_PROVIDER: z.enum(["anthropic"]).default("anthropic"),
  LLM_MODEL: z.string().min(1).default("claude-opus-5-5"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(16_000),
  LLM_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  LLM_MAX_REINTENTOS: z.coerce.number().int().min(0).max(5).default(1),
  MAX_ITERACIONES: z.coerce.number().int().positive().default(25),
  MAX_TOKENS_SESION: z.coerce.number().int().positive().default(200_000),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
})

export type Config = {
  raiz: string
  reloj: Reloj
  fechaReferencia: string | null
  llm: {
    proveedor: "anthropic"
    modelo: string
    timeoutMs: number
    maxTokens: number
    esfuerzo: "low" | "medium" | "high" | "xhigh" | "max"
    maxReintentos: number
  }
  limites: { maxIteraciones: number; maxTokensSesion: number }
  puerto: number
}

// Variables vacías (p. ej. "FOO=" en .env) se tratan como no definidas.
function sinVacios(env: Record<string, string | undefined>): Record<string, string> {
  const limpio: Record<string, string> = {}
  for (const [clave, valor] of Object.entries(env)) {
    if (valor !== undefined && valor.trim() !== "") limpio[clave] = valor
  }
  return limpio
}

export function cargarConfig(env: Record<string, string | undefined> = process.env): Config {
  const resultado = EsquemaEntorno.safeParse(sinVacios(env))
  if (!resultado.success) {
    throw new Error(`Configuración inválida:\n${z.prettifyError(resultado.error)}`)
  }
  const e = resultado.data
  return {
    raiz: RAIZ_PROYECTO,
    reloj: crearReloj(e.FECHA_REFERENCIA),
    fechaReferencia: e.FECHA_REFERENCIA ?? null,
    llm: {
      proveedor: e.LLM_PROVIDER,
      modelo: e.LLM_MODEL,
      timeoutMs: e.LLM_TIMEOUT_MS,
      maxTokens: e.LLM_MAX_TOKENS,
      esfuerzo: e.LLM_EFFORT,
      maxReintentos: e.LLM_MAX_REINTENTOS,
    },
    limites: { maxIteraciones: e.MAX_ITERACIONES, maxTokensSesion: e.MAX_TOKENS_SESION },
    puerto: e.PORT,
  }
}
