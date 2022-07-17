# Cogflare 
*(Working title)*

**Cogflare** is a [Cloudflare Workers](https://workers.cloudflare.com/) application that aims to simplify running distributed ML inference jobs through a central API. The jobs can (currently) be run using [Replicate](https://www.replicate.com/) or anywhere that Docker and a GPU is available, such as [RunPod](https://runpod.io) or your own hardware.

## How does it work?
Cogflare provides an HTTP API that is similar in surface area to [Replicate's API](https://replicate.com/api), but enables additional flexibility for running predictions. It provides a websocket server that workers connect to, and a lightweight queue with state managed by [Durable Objects](https://www.cloudflare.com/cloudflare-workers-durable-objects-beta) for running jobs on those workers. [R2](https://www.cloudflare.com/products/r2/) is leveraged to provide storage for results with high speed and no bandwidth costs, and the workers KV store is used as a record of data.

## Why does this exist?
I've been through a few iterations of the backend for [NightmareBot](https://github.com/NightmareAI/NightmareBot). I found Replicate a great solution overall but needed the flexibility to run wherever I wanted. I've found a number of people trying to solve the same problems I have so I created this project in the hopes of keeping others from having to reinvent the wheel so many times.

## What's it useful for?
You tell me! Bots are the big use case so far, but anywhere you need API access to ML inference with flexibility could be a fit.

## How do I use it?
Contact [palp@nmb.ai](mailto:palp@nmb.ai) if you're interested in using my hosted version - I'm not currently charging for it but I can only let people use it who are willing to act as testers. Currently there's a hard dependency on the Replicate API using your own key, so you'll first need to sign up for API access there and get a key. 

## No, not how do I use yours, how do I use it?
*This is a preliminary guide and needs a lot of work, operation is subject to drastic changes and it's not really recommended to do this yourself yet*

If you'd like to host it yourself, it should be as simple as updating the `wrangler.toml` file with your own account and resources (which you'll need to create) and deploying - no special sauce. The setup of Cloudflare workers is beyond the scope of this document for now, but I hope to add some basic instructions soon.

You'll need an entry in the TOKENS_KV, with the key acting as an authorization token and the contents being a JSON structure like this:
```
{"allow": true, "replicate": "YOUR_REPLICATE_TOKEN", "worker": "some-random-string" }
```
You can now make prediction requests by POSTing to the `/predictions` endpoint and retrieve their status with `GET /predictions/id`. 

Jobs will run on Replicate unless there are workers available. There is simple overflow logic place right now as well that sends jobs to Replicate if queue depth is greater than available workers, but this is temporary and subject to change.

Currently workers have to run Docker images built using a [fork of Replicate's Cog](https://github.com/NightmareAI/cog), however the public image `r8.im/nightmareai/disco-diffusion` has been built using this so I'll use it as an example. To start a worker for Disco Diffusion, a typical command would look like:
```
docker run --rm --gpus=all r8.im/nightmareai/disco-diffusion python -m cog.server.websockets wss://[WORKER-URL]/v1/models/nightmareai/disco-diffusion/websockets/[WORKER-TOKEN] https://[WORKER-URL]/v1/models/nightmareai/disco-diffusion/files nightmareai/disco-diffusion
```
This attaches the worker to your queue for this model, and it will continue to reconnect and run jobs until killed.

## This all sounds really complicated, I just want to run stuff and I don't want to talk to you!
Stay tuned! Easy sign up and setup are on the list!
