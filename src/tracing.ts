const opentelemetry = require("@opentelemetry/api");
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web"
import { registerInstrumentations } from "@opentelemetry/instrumentation"
import { ConsoleSpanExporter, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"

registerInstrumentations({
  instrumentations: [],
});

const resource =
  Resource.default().merge(
    new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: "cogflare-queue",
      [SemanticResourceAttributes.SERVICE_VERSION]: "0.1.0",
    })
  );
const provider = new WebTracerProvider({
  resource: resource
});
const exporter = new ConsoleSpanExporter();
const processor = new BatchSpanProcessor(exporter);
provider.addSpanProcessor(processor);
provider.register();


