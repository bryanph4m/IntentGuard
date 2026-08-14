/**
 * The only place in the control plane that reads process.env.
 * Adding a variable means updating this schema and .env.example in the same commit.
 */
import { z } from "zod";

const schema = z.object({
  CONTROL_PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment. ${detail}. See .env.example.`);
}

export const env = parsed.data;
