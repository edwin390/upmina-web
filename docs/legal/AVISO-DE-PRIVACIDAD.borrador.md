# Aviso de Privacidad — BORRADOR v0.3 (no publicado · pendiente de revisión jurídica)

> **Estado:** borrador técnico redactado a partir de lo que UPMINA Web **hace hoy** según el código (verificado). No es asesoría legal ni garantiza cumplimiento de la LFPDPPP (México) ni del RGPD/GDPR (UE). Todo `[PENDIENTE]` lo decide o aporta el responsable; nada de eso se ha inventado. Las bases jurídicas y plazos propuestos son **propuestas** a validar por un profesional.
> Idiomas: ES (este), EN y DE en `docs/legal/en/` y `docs/legal/de/` (traducciones de trabajo, sujetas a revisión profesional).

## 1. Responsable del tratamiento
- Responsable: persona física establecida en México que opera UPMINA Web a título personal (no es una empresa). Identidad legal: `[PENDIENTE]`.
- Contacto oficial para privacidad, ejercicio de derechos y asuntos legales: **upminaaweb@gmail.com**.
- Domicilio o medio de notificaciones exigido: `[PENDIENTE: revisión jurídica; no se publica un domicilio particular sin verificar las obligaciones aplicables]`.
- Identificación y obligaciones internacionales: `[PENDIENTE: evaluar los requisitos de identificación y posibles obligaciones al ofrecer el servicio de forma internacional (p. ej. representante en la UE o delegado de protección de datos, RGPD arts. 3, 27 y 37); no se afirma ninguna]`.
- UPMINA Web es un proyecto **independiente creado por fans**; no está oficialmente afiliado, patrocinado ni respaldado por UPMINA ni por su equipo.

## 2. Datos que tratamos
| Contexto | Datos | Origen |
|---|---|---|
| Navegación (sin cuenta) | Datos técnicos de conexión (IP, navegador, páginas, hora) en la infraestructura de alojamiento | Automático |
| Cuenta | Correo electrónico (confirmado), contraseña (la custodia el proveedor de autenticación) | Tú |
| Perfil | Nombre de usuario (público), nombre para mostrar (público), biografía y avatar si los añades | Tú |
| Community | Textos, fotos y videos que publiques (públicos, con tu usuario y fecha); «me gusta» | Tú |
| Reportes | Reportes que envíes (motivo, explicación de hasta 1000 caracteres), vinculados a tu cuenta; no se muestran a otros usuarios | Tú |
| Moderación | Casos, decisiones, sanciones (strikes), avisos, registros de auditoría sobre contenido o cuentas | Equipo |
| Derechos de autor | Reclamantes: nombre, correo, organización y relación con la obra, descripciones, enlaces de prueba, declaración y firma. Autores afectados: avisos, apelaciones y su contacto de apelación | Reclamante / autor |
| Equipo (moderación/administración) | Factores de autenticación multifactor, roles y registros de acciones | Equipo |
| Eliminación de cuenta | Identificador interno, estados y fechas del proceso (sin correo ni token) | Sistema |

No tratamos de forma deliberada datos sensibles ni pedimos fecha de nacimiento ni documentos de identidad. Lo que escribas o subas voluntariamente es responsabilidad tuya. **Menores:** ver sección 9.

## 3. Finalidades y bases jurídicas (propuesta)
| Finalidad | Base (RGPD, propuesta) | Necesaria |
|---|---|---|
| Crear y autenticar tu cuenta; correos de verificación, recuperación y seguridad (incluida MFA) | Ejecución del servicio solicitado | Sí |
| Mostrar tu perfil y publicaciones; «me gusta» | Ejecución del servicio | Sí |
| Moderar contenido, aplicar normas y strikes; atender reportes | Interés legítimo en un espacio seguro | Sí |
| Tramitar reclamaciones de derechos de autor y apelaciones | Interés legítimo; obligación legal cuando proceda `[PENDIENTE]` | Sí |
| Seguridad, prevención de abuso y registros de auditoría | Interés legítimo | Sí |
| Atender tu solicitud de eliminación y conservar la evidencia mínima | Interés legítimo / obligación legal `[PENDIENTE]` | Sí |

