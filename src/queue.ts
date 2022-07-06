type Session = {
  webSocket: WebSocket,
  connected: Date,
  quit?: boolean,
  request?: string,

}

export class Queue {
  state: DurableObjectState
  items: any[]
  sessions: any[]
  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.items = [];
    this.sessions = [];
  }

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let url = new URL(request.url);
    switch (url.pathname) {
      case "/websocket": {
        if (request.headers.get("Upgrade") != "websocket") {
          return new Response("expected websocket", { status: 400 });
        }
        let ip = request.headers.get("CF-Connecting-IP");
        let pair = new WebSocketPair();
        await this.handleSession(pair[1], ip);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      case "/predict": {
        let req = JSON.parse(await request.text());
        var session: Session = this.sessions.filter(member => !member.quit && !member.request)[0];
        if (!session)
          return new Response("No workers available", { status: 400 });
        session.request = req;
        session.webSocket.send(JSON.stringify(req));
        return new Response("OK");
      }
      default:
        return new Response("Queue: Not found", { status: 404 });
    }
  }

  async handleSession(webSocket: WebSocket, ip: string | null) {
    webSocket.accept();

    let session: Session = { webSocket: webSocket, connected: new Date() };
    this.sessions.push(session);

    webSocket.addEventListener("message", async msg => {
      try {
        if (session.quit) {
          webSocket.close(1011, "Websocket broken.");
          return;
        }

        let data = JSON.parse(msg.data.toString());
        console.log(data);
      } catch (err: any) {
        console.log("Failed to handle response:\n" + JSON.stringify({ error: err.stack }));
      }
    });

    let closeOrErrorHandler = () => {
      session.quit = true;
      this.sessions = this.sessions.filter(member => member !== session);
    };
    webSocket.addEventListener("close", closeOrErrorHandler);
    webSocket.addEventListener("error", closeOrErrorHandler);
  }
}

interface Env {
  COG_OUTPUTS: R2Bucket
}