import { Database } from 'bun:sqlite';
import path from 'node:path';
import { cacheDir } from './config.ts';

const tableName = "media_files";

const textSearchableColumns = [
    'camera_make',
    'camera_model',
    'lens_model',
    'focal_length',
    'aperture',
    'shutter_speed',
    'iso',
    'hierarchical_subject'
] as const;
type TextSearchableColumns = typeof textSearchableColumns[number];

export const numberSearchableColumns = [
    'date_taken',
    'date_modified',
    'rating',
    'image_width',
    'image_height',
    'orientation',
] as const;
type NumberSearchableColumns = typeof numberSearchableColumns[number];

export type MediaFileProperties = {
    name: string;
    /**
     * Relative to the root directory. Stored using forward slashes (`/`) as directory separators.
     * Always begins with a slash, never ends with a slash (except for root which is just "/").
     * Starts with slash so that root is represented as "/" and not as an empty string.
     */
    parent_path: string;
} & Partial<Record<TextSearchableColumns, string>>
  & Partial<Record<NumberSearchableColumns, number>>;

export type MediaFileRow = MediaFileProperties & {
    id: number;
    date_indexed: number;
};

/**
 * Converts a system-relative path to a database-friendly format.
 * @param systemRelativePath A system-relative path (e.g., "folder/subfolder" or "/folder/subfolder/")
 * @returns A database-friendly path (e.g., "/folder/subfolder")
 */
const normalizePath = (systemRelativePath: string) => {
    let normalized = systemRelativePath.replaceAll('\\', '/');
    if (normalized.endsWith('/') && normalized.length > 1) {
        normalized = normalized.slice(0, -1);
    }
    if (!normalized.startsWith('/')) {
        normalized = '/' + normalized;
    }
    return normalized;
};

export type SearchFilters = {
    includeSubfolders?: boolean;
    name?: string; // for name-based searching
    parentPath?: string;
} & Partial<Record<TextSearchableColumns, string | Array<string>>>
  & Partial<Record<NumberSearchableColumns, number | Array<number> | {from:number, to:number}>>;

export class MediaDatabase {
    private db: Database;

    constructor(dbPath:string) {
        this.db = new Database(dbPath);
        this.initializeSchema();
    }

