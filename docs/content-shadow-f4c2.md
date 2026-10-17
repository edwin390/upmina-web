# F4-C2 — adaptador OpenAI protegido, sin activación remota

## Contrato y alcance

`content-shadow-openai.ts` implementa el contrato de texto/imagen ya aprobado en
`content-shadow-provider.ts` y documentado en F4-B. Referencia oficial:
<https://platform.openai.com/docs/api-reference/moderations/create>.
No se consultó ni ejecutó un servicio remoto durante esta intervención; no se
afirma compatibilidad E2E con una cuenta/proveedor real a partir de mocks.

Una petición por componente a `POST https://api.openai.com/v1/moderations`:
`{ model: "omni-moderation-latest", input: [{ type: "text", text: "..." }] }`.
Para imágenes: `input: [{ type: "image_url", image_url: { url:
"data:image/webp;base64,..." } }]`. Solo bytes de variantes canónicas preparados
por el lector privado existente. Nunca URLs remotas de imagen, originales R2,
vídeos, audio, fotogramas, identidad de usuario o metadatos Community.

No hay SDK nuevo, migraciones, cambios en R2, UI, scheduler, decisiones automáticas
ni ampliación de privilegios. `flagged` solo se conserva como observación.

## Selección y configuración server-side

Fake sigue siendo el valor predeterminado. El modo real exige simultáneamente:

- `CONTENT_SHADOW_PROVIDER=openai` (valor exacto).
- `CONTENT_SHADOW_RUN_ENABLED=true` (valor exacto).
- `CONTENT_SHADOW_BUDGET_MODE=persistent_dev` (valor exacto).
- `VERCEL=1`, `VERCEL_ENV=preview`.
- `VERCEL_PROJECT_ID=prj_fz4fs3FBfz2Gn4LH1Qnew18PpBrP`, proyecto autorizado
  `edwin-9cad/upmina-web-testing`.
- `VITE_SUPABASE_URL=https://rkqeqbqwdswhpzwqptac.supabase.co`.
- `OPENAI_API_KEY` disponible únicamente en backend, sin espacios/caracteres de
  control y dentro del límite interno de 10–512 caracteres.
- Adaptador SQL F4-C1 operativo: reserva confirmada y autorización de cooldown
  válidas antes de cualquier envío.

Los identificadores Vercel deben provenir del runtime confiable de la plataforma,
no de HTTP ni de un nombre inferido. Si faltan, modo real bloqueado. Esto valida
configuración del servidor, no es una atestación criptográfica de credenciales
ni una inspección remota de su procedencia. Production queda rechazado.

No hay fallback automático a real. Valores desconocidos de proveedor se deniegan.
El endpoint conserva JWT, developer_panel, MFA reciente, aislamiento previo a Auth,
body cerrado a `limit`, mutex local y `private, no-store`. Devuelve únicamente modo
y contadores. No recibe proveedor, scope, N, fechas, credenciales o URLs del cliente.

No se han creado keys ni configurado variables locales persistentes/remotas.
Las pruebas usan un valor sintético y un HTTP mock; la función global fetch es
una trampa que falla si se intenta utilizar la red.

## Presupuesto, lease y resultados

Se reutiliza acquire → verificar → reservar N → start → check por componente →
evaluar → finish. N incluye texto e imágenes únicas. Sin reserva, sin SQL, sin
lease o con token sustituido no hay envío. Además, el ejecutor exige la identidad
del adaptador SQL, no basta una interfaz fake con `mode: persistent_dev`.
El WeakSet de identidad no cuenta solicitudes ni sustituye PostgreSQL como autoridad.
Las dependencias inyectadas son exclusivamente de código backend confiable/tests.

Las reservas no se reembolsan y cada reintento vuelve a reservar su lote completo.
El límite sigue siendo 100 unidades por fecha UTC. Ninguna transacción SQL permanece
abierta durante HTTP. El lote conserva máximo dos trabajos, ejecución secuencial,
deadline de 45 segundos y lease nuevo de 120 segundos. Los guardas SQL conservan
la autoridad final de versión/token; una respuesta tardía no se cuenta como éxito.
Un envío ya autorizado/en curso no puede revocarse retroactivamente.

