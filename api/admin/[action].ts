import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  handleAdminAccess,
  handleAdminActivate,
  handleAdminMe,
} from "../../src/lib/admin-handlers.js";
import { handleAdminSocialConnect } from "../../src/lib/social-connect-handlers.js";
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
// "team-invitations" (Bloque 9D — GET lista / POST crea invitaciones standard, team_admin+AAL2) y
// "team-invitations-revoke" (Bloque 9D — revoca una standard pendiente vía RPC), lógica en
// src/lib/admin-team-invitations.ts.
// "team-members", "team-members-role" y "team-members-remove" (Bloque 9F — listar miembros, cambiar rol
// y quitar acceso, team_admin+AAL2 vía RPC), lógica en src/lib/admin-team-members.ts.
// "access" (Fase 9G-1 — acceso actual para presentación: rol, capacidades y MFA reciente; exige
// autenticación pero NO MFA y NO autoriza nada), lógica en src/lib/admin-handlers.ts.
// La lógica de cada una vive en src/lib/admin-handlers.ts, no aquí, siguiendo el mismo
// patrón que los otros dos dispatchers.
export default function handler(req: VercelRequest, res: VercelResponse) {
  switch (req.query.action) {
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
    default:
      return res.status(404).json({ error: "No encontrado" });
  }
}
