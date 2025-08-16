import { Database } from 'bun:sqlite';
import path from 'node:path';
import { cacheDir } from './config.ts';

const tableName = "media_files";

export const textSearchableColumns = [
    'camera_make',
    'camera_model',
    'lens_model',
    'focal_length',
    'aperture',
    'shutter_speed',
    'iso',
    'hierarchical_subject'
] as const;
export type TextSearchableColumns = typeof textSearchableColumns[number];

export const numberSearchableColumns = [
    'date_taken',
    'date_modified',
    'rating',
    'image_width',
    'image_height',
    'orientation',
] as const;
export type NumberSearchableColumns = typeof numberSearchableColumns[number];

export type MediaFileProperties = {
    name: string;
    /**
     * Relative to the root directory. Stored using forward slashes (`/`) as directory separators.
     * Always begins with a slash, never ends with a slash (except for root which is just "/").
     * Starts with slash so that root is represented as "/" and not as an empty string.
     */
    parent_path: string;
    keywords?: string[]; // JSON array of keywords
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
    excludeSubfolders?: boolean;
    name?: string; // for name-based searching
    parentPath?: string;
    keywords?: string | string[]; // Search in keywords JSON array
} & Partial<Record<TextSearchableColumns, string | Array<string>>>
  & Partial<Record<NumberSearchableColumns, number | Array<number> | {from:number, to:number}>>;;

