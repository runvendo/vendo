import { pgSchema } from "drizzle-orm/pg-core";

/** All Flowlet-durable tables live in this Postgres schema. Tables land in Task 7. */
export const flowlet = pgSchema("flowlet");
