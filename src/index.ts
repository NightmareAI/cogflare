import { v4 as uuidv4 } from 'uuid';
export { Cogflare } from './cogflare'
export { Queue } from './queue'

export interface Env {
  // Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
  // MY_KV_NAMESPACE: KVNamespace;
  //
  // Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
  // MY_DURABLE_OBJECT: DurableObjectNamespace;
  //
  // Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
  // MY_BUCKET: R2Bucket;
  COGFLARE: DurableObjectNamespace
  QUEUE: DurableObjectNamespace
  REPLICATE_TOKEN: string
  COG_OUTPUTS: R2Bucket
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
      case 'predict': {
        let id = env.COGFLARE.newUniqueId();
        let stub = env.COGFLARE.get(id);
        let response = await stub.fetch(request);
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
