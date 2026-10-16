import { z } from "zod";

export const CurrencySchema = z.enum(["USD"]);
export const ResearchModeSchema = z.enum(["fixtures", "live"]);
export const SourceSelectionSchema = z.enum(["automatic", "manual"]);
export const SourceTypeSchema = z.enum(["fixture", "browser", "web-search"]);
export const BrowserCollectionStrategySchema = z.enum([
  "webscraper-catalog",
  "structured-search",
  "anthropic-web-search",
]);

export type ResearchMode = z.infer<typeof ResearchModeSchema>;
export type SourceSelection = z.infer<typeof SourceSelectionSchema>;

export const EvidenceSchema = z.object({
  field: z.string().min(1).max(80),
  value: z.string().min(1).max(2_000),
  sourceUrl: z.string().url().max(2_000).optional(),
  observedAt: z.string().datetime(),
  confidence: z.enum(["high", "medium", "low"]),
});

export const ProductCandidateSchema = z.object({
  id: z.string().min(1).max(160),
  sourceId: z.string().min(1).max(80),
  externalId: z.string().min(1).max(160),
  name: z.string().min(1).max(240),
  description: z.string().max(4_000).nullable(),
  category: z.string().max(120).nullable(),
  price: z.number().finite().nonnegative().nullable(),
  currency: CurrencySchema.nullable(),
  sourceUrl: z.string().url().max(2_000),
  imageUrl: z.string().url().max(2_000).nullable(),
  evidence: z.array(EvidenceSchema).max(40),
  missingFields: z.array(z.string().min(1).max(80)).max(20),
  collectedAt: z.string().datetime(),
});

export type ProductCandidate = z.infer<typeof ProductCandidateSchema>;

export const ResearchRequestSchema = z
  .object({
    niche: z.string().trim().min(2).max(80),
    minimumPrice: z.number().finite().nonnegative().max(100_000),
    maximumPrice: z.number().finite().positive().max(100_000),
    currency: CurrencySchema.default("USD"),
    requestedProductCount: z.number().int().min(1).max(50),
    sourceIds: z.array(z.string().min(1).max(80)).min(1).max(4),
    sourceSelection: SourceSelectionSchema.optional(),
    mode: ResearchModeSchema,
    objective: z.string().trim().min(10).max(1_000),
  })
  .superRefine((value, context) => {
    if (value.minimumPrice >= value.maximumPrice) {
      context.addIssue({
        code: "custom",
        path: ["maximumPrice"],
        message: "Maximum price must be greater than minimum price.",
      });
    }
  });

export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

export const SourceDescriptorSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(160),
  type: SourceTypeSchema,
  supportedCategories: z.array(z.string().min(1).max(80)).min(1),
  availability: z.enum(["available", "disabled"]),
  supportedModes: z.array(ResearchModeSchema).min(1),
  allowedCapabilities: z.array(z.enum(["list", "collect", "details"])).min(1),
  baseUrl: z.string().url().optional(),
  allowedHosts: z.array(z.string().min(1).max(255)).default([]),
  collectionStrategy: BrowserCollectionStrategySchema.default("webscraper-catalog"),
  searchable: z.boolean().default(false),
  searchUrlTemplate: z.string().min(1).max(2_000).optional(),
  nicheKeywords: z.array(z.string().min(1).max(80)).default([]),
  canonicalCategory: z.string().min(1).max(80).optional(),
  sourceNotice: z.string().min(1).max(1_000),
});

export type SourceDescriptor = z.infer<typeof SourceDescriptorSchema>;

export const CollectionMetadataSchema = z.object({
  sourceId: z.string(),
  sourceName: z.string(),
  mode: ResearchModeSchema,
  extractedCount: z.number().int().nonnegative(),
  returnedCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative(),
  filteredCount: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  collectedAt: z.string().datetime(),
  recoverableErrors: z.array(z.string().max(500)),
});

export type CollectionMetadata = z.infer<typeof CollectionMetadataSchema>;

export const CollectionResultSchema = z.object({
  products: z.array(ProductCandidateSchema),
  metadata: CollectionMetadataSchema,
});

export type CollectionResult = z.infer<typeof CollectionResultSchema>;
