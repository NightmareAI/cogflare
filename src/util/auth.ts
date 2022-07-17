
export interface User {
  allow: boolean,
  replicate: string,
  runpod: string,
  worker: string
}

export default {
  async auth(request: Request, tokens: KVNamespace): Promise<User | null> {
    try {
      let token;
      let authorization = request.headers.get("Authorization");
      if (authorization && authorization.startsWith("Token ")) {
        token = authorization.substring(6);
      } else {
        token = request.headers.get("X-Cogflare-Token");
      }
      if (token) {
        let auth = await tokens.get(token);
        if (auth) {
          return JSON.parse(auth);
        }
      }
    }
    catch (ex) { console.log("error parsing auth: " + ex) }
    return null;
  }
}

