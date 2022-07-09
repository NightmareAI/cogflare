import Replicate from "./replicate";
const POLLING_INTERVAL = 5000

export class Prediction {
  state: DurableObjectState
  storage: DurableObjectStorage
  kv: KVNamespace
  result?: PredictionResult
  replicateToken: string
  baseUrl: string
  model?: any
  outputBucket: R2Bucket
  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.storage = state.storage
    this.kv = env.PREDICTIONS_KV
    this.baseUrl = env.COGFLARE_URL
    this.replicateToken = env.REPLICATE_API_TOKEN
    this.outputBucket = env.COG_OUTPUTS
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

  async rehost(imageUrl: string, keyPrefix: string): Promise<string> {
    let url = new URL(imageUrl);
    if (!url)
      return imageUrl;
    let headers = {};
    let path = url.pathname.slice(1).split('/');
    let key = 'models/' + keyPrefix + '/' + path.slice(-1);
    if (url.host.includes("replicate.com"))
      headers = { 'Authorization': `Token ${this.replicateToken}` };
    let imageResult = await fetch(imageUrl, { headers: headers });
    if (imageResult.status != 200) {
      console.log(`failed to get ${url}: ${imageResult.status} ${imageResult.statusText}`);
      return imageUrl;
    }
    await this.outputBucket.put(key, imageResult.body);
    const newUrl = this.baseUrl + "/" + key;
    console.log(`{imageUrl} -> {newUrl}`);
    return newUrl;
  }

  async alarm() {
    this.result = JSON.parse(await this.storage.get("result") as string);
    const callbackUrl = await this.storage.get("callbackUrl") as string;
    if (!this.result) {
      console.log("alarm fired with no data for prediction " + this.state.id);
      return;
    }
    let replicate = new Replicate({ token: this.replicateToken });
    if (!this.model)
      this.model = await replicate.getModel(this.result.model, this.result.version);

    if (!this.result.replicateId) {
      console.log("Starting prediction " + this.state.id);
      var startResult = await this.model.startPrediction(this.result.input);
      this.result.replicateId = startResult.id;
      this.result.status = startResult.status;
      await this.storage.put("result", JSON.stringify(this.result));
      this.storage.setAlarm(Date.now() + POLLING_INTERVAL);
      return;
    }

    let result = await this.model.getPrediction(this.result.replicateId);
    console.log(result.status);
    //console.log(JSON.stringify(result.output));
    let updated = false;
    try {
      if (this.result.output == null && result.output != null) {
        updated = true;
        if (typeof result.output == 'object') {
          this.result.output = {};
          for (const prop in result.output) {
            let newUrl = await this.rehost(`${result.output[prop]}`, this.result.model + "/" + this.result.replicateId);
            this.result.output[prop] = newUrl;
          }
        } else if (typeof result.output == 'string') {
          this.result.output = await this.rehost(result.output, this.result.model + "/" + this.result.replicateId);
        }
      } else if (typeof this.result.output == 'object') {
        for (const prop in result.output) {
          if (!this.result.output[prop]) {
            updated = true;
            this.result.output[prop] = await this.rehost(result.output[prop], this.result.model + "/" + this.result.replicateId)
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
            console.log("callback: " + callbackUrl);
            let callbackResult = await fetch(callbackUrl, { method: "POST", body: JSON.stringify(this.result), headers: { "content-type": "application/json" } });
            if (callbackResult.status != 200)
              console.log(`callback invoke failed with ${callbackResult.status} ${callbackResult.statusText}`);
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
      case "processing":
      case "starting":
        await this.storage.put("result", JSON.stringify(this.result));
        this.storage.setAlarm(Date.now() + POLLING_INTERVAL);
        break;
      default:
        console.log("unknown status: " + this.result.status)
    }
  }
}

interface PredictionResult {
  id: string;
  replicateId?: string;
  version?: string;
  model?: string;
  urls: {
    get: string;
    cancel: string;
  },
  created_at: Date,
  completed_at?: Date,
  source: string,
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