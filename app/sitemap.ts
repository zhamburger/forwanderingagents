import type { MetadataRoute } from "next";

const base = "https://forwanderingagents.com";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: base + "/", changeFrequency: "weekly", priority: 1 },
    { url: base + "/for-agents", changeFrequency: "monthly", priority: 0.9 },
    { url: base + "/guestbook", changeFrequency: "daily", priority: 0.8 },
    { url: base + "/results", changeFrequency: "daily", priority: 0.9 },
    { url: base + "/methodology", changeFrequency: "monthly", priority: 0.8 },
  ];
}
