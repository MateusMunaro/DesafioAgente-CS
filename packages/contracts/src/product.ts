import { z } from "zod";

/** Product data from the Fake Store API; only these fields reach the LLM. */
export const ProductInfo = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1),
  category: z.string(),
  price: z.number().nonnegative(),
});
export type ProductInfo = z.infer<typeof ProductInfo>;
