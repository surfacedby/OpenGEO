import type { PageSummary } from './contracts.js';

export const pageTypeLabels = {
  home: 'Home', product: 'Products', pricing: 'Pricing', article: 'Articles',
  documentation: 'Help and documentation', company: 'Company', legal: 'Policies', other: 'Other pages',
} as const;
export type PageType = keyof typeof pageTypeLabels;

/** Tracking tags do not identify a different cited page; meaningful query parameters still do. */
export function pageIdentity(value: string): string {
  try {
    const url = new URL(value);
    for (const name of [...url.searchParams.keys()]) if (name.toLowerCase().startsWith('utm_')) url.searchParams.delete(name);
    return url.hostname.replace(/^www\./, '') + url.pathname.replace(/\/+$/, '') + url.search;
  } catch { return value; }
}

export function pageAvailable(page: Pick<PageSummary, 'status'>): boolean {
  return page.status >= 200 && page.status < 300;
}

/** Strong document declarations precede URL conventions; a product under /plugins remains a product. */
export function pageType(page: PageSummary): PageType {
  const types = page.schemaTypes.map(type => type.replace(/^https?:\/\/schema\.org\//i, '').toLowerCase());
  if (types.includes('product')) return 'product';
  if (types.some(type => ['article', 'blogposting', 'newsarticle', 'techarticle'].includes(type))) return 'article';
  const parts = new URL(page.url).pathname.toLowerCase().split('/').filter(Boolean);
  if (/^(en|fr|de|es|it|pt|nl|ja|ko|zh|ar|ru|pl|tr|sv|no|fi|da|cs|el|he|th|vi|id|ms|uk|ro|hu|sk|bg|hr)(?:-[a-z]{2})?$/.test(parts[0] ?? '')) parts.shift();
  const first = parts[0];
  if (!first) return 'home';
  if (/^(pricing|plans)$/.test(first)) return 'pricing';
  if (/^(blog|news|articles|insights)$/.test(first)) return 'article';
  if (/^(docs|documentation|help|support|guides|knowledge-base)$/.test(first)) return 'documentation';
  if (/^(products?|shop)$/.test(first)) return 'product';
  if (/^(about|contact|company|team|careers)$/.test(first)) return 'company';
  if (/^(privacy|privacy-policy|terms|terms-of-service|legal|refund-policy|policies)$/.test(first)) return 'legal';
  return 'other';
}

/** Intentional exclusions stay visible without being presented as content that must be made public. */
export function pageSearchExclusion(page: PageSummary): string | null {
  if (page.status === 401) return 'Sign-in required';
  if (/^\/(wp-login\.php|wp-admin(?:\/|$)|account\/login(?:\/|$))/i.test(new URL(page.url).pathname)) return 'Account or sign-in page';
  if (page.noindex) return 'Excluded from search by noindex';
  return null;
}

export function pageFolder(page: PageSummary): string {
  const parts = new URL(page.url).pathname.split('/').filter(Boolean);
  return parts.length > 1 ? '/' + parts[0] + '/' : 'Top-level pages';
}
