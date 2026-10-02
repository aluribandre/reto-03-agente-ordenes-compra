# Agente de Órdenes de Compra

Reto 03 · Automatización de compras con IA

Agente conversacional que convierte un paquete de compra (correo, solicitud, cotización, aprobación y, si existe, factura) en una orden de compra creada en un **SAP simulado**, con controles de negocio deterministas, confirmación humana gobernada por el runtime y trazabilidad completa en archivos.

**Qué demuestra**

- Un LLM que **interpreta y orquesta**, pero no decide reglas de negocio ni autoriza acciones.
- Controles RC1–RC10 como funciones puras y probadas, fuera del modelo.
- Payload sellado (SHA-256, write-once): lo que el usuario revisó y confirmó es exactamente lo que se envía a SAP.
- Creación idempotente por `solicitud_id` y recuperación ante fallos parciales.
- Una demo determinista que corre **sin API key**.

**Stack**: Bun 1.4 · TypeScript 7 (strict, sin `any`) · zod 4 · `@anthropic-ai/sdk` · frontend HTML/CSS/JS sin frameworks.

> Documento técnico completo (decisiones, matriz de controles, diseño SAP real, riesgos): [SOLUCION.md](SOLUCION.md).
> Requerimientos originales: [PRD.md](PRD.md).

---

## Contenido

