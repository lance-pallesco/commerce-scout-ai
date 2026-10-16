import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { ConfigurationError } from "@/lib/config/env";
import { JobNotFoundError } from "@/lib/jobs/repository";
import { SourceRegistryError } from "@/lib/research/source-registry";

export function apiError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export function apiException(error: unknown) {
  if (error instanceof ZodError) {
    return apiError("INVALID_REQUEST", "The research request is invalid.", 400);
  }
  if (error instanceof JobNotFoundError) {
    return apiError(error.code, error.message, 404);
  }
  if (error instanceof SourceRegistryError) {
    return apiError(error.code, error.message, 400);
  }
  if (error instanceof ConfigurationError) {
    return apiError(error.code, "Server research configuration is invalid.", 503);
  }
  if (error instanceof SyntaxError) {
    return apiError("INVALID_JSON", "Request body must contain valid JSON.", 400);
  }
  return apiError("INTERNAL_ERROR", "The server could not complete the request.", 500);
}
