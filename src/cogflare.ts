import Replicate from "./replicate"

export class Cogflare {
  token: string
  output: any[]
  constructor(state: DurableObjectState, env: Env) {
    this.token = env.REPLICATE_TOKEN;
    this.output = []
  }

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let req = await request.json<any>();
    var model = req.model;
    var input = req.input;
    return new Response(JSON.stringify(await this.predict(model, input)));
  }

  async predict(modelName: any, input: any) {
    // TODO: Use self-hosted workers or API    
    let replicate = new Replicate({ token: this.token })
    let model = await replicate.models.get(modelName);
    console.log(JSON.stringify(input));
    let predictor = model.predictor(input);
    for await (let prediction of predictor) {
      if (prediction != null)
        this.output.push(prediction);
    }
    return this.output;
  }

}

interface Prediction {
  id: string;
  version: string;
  urls: {
    get: string;
    cancel: string;
  },
  created_at: Date,
  completed_at: Date,
  source: string,
  status: string,
  input: any,
  output: any,
  error: string,
  logs: any,
  metrics: any
}

interface Env {
  REPLICATE_TOKEN: string
}