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
  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.storage = state.storage
    this.kv = env.PREDICTIONS_KV
    this.baseUrl = env.COGFLARE_URL
    this.replicateToken = env.REPLICATE_API_TOKEN
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
          this.result.status = "CREATING";
          this.result.input = req.input;

          await this.storage.put("result", JSON.stringify(this.result));
          this.storage.setAlarm(Date.now() + 100);
          return new Response(JSON.stringify(this.result));
        }
      }
    }

    return new Response("Not found", { status: 404 });
  }


  async alarm() {
    // TODO: Resume if interrupted
    this.result = JSON.parse(await this.storage.get("result") as string);
    if (!this.result) {
      console.log("alarm fired with no data for prediction " + this.state.id);
      return;
    }
    let replicate = new Replicate({ token: this.replicateToken });
    if (!this.model)
      this.model = await replicate.getModel(this.result.model, this.result.version);

    if (this.result.status == "CREATING" || !this.result.replicateId) {
      console.log("Starting prediction " + this.state.id);
      var startResult = await this.model.startPrediction(this.result.input);
      this.result.replicateId = startResult.id;
      this.result.status = startResult.status;
      await this.storage.put("result", JSON.stringify(this.result));
      this.storage.setAlarm(Date.now() + POLLING_INTERVAL);
      return;
    }

    let result = await this.model.getPrediction(this.result.replicateId);
    this.result.output = result.output;
    this.result.logs = result.logs;
    this.result.error = result.error;
    this.result.status = result.status;
    this.result.metrics = result.metrics;
    this.result.completed_at = result.completed_at;

    if (this.result.status == "COMPLETED") {
      await this.kv.put(this.state.id.toString(), JSON.stringify(this.result));
      await this.storage.delete("result");
    } else {
      await this.storage.put("result", JSON.stringify(this.result));
      this.storage.setAlarm(Date.now() + POLLING_INTERVAL);
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
  COG_OUTPUT: R2Bucket
  COGFLARE_URL: string
  REPLICATE_API_TOKEN: string
  PREDICTIONS_KV: KVNamespace
}