## HTTP, validación y privacidad

Endpoint fijo HTTPS; `redirect: manual` y rechazo explícito de redirecciones,
credenciales de navegador omitidas, no cache ni referrer. No hay reintentos internos.
Timeout propio de 1.800 ms, menor que los 2.000 ms del componente. Se propaga aborto
del ejecutor y se limita tanto fetch como lectura del cuerpo, incluso en mocks no
cooperativos. Una expiración puede dejar resultado externo desconocido: no se promete
entrega exactamente una vez ni anulación física de un envío ya iniciado.

Respuesta interna máxima 64 KiB y 2.048 lecturas; comprobación de Content-Type JSON,
Content-Length y bytes efectivos. UTF-8 y JSON inválidos se rechazan. No se leen
cuerpos de error HTTP; se cancelan sin guardarlos. Los límites son internos, no
límites confirmados del proveedor. El payload se proyecta a model/input únicamente.

Se validan ID `modr-...`, modelo `omni-moderation-latest` o snapshot fechado,
un único resultado, flagged booleano coherente con categorías, las 13 categorías
del contrato aprobado, mapas completos, scores finitos 0–1 y modalidad realmente
aplicada. Categorías que solo admiten texto no se convierten en cobertura de imagen.
Un esquema/modelo desconocido falla cerrado y requiere revisión de compatibilidad.
Vídeo permanece `unsupported_video`; no hay scores agregados inventados.

Credencial en campos privados y header Authorization, nunca en PostgreSQL, logs o
respuestas al navegador. Solo códigos técnicos allowlist en excepciones. No se
persisten texto de petición, binarios, Base64 ni respuestas completas del proveedor.
Los buffers de lectura se liberan/borran; strings JS inmutables no tienen garantía
de borrado físico. No se generan URLs públicas o capabilities.

## Errores y Retry-After

- 400/422 y respuesta inválida: fallo permanente, nunca safe.
- 401/403: `auth_unavailable`, lote detenido, cooldown global conservador de una hora,
  sin reintento automático de ese trabajo por credenciales.
- 429: `provider_rate_limit`; Retry-After se convierte a segundos sanitizados,
  aceptando entero o fecha HTTP. Ausente/inválido/negativo/pasado usa 60 segundos.
  Se persiste cooldown global antes de terminar. Más de siete días mantiene la
  suspensión existente, sin ruta para eliminarla automáticamente.
- 5xx/error de red: temporal; timeout/408: resultado desconocido y reintento acotado.

Para 429 sin prefijo exitoso se permite retry_wait si queda intento y el plazo cabe
en 3.600 segundos y en el snapshot. El próximo intento vuelve a pasar por autoridad
global: un cooldown concurrente más largo provoca defer sin consumir otro intento.
Un Retry-After excesivo nunca se reduce para adelantar un envío.
Con prefijo exitoso se conserva partial sin repetirlo automáticamente; no existe
checkpoint fiable por componente. Fallo al persistir cooldown detiene el lote y se
reporta como error operativo, sin afirmar que se haya registrado globalmente.

## Verificación y requisitos antes de ejecución real DEV

Pruebas focalizadas en `content-shadow-openai.test.ts`: guardas, solicitud exacta,
texto/imágenes, respuesta segura/flagged, cuotas mediante RPC mock, errores, 429,
timeouts, streaming, lease, privacidad y ausencia de decisiones. Regresiones
seleccionadas del ejecutor/endpoint F4-B; no se repite la batería PostgreSQL F4-C1
porque no cambia SQL. El harness PostgreSQL solo añade el módulo a su lista de
transpilación para conservar su ejecución futura.

Antes de habilitar DEV real se deberán verificar separadamente migraciones/RPC
instaladas, identidades de runtime y credenciales server-side autorizadas, condiciones
de privacidad del proveedor y compatibilidad real del esquema. Nada de ello se
configura, despliega o contacta en F4-C2 local. No se inicia calibración ni F4-C3.
