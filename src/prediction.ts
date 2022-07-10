import Replicate from "./replicate";
import { Queue } from "./queue";
import { v4 as uuidv4 } from 'uuid';
const POLLING_INTERVAL = 5000;

// Represents a single prediction
export class Prediction {
  state: DurableObjectState
  storage: DurableObjectStorage
  kv: KVNamespace
  result?: PredictionResult
  replicateToken: string
  baseUrl: string
  model?: any
  outputBucket: R2Bucket
  queueNamespace: DurableObjectNamespace
  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.storage = state.storage
    this.kv = env.PREDICTIONS_KV
    this.baseUrl = env.COGFLARE_URL
    this.replicateToken = env.REPLICATE_API_TOKEN
    this.outputBucket = env.COG_OUTPUTS
    this.queueNamespace = env.QUEUE
  }

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let url = new URL(request.url);
    let path = url.pathname.slice(1).split('/');
    let replicate = new Replicate({ token: this.replicateToken });
    switch (request.method) {
      case 'GET': {
        if (path[0] && path[0] == this.state.id.toString() && this.result)
          return new Response(JSON.stringify(this.result));
        return new Response("Not found", { status: 404 });
      }
      case 'POST': {
        if (!path[0]) {
          let req = await request.json<any>();
          let modelName = req.model;
          let version = req.version;
          let model = null;
          if (!req)
            return new Response("Request body missing or invalid", { status: 400 });
          if (!req["version"] && !req["model"])
            return new Response("Model and/or version must be specified", { status: 400 });
          if (!version) {
            model = await replicate.models.get(modelName);
            await model.getModelDetails();
            version = model.modelDetails.id;
          } else {
            if (!modelName) {
              // TODO: Cache versions? Pull them all from the site somehow?
              return new Response("Version requests not implemented, please supply model name", { status: 400 });
            }
            model = await replicate.models.get(modelName, version);
            await model.getModelDetails();
          }

          if (!model)
            return new Response("Not found", { status: 404 });

          const id = this.state.id.toString();

          if (req["callbackUrl"])
            await this.storage.put("callbackUrl", req["callbackUrl"] as string)

          this.result = {
            id: id,
            urls: {
              get: this.baseUrl + "/predictions/" + id,
              cancel: this.baseUrl + "/predictions/" + id + "/cancel"
            },
            source: "cogflare",
            created_at: new Date()
          }

          this.model = model;
          this.result.version = version;
          this.result.model = modelName;
          this.result.status = "creating";
          this.result.input = req.input;

          await this.storage.put("result", JSON.stringify(this.result));
          this.storage.setAlarm(Date.now() + 100);
          return new Response(JSON.stringify(this.result));
        }
      }
    }

    return new Response("Not found", { status: 404 });
  }

  async rehost(imageUrl: string, model: string): Promise<string> {
    let url = new URL(imageUrl);
    if (!url)
      return imageUrl;
    if (url.host == new URL(this.baseUrl).host)
      return imageUrl;
    let headers = {};
    let path = url.pathname.slice(1).split('/');
    let id = uuidv4();
    let key = `models/${model}/files/${id}/${path.slice(-1)}`;
    if (url.host.includes("replicate.com"))
      headers = { 'Authorization': `Token ${this.replicateToken}` };
    let imageResult = await fetch(imageUrl, { headers: headers });
    if (imageResult.status != 200) {
      console.log(`failed to get ${url}: ${imageResult.status} ${imageResult.statusText}`);
      return imageUrl;
    }
    await this.outputBucket.put(key, imageResult.body);
    const newUrl = this.baseUrl + "/" + key;
    console.log(`${imageUrl} -> ${newUrl}`);
    return newUrl;
  }

  async alarm() {
    this.result = JSON.parse(await this.storage.get("result") as string);
    const callbackUrl = await this.storage.get("callbackUrl") as string;
    if (!this.result || !this.result.model || !this.result.version || !this.result.input) {
      console.log("alarm fired with no data for prediction " + this.state.id);
      return;
    }

    let replicate = new Replicate({ token: this.replicateToken });
    if (!this.model)
      this.model = await replicate.getModel(this.result.model, this.result.version);

    if (!this.result.replicateId && !this.result.cogflare) {
      console.log("Starting prediction " + this.state.id);
      let queueId = this.queueNamespace.idFromName(this.result.model);
      let queueStub = this.queueNamespace.get(queueId);
      let status = await (await queueStub.fetch(`${this.baseUrl}/status`, {})).json<any>();
      console.log(status);
      let startResult;
      if (status.available > 0) {
        this.result.cogflare = true;
        this.result.runner = "runpod";
        const startResponse = await queueStub.fetch(`${this.baseUrl}/predictions`, { body: JSON.stringify(this.result), method: "POST", headers: { "content-type": "application/json" } });
        try {
          startResult = startResponse.json<any>();
        } catch (ex) {
          console.log("Exception parsing start response: " + ex);
          return;
        }
      }
      else {
        this.result.runner = "replicate";
        startResult = await this.model.startPrediction(this.result.input);
        this.result.replicateId = startResult.id;
      }
      this.result.status = startResult.status;
      await this.storage.put("result", JSON.stringify(this.result));
      this.storage.setAlarm(Date.now() + POLLING_INTERVAL);
      return;
    }
    let result;
    if (this.result.replicateId) {
      result = await this.model.getPrediction(this.result.replicateId);
    } else {
      let queueId = this.queueNamespace.idFromName(this.result.model);
      let queueStub = this.queueNamespace.get(queueId);
      result = await (await queueStub.fetch(`${this.baseUrl}/predictions/${this.result.id}`)).json<any>();
    }
    console.log(result.status);
    let updated = false;
    try {
      if (this.result.output == null && result.output != null) {
        updated = true;
        if (typeof result.output == 'object') {
          this.result.output = {};
          for (const prop in result.output) {
            let newUrl = await this.rehost(`${result.output[prop]}`, this.result.model);
            this.result.output[prop] = newUrl;
          }
        } else if (typeof result.output == 'string') {
          this.result.output = await this.rehost(result.output, this.result.model);
        }
      } else if (typeof this.result.output == 'object') {
        for (const prop in result.output) {
          if (!this.result.output[prop]) {
            updated = true;
            this.result.output[prop] = await this.rehost(result.output[prop], this.result.model)
          }
        }
      }

      if (updated || this.result.logs != result.logs || this.result.error != result.error || this.result.status != result.status || this.result.metrics != result.metrics) {
        this.result.logs = result.logs;
        this.result.error = result.error;
        this.result.status = result.status;
        this.result.metrics = result.metrics;
        this.result.completed_at = result.completed_at;
        try {
          if (callbackUrl) {
            let callbackResult = await fetch(callbackUrl, { method: "POST", body: JSON.stringify(this.result), headers: { "content-type": "application/json" } });
            if (callbackResult.status != 200) {
              console.log(`callback invoke ${callbackUrl} failed with ${callbackResult.status} ${callbackResult.statusText}, data follows`);
              console.log(JSON.stringify(this.result));
            }
          }
        }
        catch (ex) {
          console.log("callback url error" + ex);
        }
      }
    } catch (ex) {
      console.log("error updating result" + ex);
    }


    switch (this.result.status) {
      case "succeeded":
      case "failed":
      case "cancelled":
        await this.kv.put(this.state.id.toString(), JSON.stringify(this.result));
        await this.storage.delete("result");
        if (callbackUrl)
          await this.storage.delete("callbackUrl");
        break;
      case "starting":
      case "processing":
        if (!this.result.created_at)
          this.result.created_at = new Date();
        console.log(`${new Date(this.result.created_at).valueOf() + (30 * 60000)} ${new Date().valueOf()}`)
        if ((new Date(this.result.created_at).valueOf() + (30 * 60000)) > new Date().valueOf()) {
          await this.storage.put("result", JSON.stringify(this.result));
          this.storage.setAlarm(Date.now() + POLLING_INTERVAL);
        } else {
          console.log(`prediction timed out: ${this.state.id}`);
          // TODO: Cancel
        }
        break;
      default:
        console.log("unknown status: " + this.result.status)
    }
  }
}

export interface PredictionResult {
  id: string;
  runner?: string;
  replicateId?: string;
  cogflare?: boolean;
  version?: string;
  model?: string;
  urls?: {
    get?: string;
    cancel?: string;
  },
  created_at?: Date,
  completed_at?: Date,
  source?: string,
  status?: string,
  input?: any,
  output?: any,
  error?: string,
  logs?: any,
  metrics?: any
}

interface Env {
  QUEUE: DurableObjectNamespace
  COG_OUTPUTS: R2Bucket
  COGFLARE_URL: string
  REPLICATE_API_TOKEN: string
  PREDICTIONS_KV: KVNamespace
}