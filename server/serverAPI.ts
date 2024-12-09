type DateInfo = "mediaCreated" | "modified" | "accessed" | "fileCreated";
type SearchDate = Partial<Record<`${DateInfo}`,{start?:Date,end?:Date}>>;

type SearchMetadata = {
    comment?: string | RegExp;
    keywords?: (string | RegExp)[]; // Intersection followed by union
};

type SearchFile = {
    path?: string | RegExp;
    type?: "image" | "video" | "audio" | "document";
    size?: {min?: number, max?: number};
}

export type Search = SearchDate & SearchMetadata & SearchFile;


export type ResultParameters = {
    start?: number;
    limit?: number;
    sort?: "asc" | "desc";
    sortBy?:  DateInfo | "path" | "size" | "type";
};

type ValsAsStrings<T> = {
    [K in keyof T]:
    T[K] extends Date|RegExp|string|number|boolean ? string :
    T[K] extends object ? ValsAsStrings<T[K]> :
    never;
}

type P = (string|undefined) extends (string|undefined)? true:false;

export type QueryStringJSON = ValsAsStrings<Search & ResultParameters>;

