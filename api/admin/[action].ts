import {
  handleAccountDeletionAlerts,
  handleAccountDeletionConfirm,
  handleAccountDeletionPreview,
  handleAccountDeletionRequest,
  handleAccountDeletionRetry,
  handleAccountDeletionRun,
} from "../../src/lib/account-deletion-handlers.js";
import { handleModerationCaseDecision } from "../../src/lib/moderation-decision-handlers.js";
import {
  handleCopyrightClaim,
  handleCopyrightClaimCreate,
  handleCopyrightClaimReview,
  handleCopyrightClaims,
} from "../../src/lib/copyright-handlers.js";
import {
  handleCopyrightAppealContext,
  handleCopyrightAppealResolve,
  handleCopyrightAppealSubmit,
  handleCopyrightClaimNotice,
  handleCopyrightClaimPurge,
  handleCopyrightClaimRemove,
  handleCopyrightStrikeApply,
  handleCopyrightStrikeNotice,
  handleCopyrightStrikeState,
} from "../../src/lib/copyright-removal-handlers.js";
import {
  handleModerationStrikeApply,
  handleModerationStrikeRevoke,
} from "../../src/lib/moderation-strike-handlers.js";
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
import {
  handleAdminTeamDeveloperRemove,
  handleAdminTeamDeveloperRestore,
  handleAdminTeamDeveloperTransfer,
} from "../../src/lib/developer-transition-handlers.js";
import {
  handleDeveloperMfaCleanups,
  handleDeveloperMfaRecoveries,
} from "../../src/lib/developer-panel-handlers.js";
import { handleAdminSocialConnect } from "../../src/lib/social-connect-handlers.js";
import { handleAdminSocialDisconnect } from "../../src/lib/social-disconnect-handlers.js";
import { handleAdminSocialStatus } from "../../src/lib/social-status-handlers.js";
import {
  handleAdminTeamInvitationRevoke,
  handleAdminTeamInvitations,
} from "../../src/lib/admin-team-invitations.js";
import {
  handleAdminMfaRecovery,
  handleAdminMfaRecoveryAdmin,
  handleAdminMfaRecoveryCancel,
  handleAdminMfaRecoveryWebhook,
} from "../../src/lib/admin-mfa-recovery-handlers.js";
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
  handleCommunityAuthorRestriction,
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
// "copyright-claim-create" (COPY-1 fase 2A — reclamación de copyright de un titular, INCLUSO SIN CUENTA: PÚBLICA, sin sesión,
// con validación estricta, señuelo anti-bots y límites por IP/red/correo). "copyright-claims" (cola, GET), "copyright-claim"
// (detalle, GET ?id=) y "copyright-claim-review" (revisión, POST) SÍ son privilegiadas: capacidad `moderation` + MFA reciente.
// Solo cambian el estado de la RECLAMACIÓN: nunca retiran, restauran ni eliminan publicaciones (fase 2B). Lógica en
// src/lib/copyright-handlers.ts; este dispatcher sigue siendo la misma función serverless (12 de 12).
// COPY-1 fase 2B (src/lib/copyright-removal-handlers.ts, misma función serverless): "copyright-claim-remove" (retira = OCULTA y avisa
// al autor), "copyright-claim-notice" (reintento de aviso), "copyright-claim-appeal-resolve" y "copyright-claim-purge" (eliminación
// MANUAL) son privilegiadas (`moderation` + MFA reciente). "copyright-appeal-context" y "copyright-appeal-submit" las usa el AUTOR
// de la publicación con su sesión y el token de su enlace. Nada se elimina por vencimiento ni por proceso automático.
// Strikes manuales de Copyright (mismo archivo de handlers): "copyright-strike-state", "copyright-strike-apply" (solo con la reclamación en
// `purged`) y "copyright-strike-notice" (reintento del aviso): privilegiadas (`moderation` + MFA reciente).
// DEL-2 (src/lib/account-deletion-handlers.ts, misma función serverless): eliminación irreversible de la PROPIA cuenta.
// "account-deletion-request", "account-deletion-preview" y "account-deletion-confirm" las usa la persona usuaria con su sesión (NO
// privilegiadas; preview/confirm son las únicas que atienden a una cuenta ya bloqueada); "account-deletion-run" es interna y firmada
// (despertador de la BD); "account-deletion-alerts" y "account-deletion-retry" son del rol developer (developer_panel + MFA reciente).
// La lógica de cada una vive en src/lib/admin-handlers.ts, no aquí, siguiendo el mismo
// patrón que los otros dos dispatchers.
export default function handler(req: VercelRequest, res: VercelResponse) {
  switch (req.query.action) {
    case "account-deletion-request":
      return handleAccountDeletionRequest(req, res);
    case "account-deletion-preview":
      return handleAccountDeletionPreview(req, res);
    case "account-deletion-confirm":
      return handleAccountDeletionConfirm(req, res);
    case "account-deletion-run":
      return handleAccountDeletionRun(req, res);
    case "account-deletion-alerts":
      return handleAccountDeletionAlerts(req, res);
    case "account-deletion-retry":
      return handleAccountDeletionRetry(req, res);
    case "community-author-post":
      return handleCommunityAuthorPosts(req, res);
    case "community-author-notice-ack":
      return handleCommunityAuthorNoticeAck(req, res);
    case "moderation-case-decision":
      return handleModerationCaseDecision(req, res);
    // R5-D: acciones humanas SEPARADAS de Procede (apply: moderation+MFA; revoke: además developer/admin).
    case "moderation-strike-apply":
      return handleModerationStrikeApply(req, res);
    case "moderation-strike-revoke":
      return handleModerationStrikeRevoke(req, res);
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
    case "mfa-recovery":
      return handleAdminMfaRecovery(req, res);
    case "mfa-recovery-admin":
      return handleAdminMfaRecoveryAdmin(req, res);
    case "mfa-recovery-cancel":
      return handleAdminMfaRecoveryCancel(req, res);
    case "mfa-recovery-webhook":
      return handleAdminMfaRecoveryWebhook(req, res);
    case "team-developer-transfer":
      return handleAdminTeamDeveloperTransfer(req, res);
    case "team-developer-restore":
      return handleAdminTeamDeveloperRestore(req, res);
    case "team-developer-remove":
      return handleAdminTeamDeveloperRemove(req, res);
    case "developer-mfa-cleanups":
      return handleDeveloperMfaCleanups(req, res);
    case "developer-mfa-recoveries":
      return handleDeveloperMfaRecoveries(req, res);
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
    case "community-author-restriction":
      return handleCommunityAuthorRestriction(req, res);
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
    case "copyright-claim-create":
      return handleCopyrightClaimCreate(req, res);
    case "copyright-claims":
      return handleCopyrightClaims(req, res);
    case "copyright-claim":
      return handleCopyrightClaim(req, res);
    case "copyright-claim-review":
      return handleCopyrightClaimReview(req, res);
    case "copyright-claim-remove":
      return handleCopyrightClaimRemove(req, res);
    case "copyright-claim-notice":
      return handleCopyrightClaimNotice(req, res);
    case "copyright-claim-appeal-resolve":
      return handleCopyrightAppealResolve(req, res);
    case "copyright-claim-purge":
      return handleCopyrightClaimPurge(req, res);
    case "copyright-appeal-context":
      return handleCopyrightAppealContext(req, res);
    case "copyright-appeal-submit":
      return handleCopyrightAppealSubmit(req, res);
    case "copyright-strike-state":
      return handleCopyrightStrikeState(req, res);
    case "copyright-strike-apply":
      return handleCopyrightStrikeApply(req, res);
    case "copyright-strike-notice":
      return handleCopyrightStrikeNotice(req, res);
    default:
      return res.status(404).json({ error: "No encontrado" });
  }
}
