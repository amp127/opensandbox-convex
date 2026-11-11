/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import schema from "./component/schema.js";

export const modules = import.meta.glob(["./component/**/*.ts", "!./component/**/*.test.ts"]);

export function initConvexTest() {
  return convexTest(schema, modules);
}
