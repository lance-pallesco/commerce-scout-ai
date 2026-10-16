import { describe, expect, it } from "vitest";

import { getResearchSource, listCompatibleResearchSources } from "@/lib/research/source-registry";
import {
  SourceAccessError,
  assertApprovedSourceUrl,
  isPublicInternetAddress,
} from "@/lib/research/url-policy";

const source = getResearchSource("webscraper-ecommerce-demo", "live");

describe("browser source policy", () => {
  it("permits only public DNS results for allowlisted HTTPS sources", async () => {
    await expect(
      assertApprovedSourceUrl(source.baseUrl!, source, async () => ["104.21.36.45"]),
    ).resolves.toBeInstanceOf(URL);
  });

  it("rejects localhost, private DNS answers, and unapproved hosts", async () => {
    await expect(
      assertApprovedSourceUrl("https://localhost/catalog", source, async () => ["127.0.0.1"]),
    ).rejects.toBeInstanceOf(SourceAccessError);
    await expect(
      assertApprovedSourceUrl(source.baseUrl!, source, async () => ["169.254.169.254"]),
    ).rejects.toBeInstanceOf(SourceAccessError);
    await expect(
      assertApprovedSourceUrl("https://example.com/catalog", source, async () => ["93.184.216.34"]),
    ).rejects.toBeInstanceOf(SourceAccessError);
  });

  it("recognizes reserved network ranges", () => {
    expect(isPublicInternetAddress("10.0.0.1")).toBe(false);
    expect(isPublicInternetAddress("127.0.0.1")).toBe(false);
    expect(isPublicInternetAddress("::1")).toBe(false);
    expect(isPublicInternetAddress("8.8.8.8")).toBe(true);
  });

  it("matches bounded niche keywords and exposes approved dynamic search sources", () => {
    expect(listCompatibleResearchSources("facial serum", "live").map((item) => item.id)).toContain("target-public-skincare");
    expect(listCompatibleResearchSources("garden tractors", "live").map((item) => item.id)).toEqual([
      "anthropic-web-discovery",
      "target-public-skincare",
      "ikea-public-search",
    ]);
  });
});
