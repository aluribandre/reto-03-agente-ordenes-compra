# Módulo reutilizable — Agente de Órdenes de Compra

Bonus del PRD (sección 9.4): el agente empaquetado para integrarse a otras plataformas de agentes, **sin depender del servidor** de esta aplicación.

```
modulo/
├── agent.md                       # frontmatter: description, mode: primary, permission {edit: deny, bash: deny}; cuerpo: el system prompt
├── tools/oc.ts                    # las mismas 5 tools, importables sin el servidor
├── skill/ordenes-compra/SKILL.md  # frontmatter: name, description; cuerpo: el conocimiento del proceso
├── sincronizar.ts                 # genera agent.md y SKILL.md desde las fuentes de la aplicación
├── ejemplo.ts                     # uso de las tools como lo haría una plataforma anfitriona
└── README.md
```

## Mismas piezas que la aplicación (no copias divergentes)

| Pieza | Fuente en la aplicación | Cómo se garantiza que es la misma |
|---|---|---|
| `agent.md` | `agent/prompt.md` | Generado por `sincronizar.ts`: frontmatter + el archivo byte a byte. `--check` y `tests/modulo.test.ts` fallan si divergen. |
| `skill/ordenes-compra/SKILL.md` | `src/knowledge/ordenes-compra.md` | Ídem. |
| `tools/oc.ts` | `src/tools/oc.ts` | No es copia: reexporta las mismas tools (mismos `description` y esquemas zod `args`; su `execute` delega en el de la aplicación). Solo adapta el contexto. |

La aplicación arma su system prompt con esas dos mismas fuentes (`agent/prompt.md` + `src/knowledge/ordenes-compra.md`), así que agente, skill y tools son exactamente lo que usa la demo pública.

## Tools

Contrato PRD 6.2: cada tool es `{ description, args, execute(args, ctx) }`; `args` son esquemas zod con `.describe()`, y `execute` devuelve un string JSON `{ ok: true, data } | { ok: false, error }` y **nunca lanza**. Con el archivo `oc.ts`, el modelo las ve como:

| Tool | Argumentos |
|---|---|
| `oc_leer_paquete` | `{ caso }` |
| `oc_validar` | `{ caso, paquete }` |
| `oc_generar_evidencia` | `{ caso }` |
| `oc_construir_payload` | `{ caso, paquete, derivados }` |
| `oc_crear` | `{ caso, payload, confirmado? }` |

Contexto que entrega la plataforma: `{ directory, sessionId }` (obligatorios), y opcionalmente `turnoId` y `autorizacion`. `directory` es la raíz del proyecto que contiene `fixtures/reto-03/`; los artefactos se escriben en `<directory>/out/`.

Las garantías de la aplicación se conservan, porque viven en las tools y en el dominio, no en el servidor:

- reglas RC1–RC10 deterministas;
- paquete, derivados y payload verificados contra el estado canónico;
- payload sellado write-once;
- creación idempotente por `solicitud_id` en el SAP simulado.

**Confirmación humana.** `confirmado: true` no autoriza nada. Una OC que requiere confirmación (sol-004, sol-005, sol-006) solo se crea si el **runtime del anfitrión** entrega en `ctx.autorizacion` una autorización válida para esa acción, caso, `payload_sha`, sesión y turno. Sin ese runtime, el módulo falla cerrado (`CONFIRMACION_REQUERIDA`). Las OC sin confirmaciones (sol-001) se crean directamente.

## Cómo usarlo

Desde la raíz del repositorio (con `bun install` hecho):

```bash
bun run modulo/ejemplo.ts
```

Procesa sol-001 (crea la OC) y sol-004 (exige confirmación) sobre una copia temporal de los fixtures.

Uso programático:

```ts
import { leer_paquete, validar } from "./modulo/tools/oc"

const ctx = { directory: process.cwd(), sessionId: "mi-sesion" }
const paquete = JSON.parse(await leer_paquete.execute({ caso: "sol-001" }, ctx)).data
const resultado = JSON.parse(await validar.execute({ caso: "sol-001", paquete }, ctx))
```

Si cambian el prompt o el conocimiento de la aplicación, regenera y verifica las piezas:

```bash
bun run modulo/sincronizar.ts
bun run modulo/sincronizar.ts --check
```

## Dependencias y responsabilidades

- **No depende de `src/server.ts`** ni del **API HTTP**: no levanta servidor ni hace peticiones.
- **No depende del agent loop** (`src/agent/`) ni del adaptador LLM para importar las tools: el ciclo del agente lo pone la plataforma anfitriona.
- **Reutiliza las tools y el dominio reales del repositorio**: `tools/oc.ts` importa `src/tools/oc.ts`, que usa el dominio, la ingestión, la persistencia y el SAP simulado de `src/`.
- **No es un paquete npm standalone**: debe distribuirse junto con este repositorio, o con sus dependencias internas de `src/`, y con `fixtures/` para los casos de ejemplo.
- **El logging de llamadas es responsabilidad de la plataforma anfitriona.** En la aplicación, `out/log.jsonl` lo escribe el runner del servidor, que el módulo no usa.
- **Las acciones con confirmación requieren una `ctx.autorizacion` válida**, entregada por el runtime de confirmación humana del anfitrión (acción, caso, `payload_sha`, sesión y turno).
- **`confirmado: true` por sí solo nunca autoriza**: sin `ctx.autorizacion` válida, `oc_crear` devuelve `CONFIRMACION_REQUERIDA` y no crea la OC.

## Límites

- El cuerpo de `agent.md` es idéntico al prompt de la aplicación, que dice que el conocimiento está "más abajo". En la aplicación ambas piezas van concatenadas; en otra plataforma ese conocimiento llega por la skill `ordenes-compra`.
