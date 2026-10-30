import { fetchTopic, loadRecentPosts } from './news.js';
import { discoverFinanceMaterial } from './finance-material.js';

/** Add a source-first pass without changing other niches or the existing reserve. */
export async function selectFinanceTopic(niche, options = {}) {
  if (!niche.strictFinance || options.editorialFallback) return fetchTopic(niche, options);
  const recentPosts = options.recentPosts || await loadRecentPosts(niche.dir, 40);
  const material = await (options.discoverMaterial || discoverFinanceMaterial)(niche, { ...options, recentPosts });
  if (!material) return fetchTopic(niche, { ...options, recentPosts });
  return { ...material,
    recentTitles: recentPosts.map(post => post.title).filter(Boolean),
    recentTopicHints: recentPosts.slice(0, 8).map(post => post.source?.headline || post.title).filter(Boolean),
    recentSamples: recentPosts.slice(0, 5).map(post => ({ title: post.title, excerpt: post.excerpt })),
    recentFormats: recentPosts.slice(0, 5).map(post => post.source?.presentationFormat || '').filter(Boolean),
  };
}
