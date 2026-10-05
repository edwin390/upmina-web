import { handleModerationCaseDecision } from "../../src/lib/moderation-decision-handlers.js";
import {
  handleCommunityAuthorPosts,
  handleCommunityAuthorNoticeAck,
} from "../../src/lib/community-author-handlers.js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleModerationCases } from "../../src/lib/moderation-case-handlers.js";
import {
  handleAdminAccess,
  handleAdminActivate,
  handleAdminMe,
} from "../../src/lib/admin-handlers.js";
import { handleAdminSocialConnect } from "../../src/lib/social-connect-handlers.js";
import { handleAdminSocialDisconnect } from "../../src/lib/social-disconnect-handlers.js";
import { handleAdminSocialStatus } from "../../src/lib/social-status-handlers.js";
import {
  handleAdminTeamInvitationRevoke,
  handleAdminTeamInvitations,
} from "../../src/lib/admin-team-invitations.js";
import {
  handleAdminTeamMemberRemove,
  handleAdminTeamMemberRole,
  handleAdminTeamMembers,
} from "../../src/lib/admin-team-members.js";
import {
  handleCosplayMediaDetach,
  handleCosplayPostDelete,
  handleCosplayPostGetAdmin,
  handleCosplayPostListAdmin,
  handleCosplayPostReorder,
  handleCosplayPostSave,
} from "../../src/lib/cosplay-editor-handlers.js";
import {
  handleCommunityPostDelete,
  handleCommunityPostDetachMedia,
  handleCommunityPostListOwn,
  handleCommunityPostReorderMedia,
  handleCommunityPostSave,
} from "../../src/lib/community-post-handlers.js";
import {
  handleCommunityPostLikedByMe,
  handleCommunityPostSetLike,
} from "../../src/lib/community-like-handlers.js";
import {
  handleModerationReport,
  handleModerationReportCreate,
  handleModerationReports,
  handleModerationReportStatus,
} from "../../src/lib/moderation-handlers.js";

