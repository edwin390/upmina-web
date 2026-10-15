# Conservación de datos y copias — documento interno (estado real)

> Documento de trabajo. Describe **lo que el sistema hace hoy**; no adopta plazos ni compromisos futuros. Por decisión del propietario **no se van a implementar** reintentos automáticos de eliminación (`account-deletion-tick` sigue inactivo), sistemas o políticas de respaldos, purgas automáticas ni nuevas funcionalidades. Los textos públicos no deben prometerlos. Plazos de conservación: **no definidos** `[PENDIENTE: revisión jurídica]`.

## Retención técnica actual
| Categoría | Qué ocurre hoy |
|---|---|
| Perfil, publicaciones, «me gusta», archivos | Se eliminan en la limpieza asíncrona tras confirmar la eliminación; archivos compartidos se conservan hasta liberarse |
| Reportes y casos de moderación | Conservados con el UUID original; **sin plazo ni purga automática** |
| Strikes | Inmutables; los vencidos por tiempo siguen contando para la escalada mientras la cuenta existe; **sin plazo ni purga** |
| Reclamaciones de copyright (eventos, avisos, apelaciones) | Conservadas; contacto de apelación sin anonimizar; **sin plazo ni purga** |
| Auditoría de moderación | Solo añadir; **sin plazo ni purga** |
| Registro de eliminación | Conservado (UUID, estados; sin correo ni token); **sin plazo ni purga** |
| Token de eliminación | Solo su SHA-256; caduca a los 30 minutos |
| Límites anti-abuso (recuperación de contraseña) | Huellas hash con sal; purga >2 días en cada uso `[PENDIENTE: confirmar si la función está activa]` |
| Evidencia de aceptación legal | No activa (migración sin aplicar) |
| Logs de proveedores | Retención según cada proveedor `[PENDIENTE: verificar]` |

## Eliminación de cuentas
Al confirmar: acceso revocado de inmediato e irreversible; limpieza asíncrona; si falla, la cuenta permanece bloqueada; puede requerir **reintento manual** desde el panel Developer. Sin reintentos automáticos desatendidos y sin compromiso de activarlos.

## Copias existentes
Production no tiene backups ni PITR de Supabase (verificación del 14-oct). Existe al menos una copia manual del propietario fuera del repositorio y los proveedores pueden conservar copias propias. Estas copias pueden contener datos de cuentas eliminadas; no se anuncia rotación ni cifrado como compromiso. La gestión de esas copias es una decisión operativa del propietario, fuera de los documentos públicos.

## Excepciones
Obligación legal, reclamaciones, incidentes de seguridad y prevención de abuso, de forma justificada y limitada. `[PENDIENTE: revisión jurídica]`
