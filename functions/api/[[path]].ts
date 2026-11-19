import { handle } from "../../src/worker/index";
import { d1Store } from "../../src/worker/store-d1";

export const onRequest: PagesFunction<Cloudflare.Env> = (context) =>
  handle(context.request, d1Store(context.env.DB), context);