    private initializeSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ${tableName} (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                parent_path TEXT NOT NULL,
                ${textSearchableColumns.map(col => `${col} TEXT`).join(',\n')}
                ${numberSearchableColumns.map(col => `${col} INTEGER`).join(',\n')}
                date_indexed INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_path ON ${tableName}(parent_path, name);
            CREATE INDEX IF NOT EXISTS idx_parent_path ON ${tableName}(parent_path);
            CREATE INDEX IF NOT EXISTS idx_name ON ${tableName}(name);
            CREATE INDEX IF NOT EXISTS idx_date_taken ON ${tableName}(date_taken);
            CREATE INDEX IF NOT EXISTS idx_rating ON ${tableName}(rating);
            CREATE INDEX IF NOT EXISTS idx_camera_make ON ${tableName}(camera_make);
            CREATE INDEX IF NOT EXISTS idx_hierarchical_subject ON ${tableName}(hierarchical_subject);
        `);
    }

    addBasicFileRow(file: { name: string, parent_path: string }) {
        this.db.prepare(`
            INSERT OR IGNORE INTO ${tableName} (
                name, parent_path, date_indexed
            ) VALUES (?, ?, ?)
        `).run(
            file.name,
            normalizePath(file.parent_path),
            0 // indicate that EXIF data has not been processed yet
        );
    }

    addBasicFileRows(files: Array<{ name: string, parent_path: string }>) {
        const insertStmt = this.db.prepare(`
            INSERT OR IGNORE INTO ${tableName} (
                name, parent_path, date_indexed
            ) VALUES (?, ?, ?)
        `);
        
        const transaction = this.db.transaction((fileBatch: Array<{ name: string, parent_path: string }>) => {
            for (const file of fileBatch) {
                insertStmt.run(
                    file.name,
                    normalizePath(file.parent_path),
                    0 // indicate that EXIF data has not been processed yet
                );
            }
        });

        transaction(files);
    }

    insertOrUpdateFile(file: MediaFileProperties): MediaFileRow {
        const columns = [
            'name',
            'parent_path',
            ...textSearchableColumns,
            ...numberSearchableColumns,
            'date_indexed',
        ];
        const result = this.db.prepare(`
            INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
        `).run(
            file.name,
            normalizePath(file.parent_path),
            ...[...textSearchableColumns, ...numberSearchableColumns].map(col => file[col] ?? null),
            Date.now()
        );

        return this.getFileById(result.lastInsertRowid as number)!;
    }

    getFileById(id: number): MediaFileRow | undefined {
        const result = this.db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(id) as MediaFileRow | undefined;
        return result && {...result, parent_path: result.parent_path};
    }

    getFileByPath(relativePath: string): MediaFileRow | undefined {
        const fileName = path.basename(relativePath);
        const parentPath = path.dirname(relativePath);
        return this.db.prepare(`SELECT * FROM ${tableName} WHERE parent_path = ? AND name = ?`).get(normalizePath(parentPath), fileName) as MediaFileRow | undefined;
    }

    /**
     * List all immediate subfolders (names, not full path) of a given parent folder.
     */
    listSubfolders(parentPath: string): string[] {
        const normalizedParentPath = normalizePath(parentPath);
        const subFolderSet = this.db.prepare(`SELECT DISTINCT parent_path FROM ${tableName} WHERE parent_path like '${normalizedParentPath}%'`)
            .all()
            .map((row: any) => path.relative(normalizedParentPath, row.parent_path).split(path.sep)[0]) // Get the first segment of the relative path
            .reduce((acc: Set<string>, relativePath: string) => {
                relativePath && acc.add(relativePath);
                return acc;
            }, new Set())
        
        return [...subFolderSet].sort((a,b)=> a.localeCompare(b));
    }

    search({includeSubfolders, ...filters}: SearchFilters): MediaFileRow[] {

        type FilterProcessor = {
            [K in keyof SearchFilters]: (val: NonNullable<SearchFilters[K]>) => [string, string | string[]];
        };
        
        const specialFilterProcessors = {
            name: (val) => ['name LIKE ?', `%${val}%`],
            parentPath: (val) => {
                if (Array.isArray(val)){
                    return [`(parent_path IN (${val.map(()=>'?').join(',')})`, val]
                }
                if (!includeSubfolders){
                    return ['parent_path = ?', normalizePath(val)];
                }
                return ['parent_path LIKE ?', `${normalizePath(val)}/%`];
            },
        } as const satisfies Partial<FilterProcessor>;

        const numberFilterProcessor = (key: NumberSearchableColumns, val: NonNullable<SearchFilters[NumberSearchableColumns]>):[string, string | string[]] => {
            if (Array.isArray(val)) {
                return [`${key} IN (${val.map(() => '?').join(',')})`, val.map(v => v.toString())];
            }
            if (typeof val === 'number') {
                return [`${key} = ?`, `${val}`];
            }
            const queries = [];
            if ('from' in val) {
                queries.push(`${key} >= ?`);
                params.push(val.from.toString());
            }
            if ('to' in val) {
                queries.push(`${key} <= ?`);
                params.push(val.to.toString());
            }
            return [queries.join(' AND '), params];
        };

        const textFilterProcessor = (key: TextSearchableColumns, val: NonNullable<SearchFilters[TextSearchableColumns]>):[string, string | string[]] => {
            if (Array.isArray(val)) {
                return [`${key} IN (${val.map(() => '?').join(',')})`, val];
            }
            return [`${key} = ?`, val];
        };

        const {queries, params} = Object.entries(filters).map(([key, val]) => {
            if (key in specialFilterProcessors){
                if (typeof val !== 'string'){
                    throw new Error(`Invalid value for filter '${key}': ${JSON.stringify(val)}`);
                }
                return specialFilterProcessors[key as keyof typeof specialFilterProcessors](val);
            }
            if (textSearchableColumns.includes(key as TextSearchableColumns)) {
                if (typeof val !== 'string' && !(Array.isArray(val) && val.every(v => typeof v === 'string'))) {
                    throw new Error(`Invalid value for filter '${key}': ${JSON.stringify(val)}`);
                }
                return textFilterProcessor(key as TextSearchableColumns, val);
            }
            if (numberSearchableColumns.includes(key as NumberSearchableColumns)) {
                if (typeof val !== 'number' && !(Array.isArray(val) && val.every(v => typeof v === 'number')) && !(typeof val === 'object' && val !== null && 'from' in val && 'to' in val)) {
                    throw new Error(`Invalid value for filter '${key}': ${JSON.stringify(val)}`);
                }
                return numberFilterProcessor(key as NumberSearchableColumns, val);
            }
            throw new Error(`Unknown filter '${key}': ${JSON.stringify(val)}`);
        }).reduce((acc, [query, params]) => ({
            queries: [...acc.queries, query],
            params: [...acc.params, ...(Array.isArray(params) ? params : [params])]
        }), { queries: [] as string[], params: [] as string[] });

        const query = `SELECT * FROM ${tableName}
            ${queries.length > 0 ? ' WHERE ' + queries.join(' AND ') : ''}
             ORDER BY date_taken DESC, parent_path DESC, name ASC`;

        return this.db.prepare(query).all(...params) as MediaFileRow[];
    }

    deleteByPath(relativePath: string, deleteChildPaths: boolean = false): number {
        const fileName = path.basename(relativePath);
        const parentPath = normalizePath(path.dirname(relativePath));

        if (deleteChildPaths) {
            const dbPath = normalizePath(relativePath);
            return this.db.prepare(`DELETE FROM ${tableName} WHERE parent_path LIKE ?`).run(dbPath + '/%').changes;
        } else {
            return this.db.prepare(`DELETE FROM ${tableName} WHERE parent_path = ? AND name = ?`).run(parentPath, fileName).changes;
        }
    }

    close() {
        this.db.close();
    }
}

// Singleton instance
export const mediaDatabase = new MediaDatabase(path.join(cacheDir, "media.db"));
