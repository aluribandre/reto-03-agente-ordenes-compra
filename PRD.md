# Reto técnico 03 — Agente conversacional "Órdenes de Compra SAP"

> Proceso de selección · Equipo Perxia 2.0 · Periferia IT Group
> Versión 2.0 · 2026-09-03 · Documento entregado al candidato al inicio de la sesión

---

## 0. Ficha del reto

| Elemento | Definición |
|---|---|
| **Duración** | Se comunica al inicio de la sesión. |
| **Reto** | Construir un **agente conversacional completo e independiente** que automatice la preparación y creación de órdenes de compra en SAP: interfaz de chat, backend con el ciclo del agente y sus herramientas, y conexión a un modelo de lenguaje. Debe poder probarse desde un link. |
| **Lenguaje** | TypeScript (Bun o Node 20+) en backend y herramientas. Front libre: React, Svelte, Vue o HTML plano. |
| **Modelo de lenguaje** | El que elijas (Anthropic, OpenAI, Google, Azure, Mistral, local). La clave es tuya. Se lee de variable de entorno y **nunca** aparece en el repositorio, el front ni los logs. |
| **IA permitida** | Cualquier asistente de IA para construir (Claude, ChatGPT, Gemini, Copilot, Cursor, etc.). Debes **declarar cuáles usaste y para qué** en `SOLUCION.md`. Debes poder explicar cada línea que entregas. |
| **Lo que NO recibes** | Código ni acceso a ningún producto de Periferia. El reto es independiente: se resuelve con los fixtures adjuntos y este documento. |
| **Entregable** | Repositorio con la aplicación, link para probarla, `demo.ts` que ejecuta las herramientas sin modelo, y `SOLUCION.md` con el planteamiento de la solución. Ver sección 9. |
| **Bonus** | Hasta +10 puntos si además entregas el agente empaquetado como módulo reutilizable (sección 9.4). |
| **Aprobación** | 70 / 100 puntos según la rúbrica de la sección 10. |

---

## 1. Resumen ejecutivo

Cada compra en Periferia llega a administración por correo con tres piezas: un Excel de solicitud, la cotización del proveedor y el correo de aprobación del líder. La analista digita a mano en SAP proveedor, descripción, centro de costos y subárea, valor, indicador de IVA, aprobador y condiciones de pago, y adjunta el correo de aprobación convertido a PDF. Se repite por cada factura que entra a la compañía.

El reto consiste en construir un agente que **lea el paquete, lo valide contra los maestros (proveedores, centros de costo, matriz de aprobación, indicadores de IVA, condiciones de pago), construya el payload de la OC, genere el PDF de evidencia de aprobación y cree la OC en un SAP simulado**. Las excepciones no se resuelven a la fuerza: se clasifican y se devuelven al humano con una recomendación.

Un hallazgo del proceso actual es que muchas OC se crean **después** de que llega la factura, saltándose la cotización. El agente debe detectar ese caso y marcarlo, porque la dirección quiere medirlo.

---

## 2. Contexto y problema

### 2.1 Situación actual (as-is)

| Dimensión | Hoy |
|---|---|
| Entrada | Correo con `solicitud.xlsx` + `cotizacion.pdf` + correo de aprobación del líder. |
| Digitación | Proveedor, descripción, centro de costos, subárea, valor, indicador IVA, aprobador, condiciones de pago. Manual, en SAP GUI. |
| Evidencia | El correo de aprobación se imprime a PDF y se adjunta a la OC. |
| Frecuencia | Una por factura que ingresa. |
| Desvío de proceso | La OC se crea con frecuencia después de recibir la factura. La cotización se salta. |
| Integración | La viabilidad de conectarse a SAP no está confirmada. |

### 2.2 Dolor que resolvemos

1. **Tiempo**: digitación repetitiva con alto costo de error (un centro de costo mal digitado se corrige en cierre contable).
2. **Control**: la validación de que quien aprueba puede aprobar ese monto en ese centro es mental, no sistemática.
3. **Medición**: nadie sabe qué porcentaje de OC son retroactivas.

### 2.3 Lo que este reto NO resuelve

- Conexión real a SAP (RFC, OData, IDoc). Se diseña, no se implementa.
- Lectura de Excel y PDF binarios: los fixtures traen la solicitud como JSON y la cotización como texto. Leer `.xlsx` real es P1 opcional.
- Recepción de mercancía, registro de factura o pago.

---

## 3. Objetivos y no-objetivos

