import type Database from 'better-sqlite3';
import type { PageEvidence, PageSummary } from './contracts.js';
import { pageAvailable, pageFolder, pageSearchExclusion, pageType } from './page-classification.js';

export type PageQuery = {
  query: string; tab: 'all' | 'attention' | 'unavailable' | 'excluded';
  grouping: 'type' | 'folder' | 'none'; group?: string;
  offset: number; limit: number; groupOffset: number;
};

/** Derived navigation metadata keeps full crawl evidence on disk. Original artifacts remain the backup and audit authority. */
export class PageCatalog {
  constructor(private readonly db: Database.Database) {
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS page_catalog(
        id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL, job_id TEXT NOT NULL, source_order INTEGER NOT NULL,
        url TEXT NOT NULL, search_text TEXT NOT NULL, page_type TEXT NOT NULL, folder TEXT NOT NULL,
        excluded TEXT, available INTEGER NOT NULL, has_title INTEGER NOT NULL,
        has_description INTEGER NOT NULL, has_schema INTEGER NOT NULL, noindex INTEGER NOT NULL, summary TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS page_catalog_job ON page_catalog(project_id,job_id,source_order DESC);
        CREATE INDEX IF NOT EXISTS page_catalog_url ON page_catalog(project_id,job_id,url);
        CREATE INDEX IF NOT EXISTS artifacts_finding_url ON artifacts(project_id,CAST(json_extract(body,'$.targetUrl') AS TEXT)) WHERE kind='finding';`);
      if (!db.prepare('SELECT version FROM migrations WHERE version=4').get()) {
        // Release each read statement before writing, without loading a historical crawl into memory.
        let after = 0;
        for (;;) {
          const rows = db.prepare("SELECT project_id,job_id,body,rowid FROM artifacts WHERE kind='page' AND rowid>? ORDER BY rowid LIMIT 100").all(after) as { project_id: string; job_id: string; body: string; rowid: number }[];
          if (!rows.length) break;
          for (const row of rows) this.insert(row.project_id, row.job_id, JSON.parse(row.body), row.rowid);
          after = rows[rows.length - 1].rowid;
        }
        db.prepare('INSERT INTO migrations VALUES(4)').run();
      }
    })();
  }

  insert(projectId: string, jobId: string, page: PageEvidence, order: number) {
    const { text: _text, links: _links, ...summary } = page;
    this.db.prepare('INSERT INTO page_catalog VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      page.id, projectId, jobId, order, page.url, (page.title + ' ' + page.url).toLowerCase(),
      pageType(page), pageFolder(page), pageSearchExclusion(page), Number(pageAvailable(page)),
      Number(!!page.title.trim()), Number(!!page.description.trim()), Number(!!page.schemaTypes.length),
      Number(page.noindex), JSON.stringify(summary));
  }

  summary(projectId: string, jobId: string) {
    return this.db.prepare(`SELECT COUNT(*) AS pages,
      COALESCE(SUM(available),0) AS available, COALESCE(SUM(available * has_title),0) AS titles,
      COALESCE(SUM(available * has_description),0) AS descriptions,
      COALESCE(SUM(available * has_schema),0) AS structuredData,
      COALESCE(SUM(available * noindex),0) AS noindex
      FROM page_catalog WHERE project_id=? AND job_id=?`).get(projectId, jobId) as {
        pages: number; available: number; titles: number; descriptions: number; structuredData: number; noindex: number;
      };
  }

  /** Count and page against one SQLite snapshot; accepted work from older audits keeps its original URL association. */
  list(projectId: string, jobId: string, input: PageQuery) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50 ||
      !Number.isInteger(input.offset) || input.offset < 0 || !Number.isInteger(input.groupOffset) || input.groupOffset < 0) throw new Error('Invalid page window');
    return this.db.transaction(() => {
      const base = `WITH page_counts AS MATERIALIZED (
        SELECT p.*, (SELECT COUNT(*) FROM artifacts f JOIN jobs j ON j.id=f.job_id
        WHERE f.project_id=? AND f.kind='finding' AND json_extract(j.body,'$.kind')='audit'
          AND CAST(json_extract(f.body,'$.targetUrl') AS TEXT)=p.url
          AND json_extract(f.body,'$.kind')!='visibility' AND json_extract(f.body,'$.status')!='done'
          AND (f.job_id=? OR json_extract(f.body,'$.status')!='open')
        ) AS open_checks FROM page_catalog p WHERE p.project_id=? AND p.job_id=?
      ), pages AS (
        SELECT *, CASE WHEN excluded IS NULL AND (available=0 OR open_checks>0) THEN 1 ELSE 0 END AS attention
        FROM page_counts
      )`;
      const tab = { all: '1', attention: 'attention=1', unavailable: 'available=0', excluded: 'excluded IS NOT NULL' }[input.tab];
      const groupColumn = { type: 'page_type', folder: 'folder', none: "'Pages'" }[input.grouping];
      if (!tab || !groupColumn) throw new Error('Invalid page filter');
      // One materialized snapshot supplies every count and window, rather than repeating the evidence join for each total.
      const result = this.db.prepare(base + `, filtered AS MATERIALIZED (
        SELECT * FROM pages WHERE ${tab} AND instr(search_text,?)>0
      ), narrowed AS (SELECT * FROM filtered ${input.group === undefined ? '' : `WHERE ${groupColumn}=?`})
      SELECT
        (SELECT json_object('allPages',COUNT(*),'attention',COALESCE(SUM(attention),0),
          'unavailable',COALESCE(SUM(1-available),0),'excluded',COALESCE(SUM(excluded IS NOT NULL),0)) FROM pages) AS counts,
        (SELECT json_group_array(json_object('name',name,'count',count)) FROM (
          SELECT ${groupColumn} AS name,COUNT(*) AS count FROM filtered GROUP BY ${groupColumn}
          ORDER BY MAX(source_order) DESC,name LIMIT 20 OFFSET ?)) AS groups,
        (SELECT COUNT(*) FROM (SELECT ${groupColumn} FROM filtered GROUP BY ${groupColumn})) AS groupCount,
        (SELECT COUNT(*) FROM narrowed) AS total,
        (SELECT json_group_array(json_object('page',json(summary),'openChecks',open_checks)) FROM (
          SELECT summary,open_checks FROM narrowed ORDER BY source_order DESC,id LIMIT ? OFFSET ?)) AS rows
      `).get(projectId, jobId, projectId, jobId, input.query.trim().toLowerCase(),
        ...(input.group === undefined ? [] : [input.group]), input.groupOffset, input.limit, input.offset) as {
          counts: string; groups: string; groupCount: number; total: number; rows: string;
        };
      return {
        counts: JSON.parse(result.counts) as { allPages: number; attention: number; unavailable: number; excluded: number },
        groups: JSON.parse(result.groups) as { name: string; count: number }[], groupCount: result.groupCount,
        total: result.total, offset: input.offset, limit: input.limit,
        rows: JSON.parse(result.rows) as { page: PageSummary; openChecks: number }[],
      };
    })();
  }
}
