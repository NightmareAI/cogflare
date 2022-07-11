import * as Realm from 'realm-web';
import { PredictionResult } from "./prediction"
import Denque from "denque"

type Session = {
  webSocket: WebSocket,
  connected: Date,
  quit?: boolean,
  request?: PredictionResult
}

export class Queue {
  state: DurableObjectState
  storage: DurableObjectStorage
  queuedItems: Denque<PredictionResult>
  sessions: Session[]
  baseUrl: string
  predictions: KVNamespace
  app: Realm.App
  user?: Realm.User
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.storage = state.storage;
    this.sessions = [];
    this.baseUrl = env.COGFLARE_URL;
    this.predictions = env.PREDICTIONS_KV;
    this.queuedItems = new Denque<PredictionResult>()
    this.app = new Realm.App(env.REALM_APP_ID);
    this.state.blockConcurrencyWhile(async () => {
      this.user = await this.app.logIn(Realm.Credentials.apiKey(env.REALM_API_KEY));
      try {
        let queueJson = await this.state.storage.get("queue") as string;
        if (queueJson)
          this.queuedItems = new Denque<PredictionResult>(JSON.parse(queueJson));
      } catch { }
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
        if (!this.queuedItems.isEmpty())
          await this.storage.setAlarm(Date.now() + 1000);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      case "predictions": {
        if (path[1]) {
          let kvItem = await this.predictions.get(path[1]);
          if (kvItem) {
            await this.storage.delete(path[1]);
            return new Response(kvItem);
          }
          let item = await this.storage.get<PredictionResult>(path[1]);
          if (!item)
            return new Response("Not found", { status: 404 });
          else
            return new Response(JSON.stringify(item));
        }
        let req = await request.json<PredictionResult>();
        req.urls = { get: this.baseUrl + "/predictions/" + req.id, cancel: this.baseUrl + "/predictions/" + req.id + "/cancel" };
        req.cogflare = true;
        req.created_at = new Date();
        console.log("adding to queue");
        req.status = "starting";
        this.queuedItems.push(req);
        await this.storage.put(req.id, req);
        await this.storage.put("queue", JSON.stringify(this.queuedItems.toArray()));
        if (!(await this.storage.getAlarm()))
          await this.storage.setAlarm(Date.now() + 1000);
        return new Response(JSON.stringify(req));
      }
      case "status": {
        return new Response(JSON.stringify({ available: this.sessions.filter(member => !member.quit && !member.request).length, total: this.sessions.length, queued: this.queuedItems.length }));
      }
      default:
        return new Response("Queue: Not found", { status: 404 });
    }
  }

  async alarm() {
    let availableSessions: Session[] = this.sessions.filter(member => !member.quit && !member.request);
    for (let session of availableSessions) {
      try {
        let req = this.queuedItems.pop();
        if (req) {
          console.log(`request ${req.id} dequeued`);
          session.webSocket.send(JSON.stringify(req));
          await this.storage.put("queue", JSON.stringify(this.queuedItems.toArray()));
        }
      } catch {
      }
    }
  }

  async handleSession(webSocket: WebSocket, ip: string | null) {
    webSocket.accept();
    let session: Session = { webSocket: webSocket, connected: new Date() };
    if (!this.sessions)
      this.sessions = [];
    this.sessions.push(session);

    webSocket.addEventListener("message", async msg => {

      if (session.quit) {
        webSocket.close(1011, "Websocket broken.");
        return;
      }

      let data = JSON.parse(msg.data.toString());
      let req: PredictionResult = await this.storage.get<PredictionResult>(data.id) || data;
      try {
        session.request = req;
        session.request.output = data.output;
        session.request.logs = data.logs;
        session.request.error = data.error;
        session.request.completed_at = data.completed_at;
        session.request.metrics = data.metrics;
        session.request.status = data.status;
        if (["succeeded", "cancelled", "failed"].includes(data.status)) {
          await this.predictions.put(session.request.id, JSON.stringify(session.request));
          session.request = undefined;
          if (!this.queuedItems.isEmpty() && !(await this.storage.getAlarm()))
            await this.storage.setAlarm(Date.now() + 1000);
        }
      } catch (err: any) {
        console.log("Failed to handle response:\n" + JSON.stringify({ error: err.stack }));
      } finally {
        await this.storage.put(req.id, req);
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
  REALM_APP_ID: string
  REALM_API_KEY: string
}