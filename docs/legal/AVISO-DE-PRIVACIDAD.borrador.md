# Aviso de Privacidad — BORRADOR v0.2 (no publicado · pendiente de revisión jurídica)

> **Estado:** borrador técnico redactado a partir de lo que UPMINA Web **hace hoy** según el código (verificado). No es asesoría legal ni garantiza cumplimiento de la LFPDPPP (México) ni del RGPD/GDPR (UE). Todo `[PENDIENTE]` lo decide o aporta el responsable; nada de eso se ha inventado. Las bases jurídicas y plazos propuestos son **propuestas** a validar por un profesional.
> Idiomas: ES (este), EN y DE en `docs/legal/en/` y `docs/legal/de/` (traducciones de trabajo, sujetas a revisión profesional).

## 1. Responsable del tratamiento
- Responsable: persona física `[PENDIENTE: nombre completo]`, residente en México, que mantiene UPMINA Web a título personal (no es una empresa).
- Domicilio / contacto postal exigible: `[PENDIENTE: decidir qué dato de contacto es legalmente necesario y publicable]`.
- Contacto para privacidad y ejercicio de derechos: `[PENDIENTE: correo dedicado]`.
- UPMINA Web es un proyecto **independiente creado por fans**; no está oficialmente afiliado, patrocinado ni respaldado por UPMINA ni por su equipo.
- Representante en la UE / delegado de protección de datos: `[PENDIENTE: determinar si resulta exigible (RGPD arts. 3, 27 y 37); no se afirma ninguna obligación]`.

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
- Puedes solicitar la eliminación permanente de tu cuenta desde «Cuenta»: enlace por correo (válido 30 minutos, un solo uso), inicio de sesión y confirmación. Es **irreversible**: el acceso se bloquea al confirmar y un proceso en segundo plano elimina tu perfil, publicaciones, «me gusta», archivos y credenciales. Tu nombre de usuario queda disponible sin que otra persona herede nada.
- **Se conservan**, con acceso restringido, sin mostrarse públicamente y vinculados a un identificador interno: reportes, casos y decisiones, strikes, reclamaciones y apelaciones de derechos de autor, auditoría y el registro de la eliminación. Finalidad: seguridad, defensa ante reclamaciones y trazabilidad.
- **Plazos:** `[PENDIENTE: el código NO define plazos; el responsable debe fijarlos y justificarlos por categoría]`.
- **Límites:** copias de seguridad de proveedores y URL firmadas ya emitidas pueden persistir hasta su caducidad; cachés pueden mostrar contenido antiguo unos minutos. Las cuentas con rol de equipo no se eliminan por autoservicio.
- Contacto de apelaciones de copyright: hoy se conserva; `[PENDIENTE: política de anonimización]`.

## 7. Derechos
- **México (ARCO):** acceso, rectificación, cancelación y oposición; revocación del consentimiento.
- **UE (RGPD):** además, limitación, portabilidad, oposición a tratamientos por interés legítimo y reclamación ante la autoridad de control de tu país.

Ejercicio: escribe a `[PENDIENTE: correo]` indicando tu nombre de usuario, el correo de la cuenta y lo que solicitas (podemos pedir datos para acreditar tu identidad, los mínimos necesarios). Perfil y eliminación de cuenta pueden hacerse directamente en el sitio. Plazo de respuesta: `[PENDIENTE: plazos legales aplicables]`. Autoridad en México: `[PENDIENTE: confirmar la autoridad vigente]`.

## 8. Seguridad
Autenticación gestionada por un proveedor especializado, acceso restringido a datos de moderación, autenticación multifactor obligatoria para roles de equipo y registros de auditoría. Ningún sistema es infalible. `[PENDIENTE: procedimiento y plazo de notificación de incidentes]`.

## 9. Menores
- **Menores de 13 años:** no pueden crear cuenta. Pueden consultar el contenido público del sitio. Si detectamos una cuenta de una persona menor de 13 años, la cerraremos y eliminaremos sus datos.
- **De 13 a 17 años:** pueden registrarse sujeto a las condiciones legales de su país, incluida la autorización de madre, padre o tutor cuando la ley lo exija. **Tener 13 años no basta, por sí solo, para registrarse legalmente en cualquier país.**
- Hoy el registro **no** pregunta ni verifica la edad; las medidas (declaración de edad, consentimiento parental, privacidad por defecto) están **propuestas, no implementadas** (ver `MENORES-EVALUACION.md`).
- No usamos publicidad, seguimiento ni perfilado, de menores ni de nadie.

## 10. Cambios
Publicaremos cualquier cambio con fecha y versión, y avisaremos de los sustanciales. Versión v0.2 · Fecha `[PENDIENTE al publicar]`.
