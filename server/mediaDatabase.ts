import { Database } from 'bun:sqlite';
import path from 'node:path';
import { cacheDir } from './config.ts';

const tableName = "media_files";

export type MediaFileProperties = {
    name: string;
    /**
     * Relative to the root directory. Stored using forward slashes (`/`) as directory separators.
     * Always begins with a slash, never ends with a slash (except for root which is just "/").
     * Starts with slash so that root is represented as "/" and not as an empty string.
     */
    parent_path: string;
    date_taken?: number;
    date_modified?: number;
    rating?: number;
    camera_make?: string;
    camera_model?: string;
    lens_model?: string;
    focal_length?: string;
    aperture?: string;
    shutter_speed?: string;
    iso?: string;
    hierarchical_subject?: string;
    image_width?: number;
    image_height?: number;
    orientation?: number;
}

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

export interface SearchFilters {
    dateTaken?: { from?: Date; to?: Date };
    rating?: number[];
    cameraMake?: string[];
    cameraModel?: string[];
    lensModel?: string[];
    focalLength?: string[];
    aperture?: string[];
    shutterSpeed?: string[];
    iso?: string[];
    hierarchicalSubject?: string[];
    includeFolders?: boolean;
    recursive?: boolean;
    parentPath?: string;
    name?: string; // for name-based searching
};

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
                date_taken INTEGER,
                date_modified INTEGER,
                rating INTEGER,
                camera_make TEXT,
                camera_model TEXT,
                lens_model TEXT,
                focal_length TEXT,
                aperture TEXT,
                shutter_speed TEXT,
                iso TEXT,
                hierarchical_subject TEXT,
                image_width INTEGER,
                image_height INTEGER,
                orientation INTEGER,
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
        const result = this.db.prepare(`
            INSERT OR REPLACE INTO ${tableName} (
            name, parent_path, date_taken, date_modified, rating,
            camera_make, camera_model, lens_model, focal_length, aperture,
            shutter_speed, iso, hierarchical_subject, image_width, image_height, orientation, date_indexed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            file.name,
            normalizePath(file.parent_path),
            file.date_taken ?? null,
            file.date_modified ?? null,
            file.rating ?? null,
            file.camera_make ?? null,
            file.camera_model ?? null,
            file.lens_model ?? null,
            file.focal_length ?? null,
            file.aperture ?? null,
            file.shutter_speed ?? null,
            file.iso ?? null,
            file.hierarchical_subject ?? null,
            file.image_width ?? null,
            file.image_height ?? null,
            file.orientation ?? null,
            Math.floor(Date.now() / 1000) // Set current timestamp when EXIF data is processed
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

    search(filters: SearchFilters): MediaFileRow[] {
        const queries: string[] = [];
        const params: any[] = [];

        // Name search filter
        if (filters.name) {
            queries.push('name LIKE ?');
            params.push(`%${filters.name}%`);
        }

        // Within folder filter
        if (filters.parentPath !== undefined) {
            const dbParentPath = normalizePath(filters.parentPath);
            if (filters.recursive) {
                queries.push('(parent_path = ? OR parent_path LIKE ?)');
                params.push(dbParentPath, dbParentPath + '/%');
            } else {
                queries.push('parent_path = ?');
                params.push(dbParentPath);
            }
        }

        // Date range filter
        if (filters.dateTaken) {
            if (filters.dateTaken.from) {
                queries.push('date_taken >= ?');
                params.push(filters.dateTaken.from.getTime());
            }
            if (filters.dateTaken.to) {
                queries.push('date_taken <= ?');
                params.push(filters.dateTaken.to.getTime());
            }
        }

        // Rating filter
        if (filters.rating && filters.rating.length > 0) {
            queries.push(`rating IN (${filters.rating.map(() => '?').join(',')})`);
            params.push(...filters.rating);
        }

        const stringFilters = [
            ['camera_make', 'cameraMake'],
            ['camera_model', 'cameraModel'],
            ['lens_model', 'lensModel'],
            ['focal_length', 'focalLength'],
            ['aperture', 'aperture'],
            ['shutter_speed', 'shutterSpeed'],
            ['iso', 'iso'],
            ['hierarchical_subject', 'hierarchicalSubject'],
        ] as const;

        const [stringQueries, stringParams] = stringFilters.map(([columnName, filterKey]) => 
                [columnName, filters[filterKey]] as const)
            .filter(([_, filterValue]) => filterValue && filterValue.length > 0)
            .map(([columnName, filterValue]) => 
                [`${columnName} IN (${new Array(filterValue!.length).fill('?').join(',')})`, filterValue!] as const)
            .reduce<[string[], string[]]>(([querySegments, params], [curQuery, curParam]) => 
                [[...querySegments, `${querySegments}${curQuery}`], params.concat(curParam)] as const, [[],[]]);

        const query = `SELECT * FROM ${tableName}
            ${queries.length > 0 ? ' WHERE ' + queries.concat(stringQueries).join(' AND ') : ''}
             ORDER BY parent_path, name`;

        return this.db.prepare(query).all(...params,...stringParams) as MediaFileRow[];
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