### 3.1 Objetivos

| # | Objetivo | Métrica de éxito en el reto |
|---|---|---|
| O1 | Eliminar la digitación en el flujo normal. | El caso `sol-001` termina con OC creada en el SAP simulado sin intervención humana. |
| O2 | Bloquear lo que no cumple control. | `sol-002` (proveedor inexistente) y `sol-003` (aprobador sin autoridad) **no** crean OC y devuelven la razón y la acción sugerida. |
| O3 | Convertir dudas en confirmaciones, no en errores silenciosos. | `sol-004` (cotización ≠ solicitud) y `sol-006` (IVA no informado) piden confirmación antes de crear. |
| O4 | Medir el desvío de proceso. | `sol-005` (factura anterior a la solicitud) se crea solo con confirmación y queda marcada `retroactiva = true` en el log de control. |

### 3.2 No-objetivos

- Autenticación de usuarios, roles o multiusuario.
- Persistencia en base de datos. El SAP simulado escribe en archivos.
- Workflow de aprobación (el líder ya aprobó por correo; el agente verifica, no solicita).

---

## 4. Usuarios y actores

| Actor | Rol en el flujo | Interacción con el agente |
|---|---|---|
| **Solicitante** | Necesita comprar algo. | Envía el paquete por correo. No usa el agente. |
| **Líder aprobador** | Aprueba el gasto. | Responde el correo con "Aprobado". No usa el agente. |
| **Analista administrativa** (usuaria principal) | Crea la OC en SAP. | Conversa con el agente en el chat: "procesa la solicitud X". Confirma excepciones. |
| **Contabilidad / Auditoría** | Controla el gasto. | Consume el log de control (`out/control.csv`). |
| **SAP** | Sistema de registro. | Simulado por el adaptador local. |

---

## 5. Historias de usuario y criterios de aceptación

### HU-1 · Leer el paquete
**Como** analista, **quiero** que el agente lea el correo, la solicitud, la cotización y la aprobación, **para** tener los datos en un solo lugar.

Criterios de aceptación:
- `oc_leer_paquete` devuelve `{ correo, solicitud, cotizacion, aprobacion, factura? }` normalizados según la sección 7.2.
- Un adjunto ausente se reporta como `null` con el nombre de lo que falta; no se lanza excepción.

### HU-2 · Validar contra maestros y controles
**Como** analista, **quiero** que el agente verifique todo lo que hoy verifico de memoria, **para** no crear OC inválidas.

Criterios de aceptación:
- `oc_validar` aplica todas las reglas de la sección 7.3 y devuelve `{ apta: boolean, bloqueos[], confirmaciones[], derivados{} }`.
- `bloqueos` impiden crear la OC. `confirmaciones` la permiten solo con `confirmado = true`. `derivados` son valores que el agente completó desde maestros (por ejemplo, condiciones de pago del proveedor) y debe informar.

### HU-3 · Construir el payload
**Como** analista, **quiero** ver la OC exactamente como quedaría en SAP antes de crearla, **para** revisar en un vistazo.

Criterios de aceptación:
- `oc_construir_payload` produce el objeto de la sección 7.4, válido contra su esquema `zod`.
- Todo valor del payload es trazable a una fuente: `solicitud`, `cotizacion`, `maestro.<nombre>` o `derivado`. La trazabilidad se guarda en `out/<caso>/trazabilidad.json`.

### HU-4 · Generar la evidencia de aprobación
**Como** auditoría, **quiero** el correo de aprobación como PDF adjunto a la OC, **para** sustentar el gasto.

Criterios de aceptación:
- **P0**: `out/<caso>/aprobacion.txt` con encabezados (de, para, fecha, asunto), cuerpo y `sha256` del contenido.
- **P1**: `out/<caso>/aprobacion.pdf` con el mismo contenido (`pdf-lib` o similar).

### HU-5 · Crear la OC en SAP simulado
**Como** analista, **quiero** que el agente cree la OC y me devuelva el número, **para** cerrar el caso.

Criterios de aceptación:
- `oc_crear` solo se ejecuta si `apta = true` y (`confirmaciones` vacío **o** `confirmado = true`).
- El adaptador simulado asigna número secuencial desde `4500000001`, escribe en `out/sap/ordenes.jsonl` y devuelve `{ numero_oc, fecha }`.
- Crear dos veces el mismo `solicitud_id` devuelve el número existente (idempotencia), no una segunda OC.
- Cada intento (exitoso, bloqueado o pendiente) agrega una fila a `out/control.csv`: `solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts`.