// Despachador de acciones admin server-side por segmento dinámico `action`. Mismo
// patrón que api/instagram/[resource].ts y api/tiktok/[resource].ts: un único
// entrypoint (9 → 10 funciones Serverless) que resuelve acciones futuras (p. ej.
// invitaciones standard, protección de OAuth social) sin sumar otro entrypoint por
// acción, respetando el límite de Serverless Functions del plan Hobby de Vercel.
//
// A diferencia de esos dos dispatchers (puramente de solo lectura), aquí `action`
// controla una operación sensible: solo se resuelven acciones EXPLÍCITAMENTE
// soportadas mediante un switch cerrado. Un `action` desconocido nunca se interpreta
// como una llamada dinámica a ningún handler; siempre 404.
//
// Acciones soportadas hasta ahora: "activate" (Bloque 2C — consumir una
// admin_invitations bootstrap y conceder el rol vía consume_admin_invitation) y "me"
// (Bloque 5A — primera comprobación server-side de la identidad administrativa actual).
// "social-connect" (Bloque 8C.2 — inicio protegido del OAuth de Instagram/TikTok, ADMIN+AAL2,
// lógica en src/lib/social-connect-handlers.ts).
// "social-status" (Bloque 8E — estado de las conexiones sociales para el panel /admin, ADMIN+AAL2,
// lógica en src/lib/social-status-handlers.ts).
// "social-disconnect" (Fase 9H-3 — desconexión explícita de Instagram/TikTok, ADMIN+social_admin+MFA
// reciente, lógica en src/lib/social-disconnect-handlers.ts).
// "team-invitations" (Bloque 9D — GET lista / POST crea invitaciones standard, team_admin+AAL2) y
// "team-invitations-revoke" (Bloque 9D — revoca una standard pendiente vía RPC), lógica en
// src/lib/admin-team-invitations.ts.
// "team-members", "team-members-role" y "team-members-remove" (Bloque 9F — listar miembros, cambiar rol
// y quitar acceso, team_admin+AAL2 vía RPC), lógica en src/lib/admin-team-members.ts.
// "access" (Fase 9G-1 — acceso actual para presentación: rol, capacidades y MFA reciente; exige
// autenticación pero NO MFA y NO autoriza nada), lógica en src/lib/admin-handlers.ts.
// "cosplay-post-save", "cosplay-post-delete", "cosplay-media-detach", "cosplay-post-reorder",
// "cosplay-post-list-admin" y "cosplay-post-get-admin" (Fase 9I-3, checkpoint 2 — editor ADMIN de
// Cosplay: crear/guardar/publicar, borrado duro, desadjuntar imagen, reordenar galería y lecturas
// ADMIN de borradores/publicadas; todas cosplay_admin + MFA reciente), lógica en
// src/lib/cosplay-editor-handlers.ts.
// "community-post-save", "community-post-reorder-media", "community-post-detach-media",
// "community-post-delete" y "community-post-list-own" (Fase 9J-1C — gestión desde /account del
// PROPIO contenido de Comunidad: crear/editar, reordenar media, desadjuntar, borrado duro y
// listar las publicaciones propias). A DIFERENCIA de todo lo demás en este archivo, estas 5
// acciones NO son privilegiadas: exigen solo requireAuthenticated + perfil de Comunidad existente
// (nunca admin_roles, nunca MFA) — viven en este dispatcher "admin" únicamente porque el plan
// Hobby de Vercel ya tiene sus 12 funciones Serverless agotadas (api/media/[resource].ts es la
// función 12/12) y este es el único dispatcher genérico de acciones ya existente cuyo switch no
// impone ninguna autorización compartida (cada acción autoriza la suya propia — ver el comentario
// de arriba sobre "access"). Lógica en src/lib/community-post-handlers.ts.
// "community-post-set-like" y "community-post-liked-by-me" (Fase 9J-2C — dar/quitar like y
// consultar el propio estado de like sobre una lista de publicaciones). Igual que las acciones de
// arriba, NO son privilegiadas: solo requireAuthenticated, sin perfil de Comunidad requerido (dar
// like no es "gestionar contenido propio"), sin MFA, sin rol — cualquier usuario autenticado,
// incluido el propio autor de la publicación. Lógica en src/lib/community-like-handlers.ts.
// "moderation-report-create" (Fase 9K-1 — cualquier usuario AUTENTICADO reporta una publicación de
// Community; NO privilegiada, igual criterio que community-post-set-like). "moderation-reports"
// (cola, GET), "moderation-report" (detalle de uno, GET ?id=) y "moderation-report-status" (cambia
// su estado, POST) SÍ son privilegiadas: capacidad `moderation` (moderator/developer/admin) + MFA
// reciente, vía requireCapability. Lógica en src/lib/moderation-handlers.ts.
// La lógica de cada una vive en src/lib/admin-handlers.ts, no aquí, siguiendo el mismo
// patrón que los otros dos dispatchers.
export default function handler(req: VercelRequest, res: VercelResponse) {
  switch (req.query.action) {
    case "community-author-post":
      return handleCommunityAuthorPosts(req, res);
    case "community-author-notice-ack":
      return handleCommunityAuthorNoticeAck(req, res);
    case "moderation-case-decision":
      return handleModerationCaseDecision(req, res);
    case "moderation-cases":
      return handleModerationCases(req, res);
    case "activate":
      return handleAdminActivate(req, res);
    case "me":
      return handleAdminMe(req, res);
    case "access":
      return handleAdminAccess(req, res);
    case "social-connect":
      return handleAdminSocialConnect(req, res);
    case "social-status":
      return handleAdminSocialStatus(req, res);
    case "social-disconnect":
      return handleAdminSocialDisconnect(req, res);
    case "team-invitations":
      return handleAdminTeamInvitations(req, res);
    case "team-invitations-revoke":
      return handleAdminTeamInvitationRevoke(req, res);
    case "team-members":
      return handleAdminTeamMembers(req, res);
    case "team-members-role":
      return handleAdminTeamMemberRole(req, res);
    case "team-members-remove":
      return handleAdminTeamMemberRemove(req, res);
    case "cosplay-post-save":
      return handleCosplayPostSave(req, res);
    case "cosplay-post-delete":
      return handleCosplayPostDelete(req, res);
    case "cosplay-media-detach":
      return handleCosplayMediaDetach(req, res);
    case "cosplay-post-reorder":
      return handleCosplayPostReorder(req, res);
    case "cosplay-post-list-admin":
      return handleCosplayPostListAdmin(req, res);
    case "cosplay-post-get-admin":
      return handleCosplayPostGetAdmin(req, res);
    case "community-post-save":
      return handleCommunityPostSave(req, res);
    case "community-post-reorder-media":
      return handleCommunityPostReorderMedia(req, res);
    case "community-post-detach-media":
      return handleCommunityPostDetachMedia(req, res);
    case "community-post-delete":
      return handleCommunityPostDelete(req, res);
    case "community-post-list-own":
      return handleCommunityPostListOwn(req, res);
    case "community-post-set-like":
      return handleCommunityPostSetLike(req, res);
    case "community-post-liked-by-me":
      return handleCommunityPostLikedByMe(req, res);
    case "moderation-report-create":
      return handleModerationReportCreate(req, res);
    case "moderation-reports":
      return handleModerationReports(req, res);
    case "moderation-report":
      return handleModerationReport(req, res);
    case "moderation-report-status":
      return handleModerationReportStatus(req, res);
    default:
      return res.status(404).json({ error: "No encontrado" });
  }
}
