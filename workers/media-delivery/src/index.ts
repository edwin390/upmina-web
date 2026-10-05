import { handleMediaRequest, type MediaEnv } from "./handler";

export default {
  fetch(request: Request, env: MediaEnv): Promise<Response> {
    return handleMediaRequest(request, env);
  },
};
