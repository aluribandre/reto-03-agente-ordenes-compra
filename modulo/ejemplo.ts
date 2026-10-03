// Ejemplo: usar las tools del módulo como lo haría otra plataforma de agentes, sin servidor ni LLM.
// Trabaja sobre una copia temporal de fixtures/ (no escribe en el out/ del repositorio).
//   bun run modulo/ejemplo.ts
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { RAIZ_PROYECTO } from "../src/config"
import { DataConstruirPayload, DataCrear, DataLeerPaquete, DataValidar, ErrorTool } from "../src/schemas"
import { construir_payload, crear, generar_evidencia, leer_paquete, validar, type ContextoPlataforma } from "./tools/oc"

// Toda tool devuelve un string JSON { ok, data } | { ok: false, error }.
const Fallo = z.object({ ok: z.literal(false), error: ErrorTool })
const Exito = z.object({ ok: z.literal(true), data: z.unknown() })

async function datos<S extends z.ZodType>(esquema: S, salida: Promise<string>): Promise<z.output<S>> {
  const crudo: unknown = JSON.parse(await salida)
  const fallo = Fallo.safeParse(crudo)
  if (fallo.success) throw new Error(`${fallo.data.error.codigo}: ${fallo.data.error.mensaje}`)
  return esquema.parse(Exito.parse(crudo).data)
}

const directorio = await mkdtemp(join(tmpdir(), "modulo-ejemplo-"))
await cp(join(RAIZ_PROYECTO, "fixtures"), join(directorio, "fixtures"), { recursive: true })

try {
  // Contexto mínimo que entrega la plataforma anfitriona (PRD 6.2).
  const ctx: ContextoPlataforma = { directory: directorio, sessionId: "ejemplo-modulo" }

  for (const caso of ["sol-001", "sol-004"]) {
    // El anfitrión retransmite a cada tool exactamente lo que devolvió la anterior.
    const paquete = await datos(DataLeerPaquete, leer_paquete.execute({ caso }, ctx))
    const v = await datos(DataValidar, validar.execute({ caso, paquete }, ctx))
    await generar_evidencia.execute({ caso }, ctx)
    const p = await datos(DataConstruirPayload, construir_payload.execute({ caso, paquete, derivados: v.derivados }, ctx))
    const c = await datos(DataCrear, crear.execute({ caso, payload: p.payload }, ctx)).then(
      (d) => `OC ${d.numero_oc}`,
      (e: unknown) => (e instanceof Error ? e.message : "error"),
    )
    console.log(`${caso}: ${v.resumen}`)
    console.log(`         oc_crear → ${c}`)
  }
  console.log("\nsol-004 requiere confirmación: sin una autorización del runtime del anfitrión (ctx.autorizacion) no se crea la OC.")
} finally {
  await rm(directorio, { recursive: true, force: true })
}
