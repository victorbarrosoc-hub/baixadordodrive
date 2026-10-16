import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const atualizado = new Date("2026-10-16");
  return [
    { url: `${SITE_URL}/`, lastModified: atualizado, changeFrequency: "monthly", priority: 1 },
    { url: `${SITE_URL}/criar-conta`, lastModified: atualizado, changeFrequency: "yearly", priority: 0.6 },
    { url: `${SITE_URL}/privacidade`, lastModified: atualizado, changeFrequency: "yearly", priority: 0.4 },
    { url: `${SITE_URL}/termos`, lastModified: atualizado, changeFrequency: "yearly", priority: 0.4 },
  ];
}
