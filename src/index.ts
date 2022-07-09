import { v4 as uuidv4 } from 'uuid';

export { Queue } from './queue'
export { Prediction } from './prediction'

export interface Env {
  QUEUE: DurableObjectNamespace
  PREDICTION: DurableObjectNamespace
  REPLICATE_API_TOKEN: string
  COGFLARE_URL: string
  COG_OUTPUTS: R2Bucket
  PREDICTIONS_KV: KVNamespace
}


export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let url = new URL(request.url);
    let path = url.pathname.slice(1).split('/');
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
        const key = path.slice(1).join('/');
        console.log(key);
        const value = await env.COG_OUTPUTS.get(key);
        if (value === null) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(value.body);
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
      case 'queue': {
        if (!path[2])
          return new Response("Not found", { status: 404 });
        let queueName = path[2];
        let id = env.QUEUE.idFromName(queueName);
        let stub = env.QUEUE.get(id);
        let newUrl = new URL(request.url);
        newUrl.pathname = "/" + path.slice(3).join("/");
        return stub.fetch(newUrl.toString(), request);
      }
      case "upload": {
        let id = uuidv4();
        const formData = await request.formData();
        const file = formData.get('file') as File;
        const key = id + '/' + file.name
        await env.COG_OUTPUTS.put(key, file.stream());
        return new Response(JSON.stringify({ url: "https://cog.nmb.ai/outputs/" + key }));
      }
      default:
        return new Response("Not found", { status: 404 });
    }
  }
}
