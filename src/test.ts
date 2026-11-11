/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import { componentsGeneric, type GenericSchema, type SchemaDefinition } from "convex/server";
import schema from "./component/schema.js";
import type { ComponentApi } from "./component/_generated/component.js";

const modules = import.meta.glob(["./component/**/*.ts", "!./component/**/*.test.ts"]);

/**
 * Register the component with convex-test.
 * @param name - The name used in `app.use`, which defaults to "opensandbox".
 */
export function register<Schema extends SchemaDefinition<GenericSchema, boolean>>(
  t: TestConvex<Schema>,
  name: string = "opensandbox",
) {
  t.registerComponent(name, schema, modules);
  return componentsGeneric()[name] as unknown as ComponentApi;
}

export default { register, schema, modules };
