// Genera modulo/agent.md y modulo/skill/ordenes-compra/SKILL.md desde las mismas fuentes que usa la
// aplicación: el cuerpo es byte a byte agent/prompt.md y src/knowledge/ordenes-compra.md; solo se
// antepone el frontmatter que pide el PRD 9.4. Así las piezas no pueden divergir sin que lo detecte
// `--check` (y tests/modulo.test.ts).
//   bun run modulo/sincronizar.ts           escribe los archivos
//   bun run modulo/sincronizar.ts --check   falla si alguno no coincide con su fuente
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { RAIZ_PROYECTO } from "../src/config"

const FRONTMATTER_AGENTE = [
  "---",
  "description: Prepara y crea órdenes de compra en SAP (simulado) a partir del paquete de compra, aplicando los controles RC1–RC10 y pidiendo confirmación humana cuando corresponde.",
  "mode: primary",
  "permission:",
  "  edit: deny",
  "  bash: deny",
  "---",
  "",
].join("\n")

const FRONTMATTER_SKILL = [
  "---",
  "name: ordenes-compra",
  "description: Conocimiento del proceso de órdenes de compra (controles RC1–RC10, tipos de control, códigos de error y de motivo, acciones sugeridas y glosario). Úsalo al procesar solicitudes de compra con las herramientas oc_*.",
  "---",
  "",
].join("\n")

export type Pieza = { destino: string; fuente: string; contenido: string }

export async function piezas(raiz: string = RAIZ_PROYECTO): Promise<Pieza[]> {
  const definiciones = [
    { destino: "modulo/agent.md", fuente: "agent/prompt.md", frontmatter: FRONTMATTER_AGENTE },
    { destino: "modulo/skill/ordenes-compra/SKILL.md", fuente: "src/knowledge/ordenes-compra.md", frontmatter: FRONTMATTER_SKILL },
  ]
  return Promise.all(
    definiciones.map(async (d) => ({ destino: d.destino, fuente: d.fuente, contenido: d.frontmatter + (await readFile(join(raiz, d.fuente), "utf8")) })),
  )
}

if (import.meta.main) {
  const comprobar = process.argv.includes("--check")
  let divergentes = 0
  for (const p of await piezas()) {
    const ruta = join(RAIZ_PROYECTO, p.destino)
    if (comprobar) {
      const actual = await readFile(ruta, "utf8").catch(() => null)
      const ok = actual === p.contenido
      if (!ok) divergentes++
      console.log(`${ok ? "ok       " : "DIVERGE  "} ${p.destino} ← ${p.fuente}`)
    } else {
      await writeFile(ruta, p.contenido, "utf8")
      console.log(`escrito  ${p.destino} ← ${p.fuente}`)
    }
  }
  if (divergentes > 0) process.exit(1)
}
