import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleProfile } from "../src/lib/profile-handlers.js";

// /api/profile — POST crea el perfil público inicial (Bloque 7C.1), PATCH edita
// display_name/bio (Bloque 7D.2); el router vive en profile-handlers. Entrypoint propio (10 → 11 funciones Serverless; el plan Hobby permite 12): no
// encaja en el dispatcher api/admin/[action].ts, que es exclusivo de operaciones
// administrativas. Toda la lógica vive en src/lib/profile-handlers.ts.
export default function handler(req: VercelRequest, res: VercelResponse) {
  return handleProfile(req, res);
}
