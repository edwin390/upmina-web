# CLAUDE.md

Este archivo contiene las reglas permanentes de ingeniería y las invariantes
arquitectónicas de UPMINA Web.

Mantén este archivo enfocado únicamente en información que siga siendo útil
entre sesiones.

El repositorio actual y el historial de Git son la fuente de verdad sobre el
estado de la implementación.

# Proyecto

UPMINA Web es un fan site no oficial construido como:

- Vite + React 19 SPA
- TypeScript
- Vercel Serverless Functions
- Supabase

El proyecto integra contenido de:

- Twitch
- YouTube
- Instagram
- TikTok

También contiene infraestructura para autenticación, roles privilegiados y
un futuro sistema privado de administración/moderación.

La interfaz, documentación y la mayoría de los commits se manejan
principalmente en español.

La versión de Node está fijada mediante `engines` en `package.json`.

# Comandos

```bash
npm run dev
# Solo frontend Vite.
# /api NO se sirve con este comando.

npm run dev:local
# Entorno local con Vercel Functions + Vite.

npm run build
# tsc -b && vite build

npm run lint
# ESLint. Los warnings hacen fallar la validación.

npm test
# Suite de Vitest.

npm run test:e2e
# Playwright.

npm run admin:bootstrap-invitation
# COMANDO SENSIBLE.
# NUNCA ejecutar salvo petición explícita del usuario.
# Genera una invitación bootstrap ADMIN real.
````

Para pruebas específicas, usa preferentemente el comando más acotado posible:

```bash
npx vitest run src/lib/example.test.ts
npx vitest run -t "nombre del test"
```

Existe un hook pre-commit de Husky que ejecuta `lint-staged`.

Usa Conventional Commits con un scope apropiado.

# Arquitectura

## Frontend

`src/` contiene la SPA del navegador.

Utiliza:

* Vite
* React 19
* TypeScript
* TanStack Query
* HeroUI
* Tailwind

El TypeScript del navegador se configura mediante `tsconfig.app.json`.

El alias `@/*` apunta a `src/*`.

## Backend

`api/` contiene los entrypoints de Vercel Serverless Functions.

El TypeScript del backend se comprueba mediante `tsconfig.node.json`.

Vercel trata los archivos dentro de `api/` como rutas serverless.

No coloques helpers reutilizables del backend dentro de `api/` si hacerlo
crearía una función serverless innecesaria.

La lógica compartida del backend debe vivir en módulos apropiados de
`src/lib/`.

Los imports relativos utilizados por las funciones Vercel deben respetar
los requisitos ESM existentes del proyecto. El backend actual utiliza
extensiones `.js` explícitas donde son necesarias.

Antes de crear una nueva función serverless, inspecciona la arquitectura de
routing existente y utiliza un dispatcher existente cuando sea apropiado.

El límite de funciones del plan Hobby de Vercel importa para este proyecto.
No crees entrypoints serverless innecesarios.

## Flujo de datos de APIs

El flujo normal de las integraciones es:

Componente React
→ hook
→ `/api/...`
→ Vercel Function
→ proveedor externo
→ respuesta normalizada

Conserva el comportamiento de caché existente salvo que el bloque actual
requiera modificarlo explícitamente.

Evita:

* polling innecesario;
* requests duplicadas;
* reproductores multimedia duplicados;
* carga anticipada innecesaria.

Limpia timers, listeners y recursos cuando corresponda.

El rendimiento debe considerarse tanto en móvil como en PC sin sacrificar
la calidad visual, funcionalidad o UX prevista.

## Desarrollo local

`vite.config.ts` redirige `/api` al servidor local de Vercel Functions.

Ejecutar solamente:

```bash
npm run dev
```

no proporciona las APIs del backend.

Usa el flujo de desarrollo local existente del proyecto cuando sean
necesarias funciones API reales.

No leas archivos de entorno protegidos únicamente para diagnosticar una
configuración.

Cuando sea necesario, pide al operador que configure o verifique variables
sin solicitar sus valores secretos.

# Supabase

Supabase proporciona Postgres y Auth.

El acceso desde cliente y el acceso privilegiado server-side son límites
de seguridad diferentes.

No debilites Row-Level Security simplemente para facilitar el desarrollo.

Las tablas privilegiadas pueden utilizar intencionalmente:

* RLS habilitado;
* FORCE RLS;
* ninguna policy para `anon` o `authenticated`;
* acceso exclusivo mediante `service_role`.

Inspecciona la migración correspondiente antes de cambiar suposiciones
sobre una tabla.

Nunca modifiques retroactivamente una migración que ya fue aplicada en
Supabase remoto.

Los cambios posteriores de esquema deben realizarse mediante una nueva
migración.

# Autenticación y autorización

Autenticación y autorización son conceptos separados.

La arquitectura actual para sesiones privilegiadas es:

Supabase Auth
→ Bearer JWT
→ verificación server-side del JWT
→ user ID / AAL verificados
→ consulta server-side del rol
→ decisión de autorización

El navegador envía el access token mediante:

```text
Authorization: Bearer <token>
```

No introduzcas cookies de sesión para Admin ni `@supabase/ssr` sin una
decisión arquitectónica explícita que sustituya el diseño Bearer actual.

La identidad privilegiada debe provenir de un JWT de Supabase verificado
criptográficamente.

Nunca confíes en estos valores si provienen directamente del cliente:

* user ID;
* role;
* AAL;
* estado ADMIN/MODERATOR.

Esto incluye body, query params, metadata de localStorage u otros datos
controlados por el navegador.

Los roles privilegiados actuales son:

* USER
* MODERATOR
* ADMIN

USER se representa mediante la ausencia de una fila privilegiada en
`admin_roles`.

`admin_roles` es la fuente de verdad server-side para roles privilegiados.

El registro público nunca debe otorgar ADMIN ni MODERATOR.

# MFA

Las operaciones privilegiadas requieren que la sesión verificada actual
tenga:

```text
aal2
```

Tener un factor TOTP registrado NO significa que la sesión actual sea AAL2.

La autorización debe verificar el estado actual del JWT/AAL server-side.

ADMIN y MODERATOR requieren MFA.

No crees bypasses de MFA.

MFA tampoco constituye prueba de identidad real de una persona.

# Service Role

`SUPABASE_SERVICE_ROLE_KEY` es infraestructura privilegiada exclusivamente
server-side/operator-side.

NUNCA debe:

* llegar al navegador;
* exponerse mediante `VITE_*`;
* imprimirse;
* registrarse en logs;
* guardarse en Git;
* devolverse mediante una API;
* utilizarse como prueba de identidad de un usuario.

`service_role` puede utilizarse únicamente en código confiable
server-side/operator-side cuando sea necesario para operaciones
privilegiadas de base de datos.

Cuando una operación privilegiada se realiza en nombre de un usuario,
verifica primero su identidad de forma independiente.

# Secretos

Nunca expongas, imprimas, copies en respuestas, guardes en Git ni inspecciones
intencionalmente:

* `.env`;
* `.env.local`;
* `.env.*.local`;
* access tokens;
* refresh tokens;
* OAuth client secrets;
* Supabase service role;
* private keys;
* secretos de invitaciones generadas.

`.env.example` puede inspeccionarse porque debe contener únicamente
placeholders.

Respeta las restricciones de `.claude/settings.json`.

Nunca pidas al usuario que pegue un secreto en el chat.

Cuando un error pueda explicarse sin mostrar payloads sensibles del proveedor
o de la base de datos, utiliza un error genérico seguro.

# Invariantes del bootstrap ADMIN

El primer ADMIN se establece mediante el sistema de invitación bootstrap.

Invariantes:

* el token tiene 256 bits de aleatoriedad criptográfica;
* solo su SHA-256 se almacena en Supabase;
* el token en texto plano nunca se almacena en la base de datos;
* la invitación bootstrap es de un solo uso;
* la invitación expira;
* bootstrap no debe crear una ruta pública permanente de auto-elevación;
* bootstrap NO es un mecanismo de recuperación de cuenta;
* bootstrap NO demuestra la identidad real de una persona;
* múltiples ADMIN deben seguir siendo posibles en el futuro.

NO introduzcas una restricción global que permita únicamente un ADMIN.

El generador bootstrap es operator-side y sensible.

Nunca ejecutes:

```bash
npm run admin:bootstrap-invitation
```

salvo que el usuario solicite explícitamente crear una invitación real.

Una invitación generada nunca debe aparecer en:

* salida del terminal;
* respuestas de Claude;
* logs;
* Git.

# OAuth social

Las credenciales de conexión de Instagram y TikTok son privilegiadas.

Las operaciones OAuth capaces de conectar o reemplazar la conexión social
activa del sitio deben terminar protegidas server-side para ADMIN y MFA.

Ocultar un botón o una ruta en React NO constituye autorización.

La autorización debe realizarse server-side.

Los callbacks OAuth deben conservar las garantías de seguridad del flujo
privilegiado que los inició y no convertirse en un bypass.

Nunca coloques access tokens de Supabase en:

* query params;
* OAuth state;
* URLs;
* logs.

# Protocolo de trabajo

Trabaja en bloques pequeños y aislados.

UN BLOQUE = UN OBJETIVO CONCRETO.

Para cada bloque:

1. Comprende exactamente el requisito.
2. Inspecciona únicamente los archivos relevantes.
3. Considera implicaciones de seguridad y rutas de error cuando corresponda.
4. Realiza el cambio coherente más pequeño posible.
5. Ejecuta tests específicos.
6. Ejecuta regresión más amplia cuando corresponda.
7. Inspecciona el diff resultante.
8. Reporta archivos modificados y validaciones realizadas.
9. Haz commit únicamente cuando el usuario lo solicite.
10. DETENTE.

NO continúes automáticamente con el siguiente bloque.

NO amplíes el alcance porque hayas encontrado otra mejora conveniente.

Si descubres un problema no relacionado, repórtalo en lugar de corregirlo
silenciosamente.

NO uses subagentes salvo petición explícita del usuario.

No envíes varios agentes/modelos a releer el repositorio.

Prefiere inspecciones específicas, Git diff, búsquedas concretas y tests
enfocados sobre lecturas completas innecesarias del repositorio.

# Fuente de verdad

El repositorio actual y el historial de Git son la fuente de verdad sobre
el estado de implementación.

No dependas exclusivamente de resúmenes de sesiones anteriores cuando el
código relevante pueda inspeccionarse.

Si un handoff o una conversación anterior contradice el repositorio actual:

1. DETENTE.
2. Inspecciona el código y Git relevantes.
3. Reporta la contradicción.
4. No elijas silenciosamente una versión.

Los bloques cerrados NO deben reabrirse salvo que:

* exista evidencia nueva de una regresión;
* un requisito actual necesite modificarlos;
* el usuario lo solicite explícitamente.

No infieras el estado remoto de Supabase o Vercel únicamente desde archivos
locales cuando sea necesaria una verificación remota.

# Protocolo de cambios

Antes de editar:

* identifica el requisito;
* inspecciona los archivos relevantes;
* comprende el comportamiento existente;
* declara supuestos únicamente si afectan materialmente la implementación;
* realiza el cambio coherente más pequeño posible.

Después de editar:

* ejecuta los tests relevantes más acotados;
* ejecuta typecheck/lint/build cuando corresponda;
* inspecciona el diff;
* considera rutas de fallo;
* reporta exactamente qué cambió;
* detente antes de trabajo no relacionado.

Que los tests pasen NO demuestra por sí solo que un diseño sensible de
seguridad sea correcto.

Revisa explícitamente invariantes y estados de fallo importantes.

# Seguridad Git

Nunca:

* hagas force-push;
* hagas resets destructivos;
* elimines branches;
* descartes cambios del usuario;
* reescribas código no relacionado;
* hagas commit de secretos;
* hagas commit de archivos `.env`;

salvo petición explícita y consciente del usuario cuando corresponda.

Mantén commits atómicos.

Antes de un commit solicitado:

1. inspecciona `git status`;
2. inspecciona el diff relevante;
3. stagea únicamente los archivos previstos;
4. verifica la lista de archivos staged;
5. ejecuta las validaciones requeridas;
6. crea el commit;
7. haz push únicamente cuando sea solicitado.

No mezcles trabajo no relacionado dentro del commit de un bloque.

# Seguridad de base de datos

Las migraciones aplicadas en producción son historial inmutable.

No:

* reescribas una migración ya aplicada;
* concedas acceso cliente a tablas privilegiadas como atajo;
* desactives RLS para arreglar comportamiento;
* insertes manualmente roles ADMIN/MODERATOR salvo una operación administrativa
  controlada solicitada explícitamente.

Los cambios de esquema posteriores requieren una nueva migración.

Para funciones sensibles de base de datos considera:

* límites transaccionales;
* concurrencia;
* replay;
* expiración;
* row locking;
* RLS/FORCE RLS;
* ownership de funciones;
* SECURITY DEFINER;
* EXECUTE grants;
* comportamiento de rollback.

# Manejo de errores

Considera tanto el camino exitoso como los estados de fallo.

En operaciones sensibles de varios pasos, analiza explícitamente los fallos
parciales entre pasos.

Ejemplos:

* base de datos funciona pero filesystem falla;
* filesystem funciona pero base de datos falla;
* OAuth state se crea pero el callback nunca llega;
* un token expira durante el flujo;
* dos requests compiten simultáneamente;
* el rollback también falla.

No expongas errores sensibles del proveedor o de la base de datos cuando un
mensaje genérico sea suficiente.

# Testing

Los tests deben verificar comportamiento e invariantes importantes, no
simplemente aumentar coverage.

Para código sensible incluye casos negativos y rutas de error relevantes.

Nunca uses credenciales reales ni secretos de invitaciones reales en tests.

Los valores sintéticos deben ser claramente sintéticos.

Tests, build y dev nunca deben ejecutar accidentalmente acciones
administrativas operator-side.

Las comprobaciones estáticas del código pueden servir para invariantes
estructurales, pero no sustituyen tests runtime/integración cuando es
necesario verificar comportamiento real.

# Performance

Conserva o mejora el rendimiento con cada feature cuando sea razonable.

Prefiere:

* lazy loading para UI no crítica;
* code splitting cuando sea útil;
* caché de requests;
* deduplicación;
* limpieza de recursos;
* evitar polling innecesario.

No sacrifiques diseño, animaciones, funcionalidad o UX por optimizaciones
insignificantes.

Móvil y PC tienen la misma importancia.

# UI

Conserva el design system existente salvo que el bloque actual requiera
modificarlo.

Usa HTML semántico y accesible.

No rediseñes secciones no relacionadas durante una feature específica.

La UI administrativa nunca debe depender de ocultar elementos como frontera
de seguridad.

# Definition of Done

Un bloque está listo para cerrarse cuando, según corresponda:

* el comportamiento solicitado está implementado;
* los tests específicos pasan;
* la regresión relevante pasa;
* typecheck pasa;
* lint pasa;
* formatting pasa;
* build pasa;
* se consideraron rutas de fallo importantes;
* se revisaron invariantes sensibles de seguridad;
* el diff no contiene cambios no relacionados;
* no se expusieron secretos;
* el estado remoto se verificó cuando el bloque realmente requería
  verificación remota.

Que build/tests estén verdes NO significa automáticamente que el bloque esté
terminado.

# Disciplina de alcance

No implementes elementos futuros del roadmap simplemente porque su diseño ya
sea conocido.

No generes una invitación bootstrap real hasta que el flujo de activación,
autenticación y MFA haya sido probado end-to-end con una cuenta de prueba
controlada.

No involucres al destinatario real del ADMIN durante el desarrollo y pruebas
de infraestructura.

Cuando el bloque actual termine:

DETENTE Y ESPERA LA SIGUIENTE INSTRUCCIÓN.