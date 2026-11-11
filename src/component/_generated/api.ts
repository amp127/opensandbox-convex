/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as code from "../code.js";
import type * as errors from "../errors.js";
import type * as exec from "../exec.js";
import type * as executions from "../executions.js";
import type * as files from "../files.js";
import type * as network from "../network.js";
import type * as observe from "../observe.js";
import type * as remote from "../remote.js";
import type * as sandboxes from "../sandboxes.js";
import type * as snapshots from "../snapshots.js";
import type * as sse from "../sse.js";
import type * as store from "../store.js";
import type * as transport from "../transport.js";
import type * as urls from "../urls.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  access: typeof access;
  code: typeof code;
  errors: typeof errors;
  exec: typeof exec;
  executions: typeof executions;
  files: typeof files;
  network: typeof network;
  observe: typeof observe;
  remote: typeof remote;
  sandboxes: typeof sandboxes;
  snapshots: typeof snapshots;
  sse: typeof sse;
  store: typeof store;
  transport: typeof transport;
  urls: typeof urls;
  validators: typeof validators;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {};
