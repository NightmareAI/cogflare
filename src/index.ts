import { v4 as uuidv4 } from 'uuid';

export { Queue } from './queue'
export { Prediction } from './prediction'
import auth, { User } from './util/auth';

export interface Env {
  QUEUE: DurableObjectNamespace
  PREDICTION: DurableObjectNamespace
  COGFLARE_URL: string
  COG_OUTPUTS: R2Bucket
  PREDICTIONS_KV: KVNamespace
  TOKENS_KV: KVNamespace
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let url = new URL(request.url);
    let path = url.pathname.slice(1).split('/');
    let authenticated = false;
    let user = await auth.auth(request, env.TOKENS_KV);
    authenticated = user?.allow ?? false;
    if (!path[0])
      return new Response();

    if (path[0] == "outputs") {
      const key = path.slice(1).join('/');
      const value = await env.COG_OUTPUTS.get(key);
      if (value === null) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(value.body);
    }

    if (path[0] != 'v1')
      return new Response("Not found", { status: 404 });

    switch (path[1]) {
      case 'models': {
        if (!path[2] || !path[3]) {
          // TODO: Get model list
          return new Response("Not found", { status: 404 });
        }

        const model = path[2] + "/" + path[3];
        if (path[4] == "websocket") {
          let id = env.QUEUE.idFromName(path[5] + "/" + model);
          let stub = env.QUEUE.get(id);
          let newUrl = new URL(request.url);
          newUrl.pathname = "/" + path.slice(4).join("/");
          return stub.fetch(newUrl.toString(), request);
        }
        switch (request.method) {
          case 'GET': {
            if (!path[4] || !path[5]) {
              return new Response("Not found", { status: 404 });
            }
            const key = path.slice(1).join('/');
            console.log(key);
            const value = await env.COG_OUTPUTS.get(key);
            if (value === null) {
              return new Response("Not found", { status: 404 });
            }
            return new Response(value.body);
          }
          case 'PUT':
          case 'POST':
            {
              // TODO: Authentication
              let id = uuidv4();
              const formData = await request.formData();
              const file = formData.get('file') as File;
              const key = `models/${model}/files/${id}/${file.name}`;
              await env.COG_OUTPUTS.put(key, file.stream());
              return new Response(JSON.stringify({ url: `${env.COGFLARE_URL}/${key}` }));
            }
        }
      }
      case 'predictions': {
        let id: DurableObjectId | null = null;
        switch (request.method) {
          case 'GET': {
            if (!path[2]) {
              // TODO - List predictions
              return new Response("Not implemented", { status: 400 });
            }
            // Check KV for completed job
            let value = await env.PREDICTIONS_KV.get(path[2])
            if (value)
              return new Response(value);

            id = env.PREDICTION.idFromString(path[2]);
            break;
          }
          case 'POST': {
            if (!authenticated)
              return new Response("Not authorized", { status: 401 });

            if (!path[2]) {
              id = env.PREDICTION.newUniqueId();
            } else {
              id = env.PREDICTION.idFromString(path[2]);
            }
            break;
          }
          default:
            return new Response("Method not supported", { status: 400 });
        }
        if (!id)
          return new Response("Not found", { status: 400 });
        let stub = env.PREDICTION.get(id);
        if (!stub)
          return new Response("Not found", { status: 400 });

        let newUrl = new URL(request.url);
        newUrl.pathname = "/" + path.slice(2).join("/");
        let response = await stub.fetch(newUrl.toString(), request);
        return response;
      }
      default:
        return new Response("Not found", { status: 404 });
    }
  }
}
