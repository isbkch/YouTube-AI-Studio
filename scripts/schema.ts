import { writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  planJSONSchema,
  patchSchema,
} from "../packages/production-plan/src/index.ts";
await writeFile(
  "packages/production-plan/production-plan.schema.json",
  JSON.stringify(planJSONSchema, null, 2) + "\n",
);
await writeFile(
  "packages/production-plan/production-plan-patch.schema.json",
  JSON.stringify(z.toJSONSchema(patchSchema, { target: "draft-7" }), null, 2) +
    "\n",
);
