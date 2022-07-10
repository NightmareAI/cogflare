import { PredictionResult } from "./prediction"

type Session = {
  webSocket: WebSocket,
  connected: Date,
  quit?: boolean,
  request?: PredictionResult
}

export class Queue {
  state: DurableObjectState
  storage: DurableObjectStorage
  items: any
  sessions: any[]
  baseUrl: string
  predictions: KVNamespace
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.storage = state.storage;
    this.sessions = [];
    this.baseUrl = env.COGFLARE_URL;
    this.predictions = env.PREDICTIONS_KV;
    this.items = {};
    this.state.blockConcurrencyWhile(async () => {
      let items: Map<string, PredictionResult> | null = null;
      try {
        let itemsJson = await this.state.storage.get("items") as string;
        if (itemsJson)
          items = JSON.parse(itemsJson);
      } catch { }
      this.items = items || {};
    });
  }

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let url = new URL(request.url);
    let path = url.pathname.slice(1).split('/');
    if (path[0] == 'v1')
      path = path.slice(1);
    switch (path[0]) {
      case "websocket": {
        if (request.headers.get("Upgrade") != "websocket") {
          return new Response("expected websocket", { status: 400 });
        }
        let ip = request.headers.get("CF-Connecting-IP");
        let pair = new WebSocketPair();
        await this.handleSession(pair[1], ip);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      case "predictions": {
        if (path[1]) {
          if (!this.items || !this.items[path[1]]) {
            let kvItem = await this.predictions.get(path[1]);
            if (kvItem) {
              await this.storage.delete(path[1]);
              return new Response(kvItem);
            }
            let item = await this.storage.get(path[1]) as string;
            if (!item)
              return new Response("Not found", { status: 404 });
            else
              return new Response(item);
          }
          return new Response(JSON.stringify(this.items[path[1]]));
        }
        let req = await request.json<PredictionResult>();
        var session: Session = this.sessions.filter(member => !member.quit && !member.request)[0];
        if (!session)
          return new Response("No workers available", { status: 400 });
        session.request = req;
        session.request.created_at = new Date();
        session.request.status = "starting";
        session.request.urls = { get: this.baseUrl + "/predictions/" + session.request.id, cancel: this.baseUrl + "/predictions/" + session.request.id + "/cancel" };
        session.request.cogflare = true;
        this.items[session.request.id] = session.request;
        await this.storage.put("items", JSON.stringify(this.items));
        session.webSocket.send(JSON.stringify(session.request));
        return new Response(JSON.stringify(session.request));
      }
      case "status": {
        return new Response(JSON.stringify({ available: this.sessions.filter(member => !member.quit && !member.request).length, total: this.sessions.length }));
      }
      default:
        return new Response("Queue: Not found", { status: 404 });
    }
  }

  async handleSession(webSocket: WebSocket, ip: string | null) {
    webSocket.accept();
    let session: Session = { webSocket: webSocket, connected: new Date() };
    if (!this.sessions)
      this.sessions = [];
    this.sessions.push(session);

    webSocket.addEventListener("message", async msg => {
      try {
        if (session.quit) {
          webSocket.close(1011, "Websocket broken.");
          return;
        }

        if (!session.request) {
          console.log("message recieved with no request active!");
          return;
        }
        let data = JSON.parse(msg.data.toString());

        session.request.output = data.output;
        session.request.logs = data.logs;
        session.request.error = data.error;
        session.request.completed_at = data.completed_at;
        session.request.metrics = data.metrics;
        session.request.status = data.status;
        this.items[session.request.id] = session.request;
        if (["succeeded", "cancelled", "failed"].includes(data.status)) {
          let requestJson = JSON.stringify(session.request);
          await this.storage.put(session.request.id, requestJson);
          await this.predictions.put(session.request.id, requestJson);
          delete this.items[session.request.id];
          await this.storage.put('items', JSON.stringify(this.items));
          session.request = undefined;
        }
      } catch (err: any) {
        console.log("Failed to handle response:\n" + JSON.stringify({ error: err.stack }));
      }
    });

    let closeOrErrorHandler = () => {
      session.quit = true;
      console.log("Session closed/error");
      this.sessions = this.sessions.filter(member => member !== session);
    };

    webSocket.addEventListener("close", closeOrErrorHandler);
    webSocket.addEventListener("error", closeOrErrorHandler);
  }
}

interface Env {
  COG_OUTPUTS: R2Bucket
  COGFLARE_URL: string
  PREDICTIONS_KV: KVNamespace
}