# Protección de identidad de Mina / Upmina / Upminaa Web (username y display_name)

**Estado:** implementado y probado EN LOCAL. La migración `20261101120000_username_impersonation_guard.sql` **no está
aplicada** en ningún entorno (ni DEV ni Production) y el backend con los cambios no está desplegado. No existe la cuenta
de Mina, ni permisos, ni insignias, ni excepciones públicas.

## Dónde vive cada capa

| Capa                       | Archivo                                                                            | Papel                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Autoridad (PostgreSQL)** | `supabase/migrations/20261101120000_…`                                             | funciones puras + trigger sobre `profiles` (INSERT y UPDATE OF `username`, `display_name`). Cubre API/REST, RPC, SQL directo, upsert y `service_role` |
| Servidor                   | `src/lib/username-impersonation.ts` → `profile-username.ts`, `profile-handlers.ts` | rechaza antes de la BD (`422`)                                                                                                                        |
| Red de seguridad HTTP      | `profile-handlers.ts`                                                              | SQLSTATE `UR001` (username) / `UR002` (display_name) del trigger → `422`, nunca `500` ni texto de la BD                                               |
| Frontend (UX)              | `ProfileSection.tsx` + `ReservedIdentityMessage.tsx`                               | aviso localizado **es/en/de** (`auth.reservedName`), botón deshabilitado                                                                              |

Los **mismos vectores** (`username-impersonation-vectors.ts`) se ejecutan en TypeScript y en PostgreSQL comparando el
_motivo_ (`username-impersonation.test.ts`, `username-impersonation-sql.test.ts`, más ~600 combinaciones de username y
combinaciones de display_name generadas). Cambiar una regla exige cambiar ambos lados y una **nueva** migración.

## Algoritmo (idéntico en TS y SQL)

1. **Normalizar:** quitar `™ ℠ ® ©`, NFKD, sin marcas diacríticas ni caracteres invisibles; letras sin descomposición
   (`ß ł ø đ ı ħ`), versalitas (`ᴍɪɴᴀᴜᴘ`) y homoglifos cirílicos/griegos habituales → latín; minúsculas. NFKD cubre también
   fullwidth, matemáticas (`𝐌𝐢𝐧𝐚`), círculos (`ⓜⓘⓝⓐ`) y superíndices.
2. **Dos esqueletos solo-letras:** **A** (leet `0→o 1→i 3→e 4→a 5→s 7→t @→a $→s !→i |→i l→i`) y **B** (dígitos descartados:
   `mina1 → mina`). Separadores, espacios, emojis y puntuación desaparecen.
3. **Bloquear** si algún esqueleto, con cada letra repetible (`m+i+n+a+`: `miina`, `minaa` ≡ `mina`):
   - `exact`: `[up]mina`
   - `affixed`: afijos + `[up]mina` + afijos. **Identidad/autoridad:** `real the official oficial original verified verificado
team staff admin mod moderator support soporte account cuenta acc true authentic legit its iam im`.
     **Aficionados/páginas:** `fan fans fanpage fanclub club page`. **Sitio:** `web website site`. **Declaración:** `soy ich bin`
   - `declared` (**solo display_name**): declaración de identidad/representación/oficialidad. Frase formada **solo** por
     vocabulario (afijos + conectores) alrededor de `[up]mina` (con `s` opcional: `Mina's Official Account`) y con **al menos
     una palabra de autoridad** a un lado. Autoridad (es/en/de): `official oficial offiziell(e/er/es) original verified
verificado verifiziert team equipo staff admin administracion administration administrador administrator mod moderator
moderador support soporte account cuenta konto chat community comunidad gemeinschaft`. Conectores: `de del la el of by
from von der die das y and und`. **`fan` no es autoridad**: `Fan de Mina` no se bloquea.
   - `embedded` (**solo username**): contiene `upmina` en cualquier posición (`xupminax`)
   - `near`: esqueleto (repeticiones colapsadas, 5–7 letras) a **una edición** de `upmina` (`upmine`, `upmna`, `upmian`)

Cota anti-backtracking: si el esqueleto supera 120 letras (display_name ≤ 40 caracteres, username ≤ 30) las reglas por
expresión regular no se evalúan (idéntico en TS y SQL; nunca puede ser «identidad + vocabulario»).