### HU-6 · Manejo de errores
- Paquete incompleto, JSON malformado, monto no numérico: `{ ok: false, error }` legible. El agente informa y sugiere qué pedir al solicitante.

---

## 6. Arquitectura requerida

Construyes un agente conversacional de extremo a extremo. Tienes libertad de framework, pero no de forma: estos componentes y este contrato de herramientas son obligatorios, porque son lo que evaluamos.

### 6.1 Componentes

```
┌──────────────┐  HTTP / WS   ┌─────────────────────────────────────────┐
│  Front: chat │ ───────────▶ │  Backend                                │
│  - historial │ ◀─────────── │  - ciclo del agente (prompt → modelo →  │
│  - tool calls│              │    llamadas a herramientas → respuesta) │
│  - confirmar │              │  - herramientas tipadas (zod)           │
└──────────────┘              │  - adaptador de proveedor LLM           │
                              │  - sesiones en memoria o archivo        │
                              └───────┬─────────────────────┬───────────┘
                                      │                     │
                               fixtures/ (solo lectura)   out/ (escritura)
```

| Componente | Obligatorio | Detalle |
|---|---|---|
| **Front de chat** | Sí | Historial de la conversación, campo de entrada, indicador de "pensando". Debe **mostrar cada llamada a herramienta** (nombre, argumentos, resultado resumido) y **resaltar cuando el agente pide confirmación**. Streaming opcional. |
| **Backend** | Sí | Expone la API del chat. Ejecuta el ciclo del agente con tope de iteraciones. Mantiene la sesión (memoria o archivo). |
| **Herramientas** | Sí | Funciones tipadas con `zod`, separadas del servidor HTTP e importables desde `demo.ts`. Son la **única** fuente de valores que el agente puede afirmar. |
| **Adaptador LLM** | Sí | Una interfaz propia (`enviar(mensajes, herramientas) → respuesta`) con una implementación para el proveedor que elijas. Cambiar de proveedor no debe tocar el ciclo del agente. |
| **System prompt** | Sí | En un archivo Markdown aparte (`agent/prompt.md`), no embebido en código. |
| **Persistencia** | No | Memoria o archivos en `out/` bastan. Sin base de datos. |
| **Autenticación** | No | El link puede ser público. Si lo proteges, entrega la clave de acceso en el README. |

### 6.2 Contrato de herramientas

Cada herramienta es un objeto con tres miembros. El nombre que ve el modelo es `<archivo>_<export>`.

```ts
// src/tools/oc.ts
import { z } from "zod"

export const leer_paquete = {
  description: "…una frase: es lo único que el modelo lee para decidir cuándo llamarla",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/")
  },
  async execute(args: { caso: string }, ctx: { directory: string; sessionId: string }) {
    // ctx.directory = raíz del proyecto; resuelve rutas desde aquí, nunca absolutas
    return JSON.stringify({ ok: true, data: { /* ... */ } })
  },
}
```

| Miembro | Regla |
|---|---|
| `description` | Una frase precisa. |
| `args` | Objeto de esquemas `zod` con `.describe()` en cada campo. El backend valida antes de ejecutar y devuelve el error al modelo si no cumple. |
| `execute(args, ctx)` | Devuelve **string** (JSON serializado) con `{ ok: true, data }` o `{ ok: false, error }`. **Nunca lanza.** |

Contrato mínimo de este reto:

| Herramienta | Entrada | Salida (`data`) | Prioridad |
|---|---|---|---|
| `oc_leer_paquete` | `{ caso }` | Paquete normalizado (7.2) | P0 |
| `oc_validar` | `{ caso, paquete }` | `{ apta, bloqueos[], confirmaciones[], derivados, retroactiva }` | P0 |
| `oc_construir_payload` | `{ caso, paquete, derivados }` | `OrdenCompra` (7.4) + ruta de trazabilidad | P0 |
| `oc_generar_evidencia` | `{ caso }` | `{ ruta, sha256 }` | P0 txt · P1 pdf |
| `oc_crear` | `{ caso, payload, confirmado?: boolean }` | `{ numero_oc, fecha, idempotente: boolean }` o `{ ok: false, error }` | P0 |
| `oc_leer_excel` | `{ ruta }` | `{ filas[] }` | P1 opcional |

### 6.3 Reglas del ciclo del agente

