import { sandboxAdapterConformance } from "../adapter-conformance.js";
import { fakeSandbox } from "./fake-sandbox.js";

sandboxAdapterConformance("fake", () => fakeSandbox());