1. [Demo rápida](#demo-rápida)
2. [Arquitectura](#arquitectura)
3. [Requisitos](#requisitos)
4. [Instalación](#instalación)
5. [Configuración](#configuración)
6. [Demo determinista (sin LLM)](#demo-determinista-sin-llm)
7. [Interfaz web](#interfaz-web)
8. [API HTTP](#api-http)
9. [Tests](#tests)
10. [Casos de prueba](#casos-de-prueba)
11. [Guardrails principales](#guardrails-principales)
12. [Estructura del repositorio](#estructura-del-repositorio)
13. [Limitaciones conocidas](#limitaciones-conocidas)
14. [Documentación técnica](#documentación-técnica)

---

## Demo rápida

```bash
bun install --frozen-lockfile
bun run demo
```

No requiere API key ni red. Procesa los 6 casos de `fixtures/reto-03/` con las mismas tools que usa el agente y deja los artefactos en `out/`.

## Arquitectura

```mermaid
flowchart TD
    U[Usuario / UI web] -->|POST /api/chat| API[API HTTP<br/>src/server.ts]
    U -->|POST /api/confirm<br/>botón Confirmar| API
    API --> RT[Runtime de sesión<br/>un turno a la vez por sesión]
    RT --> AUTH[Runtime de autorización<br/>src/agent/autorizacion.ts]
    RT --> LOOP[Agent loop<br/>src/agent/loop.ts]
    LOOP <--> LLM[LlmAdapter<br/>Anthropic]
    LOOP --> TOOLS[Tools oc_*<br/>validación zod]
    AUTH -. ctx.autorizacion .-> TOOLS
    TOOLS --> DOM[Dominio determinista<br/>RC1–RC10 · evidencia · payload sellado]
    TOOLS --> SAP[SapAdapter]
    SAP --> MOCK[MockSapAdapter<br/>out/sap/ordenes.jsonl]
    TOOLS --> PER[Persistencia out/<br/>control.csv · log.jsonl · artefactos por caso]

    classDef llm fill:#fde68a,stroke:#b45309,color:#111
    classDef det fill:#bbf7d0,stroke:#15803d,color:#111
    class LLM llm
    class DOM,AUTH det
```

- **LLM ≠ reglas de negocio**: el modelo elige qué tool llamar y redacta la respuesta. Bloqueos, confirmaciones, derivados y montos los calcula el dominio (verde).
- **LLM ≠ autorización**: la confirmación humana la interpreta el runtime **antes** de llamar al modelo (botón o frase de una lista cerrada) y la entrega a `oc_crear` por `ctx.autorizacion`, nunca como argumento del modelo.

Separación pedida por el PRD: **comportamiento** en [agent/prompt.md](agent/prompt.md), **conocimiento** en [src/knowledge/ordenes-compra.md](src/knowledge/ordenes-compra.md), **ejecución** en [src/tools/oc.ts](src/tools/oc.ts).

## Requisitos

- [Bun](https://bun.sh) 1.4.x (probado con 1.4.2). No se necesita Node.js.
- Para la conversación real en la UI: una API key de Anthropic. La demo y los tests **no** la necesitan.

## Instalación

Desde la carpeta del repositorio ya descargado o clonado:

```bash
cd reto-03
bun install --frozen-lockfile
```

Copia la plantilla de variables (Bun carga `.env` automáticamente):

```bash
cp .env.example .env
```

En PowerShell: `Copy-Item .env.example .env`.

## Configuración

Todas las variables son opcionales: una variable vacía equivale a no definida y toma el valor por defecto.

| Variable | Requerida | Default | Propósito |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Solo para chat real | — | Credencial del proveedor LLM. La lee únicamente el SDK en el backend. |
| `LLM_PROVIDER` | No | `anthropic` | Único proveedor implementado detrás de `LlmAdapter`. |
| `LLM_MODEL` | No | `claude-opus-5-5` | Modelo del proveedor. |
| `LLM_TIMEOUT_MS` | No | `60000` | Timeout por llamada al modelo. |
| `LLM_MAX_TOKENS` | No | `16000` | `max_tokens` por respuesta. |
| `LLM_EFFORT` | No | `medium` | `low` \| `medium` \| `high` \| `xhigh` \| `max`. |
| `LLM_MAX_REINTENTOS` | No | `1` | Reintentos del SDK ante 408/409/429/5xx/red (0–5). |
| `MAX_ITERACIONES` | No | `25` | Tope de iteraciones tool → modelo por turno (CA1). |
| `MAX_TOKENS_SESION` | No | `200000` | Presupuesto de tokens por sesión (control de costo). |
| `PORT` | No | `3000` | Puerto HTTP. |
| `FECHA_REFERENCIA` | No | hora real | Congela el reloj del servidor (ISO con offset). `demo.ts` y los tests usan su propia fecha fija. |

Notas sobre la credencial:

- `bun run demo` y `bun test` **no** usan LLM ni red.
- El servidor **arranca sin credencial**: `/api/health` responde y la UI carga; `/api/chat` devuelve `503 LLM_NO_CONFIGURADO`.
- `llmConfigured: true` en `/api/health` significa **credencial presente** (`ANTHROPIC_API_KEY` o `ANTHROPIC_AUTH_TOKEN`), no conectividad verificada con el proveedor.
- La clave nunca se envía al frontend, a los logs ni a las respuestas de la API.

## Demo determinista (sin LLM)

```bash
bun run demo
```

`demo.ts` limpia `out/`, fija el reloj en `2026-09-03T00:00:00-05:00` y ejecuta 9 pasos llamando a las tools a través del mismo runner que usa el agente. Para `sol-004` y `sol-005` actúa como humano simulado: entrega una autorización válida por `ctx` (no interpreta lenguaje natural). No autoriza `sol-006`.

Resultado esperado:

| Paso | Caso | Resultado |
|---|---|---|
| 1 | sol-001 | OC `4500000001` creada sin confirmación |
| 2 | sol-001 | Misma OC `4500000001` (idempotencia: no se crea otra) |
| 3 | sol-002 | Bloqueado por RC1 |
| 4 | sol-003 | Bloqueado por RC2 (RC3 no evaluable) |
| 5–6 | sol-004 | Pendiente RC5 → con autorización: OC `4500000002` por COP 25.000.000 |
| 7–8 | sol-005 | Pendiente RC8 → con autorización: OC `4500000003`, marcada retroactiva |
| 9 | sol-006 | Pendiente RC6; derivados IVA `C1` y pago `Z030` informados |

Totales: **3 OC creadas · 2 bloqueados · 1 pendiente final · 9 intentos** registrados en `out/control.csv`.

Dos ejecuciones consecutivas producen exactamente los mismos archivos en `out/` (verificado por hash del árbol).

Artefactos generados:

```
out/
├── control.csv              # una fila por intento: solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts
├── log.jsonl                # una línea por llamada a tool (sin argumentos completos ni textos de correo)
├── sap/ordenes.jsonl        # "base de datos" del SAP simulado
└── sol-00X/
    ├── aprobacion.txt       # evidencia de aprobación con sha256
    ├── payload.json         # OC sellada (write-once) + payload_sha
    ├── trazabilidad.json    # fuente de cada campo + resultado de RC1–RC10
    └── ejecucion.json       # número de OC, payload_sha y autorización usada
```

## Interfaz web

```bash
bun run start
```

Abre `http://localhost:3000`. Para desarrollo con recarga: `bun run dev`.

- Sin `ANTHROPIC_API_KEY`, la UI carga y muestra que el LLM no está configurado.
- Con la clave, prueba el prompt del PRD:

  ```
  Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué
  validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.
  ```

  El turno termina con una pregunta y un banner de confirmación pendiente. Confirma con el botón **Confirmar** o escribiendo `confirmo`. Cada llamada a tool aparece como tarjeta en el chat con su nombre, los argumentos recibidos (los objetos grandes, resumidos: el payload por su `payload_sha`) y el resultado resumido.

## API HTTP

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| `GET` | `/api/health` | — | `{ ok, servicio: "oc-agent", version, llmConfigured }` |
| `POST` | `/api/chat` | `{ sessionId, message }` | `{ ok: true, data: { sessionId, respuesta, estado, eventos[], needsConfirmation, pendingConfirmation, autorizacion } }` |
| `POST` | `/api/confirm` | `{ sessionId, action: "confirm", caso, payload_sha }` | Igual que `/api/chat` |
| `GET` | `/api/sessions/:id` | — | Historial visible, eventos y confirmación pendiente |

Cada evento de tool trae `{ tipo, herramienta, caso, argumentos, ok, codigo_error, resumen }`; `argumentos` es una proyección segura (sin textos de documentos ni payload completo).

Errores: `{ ok: false, error: { codigo, mensaje } }` con 400, 404, 405, 413, 415, 500 o 503. `sessionId`: `^[A-Za-z0-9-]{8,64}$`; `message`: 1–2000 caracteres; cuerpo máximo 16 KB. Solo se sirven `/`, `/index.html`, `/app.js` y `/styles.css` de `web/`.

## Tests

```bash
bun test
bun test --coverage
bun run typecheck
```

- **222 tests** en 8 archivos, sin red ni API key (el LLM se sustituye por adaptadores guionados o por reglas).
- Cobertura aproximada: **90,4 % de funciones · 93,0 % de líneas** (lo no cubierto es principalmente la llamada real al proveedor y la carga de configuración desde el entorno).
- Incluyen: matriz RC1–RC10 y bordes, argumentos del modelo manipulados (paquete, derivados, payload, `confirmado` sin autorización), manipulación de artefactos (payload, evidencia, trazabilidad, catálogos), fallos parciales SAP/persistencia, concurrencia, aislamiento de sesiones, seguridad HTTP (path traversal, límites, tipos de contenido) y 10 escenarios de regresión de extremo a extremo en [tests/regresion.test.ts](tests/regresion.test.ts).
- Cada suite verifica que `fixtures/` no cambió.

## Casos de prueba

| Caso | Escenario | Resultado esperado |
|---|---|---|
| `sol-001` | Camino limpio | Crea la OC automáticamente |
| `sol-002` | Proveedor no registrado (NIT inexistente) | Bloquea por RC1 |
| `sol-003` | Aprobador no autorizado en el centro de costo | Bloquea por RC2; RC3 no evaluable |
| `sol-004` | Cotización 6 % por encima de la solicitud | Confirmación RC5; OC por COP 25.000.000 (valor de la solicitud) |
| `sol-005` | Factura anterior a la solicitud | Confirmación RC8; OC marcada `retroactiva` |
| `sol-006` | IVA y condiciones de pago ausentes | Deriva `C1`/`Z030` del proveedor; RC6 pide confirmación |

## Guardrails principales

- Contenido de correos, cotizaciones y aprobaciones se trata como **dato**, no como instrucciones.
- Las tools siguen las firmas del PRD 6.2 (`paquete`, `derivados`, `payload`, `confirmado`), pero esos objetos se tratan como no confiables: se comparan con el estado canónico y cualquier diferencia se rechaza. Ningún valor de negocio llega desde el modelo; argumentos no documentados se rechazan.
- `confirmado: true` no autoriza nada: sin la autorización del runtime no se crea la OC.
- La autorización la crea el runtime: es de un solo uso, vale solo en su turno y está ligada a caso, `payload_sha` y sesión.
- `oc_crear` revalida controles, integridad del payload, catálogos y autorización antes de llamar a SAP.
- Rutas confinadas a `fixtures/` y `out/`; los resultados al modelo y a la API no incluyen rutas absolutas ni trazas.
- Secretos solo por variables de entorno del backend.
- UI con CSP estricta y `textContent` (nunca `innerHTML`).
- `sessionId` aísla sesiones de navegador; **no es autenticación**.

## Estructura del repositorio

```
reto-03/
├── agent/prompt.md          # comportamiento del agente (system prompt)
├── src/
│   ├── agent/               # agent loop, sesiones y runtime de autorización
│   ├── domain/              # reglas RC1–RC10, evidencia, payload y sello (puro, sin E/S)
│   ├── ingestion/           # lectura y normalización del paquete y los maestros
│   ├── knowledge/           # conocimiento del proceso que consume el agente
│   ├── llm/                 # LlmAdapter y adaptador Anthropic
│   ├── sap/                 # interfaz SapAdapter y MockSapAdapter
│   ├── tools/               # tools oc_* y runner (validación, log, errores tipados)
│   ├── persistencia.ts      # único módulo que escribe en out/
│   ├── schemas.ts           # contratos zod
│   ├── config.ts            # variables de entorno y reloj inyectable
│   └── server.ts            # API HTTP y estáticos
├── web/                     # UI de chat (HTML/CSS/JS sin frameworks)
├── tests/                   # bun test (unitarios, integración y regresión)
├── fixtures/                # datos entregados por Periferia (solo lectura)
├── demo.ts                  # demo determinista sin LLM
├── PRD.md · README.md · SOLUCION.md
└── .env.example
```

## Limitaciones conocidas

- SAP es simulado (`MockSapAdapter`); el diseño del adaptador real está en [SOLUCION.md](SOLUCION.md#11-diseño-del-adaptador-sap-real).
- Sesiones, confirmaciones pendientes y autorizaciones viven **en memoria**: un reinicio las pierde (deliberado).
- Candados en proceso: válido para una sola instancia.
- Sin autenticación de usuarios.
- Evidencia en `.txt` (P0); el PDF (P1) no está implementado.
- Sin streaming de respuestas.
- La integración con el LLM real no se ejerce en los tests (no hay API key en CI/local); el adaptador compila y su traducción de errores está probada.
- Link público de prueba y módulo reutilizable (`modulo/`, bonus) no incluidos en esta entrega.

Lista completa y mitigaciones: [SOLUCION.md](SOLUCION.md#18-riesgos-limitaciones-y-evolución-a-producción).

## Documentación técnica

- [SOLUCION.md](SOLUCION.md): arquitectura, ciclo del agente, modelo y costo, matriz de controles, human-in-the-loop, integridad, idempotencia, adaptador SAP real, métrica de retroactivas, decisiones, supuestos, cobertura, uso de IA y riesgos.
- [PRD.md](PRD.md): requerimientos del reto.