`mina` **dentro de otra palabra no se bloquea** (`carmina`, `amina`, `minato`, `terminal`).

## Política definitiva

### username

| Categoría                                        | Política                                                                | Ejemplos                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1 · Inequívocas**                              | siempre bloqueadas                                                      | `Mina`, `UPMINA`, `miina`, `minaa`, `upminaaa`, `mi_na`, `mi.na`, `up.mina`, `m1na`, `upm1na`, `realmina`, `themina`, `minaofficial`, `upminaoficial`, `upminaa_real`, `real_upm1naa`, `official.miina`, `the.real.mina`, **`minafan`, `minafans`, `mina_fan`, `mina_fanpage`, `minafanpage`, `upminafan`, `upminaa_fans`, `mina_support`, `mina_team`, `mina_admin`, `upmina_staff`**, `fanmina`, `mina_web`, `soymina` |
| **2 · Ambiguas** (conservadora: se **bloquean**) | `mina` + dígitos; `upmina` embebido; una edición de `upmina`            | `mina1`, `mina2026`, `1mina`, `xupminax`, `upmna`, `upmine`, `upmind`, `upminaj`                                                                                                                                                                                                                                                                                                                                         |
| **3 · Distintas** (se **permiten**)              | `mina` parte de otra palabra o junto a una palabra ajena a la identidad | `amina`, `emina`, `carmina`, `minato`, `minami`, `minaj`, `minamoto`, `mina_lopez`, `lopezmina`, `real_mina_lopez`, `terminal`, `criminal`, `edwin390`                                                                                                                                                                                                                                                                   |

### display_name (espacios, Unicode, emojis)

Mismo esqueleto, pero **sin** la regla `embedded`: se bloquea cuando el nombre **entero** es la identidad, la identidad más
afijos, o una errata de `upmina`. Una frase claramente personal que solo menciona a Mina se permite.

| Bloqueados                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Permitidos                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Mina`, `Upmina`, `Upminaa`, `Mina Oficial`, `Official Mina`, `Real Mina`, `Mina Admin`, `Mina Staff`, `Upminaa Official`, `Mina Fanpage`, `Team Upmina`, `M1na`, `Miina`, `Up_Mina`, `M i n a`, `ＭＩＮＡ`, `𝐌𝐢𝐧𝐚`, `ⓜⓘⓝⓐ`, `ᴍɪɴᴀ`, `Mina ✨`, `Mina 🌸 Official`, `Mina ✔️`, `Mina (oficial)`, `The Real Mina™`, `Mina Fan Club`, `Upminaa Web`, `Soy Mina`, `Ich bin Mina`, `I'm Mina`, `Mina 2`, **`Cuenta oficial de Mina`, `Cuenta oficial de Upminaa`, `Mina Official Account`, `Official Account of Mina`, `Offizieller Mina Account`, `Upmina Chat`, `Upminaa Support`, `Administración de Mina`, `Mina Community Official`, `Equipo de Upminaa`, `Mina's Official Account`, `Cu3nta 0ficial d3 M1na`** | `Mina Lopez`, `Mina García`, `Carmina`, `Amina`, `Minato Namikaze`, `Mina-chan`, `Fan de Mina desde 2020`, `Soy fan de Mina`, `I love Mina`, `Me encanta Upmina`, `Hola, soy Ana y me encanta Upmina`, `Mina's biggest fan`, `Fan de Upmina`, `Me encanta Upminaa`, `Official Account of Ana`, `Administración de Ana`, `Ana María`, `Team Rocket`, `Real Madrid` |

## Falsos positivos y límites conocidos

- Una persona llamada Mina no puede usar `Mina` a secas (ni `Mina 2`, ni `Mina ✨`): debe añadir apellido u otra palabra.
- `mina99`, `upmind`, `upminaj`, `mina_club` y, ahora, `minafan` / `fanmina` quedan bloqueados por la política conservadora.
- **Huecos conocidos (se permiten a propósito en display_name):** `Upmina de Ana`, `Chat con Mina`, `Mina and friends` y frases
  largas con identidad en medio o con palabras fuera del vocabulario. La regla `declared` exige que **todo** el nombre sea
  vocabulario + identidad; bloquear más rechazaría también frases personales. Conviene revisión de moderación; no es garantía total.
