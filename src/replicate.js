const BASE_URL = "https://api.replicate.com/v1"

const POLLING_INTERVAL = 5000

const sleep = (ms) => new Promise((resolve) => setTimeout(() => resolve(), ms))
class Model {
  constructor(options) {
    if (!options.path)
      throw 'Missing Replicate model path'
    this.path = options.path;
    this.token = options.token;
    this.version = options.version;
    this.headers = { 'Authorization': `Token ${this.token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' };
  }

  async getModelDetails() {
    let response = await fetch(`${BASE_URL}/models/${this.path}/versions`, { headers: this.headers });
    let data = await response.json();
    let modelVersions = data.results;
    let mostRecentVersion = modelVersions[0];
    let explicitlySelectedVersion = modelVersions.find((m) => m.id == this.version);
    this.modelDetails = explicitlySelectedVersion ? explicitlySelectedVersion : mostRecentVersion;
  }

  async *predictor(input) {
    if (!this.modelDetails)
      await this.getModelDetails()
    let startRequest = { "version": this.modelDetails.id, "input": input }
    let startResponse = await fetch(`${BASE_URL}/predictions`, { method: 'POST', headers: this.headers, body: JSON.stringify(startRequest) });
    let predictionStatus;
    let startJson = await startResponse.json();
    console.log(startJson);
    do {
      let predictionId = startJson.id;
      let checkResponse = await fetch(`${BASE_URL}/predictions/${predictionId}`, { headers: this.headers });
      let data = await checkResponse.json();
      predictionStatus = data.status;
      let latestPrediction = data.output;
      await sleep(POLLING_INTERVAL);
      yield latestPrediction;

    } while (['starting', 'processing'].includes(predictionStatus))
  }

  async predict(input) {
    let predictor = this.predictor(input);
    let prediction;
    for await (prediction of predictor) {
      // console.log(prediction);
    }
    return prediction;
  }
}

class Replicate {
  constructor(options) {
    options = options ?? {};
    this.options = options;
    if (options.token)
      this.token = options.token
    if (!this.token)
      throw 'Missing Replicate token'
    this.models = { get: this.getModel.bind(this) }
  }

  async getModel(path, version) {
    let model = new Model({ path: path, version: version, token: this.token });
    await model.getModelDetails();
    return model;
  }
}

export default Replicate