Hoy **no existen finalidades opcionales** (mercadotecnia, perfiles, analítica, boletines, publicidad). Si se añadieran requerirán consentimiento separado y retirable. Para la LFPDPPP, `[PENDIENTE: confirmar si procede consentimiento expreso para algún tratamiento]`.
No tomamos decisiones automatizadas con efectos jurídicos: toda sanción la decide una persona.

## 4. Proveedores y transferencias internacionales
| Proveedor | Función | Datos | Ubicación |
|---|---|---|---|
| Vercel | Alojamiento y funciones | Datos técnicos de conexión | `[PENDIENTE: región]` |
| Supabase | Base de datos y autenticación | Cuenta, perfil, contenido, moderación | `[PENDIENTE: región del proyecto]` |
| Cloudflare (R2 y entrega) | Almacenar y entregar fotos/videos | Archivos de Community, datos de conexión | `[PENDIENTE]` |
| Resend | Correos transaccionales | Correo y contenido del mensaje | `[PENDIENTE]` |
| Google Fonts | Tipografías | Dirección IP del navegador | `[PENDIENTE]` |
| Twitch, YouTube, Instagram, TikTok | Contenido incrustado, miniaturas y datos públicos del canal | Datos técnicos que tu navegador envía al cargarlos | según proveedor |

El servicio es de alcance internacional y varios proveedores operan fuera de México y de la UE: hay transferencias internacionales. `[PENDIENTE: para cada proveedor, rol (encargado / responsable), mecanismo de transferencia (p. ej. cláusulas contractuales tipo, marco de privacidad de datos UE-EE. UU. si se acredita) y cláusulas aplicables.]` No vendemos datos personales.

## 5. Cookies y almacenamiento local
No establecemos cookies propias ni usamos analítica o publicidad. Usamos el almacenamiento local del navegador para tu idioma y, si inicias sesión, para mantener la sesión. Los contenidos incrustados de terceros pueden usar sus propias cookies (consulta sus avisos). `[PENDIENTE: confirmar tras revisión técnica de los embeds si se requiere banner de consentimiento en la UE]`.

## 6. Conservación y eliminación
### 6.1 Eliminación de cuenta (funcionamiento actual)
1. Solicitas la eliminación desde «Cuenta» con la sesión iniciada y confirmas con un enlace enviado a tu correo (válido 30 minutos, un solo uso).
2. Al confirmar, tu acceso se **revoca de inmediato y de forma irreversible**; las sesiones se cierran.
3. Se inicia la limpieza, que puede continuar de forma **asíncrona**: elimina tu perfil, publicaciones, «me gusta», archivos subidos y tus credenciales. **No afirmamos que todo desaparezca al instante.**
4. Si un paso falla, **la cuenta permanece bloqueada** y la limpieza queda pendiente; un error de limpieza nunca restaura el acceso.
5. Los fallos quedan registrados y generan alertas para el equipo técnico (rol Developer). Hoy la limpieza fallida **puede requerir un reintento manual** por parte de ese equipo. **No prometemos reintentos automáticos desatendidos.**
6. Tu nombre de usuario queda libre sin que otra persona herede nada de tu cuenta. Las cuentas con rol de equipo no se eliminan por autoservicio.

