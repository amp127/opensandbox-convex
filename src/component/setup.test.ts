import { expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "../setup.js";

test("the component schema and modules load", async () => {
  const t = initConvexTest();
  expect(await t.query(api.sandboxes.list, { ownerId: "user_1" })).toEqual([]);
});
