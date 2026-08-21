import { withWriteTx, type ArtifactStore, type SqliteDriver } from '@linkedin-mcp/db';
import { parseCsv } from '@linkedin-mcp/importers';
import { DomainError, newId } from '@linkedin-mcp/shared';

// The member's own post history, parsed from the Shares file of their export.
// It is what repetition checks compare against and what the voice profile is
// derived from — the alternative would be inventing a tone.

export interface PublishedPost {
  id: string;
  posted_at: string;
  commentary: string;
  share_url: string | null;
  char_count: number;
  hashtags: string[];
  language_guess: string | null;
}

const CYRILLIC = /[Ѐ-ӿ]/;

export function guessLanguage(text: string): string {
  const cyrillic = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cyrillic === 0) return 'en';
  if (latin === 0) return 'bg';
  return cyrillic > latin ? 'bg' : 'mixed';
}

export function extractHashtags(text: string): string[] {
  return [...new Set((text.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.toLowerCase()))];
}

export function importPublishedPosts(
  db: SqliteDriver,
  store: ArtifactStore,
  artifactId: string,
): { imported: number; skipped: number } {
  const artifact = db.get('SELECT sha256, source_relpath FROM artifacts WHERE id = ?', artifactId);
  if (!artifact) throw new DomainError('NOT_FOUND', `artifact ${artifactId} not found`);
  const rows = parseCsv(Buffer.from(store.read(String(artifact['sha256']))).toString());
  const header = rows[0] ?? [];
  const col = (name: string) => header.indexOf(name);
  const iDate = col('Date');
  const iLink = col('ShareLink');
  const iText = col('ShareCommentary');
  const iShared = col('SharedUrl');
  const iMedia = col('MediaUrl');
  const iVis = col('Visibility');
  if (iDate < 0 || iText < 0) {
    throw new DomainError(
      'INVALID_INPUT',
      `artifact ${artifactId} does not look like a Shares export (expected Date and ShareCommentary columns)`,
    );
  }

  // Counters declared inside the retried body — see withWriteTx's contract.
  return withWriteTx(db, () => {
    let imported = 0;
    let skipped = 0;
    for (const row of rows.slice(1)) {
      const commentary = (row[iText] ?? '').trim();
      const postedAt = (row[iDate] ?? '').trim();
      if (!commentary || !postedAt) {
        skipped += 1;
        continue;
      }
      const existing = db.get(
        'SELECT 1 AS x FROM published_posts WHERE posted_at = ? AND char_count = ?',
        postedAt,
        commentary.length,
      );
      if (existing) {
        skipped += 1;
        continue;
      }
      db.run(
        `INSERT INTO published_posts (id, share_url, posted_at, commentary, shared_url, media_url, visibility, char_count, hashtags_json, language_guess, artifact_id, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId('pub'),
        iLink >= 0 ? (row[iLink] ?? null) : null,
        postedAt,
        commentary,
        iShared >= 0 ? (row[iShared] ?? null) : null,
        iMedia >= 0 ? (row[iMedia] ?? null) : null,
        iVis >= 0 ? (row[iVis] ?? null) : null,
        commentary.length,
        JSON.stringify(extractHashtags(commentary)),
        guessLanguage(commentary),
        artifactId,
        new Date().toISOString(),
      );
      imported += 1;
    }
    return { imported, skipped };
  });
}

export function listPublishedPosts(db: SqliteDriver, limit = 100): PublishedPost[] {
  return db
    .all('SELECT * FROM published_posts ORDER BY posted_at DESC LIMIT ?', limit)
    .map((row) => ({
      id: String(row['id']),
      posted_at: String(row['posted_at']),
      commentary: String(row['commentary']),
      share_url: (row['share_url'] as string | null) ?? null,
      char_count: Number(row['char_count']),
      hashtags: JSON.parse(String(row['hashtags_json'])) as string[],
      language_guess: (row['language_guess'] as string | null) ?? null,
    }));
}

export interface VoiceProfile {
  posts: number;
  first_post: string | null;
  last_post: string | null;
  median_chars: number;
  language_mix: Record<string, number>;
  hashtags_per_post: number;
  top_hashtags: Array<{ tag: string; count: number }>;
  posts_with_link: number;
}

// Descriptive only: it reports how the member has actually written, so drafts
// can match that register instead of a generic "LinkedIn voice".
export function voiceProfile(db: SqliteDriver): VoiceProfile {
  const posts = db.all('SELECT * FROM published_posts ORDER BY posted_at');
  if (posts.length === 0) {
    return {
      posts: 0,
      first_post: null,
      last_post: null,
      median_chars: 0,
      language_mix: {},
      hashtags_per_post: 0,
      top_hashtags: [],
      posts_with_link: 0,
    };
  }
  const lengths = posts.map((p) => Number(p['char_count'])).sort((a, b) => a - b);
  const languageMix: Record<string, number> = {};
  const tagCounts = new Map<string, number>();
  let tagTotal = 0;
  let withLink = 0;
  for (const post of posts) {
    const lang = String(post['language_guess'] ?? 'unknown');
    languageMix[lang] = (languageMix[lang] ?? 0) + 1;
    const tags = JSON.parse(String(post['hashtags_json'])) as string[];
    tagTotal += tags.length;
    for (const tag of tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    if (String(post['shared_url'] ?? '').length > 0) withLink += 1;
  }
  return {
    posts: posts.length,
    first_post: String(posts[0]!['posted_at']),
    last_post: String(posts.at(-1)!['posted_at']),
    median_chars: lengths[Math.floor(lengths.length / 2)] ?? 0,
    language_mix: languageMix,
    hashtags_per_post: Number((tagTotal / posts.length).toFixed(1)),
    top_hashtags: [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count })),
    posts_with_link: withLink,
  };
}

export function containsCyrillic(text: string): boolean {
  return CYRILLIC.test(text);
}
