import { handle } from "../../src/worker/index";

export const onRequest: PagesFunction<Cloudflare.Env> = (context) =>
  handle(context.request, context.env, context);
