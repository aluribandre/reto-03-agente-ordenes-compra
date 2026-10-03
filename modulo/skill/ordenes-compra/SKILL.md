---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra (controles RC1–RC10, tipos de control, códigos de error y de motivo, acciones sugeridas y glosario). Úsalo al procesar solicitudes de compra con las herramientas oc_*.
---
# Conocimiento: órdenes de compra (Reto 03)

## Proceso

Cada compra llega con tres piezas: la solicitud (Excel), la cotización del proveedor y el correo de aprobación del líder. A veces también llega una factura. La OC se crea en SAP con proveedor, descripción, centro de costo y subárea, valor, indicador de IVA, aprobador y condiciones de pago, y lleva adjunta la evidencia de la aprobación.

## Tipos de control

- **BLOCK (bloqueo)**: impide crear la OC. No se levanta con una confirmación; hay que corregir el paquete con el solicitante.
- **CONFIRM (confirmación)**: la OC solo se crea si el usuario lo confirma explícitamente.
- **DERIVE (derivado)**: un valor que faltaba se completó desde el maestro del proveedor y se informa.
- **NO_EVALUABLE**: la regla no se pudo evaluar porque depende de otra que está bloqueada (`depende_de`). Impide que el caso sea apto, pero no es un bloqueo propio.
- **apta**: todas las reglas de bloqueo están en `CUMPLE`.

## Reglas RC1–RC10

| Regla | Qué verifica | Tipo |
|---|---|---|
| RC1 | El proveedor existe en el maestro (por NIT; sin NIT, por nombre normalizado) y está activo | BLOCK |
| RC2 | Existe la aprobación, contiene "Aprobado" y la envía un aprobador del centro de costo | BLOCK |
| RC3 | `valor_total` ≤ tope del aprobador en ese centro de costo | BLOCK |
| RC4 | La subárea pertenece al centro de costo | BLOCK |
| RC5 | La cotización difiere ≤ 2 % del valor solicitado; sin cotización, se confirma | CONFIRM |
| RC6 | Si falta el indicador de IVA, se deriva del proveedor y se confirma | CONFIRM + DERIVE |
| RC7 | Si faltan las condiciones de pago, se derivan del proveedor (solo se informa) | DERIVE |
| RC8 | Una factura anterior a la solicitud hace la OC **retroactiva**; se confirma | CONFIRM |
| RC9 | La aprobación no puede ser anterior a la solicitud; si lo es, se confirma | CONFIRM |
| RC10 | `cantidad × valor_unitario` = `valor_total` (± 1) | BLOCK |

**Retroactiva**: la factura llegó antes de la solicitud; la compra ocurrió antes del proceso de OC. Se puede crear con confirmación, y queda marcada en `out/control.csv` para que la dirección mida este desvío.

**Monto de la OC**: siempre es el de la solicitud, que es lo aprobado. La cotización solo se compara (RC5). Confirmar RC5 significa crear la OC por el valor solicitado; nunca por el de la cotización. Si el valor correcto es el cotizado, se necesita una solicitud y una aprobación nuevas.

## Códigos de motivo y acción sugerida

| Código | Significado |
|---|---|
| `no_encontrado` / `verificar_nit_o_tramitar_alta_proveedor` | El proveedor no está en el maestro: verificar el NIT o tramitar su alta |
| `inactivo` / `reactivar_o_cambiar_proveedor` | El proveedor está inactivo: reactivarlo o elegir otro |
| `ambiguo` / `solicitar_nit_proveedor` | El nombre coincide con varios proveedores: pedir el NIT |
| `sin_aprobacion` / `solicitar_aprobacion_del_lider` | No hay correo de aprobación |
| `aprobador_no_autorizado_en_cc` / `solicitar_aprobacion_de_aprobador_del_cc` | Quien aprobó no es aprobador de ese centro de costo |
| `sin_palabra_aprobado` / `solicitar_aprobacion_explicita` | El correo no contiene "Aprobado" |
| `centro_costo_inexistente` / `corregir_centro_costo` | El centro de costo no existe en el maestro |
| `aprobador_sin_tope_en_cc` | RC3 no evaluable: el aprobador no tiene tope en ese centro |
| `excede_tope` / `solicitar_aprobacion_con_tope_suficiente` | El valor supera el tope del aprobador. Nunca sugerir fraccionar la compra |
| `subarea_no_pertenece` / `corregir_subarea_o_centro_costo` | La subárea no corresponde al centro de costo |
| `diferencia_excede_tolerancia` / `confirmar_valor_solicitud_o_devolver` | La cotización difiere más del 2 %: confirmar por el valor solicitado o devolver |
| `sin_cotizacion` / `confirmar_sin_cotizacion_o_solicitarla` | No hay cotización |
| `iva_derivado_del_proveedor` / `confirmar_iva_derivado` | IVA tomado del maestro del proveedor |
| `condiciones_pago_derivadas_del_proveedor` | Condiciones de pago tomadas del maestro |
| `factura_anterior_a_solicitud` / `confirmar_oc_retroactiva` | OC retroactiva |
| `aprobacion_anterior_a_solicitud` / `confirmar_o_solicitar_aprobacion_vigente` | La aprobación es anterior a la solicitud |
| `aritmetica_no_cuadra` / `corregir_montos_solicitud` | Cantidad × valor unitario no da el total |

## Errores de herramientas

- **Ingestión**: `CASO_INEXISTENTE`, `SOLICITUD_FALTANTE`, `JSON_MALFORMADO`, `MONTO_NO_NUMERICO`, `INSUMO_ILEGIBLE`, … El paquete no se puede leer; hay que pedir el insumo correcto.
- **Compuertas**: `CASO_BLOQUEADO` (hay bloqueos) y `CONFIRMACION_REQUERIDA` (falta la confirmación del usuario).
- **Integridad**: `FALTA_EVIDENCIA`, `FALTA_PAYLOAD`, `PAYLOAD_NO_COINCIDE`, `CATALOGO_INVALIDO`, `AUTORIZACION_INVALIDA`. El payload sellado no se puede ejecutar tal como está.
- `SAP_ERROR`: SAP no respondió; reintentar es seguro porque la creación es idempotente.

## SAP simulado

Es un adaptador local que escribe en `out/sap/ordenes.jsonl`. Numera las OC desde 4500000001 y es idempotente por `solicitud_id`: un segundo intento devuelve la misma OC con `idempotente: true`. Cada intento (exitoso, bloqueado o pendiente) queda en `out/control.csv`.

## Glosario

- **Payload sellado**: la OC exacta que se enviaría a SAP, identificada por su `payload_sha`. Es inmutable.
- **Evidencia**: el texto canónico del correo de aprobación, con su hash sha256.
- **Centro de costo / subárea**: unidad que asume el gasto.
- **Indicador de IVA**: código (C0, C1, C2).
- **Condiciones de pago**: código (Z000, Z015, Z030, Z060).
- **Unidad**: `H` si la descripción habla de horas; en otro caso `UN`.
