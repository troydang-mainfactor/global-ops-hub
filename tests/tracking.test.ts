import { describe, expect, it } from "vitest";
import { trackingUrl } from "@/lib/tracking";

describe("trackingUrl", () => {
  it("links UPS, FedEx and USPS numbers to the carrier", () => {
    expect(trackingUrl("1Z9Y254W1373719605")).toContain("ups.com");
    expect(trackingUrl("879096806642")).toContain("fedex.com");
    expect(trackingUrl("9400111899223456789012")).toContain("usps.com");
    expect(trackingUrl("ABC123XYZ")).toContain("google.com");
  });
});