| # | Regla |
|---|---|
| CA1 | Tope de iteraciones herramienta → modelo por turno (sugerido 25). Al alcanzarlo, el agente responde con lo que tiene y lo que falta. |
| CA2 | El modelo **no puede afirmar un valor** que no haya salido de una herramienta. El prompt lo prohíbe; el diseño lo hace innecesario. |
| CA3 | **Confirmación humana**: cuando una acción la requiere, el agente termina el turno con una pregunta explícita. Solo procede si el siguiente mensaje del usuario confirma. El front resalta ese estado. |
| CA4 | Toda llamada a herramienta queda en el historial visible del chat y en `out/log.jsonl`. |
| CA5 | Un error de herramienta o del proveedor LLM se muestra en el chat en lenguaje claro. La sesión no muere. |

### 6.4 API mínima

Diseño libre, pero documentado en el README. Referencia:

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation }` (o stream de eventos) |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión |
| `GET` | `/api/health` | `{ ok: true, provider, model }` sin exponer claves |

### 6.5 Estructura sugerida del repositorio

```
reto-03/
├── agent/
│   └── prompt.md                        # system prompt del agente
├── src/
│   ├── server.ts                        # API HTTP y ciclo del agente
│   ├── llm/
│   │   ├── adapter.ts                   # interfaz del proveedor
│   │   └── <proveedor>.ts               # implementación elegida
│   ├── tools/
│   │   └── oc.ts                        # herramientas (cada export → oc_<export>)
│   └── sap/
│       ├── adapter.ts                   # interfaz SapAdapter (dada en 7.4)
│       └── mock.ts                      # implementación con archivos
│   └── knowledge/
│       └── ordenes-compra.md      # conocimiento del proceso que el agente consulta
├── web/                                 # front de chat
├── fixtures/                            # entregados por Periferia (no modificar)
├── out/                                 # generado en ejecución
├── demo.ts                              # herramientas sin modelo
├── .env.example                         # variables requeridas, sin valores
├── package.json
├── README.md
└── SOLUCION.md
```

Separación que evaluamos: **comportamiento** en `agent/prompt.md`, **conocimiento** en `src/knowledge/`, **ejecución** en `src/tools/`. Un cambio de reglas de negocio no debería tocar el servidor.

### 6.6 `demo.ts` (verificación sin modelo)

Procesa los 6 casos de `fixtures/reto-03/solicitudes/` llamando directamente a las herramientas. Imprime por caso: `apta`, bloqueos, confirmaciones, `retroactiva`, número de OC o motivo. Debe mostrar la idempotencia ejecutando `sol-001` dos veces y una confirmación explícita para `sol-004`. Debe correr sin clave de ningún proveedor:

```bash
bun install && bun run demo.ts
```

---

## 7. Requisitos funcionales detallados

### 7.1 Fixtures

| Ruta | Contenido |
|---|---|
| `fixtures/reto-03/solicitudes/<caso>/correo.json` | `{ id, de, asunto, fecha, cuerpo, adjuntos[] }`. |
| `.../solicitud.json` | Excel de solicitud normalizado: `{ solicitud_id, solicitante, proveedor_nombre, proveedor_nit?, descripcion, centro_costo, subarea, cantidad, valor_unitario, valor_total, moneda, indicador_iva?, condiciones_pago?, fecha_solicitud }`. Campos con `?` pueden faltar. |
| `.../cotizacion.txt` | Texto de la cotización: proveedor, NIT, ítems, subtotal, IVA, total, validez. |
| `.../aprobacion.json` | `{ de, para, fecha, asunto, cuerpo }`. El cuerpo contiene o no la palabra "Aprobado". |
| `.../factura.txt` | Solo en el caso retroactivo: factura con fecha anterior a `fecha_solicitud`. |
| `fixtures/reto-03/maestros/proveedores.json` | `{ codigo_sap, nit, nombre, condiciones_pago_default, indicador_iva_default, activo }[]`. |
| `fixtures/reto-03/maestros/centros-costo.json` | `{ centro_costo, subareas[], aprobadores: [{ email, tope }] }[]`. |
| `fixtures/reto-03/maestros/indicadores-iva.json` | `{ codigo, descripcion, tasa }[]`. |
| `fixtures/reto-03/maestros/condiciones-pago.json` | `{ codigo, descripcion, dias }[]`. |

### 7.2 Paquete normalizado

```ts
type Paquete = {
  correo: { id: string; de: string; asunto: string; fecha: string }
  solicitud: Solicitud                 // ver 7.1
  cotizacion: { proveedor: string; nit: string | null; total: number; moneda: string; validez_hasta: string | null; texto: string } | null
  aprobacion: { de: string; fecha: string; aprobado: boolean; texto: string } | null
  factura: { numero: string; fecha: string; total: number } | null
}
```

### 7.3 Reglas de control

| # | Regla | Tipo |
|---|---|---|
| RC1 | El proveedor debe existir en `proveedores.json` (por NIT; si no hay NIT, por nombre normalizado) y estar `activo`. | **Bloqueo** |
| RC2 | La aprobación debe existir, contener "Aprobado" y venir de un correo listado como aprobador del `centro_costo`. | **Bloqueo** |
| RC3 | `valor_total` ≤ `tope` del aprobador para ese centro. | **Bloqueo** |
| RC4 | `subarea` debe pertenecer al `centro_costo`. | **Bloqueo** |
| RC5 | `abs(cotizacion.total − solicitud.valor_total) / solicitud.valor_total` ≤ 2 %. Si excede: confirmación con ambos valores. Si no hay cotización: confirmación. | Confirmación |
| RC6 | `indicador_iva` ausente → se deriva del proveedor (`indicador_iva_default`) y se pide confirmación. | Confirmación + derivado |
| RC7 | `condiciones_pago` ausente → se deriva del proveedor. Solo se informa. | Derivado |
| RC8 | Existe `factura` con `fecha` < `fecha_solicitud` → `retroactiva = true`. Confirmación. Se registra en control. | Confirmación |
| RC9 | La fecha de aprobación debe ser ≥ `fecha_solicitud`. Si no: confirmación. | Confirmación |
| RC10 | `cantidad × valor_unitario` debe igualar `valor_total` (± 1 unidad monetaria). Si no: bloqueo. | **Bloqueo** |

### 7.4 Payload de la OC y adaptador SAP

Esquema simplificado inspirado en la API de órdenes de compra de SAP. Debe validarse con `zod`:

```ts
type OrdenCompra = {
  referencia: { solicitud_id: string; correo_id: string; cotizacion_ref: string | null }
  sociedad: "1000"
  organizacion_compras: "1000"
  proveedor: { codigo_sap: string; nit: string; nombre: string }
  moneda: "COP" | "USD"
  condiciones_pago: string             // código, ej. "Z030"
  aprobador: { email: string; fecha_aprobacion: string; evidencia_sha256: string }
  posiciones: Array<{
    numero: number                     // 10, 20, 30...
    descripcion: string                // máx. 40 caracteres (límite SAP en texto breve)
    cantidad: number
    unidad: "UN" | "H" | "MES"
    precio_unitario: number
    centro_costo: string
    subarea: string
    indicador_iva: string              // código, ej. "C1"
  }>
  excepciones: Array<{ codigo: string; detalle: string; confirmado_por: string | null }>
}
```

Interfaz del adaptador (obligatoria en `src/sap/adapter.ts`):

```ts
export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>
}
```

`src/sap/mock.ts` la implementa sobre `out/sap/`. En `SOLUCION.md` diseñas la implementación real (ver 7.5).

### 7.5 Diseño requerido (solo documentación) — adaptador SAP real

En `SOLUCION.md` describe:
- Qué opción de integración elegirías (OData `API_PURCHASEORDER_PROCESS_SRV`, RFC/BAPI `BAPI_PO_CREATE1`, SAP Integration Suite, o carga por archivo) y por qué, dada una viabilidad no confirmada.
- Cómo mapeas el payload de 7.4 a la estructura real elegida.
- Autenticación y dónde viven las credenciales (nunca en el agente ni en el prompt).
- Idempotencia frente a reintentos y qué haces si SAP responde con error parcial.
- Plan B si la conexión no es viable: cómo el agente igual ahorra tiempo (por ejemplo, generando la OC lista para pegar o un archivo de carga masiva).

---

## 8. Requisitos no funcionales

| Categoría | Requisito |
|---|---|
| Arranque | Un comando levanta front y backend en local (`bun run dev` o `docker compose up`). Menos de 2 minutos en máquina limpia con las variables de `.env.example`. |
| Determinismo | `demo.ts` produce el mismo resultado en ejecuciones consecutivas (salvo timestamps). `out/` se limpia al inicio. |
| Seguridad | Clave del modelo solo en variable de entorno del backend. Nunca en el front, el repositorio, los logs ni las respuestas de la API. Sin credenciales ni datos personales reales. Las herramientas no ejecutan comandos de shell. |
| Costo | Tope de iteraciones por turno y tope de tokens por sesión configurables. Un usuario no puede gastar tu clave sin límite. |
| Robustez | Errores tipados `{ ok: false, error }`. Timeout al proveedor LLM con mensaje claro. Un caso malo no impide el siguiente. |
| Legibilidad | TypeScript sin `any`, funciones cortas, nombres consistentes. |
| Dependencias | Las que necesites, justificadas en `SOLUCION.md`. `zod` obligatorio para los argumentos de herramientas. |

---

## 9. Entregable y documentación

### 9.1 `SOLUCION.md` — estructura obligatoria

1. **Problema en una frase** y a quién le duele.
2. **Arquitectura**: diagrama front → backend → herramientas → archivos, y dónde vive el prompt, el conocimiento y la ejecución.
3. **Ciclo del agente**: cómo implementaste el bucle, el tope de iteraciones y la confirmación humana.
4. **Elección del modelo**: proveedor, modelo, por qué, y costo estimado por caso procesado.
5. **Matriz de controles**: cómo implementaste RC1–RC10 y cuál fue la más difícil.
6. **Diseño del adaptador SAP real** (sección 7.5).
7. **Lectura del proceso**: en media página, qué le dirías a la dirección sobre las OC retroactivas y qué cambio de proceso propondrías.
8. **Decisiones y trade-offs**: mínimo 3, con la alternativa descartada y por qué.
9. **Supuestos** que tomaste al interpretar este PRD.
10. **Cobertura**: tabla de historias de usuario con estado (hecho / parcial / no hecho) y qué falta para producción.
11. **Uso de IA**: qué asistentes usaste para construir, para qué tareas, qué descartaste de lo que te propusieron y por qué.
12. **Riesgos** de llevar esto a producción y cómo los mitigarías.

### 9.2 `README.md`

Cómo levantar en local (un comando), variables de entorno requeridas, cómo correr `demo.ts`, el link de prueba y, si aplica, la clave de acceso al link.

### 9.3 Link para probar

URL pública donde el agente responde (Vercel, Render, Fly.io, Railway, Azure, un túnel estable, o el proveedor que prefieras). Debe estar activo durante la defensa. Si el despliegue no fue posible, se acepta correrlo en local durante la defensa con penalización de `-10`.

### 9.4 Bonus: módulo reutilizable (hasta +10)

Entrega además una carpeta `modulo/` con el agente empaquetado para integrarse a otras plataformas de agentes, sin depender de tu servidor:

```
modulo/
├── agent.md            # frontmatter: description, mode: primary, permission {edit: deny, bash: deny}; cuerpo: el system prompt
├── tools/oc.ts     # las mismas herramientas, importables sin el servidor
└── skill/ordenes-compra/SKILL.md   # frontmatter: name, description; cuerpo: el conocimiento del proceso
```

Se evalúa que las tres piezas sean las mismas que usa tu aplicación (no copias divergentes).

### 9.5 Forma de entrega

Repositorio Git con historial de commits, o `reto-03-<apellido>.zip`. Sin `node_modules/`, sin `out/`, sin `.env`.

---

## 10. Riesgos, supuestos y preguntas abiertas

| Tipo | Contenido |
|---|---|
| Supuesto | Los maestros de los fixtures son completos. En producción se consultan en SAP en tiempo real. |
| Supuesto | El correo de aprobación es evidencia suficiente. Auditoría puede exigir firma digital. |
| Riesgo | La conexión a SAP no sea viable en el corto plazo. Mitigación: Plan B de la sección 7.5. |
| Riesgo | El modelo "arregle" un monto para que cuadre con la cotización. Mitigación: los montos salen de las herramientas; el modelo no puede alterar el payload validado. |
| Pregunta abierta | ¿Quién decide la política sobre OC retroactivas: tolerarlas con marca, o rechazarlas? Fuera del alcance del reto; el agente las mide. |

---

## 11. Prompt de ejemplo para la demo

En tu chat, sesión nueva:

```
Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué
validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.
```

Resultado esperado: Payload resumido en tabla, lista de confirmaciones con los dos valores (solicitud vs cotización), llamadas a herramientas visibles, y una pregunta cerrando el turno. Tras "confirmo", número de OC y ruta de la evidencia.