- Falsos positivos nuevos posibles: `Chat de Mina` (declaración de canal), `Mina Community`, `Equipo Mina`: se bloquean aunque
  alguien pudiera tener un uso legítimo; `Mina Lopez Official` se permite (apellido fuera del vocabulario).
- Solo cubre `username` y `display_name`; no la bio ni el texto de publicaciones.
- Para `mina` (4 letras) no hay similitud: `mine`, `mino`, `mia`, `mnia` se permiten. Alfabetos no latinos (`ミナ`, `미나`) no se evalúan.
- Homoglifos: NFKD + tabla corta; no es la tabla UTS #39 completa. `rn↔m`, `vv↔w` no se contemplan.
- El vocabulario de afijos es corto; palabras nuevas (`ceo`, `founder`, `bot`…) requieren una **nueva** migración + cambio en TS.
- La lista exacta previa (`admin`, `moderator`, `community`…) sigue **solo en TypeScript** (`RESERVED_USERNAMES`).
- Perfiles existentes: el trigger solo actúa en INSERT y en cambios reales de `username` / `display_name`; un perfil heredado con un
  nombre conflictivo puede seguir editando su bio, avatar, etc., y reenviar el mismo valor no se bloquea (el servidor lo trata como
  no-op). Cambiar a **otro** valor protegido sí se rechaza.
- Concurrencia: PGlite usa una sola conexión; la serialización real depende de Postgres (el guard no toma locks propios y el índice
  único parcial impide dos excepciones vigentes del mismo campo y valor). No se probó con dos conexiones reales.

## Excepción administrativa futura (no pública, auditable, sin efectos hoy)

Tablas `username_reservation_grants` y `username_reservation_audit` (RLS forzada, sin policies, sin acceso para ningún rol de API;
auditoría append-only: UPDATE/DELETE/TRUNCATE lanzan error) y dos funciones SECURITY DEFINER con `search_path` fijo, ejecutables
**solo por `service_role`**:

- `community_identity_reservation_grant(actor, usuario, campo, valor, motivo)`: el actor debe ser **ADMIN** en `admin_roles`; no
  puede concederse a sí mismo; motivo 10–500 caracteres; el valor debe estar realmente protegido; un único titular vigente por
  campo y valor. Vale **solo** para ese **usuario + campo + valor exacto** (el grant de `username=mina` no permite `display_name=Mina`
  ni variantes ni a otro usuario).
- `community_identity_reservation_revoke(actor, grant, motivo)`: ADMIN; no se revoca dos veces; no cambia perfiles existentes.
  No hay endpoint: la futura capa de API deberá verificar JWT + rol ADMIN + `aal2` antes de invocarlo. No crea cuentas, no otorga roles
  ni insignias (comprobado por test).

## Revisión de conflictos en DEV (SELECT, solo lectura, 2026-10-10)

8 perfiles evaluados con el algoritmo local: **0 conflictos** en `username` y `display_name`. No se modificó nada. Production no se consultó.

## Qué haría falta para activarla en DEV (requiere autorización explícita; nada de esto se ha hecho)

1. SELECT de verificación inmediatamente antes (los perfiles pueden haber cambiado desde la comprobación anterior).
2. `db push --linked --dry-run` desde un paquete aislado (debe listar solo `20261101120000`) y, con autorización, `db push`.
3. Desplegar el backend con el mapeo `UR001`/`UR002` y los formularios (Preview + alias solo con autorización; evitar la ventana de R7).
4. Verificar triggers, permisos (`anon`/`authenticated`/`service_role` sin acceso a funciones internas ni a las tablas de grants) y un
   intento de INSERT/UPDATE protegido contra un perfil de prueba en DEV, con autorización.
5. Rollback: `supabase/rollbacks/20261101120000_username_impersonation_guard.rollback.sql` (fuera de `supabase/migrations`, así
   `db push` no lo ve). Quita los 2 triggers de `profiles` y las 10 funciones del guard; conserva las tablas de auditoría
   (`username_reservation_*`) y su trigger append-only; no toca perfiles, usuarios, roles, R7, media ni cron; es idempotente.
   Probado en local (`username-impersonation-rollback.test.ts`: perfiles y usuarios idénticos, catálogo restaurado, nombres
   protegidos vuelven a aceptarse). Para usarlo en un entorno: copiarlo a una **migración nueva** con timestamp posterior y
   aplicarla con autorización expresa; la migración original no se edita.
