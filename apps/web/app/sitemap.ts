import type { MetadataRoute } from "next";

/** Marketing routes only — /app is private and never indexed. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://sadhak.online";
  return [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/product/blast-radius`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/product/agents`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/product/gate`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/pricing`, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/signin`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/signup`, changeFrequency: "yearly", priority: 0.5 },
  ];
}
