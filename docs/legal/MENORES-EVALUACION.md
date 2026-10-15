# Evaluación de requisitos para usuarios menores — propuesta (no implementada)

> Evaluación de requisitos y propuesta proporcional. **No es asesoría legal.** No se habilita ni modifica nada: hoy el registro no pregunta ni verifica la edad y las reglas de registro no cambian en esta fase.

## 1. Alcance real de UPMINA Web (hechos del código)
- Registro con correo y contraseña; perfil con usuario, nombre, biografía y avatar **públicos**; publicaciones con foto/video **públicas**; «me gusta»; reportes.
- **No hay** mensajería privada, comentarios, publicidad, analítica, seguimiento ni perfilado; no se recopila fecha de nacimiento ni documentos.
- Contenido de UPMINA (creadora) con audiencia previsiblemente joven. Exposición principal de un menor: **perfil y publicaciones públicas** + contenido generado por otros usuarios.

## 2. Marco por jurisdicción (resumen a validar por un profesional)
| Jurisdicción | Idea general (no exhaustiva) | Efecto en el proyecto |
|---|---|---|
| UE (RGPD art. 8) | Edad de consentimiento digital **13–16 años según el Estado miembro**. Solo aplica si el tratamiento se basa en **consentimiento**; si la base es la ejecución del servicio, se aplican las reglas nacionales de capacidad contractual. | Por eso «13 años» no basta en todos los países. Hay que decidir la base (el borrador propone ejecución del servicio) y considerar los umbrales nacionales. |
| México | La LFPDPPP exige consentimiento de madre/padre/tutor para datos de menores en ciertos supuestos y refuerza la protección del interés superior del menor. | Previsión de autorización parental para menores. |
| EE. UU. (COPPA) | Obliga con **menores de 13** y servicios dirigidos a ellos o con conocimiento real. | La edad mínima de 13 evita recopilar datos de menores de 13; mantener y hacer cumplir la restricción. Si el sitio se considerara «dirigido a niños», aplicaría más. |
| Reino Unido (Age-Appropriate Design Code) y otros | Diseño adecuado a la edad, privacidad por defecto. | Inspiración para privacidad por defecto. |
Otros países: `[PENDIENTE: lista de jurisdicciones objetivo y requisitos adicionales]`. **No se puede asumir un único sistema para todos.**

## 3. Opciones de verificación y su proporcionalidad
| Opción | Datos que exige | Riesgo | Valoración |
|---|---|---|---|
| A. Declaración de edad (casilla «Tengo 13 años o más») | Ninguno guardado además de la declaración | Es fácilmente falseable; no es verificación | **Recomendada como mínimo** |
| B. Fecha de nacimiento | Dato personal adicional | Minimización: se puede **no guardar** la fecha, solo el resultado (≥13) | Opcional; no guardarla |
| C. Autorización parental por correo (enlace de confirmación al tutor) para 13–17 donde aplique | Correo del tutor | Recoge datos de un tercero; hay que borrarlos tras la confirmación | **Proporcional si se exige por jurisdicción** |
| D. Documento de identidad / verificación facial | Datos muy sensibles | Desproporcionado para este sitio; riesgo de custodia | **No recomendada** |

## 4. Propuesta concreta y proporcional
1. **Declaración de edad ≥ 13** en el registro (A), con texto claro de que, entre 13 y 17, se requiere cumplir la ley local y, cuando exista, la autorización de madre/padre/tutor. Sin recopilar fecha de nacimiento.
2. **Aviso y cierre** de cuentas de menores de 13 detectadas, con eliminación de datos (ya existe el flujo de eliminación).
3. **Privacidad por defecto para menores de 18** `[PENDIENTE: decidir]`: p. ej. no mostrar biografía ni avatar públicamente, o recomendar no usar nombre real; requeriría cambios de producto (no implementados).
4. **Autorización parental (C)** solo si la revisión jurídica lo exige para jurisdicciones concretas; implementarla de forma opt-in por país o con un texto de responsabilidad, borrando el correo del tutor tras confirmar.
5. **Moderación de contenido de menores**: ya existen reportes y strikes; añadir en las Normas la prohibición de publicar datos o imágenes de menores sin autorización (hecho en el borrador v0.2).
6. **Sin publicidad, seguimiento ni perfilado** (ya es así; mantenerlo y declararlo).
7. **Registro de aceptación** (migración `20261118120000`): guarda versión y fecha; **no** guarda edad. Una declaración de edad podría añadirse como documento/versión sin guardar la fecha de nacimiento.

## 5. Riesgos de la propuesta
- La declaración de edad no impide el falseamiento; se compensa con reporte/cierre y minimización de exposición.
- Exigir verificación fuerte aumentaría la recolección de datos y el riesgo; no se justifica con el alcance actual.
- Un umbral de 13 puede ser **insuficiente** en países de la UE con umbral de 14–16 **si** la base fuera el consentimiento; hay que decidir la base y, si hace falta, bloquear o requerir autorización parental en esos países.

## 6. Decisiones pendientes
1. ¿Base jurídica principal: ejecución del servicio o consentimiento? (impacta el umbral por país).
2. ¿Lista de países con requisitos adicionales o autorización parental?
3. ¿Privacidad por defecto para menores (qué datos ocultar)?
4. ¿Texto exacto de la declaración de edad y del aviso a menores?
5. ¿Cómo tratar cuentas existentes de edad desconocida (no bloquear; solicitar declaración en el próximo inicio de sesión sin impedir ejercer derechos)?

## 7. Implementación futura (no realizada)
Añadir la declaración de edad al registro y al contrato de `legal_acceptances` (sin fecha de nacimiento); texto ES/EN/DE; privacidad por defecto si se decide; flujo de autorización parental si se exige; pruebas.

## Actualización Fase 2B — decisiones del propietario
Contenido apto para todos los públicos; publicaciones y perfiles **públicos**, sin perfiles privados ni etiquetas de edad, y sin identificar públicamente a menores. Edad mínima 13; entre 13 y 17 según la jurisdicción y con autorización parental cuando corresponda. **No se afirma** que la plataforma verifique edades o autorizaciones (no implementado). No se recopilan fechas completas de nacimiento ni documentos. La implementación de requisitos de registro para menores queda **pendiente y fuera de esta fase**. La «privacidad más restrictiva por defecto para menores» es una intención no implementada: al ser perfiles públicos, los documentos solo **advierten** claramente de la visibilidad pública y recomiendan no incluir datos personales.