### 6.2 Qué se elimina y qué se conserva
- **Se eliminan** (en la limpieza anterior): perfil, publicaciones, «me gusta», archivos exclusivos de tus publicaciones y la identidad de acceso. Los archivos compartidos con otro recurso se conservan hasta liberarse.
- **Se conservan**, con acceso restringido, sin mostrarse públicamente y vinculados a un identificador interno: reportes, casos y decisiones de moderación, strikes (que mientras la cuenta existe se usan para aplicar el sistema de sanciones), auditoría de moderación, reclamaciones y apelaciones de derechos de autor (incluido el contacto de apelación, sin anonimizar) y el registro de la eliminación (sin correo ni token). **No hay hoy un plazo definido de conservación ni una purga automática de estos registros, y no prometemos plazos de eliminación.** `[PENDIENTE: revisión jurídica de si y por cuánto tiempo deben conservarse]`
- El token de eliminación (solo su huella) caduca a los 30 minutos.

### 6.3 Copias existentes
Pueden existir copias de seguridad y copias manuales de la base de datos, propias o de proveedores, que contengan datos de cuentas ya eliminadas. No se eliminan de forma inmediata ni automática, y no prometemos un calendario de rotación. `[PENDIENTE: verificar con los proveedores]`

### 6.4 Excepciones
Podemos conservar datos cuando sea necesario para cumplir una obligación legal, atender o defender una reclamación, investigar un incidente de seguridad o prevenir abuso, de forma justificada y limitada. `[PENDIENTE: revisión jurídica]`

### 6.5 Datos que gestiona UPMINA Web y datos que tratan terceros
Lo anterior describe los datos que UPMINA Web almacena directamente (base de datos, archivos). Los proveedores (alojamiento, base de datos, almacenamiento, correo y plataformas de contenido) conservan datos bajo sus propias políticas y plazos `[PENDIENTE: verificar]`.

## 7. Derechos
- **México (ARCO):** acceso, rectificación, cancelación y oposición; revocación del consentimiento.
- **UE (RGPD):** además, limitación, portabilidad, oposición a tratamientos por interés legítimo y reclamación ante la autoridad de control de tu país.

Ejercicio: escribe a **upminaaweb@gmail.com** indicando tu nombre de usuario, el correo de la cuenta y lo que solicitas (podemos pedir datos para acreditar tu identidad, los mínimos necesarios). Perfil y eliminación de cuenta pueden hacerse directamente en el sitio. Plazo de respuesta: `[PENDIENTE: plazos legales aplicables]`. Autoridad en México: `[PENDIENTE: confirmar la autoridad vigente]`.

## 8. Seguridad
Autenticación gestionada por un proveedor especializado, acceso restringido a datos de moderación, autenticación multifactor obligatoria para roles de equipo y registros de auditoría. Ningún sistema es infalible. `[PENDIENTE: procedimiento y plazo de notificación de incidentes]`.

## 9. Menores
- **Menores de 13 años:** no pueden crear una cuenta. Pueden consultar el contenido público del sitio, apto para todos los públicos.
- **De 13 a 17 años:** el registro depende de las obligaciones legales aplicables en su país, incluida la autorización de madre, padre o tutor cuando corresponda. **Tener 13 años no basta, por sí solo, para registrarse legalmente en todos los países.**
- **Estado actual:** el registro **no verifica la edad ni las autorizaciones parentales**; esas medidas están pendientes de implementación y no se afirma que existan. No pedimos fechas completas de nacimiento ni documentos de identidad.
- **Perfiles y publicaciones públicos:** tu perfil (usuario, nombre, biografía y avatar si los añades) y tus publicaciones son **públicos**; no existen perfiles privados ni etiquetas de edad, y no identificamos públicamente a nadie como menor. Te recomendamos no incluir datos personales en tu perfil ni en tus publicaciones, especialmente si eres menor.
- Si detectamos una cuenta de una persona menor de 13 años, la cerraremos y eliminaremos sus datos.
- No usamos publicidad, seguimiento ni perfilado, de menores ni de nadie.
- Principios: minimización de datos y privacidad. Las medidas adicionales para menores **no están implementadas**.

## 10. Cambios
Publicaremos cualquier cambio con fecha y versión, y avisaremos de los sustanciales. Versión v0.3 · Fecha `[PENDIENTE al publicar]`.
