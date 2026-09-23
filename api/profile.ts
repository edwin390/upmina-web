import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleProfileCreate } from "../src/lib/profile-handlers.js";

// POST /api/profile — crea el perfil público inicial del usuario autenticado (Bloque
// 7C.1). Entrypoint propio (10 → 11 funciones Serverless; el plan Hobby permite 12): no
// encaja en el dispatcher api/admin/[action].ts, que es exclusivo de operaciones
// administrativas. Toda la lógica vive en src/lib/profile-handlers.ts.
export default function handler(req: VercelRequest, res: VercelResponse) {
  return handleProfileCreate(req, res);
}