export const searchFields = [
    'name',
    ...textSearchableColumns,
    ...numberSearchableColumns
] as const;

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
                keywords JSON,
                ${textSearchableColumns.map(col => `${col} TEXT`).join(',\n')},
                ${numberSearchableColumns.map(col => `${col} INTEGER`).join(',\n')},
                date_indexed INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_path ON ${tableName}(parent_path, name);
            CREATE INDEX IF NOT EXISTS idx_parent_path ON ${tableName}(parent_path);
            CREATE INDEX IF NOT EXISTS idx_name ON ${tableName}(name);
            CREATE INDEX IF NOT EXISTS idx_date_taken ON ${tableName}(date_taken);
            CREATE INDEX IF NOT EXISTS idx_rating ON ${tableName}(rating);
            CREATE INDEX IF NOT EXISTS idx_camera_make ON ${tableName}(camera_make);
            CREATE INDEX IF NOT EXISTS idx_hierarchical_subject ON ${tableName}(hierarchical_subject);
            CREATE INDEX IF NOT EXISTS idx_keywords ON ${tableName}(keywords);
        `);
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
            'keywords',
            ...textSearchableColumns,
            ...numberSearchableColumns,
            'date_indexed',
        ];
        const result = this.db.prepare(`
            INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
        `).run(
            file.name,
            normalizePath(file.parent_path),
            file.keywords ? JSON.stringify(file.keywords.sort((a,b) => a.localeCompare(b))) : null,
            ...[...textSearchableColumns, ...numberSearchableColumns].map(col => file[col] ?? null),
            Date.now()
        );

        return this.getFileById(result.lastInsertRowid as number)!;
    }

    getFileById(id: number): MediaFileRow | undefined {
        const result = this.db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(id) as any;
        if (!result) return undefined;
        
        // Parse keywords JSON back to array
        const keywords = result.keywords ? JSON.parse(result.keywords) : undefined;
        return {
            ...result,
            parent_path: result.parent_path,
            keywords
        };
    }

    getFileByPath(relativePath: string): MediaFileRow | undefined {
        const fileName = path.basename(relativePath);
        const parentPath = path.dirname(relativePath);
        const result = this.db.prepare(`SELECT * FROM ${tableName} WHERE parent_path = ? AND name = ?`).get(normalizePath(parentPath), fileName) as (MediaFileRow & {keywords?:string}) | undefined;
        return { ...result, keywords: result?.keywords && JSON.parse(result.keywords)} as MediaFileRow | undefined;
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

    private createQueryFilter({excludeSubfolders: excludeSubfolders, ...filters}: SearchFilters):{whereClause:string, params:string[]} {
        type FilterProcessor = {
            [K in keyof SearchFilters]: (val: NonNullable<SearchFilters[K]>) => [string, string | string[]];
        };
        
        const specialFilterProcessors = {
            name: (val) => ['name LIKE ?', `%${val}%`],
            keywords: (val) => {
                if (Array.isArray(val)) {
                    // Search for ALL of the keywords in the JSON array (must match all)
                    const queries = val.map(() => 'EXISTS (SELECT 1 FROM JSON_EACH(keywords) WHERE value = ?)').join(' AND ');
                    return [`(${queries})`, val];
                } else {
                    // Search for a single keyword in the JSON array
                    return ['EXISTS (SELECT 1 FROM JSON_EACH(keywords) WHERE value = ?)', val];
                }
            },
            parentPath: (val) => {
                if (Array.isArray(val)){
                    return [`(parent_path IN (${val.map(()=>'?').join(',')})`, val]
                }
                const normalizedPath = normalizePath(val);
                if (excludeSubfolders){
                    return ['parent_path = ?', normalizedPath];
                }
                if (normalizedPath === "/"){
                    return ['parent_path LIKE ?', `%${normalizedPath}%`];
                }
                return ['parent_path LIKE ?', `${normalizedPath}/%`];
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
            const rangeParams = [];
            if ('from' in val) {
                queries.push(`${key} >= ?`);
                rangeParams.push(val.from.toString());
            }
            if ('to' in val) {
                queries.push(`${key} <= ?`);
                rangeParams.push(val.to.toString());
            }
            return [queries.join(' AND '), rangeParams];
        };

        const textFilterProcessor = (key: TextSearchableColumns, val: NonNullable<SearchFilters[TextSearchableColumns]>):[string, string | string[]] => {
            if (Array.isArray(val)) {
                // Fuzzy match: use LIKE for each value, combine with OR
                const queries = val.map(() => `${key} LIKE ?`).join(' OR ');
                const params = val.map(v => `%${v}%`);
                return [`(${queries})`, params];
            }
            // Fuzzy match: use LIKE with wildcards
            return [`${key} LIKE ?`, `%${val}%`];
        };

        const {queries, params} = Object.entries(filters).filter(([, val]) => val !== undefined).map(([key, val]) => {
            if (key in specialFilterProcessors){
                if (key === 'keywords') {
                    if (typeof val !== 'string' && !(Array.isArray(val) && val.every(v => typeof v === 'string'))) {
                        throw new Error(`Invalid value for filter '${key}': ${JSON.stringify(val)}`);
                    }
                    return specialFilterProcessors.keywords(val as string | string[]);
                } else {
                    if (typeof val !== 'string'){
                        throw new Error(`Invalid value for filter '${key}': ${JSON.stringify(val)}`);
                    }
                    return specialFilterProcessors[key as Exclude<keyof typeof specialFilterProcessors, 'keywords'>](val as string);
                }
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

        const whereClause = `${queries.length > 0 ? ' WHERE ' + queries.join(' AND ') : ''}
             ORDER BY date_taken DESC, parent_path DESC, name ASC`;

        return {whereClause, params};
    }

    search({excludeSubfolders, ...filters}: SearchFilters): MediaFileRow[] {
        const {whereClause, params} = this.createQueryFilter({excludeSubfolders, ...filters});
        const results = this.db.prepare(`SELECT * FROM ${tableName}${whereClause}`).all(...params) as any[];
        
        // Parse keywords JSON back to array for each result
        return results.map(result => ({
            ...result,
            keywords: result.keywords ? JSON.parse(result.keywords) : undefined
        }));
    }

    getColumnDistinctValues<T extends keyof MediaFileProperties>(column: T, options?:{filter?:SearchFilters, containsText?:string}): T extends 'keywords'?string[]:MediaFileProperties[T][] {
        const filter = {...options?.filter, [column]: options?.containsText};

        const { whereClause, params } = this.createQueryFilter(filter);

        if (column === 'keywords'){
            const query = `SELECT DISTINCT value FROM ${tableName}, JSON_EACH(${column})${whereClause}`;
            return this.db.prepare(query).all(...params).map((r:any)=>r.value) as T extends 'keywords'?string[]:never;
        }

        return this.db.prepare(`SELECT DISTINCT ${column} FROM ${tableName}${whereClause}`).all(...params).map(row => {
            if (typeof row !== 'object' || row === null || !(column in row)) {
                throw new Error(`Unexpected row format: ${JSON.stringify(row)}`);
            }
            return (row as MediaFileProperties)[column];
        }) as T extends 'keywords'?string[]:MediaFileProperties[T][];
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
