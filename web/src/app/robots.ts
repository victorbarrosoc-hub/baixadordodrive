import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Telas de conta e API não interessam a buscadores.
      disallow: ["/api/", "/conta", "/dispositivo"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
